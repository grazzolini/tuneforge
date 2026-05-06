use serde::Serialize;

#[cfg(target_os = "linux")]
use std::process::Command;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemDefaultInputVolume {
    supported: bool,
    volume_percent: Option<u8>,
    muted: Option<bool>,
    backend: Option<&'static str>,
    error: Option<String>,
}

impl SystemDefaultInputVolume {
    #[cfg(not(target_os = "android"))]
    fn supported(volume_percent: u8, muted: Option<bool>, backend: &'static str) -> Self {
        Self {
            supported: true,
            volume_percent: Some(volume_percent.min(100)),
            muted,
            backend: Some(backend),
            error: None,
        }
    }

    fn unsupported(error: impl Into<String>) -> Self {
        Self {
            supported: false,
            volume_percent: None,
            muted: None,
            backend: None,
            error: Some(error.into()),
        }
    }
}

#[tauri::command]
pub fn get_system_default_input_volume() -> SystemDefaultInputVolume {
    read_system_default_input_volume()
}

#[tauri::command]
pub fn set_system_default_input_volume(volume_percent: i32) -> SystemDefaultInputVolume {
    write_system_default_input_volume(clamp_input_volume_percent(volume_percent))
}

#[cfg(target_os = "linux")]
fn run_host_audio_command(binary: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new(binary)
        .args(args)
        .output()
        .map_err(|error| format!("{binary} is unavailable: {error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("{binary} exited with status {}", output.status)
        } else {
            stderr
        });
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg(any(target_os = "linux", test))]
fn parse_percent(value: &str) -> Option<u8> {
    let parsed = value.trim().parse::<f32>().ok()?;
    if !parsed.is_finite() {
        return None;
    }
    Some(parsed.round().clamp(0.0, 100.0) as u8)
}

fn clamp_input_volume_percent(value: i32) -> u8 {
    value.clamp(0, 100) as u8
}

#[cfg(any(target_os = "linux", test))]
fn parse_wpctl_volume(output: &str) -> Option<(u8, bool)> {
    let muted = output.contains("[MUTED]");
    let raw_volume = output.split("Volume:").nth(1)?.split_whitespace().next()?;
    let parsed = raw_volume.parse::<f32>().ok()?;
    if !parsed.is_finite() {
        return None;
    }
    Some(((parsed * 100.0).round().clamp(0.0, 100.0) as u8, muted))
}

#[cfg(any(target_os = "linux", test))]
fn parse_first_percent(output: &str) -> Option<u8> {
    let percent_index = output.find('%')?;
    let prefix = &output[..percent_index];
    let digits_start = prefix
        .rfind(|character: char| !character.is_ascii_digit())
        .map_or(0, |index| index + 1);
    parse_percent(&prefix[digits_start..])
}

#[cfg(any(target_os = "linux", test))]
fn parse_pactl_mute(output: &str) -> Option<bool> {
    let normalized = output.trim().to_ascii_lowercase();
    if normalized.ends_with("yes") {
        return Some(true);
    }
    if normalized.ends_with("no") {
        return Some(false);
    }
    None
}

#[cfg(target_os = "macos")]
mod macos_system_audio {
    use super::SystemDefaultInputVolume;
    use std::{ffi::c_void, mem, ptr};

    type AudioObjectID = u32;
    type AudioObjectPropertySelector = u32;
    type AudioObjectPropertyScope = u32;
    type AudioObjectPropertyElement = u32;
    type OSStatus = i32;

    #[allow(non_snake_case)]
    #[derive(Clone, Copy)]
    #[repr(C)]
    struct AudioObjectPropertyAddress {
        mSelector: AudioObjectPropertySelector,
        mScope: AudioObjectPropertyScope,
        mElement: AudioObjectPropertyElement,
    }

    pub(super) const fn fourcc(bytes: &[u8; 4]) -> u32 {
        u32::from_be_bytes(*bytes)
    }

    const NO_ERR: OSStatus = 0;
    const K_AUDIO_OBJECT_SYSTEM_OBJECT: AudioObjectID = 1;
    const K_AUDIO_HARDWARE_PROPERTY_DEFAULT_INPUT_DEVICE: u32 = fourcc(b"dIn ");
    const K_AUDIO_DEVICE_PROPERTY_VOLUME_SCALAR: u32 = fourcc(b"volm");
    const K_AUDIO_DEVICE_PROPERTY_MUTE: u32 = fourcc(b"mute");
    const K_AUDIO_OBJECT_PROPERTY_SCOPE_GLOBAL: u32 = fourcc(b"glob");
    const K_AUDIO_OBJECT_PROPERTY_SCOPE_INPUT: u32 = fourcc(b"inpt");
    const K_AUDIO_OBJECT_PROPERTY_ELEMENT_MAIN: u32 = 0;

