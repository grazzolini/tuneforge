use std::{fs, process::Child, sync::Mutex};

#[cfg(not(target_os = "android"))]
use std::{
    env,
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

    let child = Command::new(&python)
        .arg("-m")
        .arg("uvicorn")
        .arg("app.main:app")
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(port.to_string())
        .current_dir(&backend_source_root)
        .env("PYTHONHOME", &bundled_python_root)
        .env("PYTHONPATH", python_path)
        .env("PYTORCH_ENABLE_MPS_FALLBACK", "1")
        .env("TUNEFORGE_HOST", "127.0.0.1")
        .env("TUNEFORGE_PORT", port.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;

    wait_for_backend(port, Duration::from_secs(30))?;

    Ok(BackendRuntime::new(base_url, Some(child)))
}

#[cfg(not(target_os = "android"))]
fn development_backend() -> BackendRuntime {
    let base_url = env::var("TUNEFORGE_DEV_API_BASE_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:8765".to_string());
    BackendRuntime::new(base_url, None)
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
