//! Background lifetime protection belongs to the processing queue, independently of playback/sync.
#[cfg(target_os = "android")]
pub(crate) struct AndroidProtection;

#[cfg(target_os = "android")]
impl crate::mobile_backend::android::processing_queue::Protection for AndroidProtection {
    fn start(&self) -> Result<(), String> {
        call(1)
    }
    fn active(&self, active: bool) -> Result<(), String> {
        call(if active { 2 } else { 3 })
    }
    fn healthy(&self) -> bool {
        call(4).is_ok()
    }
    fn stop(&self) {
        let _ = call(0);
    }
}

#[cfg(target_os = "android")]
fn call(state: i32) -> Result<(), String> {
    use jni::objects::{Global, JObject, JString, JValue};
    use jni::{jni_sig, jni_str, JavaVM};
    use tauri::tao::platform::android::prelude::main_android_context;
    let context = main_android_context().ok_or("Android processing service is unavailable.")?;
    if context.java_vm.is_null() || context.context_jobject.is_null() {
        return Err("Android processing service is unavailable.".into());
    }
    let vm = unsafe { JavaVM::from_raw(context.java_vm.cast()) };
    let response = vm
        .attach_current_thread(|env| {
            let activity_raw = context.context_jobject.cast();
            let activity = unsafe { env.as_cast_raw::<Global<JObject<'static>>>(&activity_raw)? };
            let value = env
                .call_method(
                    &activity,
                    jni_str!("setTuneForgeProcessing"),
                    jni_sig!((i32) -> JString),
                    &[JValue::Int(state)],
                )?
                .into_object()?;
            JString::cast_local(env, value)?.try_to_string(env)
        })
        .map_err(|_| "Android processing service could not be updated.".to_string())?;
    if response == "ready" {
        Ok(())
    } else {
        Err(
            "Android processing could not continue in the background. Return to the app and retry."
                .into(),
        )
    }
}