    #[link(name = "CoreAudio", kind = "framework")]
    extern "C" {
        fn AudioObjectHasProperty(
            in_object_id: AudioObjectID,
            in_address: *const AudioObjectPropertyAddress,
        ) -> u8;
        fn AudioObjectIsPropertySettable(
            in_object_id: AudioObjectID,
            in_address: *const AudioObjectPropertyAddress,
            out_is_settable: *mut u8,
        ) -> OSStatus;
        fn AudioObjectGetPropertyData(
            in_object_id: AudioObjectID,
            in_address: *const AudioObjectPropertyAddress,
            in_qualifier_data_size: u32,
            in_qualifier_data: *const c_void,
            io_data_size: *mut u32,
            out_data: *mut c_void,
        ) -> OSStatus;
        fn AudioObjectSetPropertyData(
            in_object_id: AudioObjectID,
            in_address: *const AudioObjectPropertyAddress,
            in_qualifier_data_size: u32,
            in_qualifier_data: *const c_void,
            in_data_size: u32,
            in_data: *const c_void,
        ) -> OSStatus;
    }

    pub(super) fn read() -> SystemDefaultInputVolume {
        match read_default_input_device_volume() {
            Ok((volume_percent, muted)) => {
                SystemDefaultInputVolume::supported(volume_percent, muted, "macos-coreaudio")
            }
            Err(error) => SystemDefaultInputVolume::unsupported(format!(
                "Could not read macOS default input volume with CoreAudio: {error}"
            )),
        }
    }

    pub(super) fn write(volume_percent: u8) -> SystemDefaultInputVolume {
        match set_default_input_device_volume(volume_percent) {
            Ok(()) => read(),
            Err(error) => SystemDefaultInputVolume::unsupported(format!(
                "Could not set macOS default input volume with CoreAudio: {error}"
            )),
        }
    }

    fn read_default_input_device_volume() -> Result<(u8, Option<bool>), String> {
        let device_id = default_input_device()?;
        let volume = read_input_volume_percent(device_id)?;
        let muted = read_input_mute(device_id);
        Ok((volume, muted))
    }

    fn set_default_input_device_volume(volume_percent: u8) -> Result<(), String> {
        let device_id = default_input_device()?;
        let scalar = f32::from(volume_percent) / 100.0;
        let mut wrote_volume = false;

        for address in volume_addresses() {
            if !is_property_settable(device_id, &address) {
                continue;
            }
            set_property_data(device_id, &address, &scalar).map_err(|status| {
                format!(
                    "CoreAudio returned status {status} while setting input volume element {}.",
                    address.mElement
                )
            })?;
            wrote_volume = true;
        }

        if !wrote_volume {
            return Err("default input device does not expose a settable volume.".to_string());
        }

        if volume_percent > 0 {
            let unmuted: u32 = 0;
            for address in mute_addresses() {
                if is_property_settable(device_id, &address) {
                    let _ = set_property_data(device_id, &address, &unmuted);
                }
            }
        }

        Ok(())
    }

    fn default_input_device() -> Result<AudioObjectID, String> {
        let address = property_address(
            K_AUDIO_HARDWARE_PROPERTY_DEFAULT_INPUT_DEVICE,
            K_AUDIO_OBJECT_PROPERTY_SCOPE_GLOBAL,
            K_AUDIO_OBJECT_PROPERTY_ELEMENT_MAIN,
        );
        let device_id = get_property_data::<AudioObjectID>(K_AUDIO_OBJECT_SYSTEM_OBJECT, &address)
            .map_err(|status| {
                format!("CoreAudio returned status {status} for the default input device.")
            })?;
        if device_id == 0 {
            return Err("no default input device is available.".to_string());
        }
        Ok(device_id)
    }

    fn read_input_volume_percent(device_id: AudioObjectID) -> Result<u8, String> {
        for address in volume_addresses() {
            if !has_property(device_id, &address) {
                continue;
            }
            if let Ok(volume) = get_property_data::<f32>(device_id, &address) {
                if volume.is_finite() {
                    return Ok((volume * 100.0).round().clamp(0.0, 100.0) as u8);
                }
            }
        }

        Err("default input device does not expose a readable volume.".to_string())
    }

