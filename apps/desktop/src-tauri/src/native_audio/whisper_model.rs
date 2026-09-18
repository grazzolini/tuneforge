#[cfg(target_os = "android")]
pub(crate) fn status() -> String {
    android_string_call("getTuneForgeWhisperStatus", None)
        .unwrap_or_else(|_| "unavailable".to_string())
}

#[cfg(target_os = "android")]
pub(crate) fn prepare(job_id: &str) -> Result<String, String> {
    normalize_prepare_result(
        android_string_call("prepareTuneForgeWhisper", Some(job_id)),
        || android_string_call("takeTuneForgeWhisperError", Some(job_id)),
    )
}

fn normalize_prepare_result(
    prepare_result: Result<String, String>,
    take_error: impl FnOnce() -> Result<String, String>,
) -> Result<String, String> {
    match prepare_result {
        Ok(path) if !path.is_empty() => Ok(path),
        Ok(_) => Err(error_message(&match take_error() {
            Ok(code) | Err(code) => code,
        })),
        Err(code) => Err(error_message(&code)),
    }
}

#[cfg(target_os = "android")]
pub(crate) fn cancel(job_id: &str) {
    let _ = android_string_call("cancelTuneForgeWhisper", Some(job_id));
}

#[cfg(target_os = "android")]
pub(crate) fn progress(job_id: &str) -> Option<i32> {
    android_int_call("getTuneForgeWhisperProgress", job_id)
        .ok()
        .filter(|progress| *progress >= 0)
}

#[cfg(target_os = "android")]
pub(crate) fn clear_progress(job_id: &str) {
    let _ = android_string_call("clearTuneForgeWhisperProgress", Some(job_id));
}

