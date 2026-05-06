use super::AudioPlatform;

pub fn current_platform() -> AudioPlatform {
    AudioPlatform {
        name: "android",
        backend: "android-null",
        native_playback_supported: false,
        mic_capture_supported: false,
        mic_monitoring_supported: false,
        system_input_volume_supported: false,
    }
}
