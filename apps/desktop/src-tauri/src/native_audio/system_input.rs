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
pub fn get_system_default_input_volume(device_id: Option<String>) -> SystemDefaultInputVolume {
    read_system_input_volume(device_id.as_deref())
}

#[tauri::command]
pub fn set_system_default_input_volume(
    volume_percent: i32,
    device_id: Option<String>,
) -> SystemDefaultInputVolume {
    write_system_input_volume(
        clamp_input_volume_percent(volume_percent),
        device_id.as_deref(),
    )
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

    Ok(String::from_utf8_lossy(&output.stdout)
        .trim_end_matches(['\n', '\r'])
        .to_string())
}

fn clamp_input_volume_percent(value: i32) -> u8 {
    value.clamp(0, 100) as u8
}

fn is_default_input_device_id(device_id: Option<&str>) -> bool {
    device_id
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "default")
        .is_none()
}

#[cfg(any(target_os = "macos", test))]
fn native_input_device_hash(device_id: &str) -> Option<u64> {
    let mut parts = device_id.split(':');
    if parts.next()? != "cpal" {
        return None;
    }
    let _index = parts.next()?;
    u64::from_str_radix(parts.next()?, 16).ok()
}

#[cfg(any(target_os = "macos", test))]
fn stable_name_hash(value: &str) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
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
#[derive(Debug, PartialEq, Eq)]
struct WpctlSource {
    id: String,
    node_name: String,
    is_default: bool,
}

#[cfg(any(target_os = "linux", test))]
fn parse_wpctl_sources(output: &str) -> Result<Vec<WpctlSource>, String> {
    let sources: Vec<WpctlSource> = output
        .lines()
        .map(|line| {
            let fields = line.split('\t').collect::<Vec<_>>();
            let [id, node_name, kind, default] = fields.as_slice() else {
                return Err("Could not parse wpctl audio sources.".to_string());
            };
            if id.is_empty()
                || !id.bytes().all(|byte| byte.is_ascii_digit())
                || node_name.is_empty()
                || *kind != "audio/source"
                || !matches!(*default, "*" | " ")
            {
                return Err("wpctl returned an invalid audio source.".to_string());
            }
            Ok(WpctlSource {
                id: (*id).to_string(),
                node_name: (*node_name).to_string(),
                is_default: *default == "*",
            })
        })
        .collect::<Result<_, String>>()?;
    let mut seen_ids = std::collections::HashSet::new();
    let mut seen_names = std::collections::HashSet::new();
    for source in &sources {
        if !seen_ids.insert(&source.id) || !seen_names.insert(&source.node_name) {
            return Err("PipeWire microphone identity is duplicated.".to_string());
        }
    }
    if sources.iter().filter(|source| source.is_default).count() > 1 {
        return Err("Default PipeWire microphone identity is duplicated.".to_string());
    }
    Ok(sources)
}

#[cfg(any(target_os = "linux", test))]
fn verify_wpctl_source_inspect(
    output: &str,
    expected_id: &str,
    expected_name: &str,
) -> Result<(), String> {
    let mut node_name = None;
    let mut media_class = None;
    let mut id_matches = false;
    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("id ") && trimmed.contains("PipeWire:Interface:Node") {
            id_matches = trimmed
                .strip_prefix("id ")
                .and_then(|rest| rest.split_once(','))
                .is_some_and(|(id, _)| id == expected_id);
        }
        if let Some((key, value)) = trimmed.split_once('=') {
            let value = value.trim().trim_matches('"');
            match key.trim().trim_start_matches('*').trim() {
                "node.name" => node_name = Some(value),
                "media.class" => media_class = Some(value),
                _ => {}
            }
        }
    }
    if !id_matches
        || media_class != Some("Audio/Source")
        || node_name != Some(expected_name)
    {
        return Err("wpctl source identity changed or is not an audio input.".to_string());
    }
    Ok(())
}

#[cfg(any(target_os = "linux", test))]
fn unique_wpctl_source_id(sources: &[WpctlSource], node_name: &str) -> Result<String, String> {
    let mut matches = sources.iter().filter(|source| source.node_name == node_name);
    let source = matches
        .next()
        .ok_or_else(|| "Selected PipeWire microphone is unavailable.".to_string())?;
    if matches.next().is_some() {
        return Err("Selected PipeWire microphone identity is duplicated.".to_string());
    }
    Ok(source.id.clone())
}