    fn read_input_mute(device_id: AudioObjectID) -> Option<bool> {
        for address in mute_addresses() {
            if !has_property(device_id, &address) {
                continue;
            }
            if let Ok(muted) = get_property_data::<u32>(device_id, &address) {
                return Some(muted != 0);
            }
        }

        None
    }

    fn volume_addresses() -> [AudioObjectPropertyAddress; 9] {
        input_channel_addresses(K_AUDIO_DEVICE_PROPERTY_VOLUME_SCALAR)
    }

    fn mute_addresses() -> [AudioObjectPropertyAddress; 9] {
        input_channel_addresses(K_AUDIO_DEVICE_PROPERTY_MUTE)
    }

    fn input_channel_addresses(
        selector: AudioObjectPropertySelector,
    ) -> [AudioObjectPropertyAddress; 9] {
        [
            property_address(
                selector,
                K_AUDIO_OBJECT_PROPERTY_SCOPE_INPUT,
                K_AUDIO_OBJECT_PROPERTY_ELEMENT_MAIN,
            ),
            property_address(selector, K_AUDIO_OBJECT_PROPERTY_SCOPE_INPUT, 1),
            property_address(selector, K_AUDIO_OBJECT_PROPERTY_SCOPE_INPUT, 2),
            property_address(selector, K_AUDIO_OBJECT_PROPERTY_SCOPE_INPUT, 3),
            property_address(selector, K_AUDIO_OBJECT_PROPERTY_SCOPE_INPUT, 4),
            property_address(selector, K_AUDIO_OBJECT_PROPERTY_SCOPE_INPUT, 5),
            property_address(selector, K_AUDIO_OBJECT_PROPERTY_SCOPE_INPUT, 6),
            property_address(selector, K_AUDIO_OBJECT_PROPERTY_SCOPE_INPUT, 7),
            property_address(selector, K_AUDIO_OBJECT_PROPERTY_SCOPE_INPUT, 8),
        ]
    }

    fn property_address(
        selector: AudioObjectPropertySelector,
        scope: AudioObjectPropertyScope,
        element: AudioObjectPropertyElement,
    ) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress {
            mSelector: selector,
            mScope: scope,
            mElement: element,
        }
    }

    fn has_property(object_id: AudioObjectID, address: &AudioObjectPropertyAddress) -> bool {
        unsafe { AudioObjectHasProperty(object_id, address) != 0 }
    }

    fn is_property_settable(
        object_id: AudioObjectID,
        address: &AudioObjectPropertyAddress,
    ) -> bool {
        if !has_property(object_id, address) {
            return false;
        }

        let mut settable = 0u8;
        let status = unsafe { AudioObjectIsPropertySettable(object_id, address, &mut settable) };
        status == NO_ERR && settable != 0
    }

    fn get_property_data<T: Copy>(
        object_id: AudioObjectID,
        address: &AudioObjectPropertyAddress,
    ) -> Result<T, OSStatus> {
        let mut value = mem::MaybeUninit::<T>::uninit();
        let mut data_size = mem::size_of::<T>() as u32;
        let status = unsafe {
            AudioObjectGetPropertyData(
                object_id,
                address,
                0,
                ptr::null(),
                &mut data_size,
                value.as_mut_ptr().cast::<c_void>(),
            )
        };
        if status != NO_ERR {
            return Err(status);
        }
        if data_size < mem::size_of::<T>() as u32 {
            return Err(-1);
        }

        Ok(unsafe { value.assume_init() })
    }

    fn set_property_data<T>(
        object_id: AudioObjectID,
        address: &AudioObjectPropertyAddress,
        value: &T,
    ) -> Result<(), OSStatus> {
        let status = unsafe {
            AudioObjectSetPropertyData(
                object_id,
                address,
                0,
                ptr::null(),
                mem::size_of::<T>() as u32,
                (value as *const T).cast::<c_void>(),
            )
        };
        if status == NO_ERR {
            Ok(())
        } else {
            Err(status)
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn fourcc_constants_use_core_audio_byte_order() {
            assert_eq!(fourcc(b"dIn "), 0x6449_6e20);
            assert_eq!(fourcc(b"volm"), 0x766f_6c6d);
        }
    }
}

#[cfg(target_os = "macos")]
fn read_system_default_input_volume() -> SystemDefaultInputVolume {
    macos_system_audio::read()
}

#[cfg(target_os = "macos")]
fn write_system_default_input_volume(volume_percent: u8) -> SystemDefaultInputVolume {
    macos_system_audio::write(volume_percent)
}

