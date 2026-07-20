use super::AudioPlatform;
use std::sync::OnceLock;

const ANDROID_CONTEXT_UNAVAILABLE: &str =
    "Native audio playback is unavailable because the Android audio context could not be initialized.";

static ANDROID_AUDIO_CONTEXT: OnceLock<Result<(), &'static str>> = OnceLock::new();

pub fn current_platform() -> AudioPlatform {
    let context_result = ensure_android_audio_context();
    AudioPlatform {
        name: "android",
        backend: "android-aaudio",
        native_playback_supported: context_result.is_ok(),
        fallback_reason: context_result.err(),
        mic_capture_supported: false,
        mic_monitoring_supported: false,
        system_input_volume_supported: false,
    }
}

fn ensure_android_audio_context() -> Result<(), &'static str> {
    *ANDROID_AUDIO_CONTEXT.get_or_init(initialize_android_audio_context)
}

fn initialize_android_audio_context() -> Result<(), &'static str> {
    use tauri::tao::platform::android::prelude::main_android_context;

    let context = main_android_context().ok_or(ANDROID_CONTEXT_UNAVAILABLE)?;
    if context.java_vm.is_null() || context.context_jobject.is_null() {
        return Err(ANDROID_CONTEXT_UNAVAILABLE);
    }

    // Tao owns global references for these process-lifetime pointers. CPAL's AAudio
    // backend uses the separate ndk-context crate for AudioManager JNI calls.
    unsafe {
        ndk_context::initialize_android_context(context.java_vm, context.context_jobject);
    }
    Ok(())
}
