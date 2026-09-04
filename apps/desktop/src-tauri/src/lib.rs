use std::{process::Child, sync::Mutex};

#[cfg(not(target_os = "android"))]
use std::{
    collections::HashMap,
    env,
    ffi::OsString,
    fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use tauri::{AppHandle, Manager, State};

#[cfg(not(target_os = "android"))]
use serde::{Deserialize, Serialize};

mod file_dialog_scope;
mod mobile_backend;
mod mobile_media_transport;
mod native_audio;
pub mod power_inhibition;
mod sync_transport;
mod system_media;

struct BackendRuntime {
    base_url: String,
    child: Mutex<Option<Child>>,
}

impl BackendRuntime {
    fn new(base_url: String, child: Option<Child>) -> Self {
        Self {
            base_url,
            child: Mutex::new(child),
        }
    }

    fn shutdown(&self) {
        if let Ok(mut guard) = self.child.lock() {
            if let Some(child) = guard.as_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
            *guard = None;
        }
    }
}

#[tauri::command]
fn backend_base_url(runtime: State<'_, BackendRuntime>) -> String {
    runtime.base_url.clone()
}

#[tauri::command]
fn read_settings_snapshot_file(app: AppHandle) -> Result<Option<String>, String> {
    file_dialog_scope::read_user_selected_json_file(&app, "Import Settings Snapshot")
}

#[tauri::command]
fn write_settings_snapshot_file(
    app: AppHandle,
    default_file_name: String,
    contents: String,
) -> Result<bool, String> {
    file_dialog_scope::write_user_selected_json_file(
        &app,
        "Export Settings Snapshot",
        default_file_name,
        "tuneforge-settings.json",
        contents,
        "settings snapshot",
    )
}

#[tauri::command]
async fn write_sync_evidence_file(
    app: AppHandle,
    default_file_name: String,
    contents: String,
) -> Result<bool, String> {
    dispatch_sync_evidence_write(move || {
        file_dialog_scope::write_user_selected_json_file(
            &app,
            "Export Sync Evidence",
            default_file_name,
            "tuneforge-sync-evidence.json",
            contents,
            "sync evidence",
        )
    })
    .await
}

async fn dispatch_sync_evidence_write<F>(write: F) -> Result<bool, String>
where
    F: FnOnce() -> Result<bool, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(write)
        .await
        .map_err(|_| "Sync evidence export worker stopped unexpectedly.".to_string())?
}

#[cfg(not(target_os = "android"))]
fn allocate_port() -> Result<u16, Box<dyn std::error::Error>> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    Ok(listener.local_addr()?.port())
}

#[cfg(not(target_os = "android"))]
fn try_health_check(port: u16) -> bool {
    let mut stream = match TcpStream::connect(("127.0.0.1", port)) {
        Ok(stream) => stream,
        Err(_) => return false,
    };

    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));

    if stream
        .write_all(b"GET /api/v1/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }

    let mut response = String::new();
    if stream.read_to_string(&mut response).is_err() {
        return false;
    }

    response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.0 200")
}

#[cfg(not(target_os = "android"))]
fn wait_for_backend(port: u16, timeout: Duration) -> Result<(), Box<dyn std::error::Error>> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if try_health_check(port) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(250));
    }

    Err(format!("Timed out waiting for bundled backend on port {port}").into())
}

#[cfg(not(target_os = "android"))]
fn python_executable(python_root: &Path) -> PathBuf {
    python_root.join("bin").join("python3.14")
}

#[cfg(not(target_os = "android"))]
#[derive(Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct TorchExtensionProfile {
    schema_version: u8,
    contract: String,
    profile: String,
    role: String,
    ref_id: String,
    python_abi: String,
    torch_version: String,
    torchaudio_version: String,
    triton_version: String,
    cuda_family: String,
    pair_id: String,
}

