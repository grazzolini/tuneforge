use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fmt;

#[cfg(any(target_os = "android", target_os = "ios", target_os = "linux", target_os = "macos"))]
use cpal::traits::{DeviceTrait, HostTrait};

pub const SYSTEM_DEFAULT_OUTPUT: &str = "default";

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum RouteSelection {
    #[default]
    Inherit,
    SystemDefault,
    ExplicitDevice {
        #[serde(rename = "deviceId")]
        device_id: String,
    },
}

impl RouteSelection {
    fn validate(&self) -> Result<(), &'static str> {
        if let Self::ExplicitDevice { device_id } = self {
            if device_id.trim().is_empty() || device_id == SYSTEM_DEFAULT_OUTPUT {
                return Err("invalid_output_route");
            }
            if cfg!(target_os = "ios") {
                return Err("output_selection_unsupported");
            }
        }
        Ok(())
    }

    fn resolve<'a>(&'a self, inherited: Option<&'a str>) -> Option<&'a str> {
        match self {
            Self::Inherit => inherited,
            Self::SystemDefault => None,
            Self::ExplicitDevice { device_id } => Some(device_id),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaneRouteSelection {
    pub lane_id: String,
    #[serde(default)]
    pub parent_lane_id: Option<String>,
    #[serde(default)]
    pub selection: RouteSelection,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputRoutingRequest {
    #[serde(default)]
    pub project: RouteSelection,
    #[serde(default)]
    pub cue: RouteSelection,
    #[serde(default)]
    pub lanes: Vec<LaneRouteSelection>,
}

impl OutputRoutingRequest {
    pub fn validate(&self) -> Result<(), &'static str> {
        self.project.validate()?;
        self.cue.validate()?;
        let mut seen = HashSet::new();
        for lane in &self.lanes {
            if lane.lane_id.is_empty() || !seen.insert(lane.lane_id.as_str()) {
                return Err("invalid_output_route");
            }
            lane.selection.validate()?;
            if lane.parent_lane_id.as_deref() == Some(&lane.lane_id) {
                return Err("invalid_output_route");
            }
        }
        for lane in &self.lanes {
            if let Some(parent) = lane.parent_lane_id.as_deref() {
                if !seen.contains(parent) {
                    return Err("invalid_output_route");
                }
                let mut ancestor = Some(parent);
                let mut visited = HashSet::new();
                while let Some(id) = ancestor {
                    if !visited.insert(id) {
                        return Err("invalid_output_route");
                    }
                    ancestor = self
                        .lanes
                        .iter()
                        .find(|route| route.lane_id == id)
                        .and_then(|route| route.parent_lane_id.as_deref());
                }
            }
        }
        Ok(())
    }

    pub fn preferred_for_lane<'a>(
        &'a self,
        lane_id: &str,
        global: Option<&'a str>,
    ) -> Option<&'a str> {
        let project = self.project.resolve(global);
        let routes: HashMap<_, _> = self
            .lanes
            .iter()
            .map(|route| (route.lane_id.as_str(), route))
            .collect();
        let mut chain = Vec::new();
        let mut current = Some(lane_id);
        while let Some(id) = current {
            let Some(route) = routes.get(id) else {
                break;
            };
            chain.push(&route.selection);
            current = route.parent_lane_id.as_deref();
        }
        chain
            .iter()
            .rev()
            .fold(project, |inherited, selection| selection.resolve(inherited))
    }

    pub fn preferred_for_cue<'a>(
        &'a self,
        global: Option<&'a str>,
        follow_playback: bool,
    ) -> Option<&'a str> {
        let project = self.project.resolve(global);
        if follow_playback {
            self.cue.resolve(project)
        } else {
            global
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DestinationRouteSnapshot {
    pub selection: RouteSelection,
    pub preferred_device_id: Option<String>,
    pub effective_device_id: Option<String>,
    pub status: OutputRouteStatus,
    pub fallback_latched: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaneRouteSnapshot {
    pub lane_id: String,
    #[serde(flatten)]
    pub route: DestinationRouteSnapshot,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputRoutingSnapshot {
    pub project: DestinationRouteSnapshot,
    pub cue: DestinationRouteSnapshot,
    pub lanes: Vec<LaneRouteSnapshot>,
    pub generation: u64,
}

#[derive(Clone, Debug, Default)]
pub struct OutputRoutingState {
    request: OutputRoutingRequest,
    project: OutputRouteState,
    cue: OutputRouteState,
    lanes: HashMap<String, OutputRouteState>,
    generation: u64,
}

impl OutputRoutingState {
    pub fn select(
        &mut self,
        request: OutputRoutingRequest,
        global: &OutputRouteState,
    ) -> Result<(), &'static str> {
        request.validate()?;
        self.request = request;
        self.project = OutputRouteState::default();
        self.cue = OutputRouteState::default();
        self.lanes.clear();
        self.recompute(global);
        Ok(())
    }

    pub fn update_metadata(
        &mut self,
        request: OutputRoutingRequest,
        global: &OutputRouteState,
    ) -> Result<(), &'static str> {
        request.validate()?;
        self.request = request;
        self.recompute(global);
        Ok(())
    }

    pub fn retry(&mut self, global: &OutputRouteState) {
        let request = self.request.clone();
        self.select(request, global)
            .expect("retained output routing is validated");
    }

    pub fn recompute(&mut self, global: &OutputRouteState) {
        let global_preferred = global.preferred_device_id();
        let project = self.request.project.resolve(global_preferred);
        if !self.project.same_preference(project) {
            self.project.select(project.map(str::to_string));
        }
        let cue = self.request.cue.resolve(project);
        if !self.cue.same_preference(cue) {
            self.cue.select(cue.map(str::to_string));
        }
        self.lanes
            .retain(|id, _| self.request.lanes.iter().any(|route| route.lane_id == *id));
        for lane in &self.request.lanes {
            let preferred = self
                .request
                .preferred_for_lane(&lane.lane_id, global_preferred);
            let state = self.lanes.entry(lane.lane_id.clone()).or_default();
            if !state.same_preference(preferred) {
                state.select(preferred.map(str::to_string));
            }
        }
        self.generation = self.generation.wrapping_add(1).max(1);
    }

    pub fn request(&self) -> &OutputRoutingRequest {
        &self.request
    }

    pub fn route_for_lane(&self, lane_id: &str) -> &OutputRouteState {
        self.lanes.get(lane_id).unwrap_or(&self.project)
    }

    pub fn route_for_lane_mut(&mut self, lane_id: &str) -> &mut OutputRouteState {
        self.lanes.get_mut(lane_id).unwrap_or(&mut self.project)
    }

    pub fn project(&self) -> &OutputRouteState {
        &self.project
    }
    pub fn cue(&self) -> &OutputRouteState {
        &self.cue
    }
    pub fn cue_mut(&mut self) -> &mut OutputRouteState {
        &mut self.cue
    }

    pub fn unavailable_all(&mut self) {
        self.project.unavailable();
        self.cue.unavailable();
        for route in self.lanes.values_mut() {
            route.unavailable();
        }
    }

    pub fn snapshot(&self) -> OutputRoutingSnapshot {
        let destination =
            |selection: &RouteSelection, route: &OutputRouteState| DestinationRouteSnapshot {
                selection: selection.clone(),
                preferred_device_id: route.preferred_device_id.clone(),
                effective_device_id: route.active_device_id.clone(),
                status: route.status,
                fallback_latched: route.fallback_latched,
            };
        let mut lanes = self
            .request
            .lanes
            .iter()
            .map(|lane| LaneRouteSnapshot {
                lane_id: lane.lane_id.clone(),
                route: destination(&lane.selection, self.route_for_lane(&lane.lane_id)),
            })
            .collect::<Vec<_>>();
        lanes.sort_by(|left, right| left.lane_id.cmp(&right.lane_id));
        OutputRoutingSnapshot {
            project: destination(&self.request.project, &self.project),
            cue: destination(&self.request.cue, &self.cue),
            lanes,
            generation: self.generation,
        }
    }
}

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

    #[test]
    fn routing_inherits_project_and_drum_parent_with_explicit_child_override() {
        let mut global = OutputRouteState::default();
        global.select(Some("global".into()));
        let request = OutputRoutingRequest {
            project: RouteSelection::ExplicitDevice {
                device_id: "project".into(),
            },
            cue: RouteSelection::Inherit,
            lanes: vec![
                LaneRouteSelection {
                    lane_id: "drums".into(),
                    parent_lane_id: None,
                    selection: RouteSelection::ExplicitDevice {
                        device_id: "drum-output".into(),
                    },
                },
                LaneRouteSelection {
                    lane_id: "kick".into(),
                    parent_lane_id: Some("drums".into()),
                    selection: RouteSelection::Inherit,
                },
                LaneRouteSelection {
                    lane_id: "snare".into(),
                    parent_lane_id: Some("drums".into()),
                    selection: RouteSelection::SystemDefault,
                },
            ],
        };
        let mut routing = OutputRoutingState::default();
        routing.select(request, &global).unwrap();
        assert_eq!(routing.project().target_device_id(), Some("project"));
        assert_eq!(routing.cue().target_device_id(), Some("project"));
        assert_eq!(
            routing.route_for_lane("source").target_device_id(),
            Some("project")
        );
        assert_eq!(
            routing.route_for_lane("kick").target_device_id(),
            Some("drum-output")
        );
        assert_eq!(routing.route_for_lane("snare").target_device_id(), None);
    }

    #[test]
    fn invalid_parent_cycle_and_explicit_default_id_are_rejected() {
        let mut request = OutputRoutingRequest {
            lanes: vec![
                LaneRouteSelection {
                    lane_id: "a".into(),
                    parent_lane_id: Some("b".into()),
                    selection: RouteSelection::Inherit,
                },
                LaneRouteSelection {
                    lane_id: "b".into(),
                    parent_lane_id: Some("a".into()),
                    selection: RouteSelection::Inherit,
                },
            ],
            ..Default::default()
        };
        assert_eq!(request.validate(), Err("invalid_output_route"));
        request.lanes.clear();
        request.project = RouteSelection::ExplicitDevice {
            device_id: "default".into(),
        };
        assert_eq!(request.validate(), Err("invalid_output_route"));
    }

    #[test]
    fn fallback_stays_latched_until_an_explicit_routing_attempt() {
        let mut global = OutputRouteState::default();
        global.select(Some("global".into()));
        let request = OutputRoutingRequest {
            project: RouteSelection::ExplicitDevice {
                device_id: "speaker".into(),
            },
            ..Default::default()
        };
        let mut routing = OutputRoutingState::default();
        routing.select(request.clone(), &global).unwrap();
        assert!(routing.project.fallback_to_default());
        routing.project.activate();
        assert_eq!(routing.project.target_device_id(), None);
        assert_eq!(
            routing.project.snapshot().preferred_device_id.as_deref(),
            Some("speaker")
        );
        routing.recompute(&global);
        assert_eq!(routing.project.target_device_id(), None);
        assert_eq!(
            routing.project.snapshot().status,
            OutputRouteStatus::FallbackDefault
        );
        routing.select(request, &global).unwrap();
        assert_eq!(routing.project.target_device_id(), Some("speaker"));
        assert_eq!(
            routing.project.snapshot().status,
            OutputRouteStatus::Pending
        );
    }

    #[test]
    fn independent_project_and_cue_fallbacks_preserve_their_preferences() {
        let global = OutputRouteState::default();
        let mut routing = OutputRoutingState::default();
        routing
            .select(
                OutputRoutingRequest {
                    project: RouteSelection::ExplicitDevice {
                        device_id: "project".into(),
                    },
                    cue: RouteSelection::ExplicitDevice {
                        device_id: "cue".into(),
                    },
                    ..Default::default()
                },
                &global,
            )
            .unwrap();
        assert!(routing.cue_mut().fallback_to_default());
        assert_eq!(routing.project().target_device_id(), Some("project"));
        assert_eq!(routing.cue().target_device_id(), None);
        assert_eq!(
            routing.cue().snapshot().preferred_device_id.as_deref(),
            Some("cue")
        );
        routing.cue_mut().unavailable();
        assert_eq!(
            routing.cue().snapshot().status,
            OutputRouteStatus::Unavailable
        );
    }

    #[test]
    fn explicit_device_selection_uses_camel_case_ipc_field_in_both_directions() {
        let selection = RouteSelection::ExplicitDevice {
            device_id: "coreaudio:42".into(),
        };
        let wire = serde_json::to_value(&selection).unwrap();
        assert_eq!(
            wire,
            serde_json::json!({ "kind": "explicit-device", "deviceId": "coreaudio:42" })
        );
        let decoded: RouteSelection = serde_json::from_value(wire).unwrap();
        assert_eq!(decoded, selection);
    }
}
