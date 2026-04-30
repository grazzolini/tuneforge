use std::{fs, process::Child, sync::Mutex};

#[cfg(not(target_os = "android"))]
use std::{
    env,
    ffi::OsString,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

#[cfg(not(target_os = "android"))]
use tauri::AppHandle;
use tauri::{Manager, State};

mod mobile_backend;

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
fn read_settings_snapshot_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|error| format!("Could not read settings file: {error}"))
}

#[tauri::command]
fn write_settings_snapshot_file(path: String, contents: String) -> Result<(), String> {
    fs::write(&path, contents).map_err(|error| format!("Could not write settings file: {error}"))
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
    python_root.join("bin").join("python3.11")
}

#[cfg(not(target_os = "android"))]
fn build_python_path(backend_root: &Path) -> Result<String, Box<dyn std::error::Error>> {
    let site_packages = backend_root.join("site-packages");
    let backend_source = backend_root.join("src");
    let joined = env::join_paths([site_packages, backend_source])?;
    Ok(joined.to_string_lossy().into_owned())
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
    let resources_root = app.path().resource_dir()?;
    let bundled_backend_root = resources_root.join("resources").join("backend");
    let bundled_python_root = bundled_backend_root.join("python");
    let backend_source_root = bundled_backend_root.join("src");
    let python = python_executable(&bundled_python_root);

    if !python.exists() {
        return Err(format!("Bundled Python runtime not found at {}", python.display()).into());
    }

    let port = allocate_port()?;
    let base_url = format!("http://127.0.0.1:{port}");
    let python_path = build_python_path(&bundled_backend_root)?;
    let backend_search_path = build_backend_search_path()?;
    let ffmpeg_path = find_executable_in_path("ffmpeg", &backend_search_path);
    let ffprobe_path = find_executable_in_path("ffprobe", &backend_search_path);

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
        .env("PATH", &backend_search_path)
        .env("PYTHONHOME", &bundled_python_root)
        .env("PYTHONPATH", python_path)
        .env("PYTORCH_ENABLE_MPS_FALLBACK", "1")
        .env("TUNEFORGE_HOST", "127.0.0.1")
        .env("TUNEFORGE_PORT", port.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

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
    let app = tauri::Builder::default()
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
            app.manage(runtime);
            #[cfg(target_os = "linux")]
            install_linux_media_permission_handler(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            backend_base_url,
            read_settings_snapshot_file,
            write_settings_snapshot_file,
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
            mobile_backend::mobile_cancel_job
        ])
        .build(tauri::generate_context!())
        .expect("error while building tuneforge");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            let runtime = app_handle.state::<BackendRuntime>();
            runtime.shutdown();
        }
    });
}

#[cfg(all(test, not(target_os = "android")))]
mod tests {
    use super::*;

    #[test]
    fn append_unique_paths_preserves_order_without_duplicates() {
        let first = PathBuf::from("/usr/bin");
        let second = PathBuf::from("/opt/homebrew/bin");
        let paths = append_unique_paths(vec![first.clone()], [second.clone(), first.clone()]);

        assert_eq!(paths, vec![first, second]);
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