#[cfg(not(target_os = "android"))]
const TORCH_EXTENSION_POLICY_JSON: &str = r#"{
  "schema_version": 2,
  "contract": "profile-pair-v1",
  "python_abi": "cp314",
  "profiles": {
    "Nvidia": {
      "ref_prefix": "com.tuneforge.desktop.Torch.Stack.Nvidia",
      "torch_version": "2.13.0",
      "torchaudio_version": "2.11.0",
      "triton_version": "3.7.1",
      "cuda_family": "13",
      "pair_id": "5655bca4c785fdcc9390b2c3ed9c58b6a69eeee3b383d2aaf3f7903bbec3abc2"
    },
    "LegacyNvidia": {
      "ref_prefix": "com.tuneforge.desktop.Torch.Stack.LegacyNvidia",
      "torch_version": "2.13.0+cu126",
      "torchaudio_version": "2.11.0+cu126",
      "triton_version": "3.7.1",
      "cuda_family": "12.6",
      "pair_id": "5896e6c2ba980be746fb7bb711d8e2e49f23713c58e0c6d3bec76ca048f60743"
    }
  }
}"#;

#[cfg(not(target_os = "android"))]
#[derive(Deserialize)]
struct TorchExtensionPolicy {
    schema_version: u8,
    contract: String,
    python_abi: String,
    profiles: HashMap<String, TorchExtensionPolicyProfile>,
}

#[cfg(not(target_os = "android"))]
#[derive(Deserialize)]
struct TorchExtensionPolicyProfile {
    ref_prefix: String,
    torch_version: String,
    torchaudio_version: String,
    triton_version: String,
    cuda_family: String,
    pair_id: String,
}

#[cfg(not(target_os = "android"))]
fn expected_torch_extension_profile(name: &str, role: &str) -> TorchExtensionProfile {
    let policy = serde_json::from_str::<TorchExtensionPolicy>(TORCH_EXTENSION_POLICY_JSON)
        .expect("valid embedded Torch extension policy");
    let profile = policy
        .profiles
        .get(name)
        .expect("fixed Torch extension name");
    let ref_role = match role {
        "core" => "Core",
        "runtime" => "Runtime",
        _ => unreachable!("fixed Torch extension role"),
    };
    TorchExtensionProfile {
        schema_version: policy.schema_version,
        contract: policy.contract.clone(),
        profile: name.to_string(),
        role: role.to_string(),
        ref_id: format!("{}.{ref_role}", profile.ref_prefix),
        python_abi: policy.python_abi.clone(),
        torch_version: profile.torch_version.clone(),
        torchaudio_version: profile.torchaudio_version.clone(),
        triton_version: profile.triton_version.clone(),
        cuda_family: profile.cuda_family.clone(),
        pair_id: profile.pair_id.clone(),
    }
}

#[cfg(not(target_os = "android"))]
fn valid_torch_extension_site_packages(root: &Path, name: &str) -> Option<PathBuf> {
    let site_packages = root.join("site-packages");
    let core = root.join("Core");
    let runtime = root.join("Runtime");
    if !root.is_dir()
        || !site_packages.is_dir()
        || !core.join("site-packages").is_dir()
        || !runtime.join("site-packages").is_dir()
    {
        return None;
    }
    let core_profile =
        serde_json::from_slice::<TorchExtensionProfile>(&fs::read(core.join("profile.json")).ok()?)
            .ok()?;
    let runtime_profile = serde_json::from_slice::<TorchExtensionProfile>(
        &fs::read(runtime.join("profile.json")).ok()?,
    )
    .ok()?;
    (core_profile == expected_torch_extension_profile(name, "core")
        && runtime_profile == expected_torch_extension_profile(name, "runtime"))
    .then_some(site_packages)
}

#[cfg(not(target_os = "android"))]
fn select_torch_extension_site_packages(nvidia_root: &Path, legacy_root: &Path) -> Option<PathBuf> {
    valid_torch_extension_site_packages(nvidia_root, "Nvidia")
        .or_else(|| valid_torch_extension_site_packages(legacy_root, "LegacyNvidia"))
}

#[cfg(not(target_os = "android"))]
fn mounted_torch_extension_site_packages() -> Option<PathBuf> {
    let root = Path::new("/app/lib/tuneforge/backend/torch-extensions");
    select_torch_extension_site_packages(&root.join("Nvidia"), &root.join("LegacyNvidia"))
}

#[cfg(not(target_os = "android"))]
fn build_python_path(backend_root: &Path) -> Result<String, Box<dyn std::error::Error>> {
    let site_packages = backend_root.join("site-packages");
    let backend_source = backend_root.join("src");
    let mut paths = Vec::new();
    if cfg!(target_os = "linux") {
        if let Some(extension) = mounted_torch_extension_site_packages() {
            paths.push(extension);
        }
    }
    paths.extend([site_packages, backend_source]);
    let joined = env::join_paths(paths)?;
    Ok(joined.to_string_lossy().into_owned())
}

