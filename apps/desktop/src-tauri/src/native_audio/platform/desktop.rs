use super::AudioPlatform;

pub fn current_platform() -> AudioPlatform {
    AudioPlatform {
        name: if cfg!(target_os = "macos") {
            "macos"
        } else {
            "linux"
        },
        backend: "desktop-cpal",
        native_playback_supported: true,
        availability_reason: None,
        mic_capture_supported: true,
        mic_monitoring_supported: false,
        system_input_volume_supported: true,
    }
}
