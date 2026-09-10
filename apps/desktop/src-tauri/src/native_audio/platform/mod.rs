#[cfg(target_os = "android")]
mod android;
#[cfg(target_os = "ios")]
mod ios {
    use super::AudioPlatform;

    pub fn current_platform() -> AudioPlatform {
        AudioPlatform {
            name: "ios",
            backend: "ios-coreaudio",
            native_playback_supported: true,
            availability_reason: None,
            mic_capture_supported: false,
            mic_monitoring_supported: false,
            system_input_volume_supported: false,
        }
    }
}
#[cfg(all(
    not(any(target_os = "android", target_os = "ios")),
    any(target_os = "linux", target_os = "macos")
))]
mod desktop;
#[cfg(not(any(
    target_os = "android",
    target_os = "ios",
    target_os = "linux",
    target_os = "macos"
)))]
mod null;

#[derive(Clone, Copy)]
pub struct AudioPlatform {
    pub name: &'static str,
    pub backend: &'static str,
    pub native_playback_supported: bool,
    pub availability_reason: Option<&'static str>,
    pub mic_capture_supported: bool,
    pub mic_monitoring_supported: bool,
    pub system_input_volume_supported: bool,
}

#[cfg(target_os = "android")]
pub fn current_platform() -> AudioPlatform {
    android::current_platform()
}

#[cfg(target_os = "ios")]
pub fn current_platform() -> AudioPlatform {
    ios::current_platform()
}

#[cfg(all(
    not(any(target_os = "android", target_os = "ios")),
    any(target_os = "linux", target_os = "macos")
))]
pub fn current_platform() -> AudioPlatform {
    desktop::current_platform()
}

#[cfg(not(any(
    target_os = "android",
    target_os = "ios",
    target_os = "linux",
    target_os = "macos"
)))]
pub fn current_platform() -> AudioPlatform {
    null::current_platform()
}