#[cfg(target_os = "linux")]
fn read_wpctl_default_input_volume() -> Result<SystemDefaultInputVolume, String> {
    let output = run_host_audio_command("wpctl", &["get-volume", "@DEFAULT_AUDIO_SOURCE@"])?;
    let (volume_percent, muted) = parse_wpctl_volume(&output)
        .ok_or_else(|| "Could not parse wpctl default input volume.".to_string())?;
    Ok(SystemDefaultInputVolume::supported(
        volume_percent,
        Some(muted),
        "linux-wpctl",
    ))
}

#[cfg(target_os = "linux")]
fn read_pactl_default_input_volume() -> Result<SystemDefaultInputVolume, String> {
    let volume_output =
        run_host_audio_command("pactl", &["get-source-volume", "@DEFAULT_SOURCE@"])?;
    let volume_percent = parse_first_percent(&volume_output)
        .ok_or_else(|| "Could not parse pactl default source volume.".to_string())?;
    let muted = run_host_audio_command("pactl", &["get-source-mute", "@DEFAULT_SOURCE@"])
        .ok()
        .and_then(|output| parse_pactl_mute(&output));
    Ok(SystemDefaultInputVolume::supported(
        volume_percent,
        muted,
        "linux-pactl",
    ))
}

#[cfg(target_os = "linux")]
fn read_system_default_input_volume() -> SystemDefaultInputVolume {
    read_wpctl_default_input_volume()
        .or_else(|wpctl_error| {
            read_pactl_default_input_volume().map_err(|pactl_error| {
                format!(
                    "Could not read default input volume with wpctl ({wpctl_error}) or pactl ({pactl_error})."
                )
            })
        })
        .unwrap_or_else(SystemDefaultInputVolume::unsupported)
}

#[cfg(target_os = "linux")]
fn write_wpctl_default_input_volume(
    volume_percent: u8,
) -> Result<SystemDefaultInputVolume, String> {
    let volume = format!("{volume_percent}%");
    run_host_audio_command("wpctl", &["set-mute", "@DEFAULT_AUDIO_SOURCE@", "0"])?;
    run_host_audio_command("wpctl", &["set-volume", "@DEFAULT_AUDIO_SOURCE@", &volume])?;
    read_wpctl_default_input_volume()
}

#[cfg(target_os = "linux")]
fn write_pactl_default_input_volume(
    volume_percent: u8,
) -> Result<SystemDefaultInputVolume, String> {
    let volume = format!("{volume_percent}%");
    run_host_audio_command("pactl", &["set-source-mute", "@DEFAULT_SOURCE@", "0"])?;
    run_host_audio_command("pactl", &["set-source-volume", "@DEFAULT_SOURCE@", &volume])?;
    read_pactl_default_input_volume()
}

#[cfg(target_os = "linux")]
fn write_system_default_input_volume(volume_percent: u8) -> SystemDefaultInputVolume {
    write_wpctl_default_input_volume(volume_percent)
        .or_else(|wpctl_error| {
            write_pactl_default_input_volume(volume_percent).map_err(|pactl_error| {
                format!(
                    "Could not set default input volume with wpctl ({wpctl_error}) or pactl ({pactl_error})."
                )
            })
        })
        .unwrap_or_else(SystemDefaultInputVolume::unsupported)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn read_system_default_input_volume() -> SystemDefaultInputVolume {
    SystemDefaultInputVolume::unsupported(
        "System input volume control is only available on macOS and Linux.",
    )
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn write_system_default_input_volume(_volume_percent: u8) -> SystemDefaultInputVolume {
    read_system_default_input_volume()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamps_input_volume_command_values() {
        assert_eq!(clamp_input_volume_percent(-20), 0);
        assert_eq!(clamp_input_volume_percent(87), 87);
        assert_eq!(clamp_input_volume_percent(160), 100);
    }

    #[test]
    fn parses_wpctl_volume_and_mute_state() {
        assert_eq!(parse_wpctl_volume("Volume: 0.37"), Some((37, false)));
        assert_eq!(parse_wpctl_volume("Volume: 0.82 [MUTED]"), Some((82, true)));
    }

    #[test]
    fn parses_pactl_volume_and_mute_state() {
        assert_eq!(
            parse_first_percent(
                "Volume: front-left: 49152 / 75% / -7.50 dB, front-right: 49152 / 75% / -7.50 dB",
            ),
            Some(75),
        );
        assert_eq!(parse_pactl_mute("Mute: yes"), Some(true));
        assert_eq!(parse_pactl_mute("Mute: no"), Some(false));
    }
}
