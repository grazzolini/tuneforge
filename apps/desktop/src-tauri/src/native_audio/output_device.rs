use serde::Serialize;
use std::fmt;

#[cfg(any(target_os = "android", target_os = "ios", target_os = "linux", target_os = "macos"))]
use cpal::traits::{DeviceTrait, HostTrait};

pub const SYSTEM_DEFAULT_OUTPUT: &str = "default";

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum OutputRouteStatus {
    SystemDefault,
    Pending,
    Selected,
    RequestedUnverified,
    FallbackDefault,
    Unavailable,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputRouteSnapshot {
    pub preferred_device_id: Option<String>,
    pub active_device_id: Option<String>,
    pub status: OutputRouteStatus,
    pub fallback_latched: bool,
    pub generation: u64,
}

#[derive(Clone, Debug)]
pub struct OutputRouteState {
    preferred_device_id: Option<String>,
    active_device_id: Option<String>,
    status: OutputRouteStatus,
    fallback_latched: bool,
    generation: u64,
}

impl Default for OutputRouteState {
    fn default() -> Self {
        Self {
            preferred_device_id: None,
            active_device_id: None,
            status: OutputRouteStatus::SystemDefault,
            fallback_latched: false,
            generation: 0,
        }
    }
}

impl OutputRouteState {
    pub fn snapshot(&self) -> OutputRouteSnapshot {
        OutputRouteSnapshot {
            preferred_device_id: self.preferred_device_id.clone(),
            active_device_id: self.active_device_id.clone(),
            status: self.status,
            fallback_latched: self.fallback_latched,
            generation: self.generation,
        }
    }

    pub fn preferred_device_id(&self) -> Option<&str> { self.preferred_device_id.as_deref() }
    pub fn target_device_id(&self) -> Option<&str> {
        if self.fallback_latched { None } else { self.preferred_device_id() }
    }

    pub fn same_preference(&self, id: Option<&str>) -> bool {
        self.preferred_device_id() == id.filter(|id| !id.is_empty() && *id != SYSTEM_DEFAULT_OUTPUT)
    }

    pub fn select(&mut self, id: Option<String>) {
        self.preferred_device_id = id.filter(|id| !id.is_empty() && id != SYSTEM_DEFAULT_OUTPUT);
        self.fallback_latched = false;
        self.active_device_id = None;
        self.status = if self.preferred_device_id.is_some() {
            OutputRouteStatus::Pending
        } else {
            OutputRouteStatus::SystemDefault
        };
        self.generation = self.generation.wrapping_add(1).max(1);
    }

    pub fn activate(&mut self) {
        self.active_device_id = self.target_device_id().map(str::to_string);
        self.status = if self.fallback_latched {
            OutputRouteStatus::FallbackDefault
        } else if self.active_device_id.is_none() {
            OutputRouteStatus::SystemDefault
        } else if cfg!(target_os = "android") {
            OutputRouteStatus::RequestedUnverified
        } else {
            OutputRouteStatus::Selected
        };
        self.generation = self.generation.wrapping_add(1).max(1);
    }

    pub fn fallback_to_default(&mut self) -> bool {
        if self.fallback_latched || self.preferred_device_id.is_none() { return false; }
        self.fallback_latched = true;
        self.active_device_id = None;
        self.status = OutputRouteStatus::FallbackDefault;
        self.generation = self.generation.wrapping_add(1).max(1);
        true
    }

    pub fn unavailable(&mut self) {
        self.active_device_id = None;
        self.status = OutputRouteStatus::Unavailable;
        self.generation = self.generation.wrapping_add(1).max(1);
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ResolveError {
    Missing,
    Invalid,
    Inventory(String),
    NoDefault,
}

impl fmt::Display for ResolveError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Missing => formatter.write_str("Selected native output device was not found."),
            Self::Invalid => formatter.write_str("Selected output has an unavailable identity; reselect it."),
            Self::Inventory(message) => formatter.write_str(message),
            Self::NoDefault => formatter.write_str("System Default output is unavailable."),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioOutputDevice {
    pub id: String,
    pub label: String,
    pub is_default: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioOutputDevices {
    pub supported: bool,
    pub devices: Vec<AudioOutputDevice>,
    pub error: Option<String>,
}

#[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
pub fn list() -> AudioOutputDevices {
    match list_inner() {
        Ok(devices) => AudioOutputDevices { supported: true, devices, error: None },
        Err(error) => AudioOutputDevices { supported: false, devices: Vec::new(), error: Some(error) },
    }
}

#[cfg(not(any(target_os = "android", target_os = "linux", target_os = "macos")))]
pub fn list() -> AudioOutputDevices {
    AudioOutputDevices {
        supported: false,
        devices: Vec::new(),
        error: Some("Only System Default output is available on this platform.".to_string()),
    }
}

#[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
fn list_inner() -> Result<Vec<AudioOutputDevice>, String> {
    let host = super::native_cpal_host()?;
    #[cfg(target_os = "linux")]
    let verified_sinks = verified_pipewire_sinks()?;
    #[cfg(target_os = "macos")]
    let default_id = host.default_output_device().and_then(|device| device.id().ok());
    let devices = host.output_devices()
        .map_err(|error| format!("Could not list native output devices: {error}"))?;
    let mut result = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for device in devices {
        let id = device.id().map_err(|error| format!("Could not identify native output device: {error}"))?;
        #[cfg(target_os = "linux")]
        let Some(&is_default) = verified_sinks.get(id.id()) else { continue };
        #[cfg(target_os = "android")]
        if id.id() == "-1" { continue; }
        #[cfg(target_os = "android")]
        let is_default = false;
        #[cfg(target_os = "macos")]
        let is_default = default_id.as_ref() == Some(&id);
        if !seen.insert(id.to_string()) {
            return Err("Native output device identity is duplicated.".to_string());
        }
        let label = device.description()
            .map_err(|error| format!("Could not describe native output device: {error}"))?
            .name().to_string();
        result.push(AudioOutputDevice { id: id.to_string(), label, is_default });
    }
    #[cfg(target_os = "android")]
    if result.is_empty() {
        // CPAL substitutes its synthetic default device when the Java inventory fails.
        // It cannot distinguish that failure from no connected outputs.
        return Err("Android output inventory is unavailable; System Default may still work.".to_string());
    }
    Ok(result)
}

#[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
pub fn resolve(id: Option<&str>) -> Result<cpal::Device, ResolveError> {
    let host = super::native_cpal_host().map_err(ResolveError::Inventory)?;
    let Some(id) = id.filter(|id| !id.is_empty() && *id != SYSTEM_DEFAULT_OUTPUT) else {
        return host.default_output_device()
            .ok_or(ResolveError::NoDefault);
    };
    let requested: cpal::DeviceId = id.parse()
        .map_err(|_| ResolveError::Invalid)?;
    #[cfg(target_os = "linux")]
    {
        if requested.host() != cpal::HostId::PipeWire || requested.id().is_empty()
            || matches!(requested.id(), "sink_default" | "output_default" | "input_default") {
            return Err(ResolveError::Invalid);
        }
        verify_selected_pipewire_sink(requested.id())?;
    }
    #[cfg(target_os = "android")]
    if requested.host() != cpal::HostId::AAudio || requested.id() == "-1" || requested.id().parse::<i32>().is_err() {
        return Err(ResolveError::Invalid);
    }
    #[cfg(target_os = "macos")]
    if requested.host() != cpal::HostId::CoreAudio {
        return Err(ResolveError::Invalid);
    }
    let mut matched = None;
    for device in host.output_devices()
        .map_err(|error| ResolveError::Inventory(format!("Could not list native output devices: {error}")))? {
        if device.id().ok().as_ref() == Some(&requested) {
            if matched.is_some() {
                return Err(ResolveError::Inventory("Selected output identity is duplicated.".to_string()));
            }
            matched = Some(device);
        }
    }
    matched.ok_or(ResolveError::Missing)
}

#[cfg(target_os = "ios")]
pub fn resolve(id: Option<&str>) -> Result<cpal::Device, ResolveError> {
    if id.is_some_and(|id| !id.is_empty() && id != SYSTEM_DEFAULT_OUTPUT) {
        return Err(ResolveError::Invalid);
    }
    super::native_cpal_host().map_err(ResolveError::Inventory)?
        .default_output_device().ok_or(ResolveError::NoDefault)
}

#[cfg(any(target_os = "linux", test))]
#[derive(Clone, Debug, PartialEq, Eq)]
struct PipeWireSink {
    id: String,
    node_name: String,
    is_default: bool,
}

#[cfg(any(target_os = "linux", test))]
fn parse_wpctl_sinks(output: &str) -> Result<Vec<PipeWireSink>, String> {
    let mut seen_ids = std::collections::HashSet::new();
    let mut seen_names = std::collections::HashSet::new();
    let mut default_count = 0;
    let mut sinks = Vec::new();
    for line in output.lines() {
        let fields: Vec<_> = line.split('\t').collect();
        let [id, node_name, kind, marker] = fields.as_slice() else {
            return Err("Could not parse wpctl audio sinks.".to_string());
        };
        if id.is_empty() || !id.bytes().all(|byte| byte.is_ascii_digit()) || node_name.is_empty()
            || *kind != "audio/sink" || !matches!(*marker, "*" | " ")
            || !seen_ids.insert(*id) || !seen_names.insert(*node_name) {
            return Err("wpctl returned an invalid or duplicate audio sink.".to_string());
        }
        default_count += usize::from(*marker == "*");
        sinks.push(PipeWireSink { id: (*id).to_string(), node_name: (*node_name).to_string(), is_default: *marker == "*" });
    }
    if default_count > 1 { return Err("Default PipeWire output identity is duplicated.".to_string()); }
    Ok(sinks)
}

#[cfg(any(target_os = "linux", test))]
fn verify_wpctl_sink_inspect(output: &str, expected_id: &str, expected_name: &str) -> Result<(), String> {
    let mut id_matches = false;
    let mut name = None;
    let mut media_class = None;
    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("id ") && trimmed.contains("PipeWire:Interface:Node") {
            id_matches = trimmed.strip_prefix("id ").and_then(|rest| rest.split_once(','))
                .is_some_and(|(id, _)| id == expected_id);
        }
        if let Some((key, value)) = trimmed.split_once('=') {
            let value = value.trim().trim_matches('"');
            match key.trim().trim_start_matches('*').trim() {
                "node.name" => name = Some(value),
                "media.class" => media_class = Some(value),
                _ => {}
            }
        }
    }
    if !id_matches || name != Some(expected_name) || media_class != Some("Audio/Sink") {
        return Err("wpctl sink identity changed or is not an audio output.".to_string());
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn verified_pipewire_sinks() -> Result<std::collections::HashMap<String, bool>, String> {
    let output = super::system_input::run_host_audio_command("wpctl", &["list", "audio", "sinks"])?;
    let sinks = parse_wpctl_sinks(&output)?;
    let mut verified = std::collections::HashMap::new();
    for sink in sinks {
        let inspect = super::system_input::run_host_audio_command("wpctl", &["inspect", &sink.id])?;
        if verify_wpctl_sink_inspect(&inspect, &sink.id, &sink.node_name).is_ok() {
            verified.insert(sink.node_name, sink.is_default);
        }
    }
    Ok(verified)
}

#[cfg(target_os = "linux")]
fn verify_selected_pipewire_sink(node_name: &str) -> Result<(), ResolveError> {
    if verified_pipewire_sinks().map_err(ResolveError::Inventory)?.contains_key(node_name) { Ok(()) }
    else { Err(ResolveError::Missing) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_exact_sinks_and_rejects_streams_or_duplicates() {
        let sinks = parse_wpctl_sinks("45\talsa_output.usb:é \taudio/sink\t*\n53\talsa_output.other\taudio/sink\t ").unwrap();
        assert_eq!(sinks[0].node_name, "alsa_output.usb:é ");
        assert_eq!(sinks[1].id, "53");
        assert!(parse_wpctl_sinks("45\tstream.playback\tstream/output/audio\t ").is_err());
        assert!(parse_wpctl_sinks("45\tfirst\taudio/sink\t \n45\tsecond\taudio/sink\t ").is_err());
        assert!(parse_wpctl_sinks("45\tfirst\taudio/sink\t \n53\tfirst\taudio/sink\t ").is_err());
    }

    #[test]
    fn verifies_sink_identity_and_class() {
        let inspect = "id 45, type PipeWire:Interface:Node\n  node.name = \"alsa_output.usb:é \"\n  media.class = \"Audio/Sink\"";
        assert!(verify_wpctl_sink_inspect(inspect, "45", "alsa_output.usb:é ").is_ok());
        assert!(verify_wpctl_sink_inspect(inspect, "45", "alsa_output.other").is_err());
        assert!(verify_wpctl_sink_inspect(&inspect.replace("Audio/Sink", "Audio/Source"), "45", "alsa_output.usb:é ").is_err());
    }

    #[test]
    fn selected_loss_latches_default_without_erasing_preference() {
        let mut route = OutputRouteState::default();
        route.select(Some("pipewire:alsa_output.usb:é ".to_string()));
        assert_eq!(route.target_device_id(), Some("pipewire:alsa_output.usb:é "));
        route.activate();
        assert_eq!(route.snapshot().status, OutputRouteStatus::Selected);
        assert!(route.fallback_to_default());
        route.activate();
        assert_eq!(route.target_device_id(), None);
        assert_eq!(route.snapshot().preferred_device_id.as_deref(), Some("pipewire:alsa_output.usb:é "));
        assert_eq!(route.snapshot().status, OutputRouteStatus::FallbackDefault);
        assert!(!route.fallback_to_default());
        assert!(route.same_preference(Some("pipewire:alsa_output.usb:é ")));
        route.select(Some("pipewire:alsa_output.usb:é ".to_string()));
        assert!(!route.snapshot().fallback_latched);
    }
}