#[cfg(not(target_os = "android"))]
fn build_backend_library_path(python_root: &Path) -> Result<OsString, env::JoinPathsError> {
    let current_paths: Vec<PathBuf> = env::var_os("LD_LIBRARY_PATH")
        .map(|path| env::split_paths(&path).collect())
        .unwrap_or_default();
    env::join_paths(append_unique_paths(
        vec![python_root.join("lib")],
        current_paths,
    ))
}

#[cfg(not(target_os = "android"))]
fn resolve_bundled_backend_root(app: &AppHandle) -> Result<PathBuf, Box<dyn std::error::Error>> {
    if let Some(root) = env::var_os("TUNEFORGE_BUNDLED_BACKEND_ROOT") {
        return Ok(PathBuf::from(root));
    }

    let resources_root = app.path().resource_dir()?;
    Ok(resources_root.join("resources").join("backend"))
}

#[cfg(all(not(target_os = "android"), target_os = "macos"))]
fn host_tool_fallback_dirs() -> Vec<PathBuf> {
    [
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
        "/usr/local/sbin",
        "/opt/local/bin",
        "/opt/local/sbin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ]
    .into_iter()
    .map(PathBuf::from)
    .collect()
}

#[cfg(all(not(target_os = "android"), not(target_os = "macos")))]
fn host_tool_fallback_dirs() -> Vec<PathBuf> {
    Vec::new()
}

#[cfg(not(target_os = "android"))]
fn append_unique_paths(
    mut paths: Vec<PathBuf>,
    extras: impl IntoIterator<Item = PathBuf>,
) -> Vec<PathBuf> {
    for extra in extras {
        if !paths.iter().any(|path| path == &extra) {
            paths.push(extra);
        }
    }
    paths
}

#[cfg(not(target_os = "android"))]
fn build_backend_search_path() -> Result<OsString, env::JoinPathsError> {
    let current_paths = env::var_os("PATH")
        .map(|path| env::split_paths(&path).collect())
        .unwrap_or_default();
    env::join_paths(append_unique_paths(
        current_paths,
        host_tool_fallback_dirs(),
    ))
}

#[cfg(all(not(target_os = "android"), unix))]
fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;

    fs::metadata(path)
        .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(all(not(target_os = "android"), not(unix)))]
fn is_executable_file(path: &Path) -> bool {
    path.is_file()
}

#[cfg(not(target_os = "android"))]
fn find_executable_in_path(binary_name: &str, search_path: &OsString) -> Option<PathBuf> {
    env::split_paths(search_path)
        .map(|directory| directory.join(binary_name))
        .find(|candidate| is_executable_file(candidate))
}

#[cfg(not(target_os = "android"))]
fn spawn_packaged_backend(app: &AppHandle) -> Result<BackendRuntime, Box<dyn std::error::Error>> {
    let bundled_backend_root = resolve_bundled_backend_root(app)?;
    let bundled_python_root = bundled_backend_root.join("python");
    let backend_source_root = bundled_backend_root.join("src");
    let python = python_executable(&bundled_python_root);

    if !python.exists() {
        return Err(format!("Bundled Python runtime not found at {}", python.display()).into());
    }

    let port = allocate_port()?;
    let base_url = format!("http://127.0.0.1:{port}");
    let python_path = build_python_path(&bundled_backend_root)?;
    let backend_library_path = build_backend_library_path(&bundled_python_root)?;
    let backend_search_path = build_backend_search_path()?;
    let ffmpeg_path = find_executable_in_path("ffmpeg", &backend_search_path);
    let ffprobe_path = find_executable_in_path("ffprobe", &backend_search_path);
    let model_bundle_dir = bundled_backend_root.join("models").join("bundle");

    let mut command = Command::new(&python);
    command
        .args([
            "-m",
            "uvicorn",
            "app.main:app",
            "--host",
            "127.0.0.1",
            "--port",
        ])
        .arg(port.to_string())
        .current_dir(&backend_source_root)
        .env("LD_LIBRARY_PATH", &backend_library_path)
        .env("PATH", &backend_search_path)
        .env("PYTHONHOME", &bundled_python_root)
        .env("PYTHONPATH", python_path)
        .env("PYTORCH_ENABLE_MPS_FALLBACK", "1")
        .env("TUNEFORGE_HOST", "127.0.0.1")
        .env("TUNEFORGE_PORT", port.to_string())
        .env(
            "TUNEFORGE_VERSION_FILE",
            bundled_backend_root.join("version.json"),
        )
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    if model_bundle_dir.exists() {
        command.env("TUNEFORGE_MODEL_BUNDLE_DIR", model_bundle_dir);
    }

    if env::var_os("TUNEFORGE_FFMPEG_PATH").is_none() {
        if let Some(path) = ffmpeg_path {
            command.env("TUNEFORGE_FFMPEG_PATH", path);
        }
    }
    if env::var_os("TUNEFORGE_FFPROBE_PATH").is_none() {
        if let Some(path) = ffprobe_path {
            command.env("TUNEFORGE_FFPROBE_PATH", path);
        }
    }

    let child = command.spawn()?;

    wait_for_backend(port, Duration::from_secs(30))?;

    Ok(BackendRuntime::new(base_url, Some(child)))
}

