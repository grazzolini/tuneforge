use super::AudioPlatform;

pub fn current_platform() -> AudioPlatform {
    AudioPlatform {
        name: "unsupported",
        backend: "null",
        native_playback_supported: false,
        fallback_reason: Some("Native audio playback is unsupported on this platform."),
        mic_capture_supported: false,
        mic_monitoring_supported: false,
        system_input_volume_supported: false,
    }
}
