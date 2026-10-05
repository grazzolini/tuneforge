use serde::Serialize;
use tauri::AppHandle;

use crate::storage_profile::{production_id, test_id};

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PackageIdentity {
    package_id: String,
    is_test_package: bool,
}

fn identity_from_id(package_id: String) -> PackageIdentity {
    PackageIdentity {
        is_test_package: package_id != production_id(),
        package_id,
    }
}

#[cfg(target_os = "android")]
fn installed_package_id() -> Option<String> {
    use jni::objects::{Global, JObject, JString};
    use jni::{jni_sig, jni_str, JavaVM};
    use tauri::tao::platform::android::prelude::main_android_context;

    let context = main_android_context()?;
    if context.java_vm.is_null() || context.context_jobject.is_null() {
        return None;
    }
    let vm = unsafe { JavaVM::from_raw(context.java_vm.cast()) };
    vm.attach_current_thread(|env| {
        let raw = context.context_jobject.cast();
        let activity = unsafe { env.as_cast_raw::<Global<JObject<'static>>>(&raw)? };
        let value = env
            .call_method(&activity, jni_str!("getPackageName"), jni_sig!(() -> JString), &[])?
            .into_object()?;
        JString::cast_local(env, value)?.try_to_string(env)
    })
    .ok()
    .filter(|value| !value.is_empty())
}

#[cfg(target_os = "macos")]
fn installed_package_id() -> Option<String> {
    if cfg!(debug_assertions) {
        return None;
    }
    objc2_foundation::NSBundle::mainBundle()
        .bundleIdentifier()
        .map(|value| value.to_string())
}

#[cfg(target_os = "linux")]
fn installed_package_id() -> Option<String> {
    std::env::var("FLATPAK_ID")
        .ok()
        .filter(|value| !value.is_empty())
}

#[cfg(not(any(target_os = "android", target_os = "macos", target_os = "linux")))]
fn installed_package_id() -> Option<String> {
    None
}

pub(crate) fn installed_identity() -> Option<PackageIdentity> {
    installed_package_id().map(identity_from_id)
}

#[tauri::command]
pub(crate) fn get_package_identity() -> Option<PackageIdentity> {
    installed_identity()
}

#[cfg(not(mobile))]
pub(crate) fn ensure_compiled_identity_matches(app: &AppHandle) -> Result<(), String> {
    let actual = installed_package_id()
        .ok_or_else(|| "Packaged application identity is unavailable.".to_string())?;
    if actual != app.config().identifier {
        return Err(format!(
            "Installed package ID {actual} does not match compiled Tauri ID {}.",
            app.config().identifier
        ));
    }
    Ok(())
}

#[cfg(not(mobile))]
pub(crate) fn packaged_test_data_root() -> Result<Option<std::path::PathBuf>, String> {
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
    test_data_root_from_parts(
        installed_package_id().as_deref(),
        home.as_deref(),
        cfg!(target_os = "linux"),
    )
}

#[cfg(not(mobile))]
fn test_data_root_from_parts(
    package_id: Option<&str>,
    home: Option<&std::path::Path>,
    linux: bool,
) -> Result<Option<std::path::PathBuf>, String> {
    if package_id != Some(test_id()) {
        return Ok(None);
    }
    let home = home.ok_or("HOME is required for test package storage.")?;
    crate::storage_profile::packaged_test_root(home, linux).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn custom_android_identity_is_test() {
        assert!(!identity_from_id(production_id().to_string()).is_test_package);
        assert!(identity_from_id(test_id().to_string()).is_test_package);
        assert!(identity_from_id("org.example.tuneforge.local".to_string()).is_test_package);
    }

    #[cfg(not(mobile))]
    #[test]
    fn test_data_root_ignores_inherited_production_override() {
        let home = std::path::Path::new("/synthetic/home");
        assert_eq!(test_data_root_from_parts(Some(test_id()), Some(home), false).unwrap(),
            Some(home.join("Library/Application Support/Tuneforge Test")));
        assert_eq!(test_data_root_from_parts(Some(test_id()), Some(home), true).unwrap(),
            Some(home.join(".local/share/tuneforge-test")));
        assert_eq!(test_data_root_from_parts(Some(production_id()), Some(home), false).unwrap(), None);
        assert_eq!(test_data_root_from_parts(None, Some(home), false).unwrap(), None);
    }
}