#[cfg(any(target_os = "linux", test))]
fn default_wpctl_source_id(sources: &[WpctlSource]) -> Result<String, String> {
    let mut matches = sources.iter().filter(|source| source.is_default);
    let source = matches
        .next()
        .ok_or_else(|| "Default PipeWire microphone is unavailable.".to_string())?;
    if matches.next().is_some() {
        return Err("Default PipeWire microphone identity is duplicated.".to_string());
    }
    Ok(source.id.clone())
}

#[cfg(target_os = "macos")]
mod macos_system_audio {
    use super::{
        is_default_input_device_id, native_input_device_hash, stable_name_hash,
        SystemDefaultInputVolume,
    };
    use std::ffi::CStr;
    use std::os::raw::c_char;
    use std::{ffi::c_void, mem, ptr};

    type AudioObjectID = u32;
    type AudioObjectPropertySelector = u32;
    type AudioObjectPropertyScope = u32;
    type AudioObjectPropertyElement = u32;
    type OSStatus = i32;
    type CFStringRef = *const c_void;

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
    const K_AUDIO_HARDWARE_PROPERTY_DEVICES: u32 = fourcc(b"dev#");
    const K_AUDIO_HARDWARE_PROPERTY_DEFAULT_INPUT_DEVICE: u32 = fourcc(b"dIn ");
    const K_AUDIO_DEVICE_PROPERTY_DEVICE_NAME_CF_STRING: u32 = fourcc(b"lnam");
    const K_AUDIO_DEVICE_PROPERTY_STREAM_CONFIGURATION: u32 = fourcc(b"slay");
    const K_AUDIO_DEVICE_PROPERTY_VOLUME_SCALAR: u32 = fourcc(b"volm");
    const K_AUDIO_DEVICE_PROPERTY_MUTE: u32 = fourcc(b"mute");
    const K_AUDIO_DEVICE_PROPERTY_SCOPE_OUTPUT: u32 = fourcc(b"outp");
    const K_AUDIO_OBJECT_PROPERTY_SCOPE_GLOBAL: u32 = fourcc(b"glob");
    const K_AUDIO_OBJECT_PROPERTY_SCOPE_INPUT: u32 = fourcc(b"inpt");
    const K_AUDIO_OBJECT_PROPERTY_ELEMENT_MAIN: u32 = 0;
    const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;

    #[allow(non_snake_case)]
    #[derive(Clone, Copy)]
    #[repr(C)]
    struct AudioBuffer {
        mNumberChannels: u32,
        mDataByteSize: u32,
        mData: *mut c_void,
    }