#[cfg(not(target_os = "android"))]
fn development_backend() -> BackendRuntime {
    let base_url = env::var("TUNEFORGE_DEV_API_BASE_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:8765".to_string());
    BackendRuntime::new(base_url, None)
}

#[cfg(target_os = "linux")]
fn install_linux_media_permission_handler(
    app: &AppHandle,
) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(webview) = app.get_webview_window("main") {
        webview.with_webview(|webview| {
            use webkit2gtk::{glib::prelude::*, PermissionRequestExt, SettingsExt, WebViewExt};

            if cfg!(debug_assertions) {
                if let Some(settings) = webview.inner().settings() {
                    settings.set_enable_write_console_messages_to_stdout(true);
                }
            }

            webview.inner().connect_permission_request(|_, request| {
                let request_type = request.type_().name();
                if request_type.contains("DeviceInfoPermissionRequest") {
                    request.allow();
                    return true;
                }

                if request_type.contains("UserMediaPermissionRequest") {
                    let is_audio = request.property::<bool>("is-for-audio-device");
                    let is_video = request.property::<bool>("is-for-video-device");
                    if is_audio && !is_video {
                        request.allow();
                    } else {
                        request.deny();
                    }
                    return true;
                }

                false
            });
        })?;
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "android")]
    let builder = builder.plugin(tauri_plugin_barcode_scanner::init());

    let app = builder
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            #[cfg(target_os = "android")]
            let runtime = BackendRuntime::new("mobile://embedded".to_string(), None);
            #[cfg(not(target_os = "android"))]
            let runtime = if cfg!(debug_assertions) {
                development_backend()
            } else {
                spawn_packaged_backend(app.handle())?
            };
            let power_inhibition = power_inhibition::PowerInhibitionState::new();
            let mobile_media =
                mobile_media_transport::MobileMediaTransportState::new(app.handle().clone())?;
            let sync_transport = sync_transport::SyncTransportState::new(
                runtime.base_url.clone(),
                app.handle().clone(),
                power_inhibition.clone(),
            );
            app.manage(runtime);
            app.manage(mobile_media);
            app.manage(native_audio::NativeAudioState::new());
            app.manage(sync_transport);
            app.manage(system_media::SystemMediaState::new(app.handle().clone()));
            app.manage(power_inhibition);
            #[cfg(target_os = "linux")]
            install_linux_media_permission_handler(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            backend_base_url,
            read_settings_snapshot_file,
            write_settings_snapshot_file,
            write_sync_evidence_file,
            native_audio::system_input::get_system_default_input_volume,
            native_audio::system_input::set_system_default_input_volume,
            native_audio::audio_get_capabilities,
            native_audio::diagnostics::native_audio_diagnostics_availability,
            native_audio::diagnostics::native_audio_diagnostics_read,
            native_audio::diagnostics::native_audio_diagnostics_reset,
            native_audio::diagnostics::native_audio_diagnostics_export,
            native_audio::audio_prepare_session,
            native_audio::audio_play,
            native_audio::audio_pause,
            native_audio::audio_stop,
            native_audio::audio_seek,
            native_audio::audio_set_lanes,
            native_audio::audio_set_standalone_metronome,
            native_audio::audio_get_snapshot,
            native_audio::audio_get_session_snapshot,
            native_audio::audio_schedule_cues,
            native_audio::audio_cancel_cues,
            native_audio::audio_list_input_devices,
            native_audio::audio_list_output_devices,
            native_audio::audio_get_input_state,
            native_audio::audio_get_input_permission_status,
            native_audio::audio_request_input_permission,
            native_audio::audio_start_input,
            native_audio::audio_stop_input,
            native_audio::audio_set_monitor,
            system_media::system_media_update_state,
            system_media::system_media_clear_state,
            power_inhibition::system_media_set_idle_inhibition,
            power_inhibition::power_inhibition_set_activity,
            power_inhibition::power_inhibition_status,
            sync_transport::sync_transport_start_listener,
            sync_transport::sync_transport_stop_listener,
            sync_transport::sync_transport_status,
            sync_transport::sync_transport_record_lifecycle_event,
            sync_transport::sync_transport_create_pairing_offer,
            sync_transport::sync_transport_sync_now,
            mobile_backend::mobile_capabilities,
            mobile_backend::mobile_get_health,
            mobile_backend::mobile_list_projects,
            mobile_backend::mobile_import_project,
            mobile_backend::mobile_get_project,
            mobile_backend::mobile_update_project,
            mobile_backend::mobile_delete_project,
            mobile_backend::mobile_submit_analyze,
            mobile_backend::mobile_get_analysis,
            mobile_backend::mobile_submit_chords,
            mobile_backend::mobile_get_chords,
            mobile_backend::mobile_submit_lyrics,
            mobile_backend::mobile_get_lyrics,
            mobile_backend::mobile_update_lyrics,
            mobile_backend::mobile_submit_preview,
            mobile_backend::mobile_submit_stems,
            mobile_backend::mobile_submit_retune,
            mobile_backend::mobile_submit_transpose,
            mobile_backend::mobile_list_artifacts,
            mobile_backend::mobile_delete_artifact,
            mobile_backend::mobile_submit_export,
            mobile_backend::mobile_list_jobs,
            mobile_backend::mobile_get_job,
            mobile_backend::mobile_cancel_job,
            mobile_backend::mobile_get_sync_identity,
            mobile_backend::mobile_create_sync_pairing_offer,
            mobile_backend::mobile_answer_sync_pairing_offer,
            mobile_backend::mobile_list_sync_trusted_peers,
            mobile_backend::mobile_trust_sync_peer,
            mobile_backend::mobile_revoke_sync_trusted_peer,
            mobile_backend::mobile_get_sync_metadata,
            mobile_backend::mobile_get_sync_project_manifest,
            mobile_backend::mobile_update_sync_project_status,
            mobile_backend::mobile_stage_sync_artifact,
            mobile_backend::mobile_get_sync_staged_artifact,
            mobile_backend::mobile_import_sync_project,
            mobile_backend::mobile_plan_sync_reconciliation,
            mobile_backend::mobile_apply_sync_reconciliation,
            mobile_media_transport::mobile_media_base_url
        ])
        .build(tauri::generate_context!())
        .expect("error while building tuneforge");

    app.run(|app_handle, event| {
        #[cfg(target_os = "android")]
        if matches!(
            event,
            tauri::RunEvent::WindowEvent {
                event: tauri::WindowEvent::Suspended,
                ..
            }
        ) {
            let native_audio = app_handle.state::<native_audio::NativeAudioState>();
            native_audio::stop_input_for_lifecycle(app_handle, native_audio.inner());
        }
        if let tauri::RunEvent::Exit = event {
            let mobile_media =
                app_handle.state::<mobile_media_transport::MobileMediaTransportState>();
            mobile_media.shutdown();
            let sync_transport = app_handle.state::<sync_transport::SyncTransportState>();
            sync_transport.shutdown();
            let power_inhibition = app_handle.state::<power_inhibition::PowerInhibitionState>();
            power_inhibition.shutdown();
            let runtime = app_handle.state::<BackendRuntime>();
            runtime.shutdown();
        }
    });
}

