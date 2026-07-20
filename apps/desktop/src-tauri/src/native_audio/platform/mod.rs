#[cfg(target_os = "android")]
mod android;
#[cfg(all(
    not(target_os = "android"),
    any(target_os = "linux", target_os = "macos")
))]
mod desktop;
#[cfg(not(any(target_os = "android", target_os = "linux", target_os = "macos")))]
mod null;

#[derive(Clone, Copy)]
pub struct AudioPlatform {
    pub name: &'static str,
    pub backend: &'static str,
    pub native_playback_supported: bool,
    pub fallback_reason: Option<&'static str>,
    pub mic_capture_supported: bool,
    pub mic_monitoring_supported: bool,
    pub system_input_volume_supported: bool,
}

#[cfg(target_os = "android")]
pub fn current_platform() -> AudioPlatform {
    android::current_platform()
}

#[cfg(all(
    not(target_os = "android"),
    any(target_os = "linux", target_os = "macos")
))]
pub fn current_platform() -> AudioPlatform {
    desktop::current_platform()
}

#[cfg(not(any(target_os = "android", target_os = "linux", target_os = "macos")))]
pub fn current_platform() -> AudioPlatform {
    null::current_platform()
}