#[cfg(target_os = "android")]
pub(crate) fn with_inference_lock<T>(
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    use jni::objects::{Global, JObject};
    use jni::{jni_sig, jni_str, JavaVM};
    use tauri::tao::platform::android::prelude::main_android_context;

    let context =
        main_android_context().ok_or_else(|| "WHISPER_RUNTIME_UNAVAILABLE".to_string())?;
    if context.java_vm.is_null() || context.context_jobject.is_null() {
        return Err("WHISPER_RUNTIME_UNAVAILABLE".to_string());
    }
    let vm = unsafe { JavaVM::from_raw(context.java_vm.cast()) };
    let mut operation = Some(operation);
    let mut outcome = None;
    vm.attach_current_thread(|env| -> jni::errors::Result<()> {
        let activity_raw = context.context_jobject.cast();
        let activity = unsafe { env.as_cast_raw::<Global<JObject<'static>>>(&activity_raw)? };
        let lock = env
            .call_method(
                &activity,
                jni_str!("getTuneForgeInferenceLock"),
                jni_sig!(() -> JObject),
                &[],
            )?
            .into_object()?;
        let _guard = env.lock_obj(&lock)?;
        outcome = Some(operation.take().expect("inference operation runs once")());
        Ok(())
    })
    .map_err(|_| "WHISPER_RUNTIME_UNAVAILABLE".to_string())?;
    outcome.ok_or_else(|| "WHISPER_RUNTIME_UNAVAILABLE".to_string())?
}

#[cfg(target_os = "android")]
fn android_string_call(method: &str, job_id: Option<&str>) -> Result<String, String> {
    use jni::objects::{Global, JObject, JString, JValue};
    use jni::{jni_sig, jni_str, JavaVM};
    use tauri::tao::platform::android::prelude::main_android_context;

    let context =
        main_android_context().ok_or_else(|| "WHISPER_RUNTIME_UNAVAILABLE".to_string())?;
    if context.java_vm.is_null() || context.context_jobject.is_null() {
        return Err("WHISPER_RUNTIME_UNAVAILABLE".to_string());
    }
    let vm = unsafe { JavaVM::from_raw(context.java_vm.cast()) };
    vm.attach_current_thread(|env| {
        let activity_raw = context.context_jobject.cast();
        let activity = unsafe { env.as_cast_raw::<Global<JObject<'static>>>(&activity_raw)? };
        if let Some(job_id) = job_id {
            let job = env.new_string(job_id)?;
            if method == "cancelTuneForgeWhisper" || method == "clearTuneForgeWhisperProgress" {
                env.call_method(
                    &activity,
                    if method == "cancelTuneForgeWhisper" {
                        jni_str!("cancelTuneForgeWhisper")
                    } else {
                        jni_str!("clearTuneForgeWhisperProgress")
                    },
                    jni_sig!((JString) -> ()),
                    &[JValue::Object(job.as_ref())],
                )?;
                return Ok(String::new());
            }
            let result = match method {
                "prepareTuneForgeWhisper" => env.call_method(
                    &activity,
                    jni_str!("prepareTuneForgeWhisper"),
                    jni_sig!((JString) -> JString),
                    &[JValue::Object(job.as_ref())],
                )?,
                _ => env.call_method(
                    &activity,
                    jni_str!("takeTuneForgeWhisperError"),
                    jni_sig!((JString) -> JString),
                    &[JValue::Object(job.as_ref())],
                )?,
            }
            .into_object()?;
            return JString::cast_local(env, result)?.try_to_string(env);
        }
        let result = env
            .call_method(
                &activity,
                jni_str!("getTuneForgeWhisperStatus"),
                jni_sig!(() -> JString),
                &[],
            )?
            .into_object()?;
        JString::cast_local(env, result)?.try_to_string(env)
    })
    .map_err(|_| "WHISPER_RUNTIME_UNAVAILABLE".to_string())
}

#[cfg(target_os = "android")]
fn android_int_call(method: &str, job_id: &str) -> Result<i32, String> {
    use jni::objects::{Global, JObject, JValue};
    use jni::{jni_sig, jni_str, JavaVM};
    use tauri::tao::platform::android::prelude::main_android_context;

    let context =
        main_android_context().ok_or_else(|| "WHISPER_RUNTIME_UNAVAILABLE".to_string())?;
    if context.java_vm.is_null() || context.context_jobject.is_null() {
        return Err("WHISPER_RUNTIME_UNAVAILABLE".to_string());
    }
    let vm = unsafe { JavaVM::from_raw(context.java_vm.cast()) };
    vm.attach_current_thread(|env| {
        let activity_raw = context.context_jobject.cast();
        let activity = unsafe { env.as_cast_raw::<Global<JObject<'static>>>(&activity_raw)? };
        let job = env.new_string(job_id)?;
        let result = env.call_method(
            &activity,
            jni_str!("getTuneForgeWhisperProgress"),
            jni_sig!((JString) -> i32),
            &[JValue::Object(job.as_ref())],
        )?;
        result.i()
    })
    .map_err(|_| format!("{method}: WHISPER_RUNTIME_UNAVAILABLE"))
}

pub(crate) fn error_message(code: &str) -> String {
    if code == "WHISPER_CANCELLED" {
        return "LYRICS_CANCELLED".to_string();
    }
    if code == "WHISPER_RUNTIME_UNAVAILABLE" {
        return "Whisper Turbo is unavailable in this build.".to_string();
    }
    if let Some(bytes) = code.strip_prefix("WHISPER_MODEL_STORAGE_INSUFFICIENT:") {
        let missing = bytes.parse::<u64>().unwrap_or(0);
        let gib = missing as f64 / 1_073_741_824.0;
        return format!(
            "Not enough free space to install Whisper Turbo. Free {gib:.2} GB and try again."
        );
    }
    if code.contains("INTEGRITY") || code.contains("SIZE_INVALID") {
        return "Whisper Turbo failed verification. Repair downloads and verifies the full 1.62 GB model again.".to_string();
    }
    if code == "WHISPER_MODEL_NETWORK_TIMEOUT" {
        return "Whisper Turbo download timed out. Check your connection; retry starts from the beginning.".to_string();
    }
    if code == "WHISPER_MODEL_NETWORK_UNAVAILABLE" {
        return "Whisper Turbo could not reach the download server. Check your connection; retry starts from the beginning.".to_string();
    }
    if code == "WHISPER_MODEL_NETWORK_TLS_FAILED" {
        return "Whisper Turbo could not establish a secure download connection. Check the device date and network security; retry starts from the beginning.".to_string();
    }
    if code.contains("DOWNLOAD") {
        return "Whisper Turbo could not be downloaded. Check your connection; retry starts from the beginning.".to_string();
    }
    if code.contains("STORAGE") || code.contains("STAGING") || code.contains("REPLACE") {
        return "Device storage is unavailable for Whisper Turbo. Check available space and retry."
            .to_string();
    }
    "Whisper Turbo setup failed. Retry downloads and verifies the full model from the beginning."
        .to_string()
}

fn recoverable_gpu_error_detail(message: &str) -> Option<&'static str> {
    if message == "WHISPER_GPU_UNAVAILABLE" {
        Some("CPU retry after Vulkan was unavailable.")
    } else if message.starts_with("Whisper model could not be loaded:") {
        Some("CPU retry after Vulkan model initialization failed.")
    } else if message.starts_with("Whisper state could not be created:") {
        Some("CPU retry after Vulkan state initialization failed.")
    } else if message.starts_with("Whisper transcription failed:") {
        Some("CPU retry after Vulkan inference failed.")
    } else {
        None
    }
}

pub(crate) fn completed_backend_device(backend_type: i32) -> Result<Option<&'static str>, String> {
    match backend_type {
        0 => Ok(Some("cpu")),
        1 => Ok(Some("vulkan")),
        -1 => Ok(None),
        _ => Err("Whisper returned invalid backend provenance.".to_string()),
    }
}

pub(crate) fn transcribe_with_cpu_fallback<T>(
    mut transcribe: impl FnMut(bool) -> Result<T, String>,
    cancelled: impl Fn() -> bool,
    mut report_fallback: impl FnMut() -> Result<(), String>,
) -> Result<(T, Option<&'static str>), String> {
    match transcribe(true) {
        Ok(transcription) => Ok((transcription, None)),
        Err(message) if message == "LYRICS_CANCELLED" || cancelled() => {
            Err("LYRICS_CANCELLED".to_string())
        }
        Err(message) if recoverable_gpu_error_detail(&message).is_some() => {
            let detail = recoverable_gpu_error_detail(&message)
                .expect("guarded recoverable Vulkan error must have safe detail");
            report_fallback()?;
            if cancelled() {
                return Err("LYRICS_CANCELLED".to_string());
            }
            let transcription = transcribe(false)?;
            Ok((transcription, Some(detail)))
        }
        Err(message) => Err(message),
    }
}

#[cfg(all(test, not(target_os = "android")))]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    #[test]
    fn maps_verification_and_fresh_retry_errors() {
        assert!(error_message("WHISPER_MODEL_INTEGRITY_FAILED").contains("full 1.62 GB"));
        assert!(error_message("WHISPER_MODEL_DOWNLOAD_FAILED").contains("beginning"));
    }

    #[test]
    fn maps_safe_network_and_setup_errors_without_claiming_missing_runtime() {
        for code in [
            "WHISPER_MODEL_NETWORK_TIMEOUT",
            "WHISPER_MODEL_NETWORK_UNAVAILABLE",
            "WHISPER_MODEL_NETWORK_TLS_FAILED",
            "WHISPER_MODEL_SETUP_FAILED",
            "Unable to resolve host example.invalid",
        ] {
            let message = error_message(code);
            assert!(message.contains("retry") || message.contains("Retry"));
            assert!(!message.contains("unavailable in this build"));
            assert!(!message.contains("example.invalid"));
        }
        assert_eq!(
            error_message("WHISPER_RUNTIME_UNAVAILABLE"),
            "Whisper Turbo is unavailable in this build."
        );
    }

    #[test]
    fn preserves_runtime_failure_when_setup_error_cannot_be_read() {
        assert_eq!(
            normalize_prepare_result(Ok(String::new()), || {
                Err("WHISPER_RUNTIME_UNAVAILABLE".to_string())
            }),
            Err("Whisper Turbo is unavailable in this build.".to_string())
        );
        assert_eq!(
            normalize_prepare_result(Ok(String::new()), || {
                Ok("WHISPER_MODEL_NETWORK_TIMEOUT".to_string())
            }),
            Err("Whisper Turbo download timed out. Check your connection; retry starts from the beginning.".to_string())
        );
    }

    #[test]
    fn recoverable_gpu_failure_retries_once_with_fresh_cpu_run() {
        let attempts = RefCell::new(Vec::new());
        let fallback_reports = Cell::new(0);

        let (result, detail) = transcribe_with_cpu_fallback(
            |use_gpu| {
                attempts.borrow_mut().push(use_gpu);
                if use_gpu {
                    Err("Whisper transcription failed: Vulkan device lost".to_string())
                } else {
                    Ok("cpu result")
                }
            },
            || false,
            || {
                fallback_reports.set(fallback_reports.get() + 1);
                Ok(())
            },
        )
        .expect("recoverable GPU failure should retry on CPU");

        assert_eq!(result, "cpu result");
        assert_eq!(detail, Some("CPU retry after Vulkan inference failed."));
        assert_eq!(*attempts.borrow(), vec![true, false]);
        assert_eq!(fallback_reports.get(), 1);
    }

    #[test]
    fn successful_cpu_attribution_from_gpu_request_does_not_retry() {
        let attempts = RefCell::new(Vec::new());
        let fallback_reports = Cell::new(0);

        let (result, detail) = transcribe_with_cpu_fallback(
            |use_gpu| {
                attempts.borrow_mut().push(use_gpu);
                Ok("successful cpu-attributed result")
            },
            || false,
            || {
                fallback_reports.set(fallback_reports.get() + 1);
                Ok(())
            },
        )
        .expect("a successful native result must not be discarded");

        assert_eq!(result, "successful cpu-attributed result");
        assert_eq!(detail, None);
        assert_eq!(*attempts.borrow(), vec![true]);
        assert_eq!(fallback_reports.get(), 0);
    }

    #[test]
    fn cancellation_never_retries_on_cpu() {
        let attempts = RefCell::new(Vec::new());
        let fallback_reports = Cell::new(0);

        let result = transcribe_with_cpu_fallback(
            |use_gpu| {
                attempts.borrow_mut().push(use_gpu);
                Err::<(), _>("LYRICS_CANCELLED".to_string())
            },
            || true,
            || {
                fallback_reports.set(fallback_reports.get() + 1);
                Ok(())
            },
        );

        assert_eq!(result, Err("LYRICS_CANCELLED".to_string()));
        assert_eq!(*attempts.borrow(), vec![true]);
        assert_eq!(fallback_reports.get(), 0);
    }

    #[test]
    fn cancellation_after_gpu_failure_stops_before_cpu_retry() {
        let attempts = RefCell::new(Vec::new());
        let cancelled = Cell::new(false);

        let result = transcribe_with_cpu_fallback(
            |use_gpu| {
                attempts.borrow_mut().push(use_gpu);
                Err::<(), _>("WHISPER_GPU_UNAVAILABLE".to_string())
            },
            || cancelled.get(),
            || {
                cancelled.set(true);
                Ok(())
            },
        );

        assert_eq!(result, Err("LYRICS_CANCELLED".to_string()));
        assert_eq!(*attempts.borrow(), vec![true]);
    }

    #[test]
    fn reports_only_the_safe_vulkan_failure_stage() {
        assert_eq!(
            recoverable_gpu_error_detail("WHISPER_GPU_UNAVAILABLE"),
            Some("CPU retry after Vulkan was unavailable.")
        );
        assert_eq!(
            recoverable_gpu_error_detail("Whisper model could not be loaded: driver detail"),
            Some("CPU retry after Vulkan model initialization failed.")
        );
        assert_eq!(
            recoverable_gpu_error_detail("Whisper state could not be created: driver detail"),
            Some("CPU retry after Vulkan state initialization failed.")
        );
        assert_eq!(
            recoverable_gpu_error_detail("Whisper transcription failed: driver detail"),
            Some("CPU retry after Vulkan inference failed.")
        );
        assert_eq!(recoverable_gpu_error_detail("unrelated failure"), None);
    }

    #[test]
    fn maps_only_completed_backend_provenance() {
        assert_eq!(completed_backend_device(0).unwrap(), Some("cpu"));
        assert_eq!(completed_backend_device(1).unwrap(), Some("vulkan"));
        assert_eq!(completed_backend_device(-1).unwrap(), None);
        assert!(completed_backend_device(2).is_err());
    }
}