#[cfg(all(test, not(target_os = "android")))]
mod tests {
    use super::*;

    #[test]
    fn sync_evidence_write_dispatches_off_caller_thread_and_maps_results_safely() {
        let caller_thread = std::thread::current().id();
        let observed_thread = std::sync::Arc::new(Mutex::new(None));
        let observed_thread_for_write = observed_thread.clone();

        let exported = tauri::async_runtime::block_on(dispatch_sync_evidence_write(move || {
            *observed_thread_for_write.lock().expect("observed thread") =
                Some(std::thread::current().id());
            Ok(true)
        }))
        .expect("export dispatch");
        assert!(exported);
        assert_ne!(
            observed_thread.lock().expect("observed thread").as_ref(),
            Some(&caller_thread)
        );

        let cancelled = tauri::async_runtime::block_on(dispatch_sync_evidence_write(|| Ok(false)))
            .expect("cancel dispatch");
        assert!(!cancelled);

        let write_error = tauri::async_runtime::block_on(dispatch_sync_evidence_write(|| {
            Err("bounded write error".to_string())
        }));
        assert_eq!(write_error, Err("bounded write error".to_string()));

        let join_error = tauri::async_runtime::block_on(dispatch_sync_evidence_write(
            || -> Result<bool, String> { panic!("private worker panic details") },
        ));
        assert_eq!(
            join_error,
            Err("Sync evidence export worker stopped unexpectedly.".to_string())
        );
    }