    #[allow(non_snake_case)]
    #[repr(C)]
    struct AudioBufferList {
        mNumberBuffers: u32,
        mBuffers: [AudioBuffer; 1],
    }

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
        fn AudioObjectGetPropertyDataSize(
            in_object_id: AudioObjectID,
            in_address: *const AudioObjectPropertyAddress,
            in_qualifier_data_size: u32,
            in_qualifier_data: *const c_void,
            out_data_size: *mut u32,
        ) -> OSStatus;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringGetCStringPtr(the_string: CFStringRef, encoding: u32) -> *const c_char;
        fn CFStringGetCString(
            the_string: CFStringRef,
            buffer: *mut c_char,
            buffer_size: isize,
            encoding: u32,
        ) -> u8;
    }

    pub(super) fn read(device_id: Option<&str>) -> SystemDefaultInputVolume {
        match read_target_input_device_volume(device_id) {
            Ok((volume_percent, muted)) => {
                SystemDefaultInputVolume::supported(volume_percent, muted, "macos-coreaudio")
            }
            Err(error) => SystemDefaultInputVolume::unsupported(format!(
                "Could not read macOS input volume with CoreAudio: {error}"
            )),
        }
    }

    pub(super) fn write(volume_percent: u8, device_id: Option<&str>) -> SystemDefaultInputVolume {
        match set_target_input_device_volume(volume_percent, device_id) {
            Ok(()) => read(device_id),
            Err(error) => SystemDefaultInputVolume::unsupported(format!(
                "Could not set macOS input volume with CoreAudio: {error}"
            )),
        }
    }

    fn read_target_input_device_volume(
        device_id: Option<&str>,
    ) -> Result<(u8, Option<bool>), String> {
        let target = target_input_device(device_id)?;
        let volume = read_input_volume_percent(target)?;
        let muted = read_input_mute(target);
        Ok((volume, muted))
    }

    fn set_target_input_device_volume(
        volume_percent: u8,
        device_id: Option<&str>,
    ) -> Result<(), String> {
        let target = target_input_device(device_id)?;
        let scalar = f32::from(volume_percent) / 100.0;
        let mut wrote_volume = false;

        for address in volume_addresses() {
            if !is_property_settable(target, &address) {
                continue;
            }
            set_property_data(target, &address, &scalar).map_err(|status| {
                format!(
                    "CoreAudio returned status {status} while setting input volume element {}.",
                    address.mElement
                )
            })?;
            wrote_volume = true;
        }

        if !wrote_volume {
            return Err("input device does not expose a settable volume.".to_string());
        }

        if volume_percent > 0 {
            let unmuted: u32 = 0;
            for address in mute_addresses() {
                if is_property_settable(target, &address) {
                    let _ = set_property_data(target, &address, &unmuted);
                }
            }
        }

        Ok(())
    }

    fn target_input_device(device_id: Option<&str>) -> Result<AudioObjectID, String> {
        if is_default_input_device_id(device_id) {
            return default_input_device();
        }

        let requested_device_id = device_id.unwrap_or_default();
        let requested_hash = native_input_device_hash(requested_device_id)
            .ok_or_else(|| "selected input device is not a native cpal device.".to_string())?;
        let mut hash_match = None;

        for (index, audio_device_id, label) in input_devices()? {
            let candidate_id = native_input_device_id(index, &label);
            if candidate_id == requested_device_id {
                return Ok(audio_device_id);
            }
            if hash_match.is_none() && stable_name_hash(&label) == requested_hash {
                hash_match = Some(audio_device_id);
            }
        }

        hash_match.ok_or_else(|| "selected input device was not found.".to_string())
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

    fn input_devices() -> Result<Vec<(usize, AudioObjectID, String)>, String> {
        let devices = all_audio_devices()?;
        let mut input_devices = Vec::new();

        for device_id in devices {
            if !device_has_input_channels(device_id) {
                continue;
            }
            let label = device_name(device_id).unwrap_or_else(|_| "Input Device".to_string());
            let index = input_devices.len();
            input_devices.push((index, device_id, label));
        }

        Ok(input_devices)
    }

    fn all_audio_devices() -> Result<Vec<AudioObjectID>, String> {
        let address = property_address(
            K_AUDIO_HARDWARE_PROPERTY_DEVICES,
            K_AUDIO_OBJECT_PROPERTY_SCOPE_GLOBAL,
            K_AUDIO_OBJECT_PROPERTY_ELEMENT_MAIN,
        );
        let data_size =
            get_property_data_size(K_AUDIO_OBJECT_SYSTEM_OBJECT, &address).map_err(|status| {
                format!("CoreAudio returned status {status} while listing devices.")
            })?;
        let device_count = data_size as usize / mem::size_of::<AudioObjectID>();
        if device_count == 0 {
            return Ok(Vec::new());
        }

        let mut devices = vec![0u32; device_count];
        get_property_data_into(K_AUDIO_OBJECT_SYSTEM_OBJECT, &address, &mut devices).map_err(
            |status| format!("CoreAudio returned status {status} while reading devices."),
        )?;
        Ok(devices)
    }

    fn device_name(device_id: AudioObjectID) -> Result<String, String> {
        let address = property_address(
            K_AUDIO_DEVICE_PROPERTY_DEVICE_NAME_CF_STRING,
            K_AUDIO_DEVICE_PROPERTY_SCOPE_OUTPUT,
            K_AUDIO_OBJECT_PROPERTY_ELEMENT_MAIN,
        );
        let device_name =
            get_property_data::<CFStringRef>(device_id, &address).map_err(|status| {
                format!("CoreAudio returned status {status} while reading device name.")
            })?;
        if device_name.is_null() {
            return Err("CoreAudio returned an empty device name.".to_string());
        }

        let c_string = unsafe { CFStringGetCStringPtr(device_name, K_CF_STRING_ENCODING_UTF8) };
        if !c_string.is_null() {
            return Ok(unsafe { CStr::from_ptr(c_string) }
                .to_string_lossy()
                .into_owned());
        }

        let mut buffer = [0 as c_char; 255];
        let copied = unsafe {
            CFStringGetCString(
                device_name,
                buffer.as_mut_ptr(),
                buffer.len() as isize,
                K_CF_STRING_ENCODING_UTF8,
            )
        };
        if copied == 0 {
            return Err("CoreFoundation could not copy the device name.".to_string());
        }

        Ok(unsafe { CStr::from_ptr(buffer.as_ptr()) }
            .to_string_lossy()
            .into_owned())
    }

    fn device_has_input_channels(device_id: AudioObjectID) -> bool {
        let address = property_address(
            K_AUDIO_DEVICE_PROPERTY_STREAM_CONFIGURATION,
            K_AUDIO_OBJECT_PROPERTY_SCOPE_INPUT,
            K_AUDIO_OBJECT_PROPERTY_ELEMENT_MAIN,
        );
        if !has_property(device_id, &address) {
            return false;
        }
        let Ok(data_size) = get_property_data_size(device_id, &address) else {
            return false;
        };
        if data_size as usize <= mem::size_of::<u32>() {
            return false;
        }

        let mut data = vec![0u8; data_size as usize];
        if get_property_bytes(device_id, &address, &mut data).is_err() {
            return false;
        }

        let buffers = data.as_ptr().cast::<AudioBufferList>();
        let number_buffers = unsafe { (*buffers).mNumberBuffers as usize };
        let first_buffer = unsafe { ptr::addr_of!((*buffers).mBuffers).cast::<AudioBuffer>() };
        for index in 0..number_buffers {
            let buffer = unsafe { *first_buffer.add(index) };
            if buffer.mNumberChannels > 0 {
                return true;
            }
        }

        false
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

        Err("input device does not expose a readable volume.".to_string())
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

    fn native_input_device_id(index: usize, label: &str) -> String {
        format!("cpal:{index}:{:016x}", stable_name_hash(label))
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

    fn get_property_data_into<T: Copy>(
        object_id: AudioObjectID,
        address: &AudioObjectPropertyAddress,
        values: &mut [T],
    ) -> Result<(), OSStatus> {
        let mut data_size = mem::size_of_val(values) as u32;
        let status = unsafe {
            AudioObjectGetPropertyData(
                object_id,
                address,
                0,
                ptr::null(),
                &mut data_size,
                values.as_mut_ptr().cast::<c_void>(),
            )
        };
        if status == NO_ERR {
            Ok(())
        } else {
            Err(status)
        }
    }

    fn get_property_bytes(
        object_id: AudioObjectID,
        address: &AudioObjectPropertyAddress,
        values: &mut [u8],
    ) -> Result<(), OSStatus> {
        let mut data_size = values.len() as u32;
        let status = unsafe {
            AudioObjectGetPropertyData(
                object_id,
                address,
                0,
                ptr::null(),
                &mut data_size,
                values.as_mut_ptr().cast::<c_void>(),
            )
        };
        if status == NO_ERR {
            Ok(())
        } else {
            Err(status)
        }
    }

    fn get_property_data_size(
        object_id: AudioObjectID,
        address: &AudioObjectPropertyAddress,
    ) -> Result<u32, OSStatus> {
        let mut data_size = 0u32;
        let status = unsafe {
            AudioObjectGetPropertyDataSize(object_id, address, 0, ptr::null(), &mut data_size)
        };
        if status == NO_ERR {
            Ok(data_size)
        } else {
            Err(status)
        }
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
fn read_system_input_volume(device_id: Option<&str>) -> SystemDefaultInputVolume {
    macos_system_audio::read(device_id)
}

#[cfg(target_os = "macos")]
fn write_system_input_volume(
    volume_percent: u8,
    device_id: Option<&str>,
) -> SystemDefaultInputVolume {
    macos_system_audio::write(volume_percent, device_id)
}

#[cfg(target_os = "linux")]
fn write_system_input_volume(
    volume_percent: u8,
    device_id: Option<&str>,
) -> SystemDefaultInputVolume {
    write_wpctl_input_volume(volume_percent, device_id)
        .unwrap_or_else(SystemDefaultInputVolume::unsupported)
}

#[cfg(target_os = "linux")]
fn read_system_input_volume(device_id: Option<&str>) -> SystemDefaultInputVolume {
    read_wpctl_input_volume(device_id).unwrap_or_else(SystemDefaultInputVolume::unsupported)
}

#[cfg(target_os = "linux")]
pub(super) fn verified_pipewire_sources() -> Result<std::collections::HashMap<String, bool>, String> {
    let output = run_host_audio_command("wpctl", &["list", "audio", "sources"])?;
    let sources = parse_wpctl_sources(&output)?;
    let mut verified = std::collections::HashMap::new();
    for source in sources {
        let inspect = run_host_audio_command("wpctl", &["inspect", &source.id])?;
        if verify_wpctl_source_inspect(&inspect, &source.id, &source.node_name).is_ok() {
            verified.insert(source.node_name, source.is_default);
        }
    }
    Ok(verified)
}

#[cfg(target_os = "linux")]
pub(super) fn resolve_wpctl_input_source(device_id: Option<&str>) -> Result<String, String> {
    let output = run_host_audio_command("wpctl", &["list", "audio", "sources"])?;
    let sources = parse_wpctl_sources(&output)?;
    let source_id = if is_default_input_device_id(device_id) {
        default_wpctl_source_id(&sources)?
    } else {
        let node_name = super::pipewire_node_name(device_id.unwrap_or_default()).ok_or_else(|| {
            "Selected microphone uses an unavailable device identity; reselect it.".to_string()
        })?;
        unique_wpctl_source_id(&sources, &node_name)?
    };
    let expected_name = sources
        .iter()
        .find(|source| source.id == source_id)
        .ok_or_else(|| "PipeWire microphone disappeared.".to_string())?;
    let inspect = run_host_audio_command("wpctl", &["inspect", &source_id])?;
    verify_wpctl_source_inspect(&inspect, &source_id, &expected_name.node_name)?;
    Ok(source_id)
}

#[cfg(target_os = "linux")]
fn read_wpctl_input_volume(device_id: Option<&str>) -> Result<SystemDefaultInputVolume, String> {
    let source_id = resolve_wpctl_input_source(device_id)?;
    let output = run_host_audio_command("wpctl", &["get-volume", &source_id])?;
    let (volume_percent, muted) = parse_wpctl_volume(&output)
        .ok_or_else(|| "Could not parse wpctl input volume.".to_string())?;
    Ok(SystemDefaultInputVolume::supported(
        volume_percent,
        Some(muted),
        "linux-wpctl",
    ))
}

#[cfg(target_os = "linux")]
fn write_wpctl_input_volume(
    volume_percent: u8,
    device_id: Option<&str>,
) -> Result<SystemDefaultInputVolume, String> {
    let source_id = resolve_wpctl_input_source(device_id)?;
    run_host_audio_command("wpctl", &["set-mute", &source_id, "0"])?;
    let source_id = resolve_wpctl_input_source(device_id)?;
    let volume = format!("{volume_percent}%");
    run_host_audio_command("wpctl", &["set-volume", &source_id, &volume])?;
    read_wpctl_input_volume(device_id)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn read_system_input_volume(_device_id: Option<&str>) -> SystemDefaultInputVolume {
    SystemDefaultInputVolume::unsupported(
        "System input volume control is only available on macOS and Linux.",
    )
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn write_system_input_volume(
    _volume_percent: u8,
    device_id: Option<&str>,
) -> SystemDefaultInputVolume {
    read_system_input_volume(device_id)
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
    fn resolves_wpctl_sources_by_node_name_not_shared_label_or_order() {
        let sources = parse_wpctl_sources("54\tusb.mic.b\taudio/source\t \n55\tusb.mic.a\taudio/source\t*\n").unwrap();
        assert_eq!(
            sources,
            vec![
                WpctlSource {
                    id: "54".to_string(),
                    node_name: "usb.mic.b".to_string(),
                    is_default: false,
                },
                WpctlSource {
                    id: "55".to_string(),
                    node_name: "usb.mic.a".to_string(),
                    is_default: true,
                },
            ],
        );
        assert_eq!(unique_wpctl_source_id(&sources, "usb.mic.a"), Ok("55".to_string()));
        assert_eq!(default_wpctl_source_id(&sources), Ok("55".to_string()));
    }

    #[test]
    fn rejects_missing_or_duplicated_wpctl_identity() {
        assert!(parse_wpctl_sources("54\tusb.mic\taudio/source\t \n55\tusb.mic\taudio/source\t \n").is_err());
        let sources = parse_wpctl_sources("54\tusb.mic\taudio/source\t \n").unwrap();
        assert_eq!(unique_wpctl_source_id(&sources, "usb.mic"), Ok("54".to_string()));
        assert!(unique_wpctl_source_id(&sources, "absent").is_err());
        assert!(default_wpctl_source_id(&sources).is_err());
        assert!(parse_wpctl_sources("54\tusb.mic\taudio/sink\t ").is_err());
        assert!(parse_wpctl_sources("54\tapp.capture\taudio/stream\t ").is_err());
    }

    #[test]
    fn verifies_inspected_source_before_volume_action() {
        let inspect = "id 54, type PipeWire:Interface:Node/3\n  * media.class = \"Audio/Source\"\n  * node.name = \"usb.mic\"\n";
        assert!(verify_wpctl_source_inspect(inspect, "54", "usb.mic").is_ok());
        assert!(verify_wpctl_source_inspect(inspect, "55", "usb.mic").is_err());
        assert!(verify_wpctl_source_inspect(inspect, "54", "usb.other").is_err());
        assert!(verify_wpctl_source_inspect(&inspect.replace("Audio/Source", "Audio/Sink"), "54", "usb.mic").is_err());
        assert!(verify_wpctl_source_inspect(&inspect.replace("Audio/Source", "Stream/Input/Audio"), "54", "usb.mic").is_err());
    }
}
