use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

static PROFILE: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../../backend/app/storage-profile.json"))
        .expect("valid packaged storage profile")
});
static BASE_CONFIG: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../tauri.conf.json")).expect("valid base Tauri config")
});
static TEST_ID: LazyLock<String> = LazyLock::new(|| format!("{}.test", production_id()));

pub(crate) fn production_id() -> &'static str {
    BASE_CONFIG["identifier"].as_str().expect("base package ID")
}

pub(crate) fn test_id() -> &'static str {
    &TEST_ID
}

pub(crate) fn default_backend_root(home: &Path, platform: &str) -> PathBuf {
    backend_root_from_profile(&PROFILE, home, platform)
}

fn backend_root_from_profile(profile: &Value, home: &Path, platform: &str) -> PathBuf {
    home.join(profile["backend"][platform].as_str().unwrap_or_else(|| {
        profile["backend"]["linux"]
            .as_str()
            .expect("Linux storage default")
    }))
}

pub(crate) fn derive_test_root(root: &Path, platform: &str) -> Result<PathBuf, String> {
    derive_test_root_from_profile(&PROFILE, root, platform)
}

fn derive_test_root_from_profile(
    profile: &Value,
    root: &Path,
    platform: &str,
) -> Result<PathBuf, String> {
    let name = root
        .file_name()
        .ok_or("Production storage root has no final component.")?;
    let mut test_name = name.to_os_string();
    test_name.push(profile["testSuffix"][platform].as_str().unwrap_or_else(|| {
        profile["testSuffix"]["linux"]
            .as_str()
            .expect("Linux test suffix")
    }));
    Ok(root.with_file_name(test_name))
}

#[cfg(not(mobile))]
pub(crate) fn packaged_test_root(home: &Path, linux: bool) -> Result<PathBuf, String> {
    if linux {
        let fallback = format!(
            "~/{}",
            PROFILE["backend"]["linux"]
                .as_str()
                .expect("Linux storage default")
        );
        let selected = option_env!("TUNEFORGE_PACKAGE_DATA_ROOT").unwrap_or(&fallback);
        let production = if let Some(relative) = selected.strip_prefix("~/") {
            home.join(relative)
        } else {
            PathBuf::from(selected)
        };
        derive_test_root(&production, "linux")
    } else {
        derive_test_root(&default_backend_root(home, "darwin"), "darwin")
    }
}

#[cfg(not(mobile))]
pub(crate) fn native_data_root() -> Result<PathBuf, String> {
    let platform = if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "win32"
    } else {
        "linux"
    };
    if platform == "linux" {
        if let Ok(value) = std::env::var("XDG_DATA_HOME") {
            if !value.trim().is_empty() {
                return Ok(PathBuf::from(value.trim()).join(production_id()));
            }
        }
    }
    let template = PROFILE["native"][platform]
        .as_str()
        .expect("native storage default");
    let mut value = template.replace("{packageId}", production_id());
    if platform == "win32" {
        value = value.replace(
            "{appData}",
            &std::env::var("APPDATA")
                .map_err(|_| "Could not resolve APPDATA for Iroh transport state.")?,
        );
        return Ok(PathBuf::from(value));
    }
    let home = std::env::var("HOME")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or("Could not resolve the home directory for Iroh transport state.")?;
    Ok(home.join(value))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn derives_from_changed_production_defaults() {
        let mut profile = PROFILE.clone();
        profile["backend"]["darwin"] = Value::String("Library/Application Support/Renamed".into());
        profile["backend"]["linux"] = Value::String(".local/share/renamed".into());
        for (platform, expected) in [
            (
                "darwin",
                "/synthetic/Library/Application Support/Renamed Test",
            ),
            ("linux", "/synthetic/.local/share/renamed-test"),
        ] {
            let production = backend_root_from_profile(&profile, Path::new("/synthetic"), platform);
            assert_eq!(
                derive_test_root_from_profile(&profile, &production, platform).unwrap(),
                PathBuf::from(expected)
            );
        }
        assert_eq!(test_id(), format!("{}.test", production_id()));
    }
}