    #[test]
    fn append_unique_paths_preserves_order_without_duplicates() {
        let first = PathBuf::from("/usr/bin");
        let second = PathBuf::from("/opt/homebrew/bin");
        let paths = append_unique_paths(vec![first.clone()], [second.clone(), first.clone()]);

        assert_eq!(paths, vec![first, second]);
    }

    fn torch_extension_fixture(root: &Path, name: &str, valid: bool) -> PathBuf {
        let extension = root.join(name);
        fs::create_dir_all(extension.join("site-packages")).expect("create extension fixture");
        for role in ["core", "runtime"] {
            let role_dir = extension.join(if role == "core" { "Core" } else { "Runtime" });
            fs::create_dir_all(role_dir.join("site-packages"))
                .expect("create extension role fixture");
            let profile = if valid {
                serde_json::to_vec(&expected_torch_extension_profile(name, role))
                    .expect("serialize profile")
            } else {
                br#"{"schema_version":0}"#.to_vec()
            };
            fs::write(role_dir.join("profile.json"), profile).expect("write extension marker");
        }
        extension
    }

    fn torch_test_root(name: &str) -> PathBuf {
        let root = env::temp_dir().join(format!("tuneforge-torch-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("create torch test root");
        root
    }

    #[test]
    fn torch_extension_markers_match_literal_profile_role_contracts() {
        for (profile, role, ref_id, pair_id) in [
            (
                "Nvidia",
                "core",
                "com.tuneforge.desktop.Torch.Stack.Nvidia.Core",
                "5655bca4c785fdcc9390b2c3ed9c58b6a69eeee3b383d2aaf3f7903bbec3abc2",
            ),
            (
                "Nvidia",
                "runtime",
                "com.tuneforge.desktop.Torch.Stack.Nvidia.Runtime",
                "5655bca4c785fdcc9390b2c3ed9c58b6a69eeee3b383d2aaf3f7903bbec3abc2",
            ),
            (
                "LegacyNvidia",
                "core",
                "com.tuneforge.desktop.Torch.Stack.LegacyNvidia.Core",
                "5896e6c2ba980be746fb7bb711d8e2e49f23713c58e0c6d3bec76ca048f60743",
            ),
            (
                "LegacyNvidia",
                "runtime",
                "com.tuneforge.desktop.Torch.Stack.LegacyNvidia.Runtime",
                "5896e6c2ba980be746fb7bb711d8e2e49f23713c58e0c6d3bec76ca048f60743",
            ),
        ] {
            let marker = expected_torch_extension_profile(profile, role);
            assert_eq!(marker.schema_version, 2);
            assert_eq!(marker.contract, "profile-pair-v1");
            assert_eq!(marker.profile, profile);
            assert_eq!(marker.role, role);
            assert_eq!(marker.ref_id, ref_id);
            assert_eq!(marker.pair_id, pair_id);
        }
    }

    #[test]
    fn torch_extension_selection_uses_cpu_without_extensions() {
        let root = torch_test_root("none");
        assert_eq!(
            select_torch_extension_site_packages(&root.join("nvidia"), &root.join("legacy")),
            None
        );
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn torch_extension_selection_accepts_nvidia_only() {
        let root = torch_test_root("nvidia");
        let nvidia = torch_extension_fixture(&root, "Nvidia", true);
        assert_eq!(
            select_torch_extension_site_packages(&nvidia, &root.join("legacy")),
            Some(nvidia.join("site-packages"))
        );
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn torch_extension_selection_rejects_partial_profile() {
        for missing_role in ["Core", "Runtime"] {
            let root = torch_test_root(&format!("partial-{missing_role}"));
            let nvidia = torch_extension_fixture(&root, "Nvidia", true);
            fs::remove_dir_all(nvidia.join(missing_role)).expect("remove role fixture");
            assert_eq!(
                select_torch_extension_site_packages(&nvidia, &root.join("legacy")),
                None
            );
            fs::remove_dir_all(root).expect("remove fixture");
        }
    }

    #[test]
    fn torch_extension_selection_accepts_legacy_only() {
        let root = torch_test_root("legacy");
        let legacy = torch_extension_fixture(&root, "LegacyNvidia", true);
        assert_eq!(
            select_torch_extension_site_packages(&root.join("nvidia"), &legacy),
            Some(legacy.join("site-packages"))
        );
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn torch_extension_selection_prefers_nvidia_when_both_are_valid() {
        let root = torch_test_root("both");
        let nvidia = torch_extension_fixture(&root, "Nvidia", true);
        let legacy = torch_extension_fixture(&root, "LegacyNvidia", true);
        assert_eq!(
            select_torch_extension_site_packages(&nvidia, &legacy),
            Some(nvidia.join("site-packages"))
        );
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn torch_extension_selection_rejects_mismatched_pair() {
        let root = torch_test_root("mismatched");
        let nvidia = torch_extension_fixture(&root, "Nvidia", true);
        let mut mismatched = expected_torch_extension_profile("Nvidia", "runtime");
        mismatched.pair_id = "b".repeat(64);
        fs::write(
            nvidia.join("Runtime").join("profile.json"),
            serde_json::to_vec(&mismatched).expect("serialize mismatched marker"),
        )
        .expect("write mismatched marker");
        assert_eq!(
            select_torch_extension_site_packages(&nvidia, &root.join("legacy")),
            None
        );
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn torch_extension_selection_rejects_cross_profile_pair() {
        let root = torch_test_root("cross-profile");
        let nvidia = torch_extension_fixture(&root, "Nvidia", true);
        fs::write(
            nvidia.join("Runtime").join("profile.json"),
            serde_json::to_vec(&expected_torch_extension_profile("LegacyNvidia", "runtime"))
                .expect("serialize cross-profile marker"),
        )
        .expect("write cross-profile marker");
        assert_eq!(
            select_torch_extension_site_packages(&nvidia, &root.join("legacy")),
            None
        );
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn torch_extension_selection_falls_through_malformed_nvidia_marker() {
        let root = torch_test_root("malformed");
        let nvidia = torch_extension_fixture(&root, "Nvidia", false);
        let legacy = torch_extension_fixture(&root, "LegacyNvidia", true);
        assert_eq!(
            select_torch_extension_site_packages(&nvidia, &legacy),
            Some(legacy.join("site-packages"))
        );
        fs::remove_dir_all(root).expect("remove fixture");
    }

    #[test]
    fn backend_library_path_starts_with_bundled_python_lib() {
        let python_root = PathBuf::from("/app/lib/tuneforge/backend/python");
        let library_path = build_backend_library_path(&python_root).expect("build library path");
        let paths = env::split_paths(&library_path).collect::<Vec<_>>();

        assert_eq!(paths.first(), Some(&python_root.join("lib")));
    }

    #[test]
    fn find_executable_in_path_prefers_first_matching_directory() {
        let root = env::temp_dir().join(format!("tuneforge-path-test-{}", std::process::id()));
        let first = root.join("first");
        let second = root.join("second");
        fs::create_dir_all(&first).expect("create first temp dir");
        fs::create_dir_all(&second).expect("create second temp dir");

        let first_binary = first.join("ffmpeg");
        let second_binary = second.join("ffmpeg");
        fs::write(&first_binary, "#!/bin/sh\n").expect("write first binary");
        fs::write(&second_binary, "#!/bin/sh\n").expect("write second binary");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&first_binary, fs::Permissions::from_mode(0o755))
                .expect("chmod first binary");
            fs::set_permissions(&second_binary, fs::Permissions::from_mode(0o755))
                .expect("chmod second binary");
        }

        let search_path = env::join_paths([&first, &second]).expect("join search path");
        let resolved = find_executable_in_path("ffmpeg", &search_path);

        fs::remove_dir_all(root).expect("remove temp dirs");
        assert_eq!(resolved, Some(first_binary));
    }
}
