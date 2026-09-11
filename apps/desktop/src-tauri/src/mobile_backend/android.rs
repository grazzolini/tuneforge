use crate::mobile_ffmpeg::{render_audio, AudioOutputFormat};
use crate::native_audio::decode::{
    probe_mobile_durable_audio, read_mobile_audio, read_resampled_mono_audio, write_mono_pcm_wav,
};
use android_system_properties::AndroidSystemProperties;
use tauri_plugin_fs::{FilePath, FsExt, OpenOptions};
use whisper_rs::{
    install_logging_hooks, FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters,
};

#[path = "audio.rs"]
mod audio;
#[path = "export.rs"]
mod export;
#[path = "lyrics.rs"]
mod lyrics;

include!("embedded.rs");

use audio::{ensure_source_playback_proxy_metadata, spawn_playback_proxy_generation};
use lyrics::find_whisper_model;

pub use audio::{
    mobile_get_analysis, mobile_get_chords, mobile_submit_analyze, mobile_submit_chords,
    mobile_submit_preview, mobile_submit_retune, mobile_submit_stems, mobile_submit_transpose,
};
pub use export::mobile_submit_export;
pub use lyrics::{mobile_get_lyrics, mobile_submit_lyrics, mobile_update_lyrics};

const WHISPER_SAMPLE_RATE: u32 = 16_000;
const WHISPER_MODEL_DIR: &str = "models/whisper";
const WHISPER_MODEL_MISSING: &str =
        "Side-load a Whisper ggml model into app storage at models/whisper/ggml-base.bin or models/whisper/ggml-tiny.bin to enable local lyrics.";
pub fn mobile_capabilities(app: AppHandle) -> Result<MobileCapabilities, String> {
    let root = app_data_root(&app)?;
    let whisper_model = find_whisper_model(&root);
    let is_emulator = is_android_emulator();
    Ok(MobileCapabilities {
        platform: "android",
        media_backend: "android_media_codec",
        is_emulator,
        gpu_backend: None,
        analysis_available: true,
        basic_chords_available: true,
        whisper_available: whisper_model.is_some(),
        stem_separation_available: false,
        generation_testing_available: generation_testing_available(is_emulator),
        max_recommended_model: whisper_model
            .as_ref()
            .map(|model| model.max_recommended_model),
        cpu_fallback_allowed: false,
    })
}

fn generation_testing_available(is_emulator: bool) -> bool {
    cfg!(debug_assertions) && is_emulator
}

fn is_android_emulator() -> bool {
    let properties = AndroidSystemProperties::new();
    if property_is(&properties, "ro.kernel.qemu", "1")
        || property_is(&properties, "ro.boot.qemu", "1")
    {
        return true;
    }

    [
        ("ro.hardware", &["goldfish", "ranchu"][..]),
        ("ro.product.board", &["goldfish", "ranchu"]),
        ("ro.product.device", &["generic", "emulator", "sdk_gphone"]),
        ("ro.product.model", &["sdk", "emulator"]),
        ("ro.product.name", &["sdk", "emulator"]),
    ]
    .iter()
    .any(|(name, needles)| property_contains_any(&properties, name, needles))
}

fn property_is(properties: &AndroidSystemProperties, name: &str, expected: &str) -> bool {
    properties
        .get(name)
        .is_some_and(|value| value.trim().eq_ignore_ascii_case(expected))
}

fn property_contains_any(
    properties: &AndroidSystemProperties,
    name: &str,
    needles: &[&str],
) -> bool {
    properties.get(name).is_some_and(|value| {
        let normalized = value.to_ascii_lowercase();
        needles.iter().any(|needle| normalized.contains(needle))
    })
}

fn generation_unavailable_message(job_type: &str) -> &'static str {
    let is_emulator = is_android_emulator();
    if generation_testing_available(is_emulator) {
        match job_type {
            "lyrics" => LYRICS_NOT_WIRED,
            "stems" => STEMS_NOT_WIRED,
            _ => GPU_REQUIRED,
        }
    } else {
        GPU_REQUIRED
    }
}
