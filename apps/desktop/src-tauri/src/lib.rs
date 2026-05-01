use serde::Serialize;
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

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemDefaultInputVolume {
    supported: bool,
    volume_percent: Option<u8>,
    muted: Option<bool>,
    backend: Option<&'static str>,
    error: Option<String>,
}

impl SystemDefaultInputVolume {
    fn supported(volume_percent: u8, muted: Option<bool>, backend: &'static str) -> Self {
        Self {
            supported: true,
            volume_percent: Some(volume_percent.min(100)),
            muted,
            backend: Some(backend),
            error: None,
        }
    }

    fn unsupported(error: impl Into<String>) -> Self {
        Self {
            supported: false,
            volume_percent: None,
            muted: None,
            backend: None,
            error: Some(error.into()),
        }
    }
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

#[tauri::command]
fn get_system_default_input_volume() -> SystemDefaultInputVolume {
    read_system_default_input_volume()
}

#[tauri::command]
fn set_system_default_input_volume(volume_percent: i32) -> SystemDefaultInputVolume {
    write_system_default_input_volume(clamp_input_volume_percent(volume_percent))
}

#[cfg(target_os = "linux")]
fn run_host_audio_command(binary: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new(binary)
        .args(args)
        .output()
        .map_err(|error| format!("{binary} is unavailable: {error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("{binary} exited with status {}", output.status)
        } else {
            stderr
        });
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg(any(target_os = "linux", test))]
fn parse_percent(value: &str) -> Option<u8> {
    let parsed = value.trim().parse::<f32>().ok()?;
    if !parsed.is_finite() {
        return None;
    }
    Some(parsed.round().clamp(0.0, 100.0) as u8)
}

fn clamp_input_volume_percent(value: i32) -> u8 {
    value.clamp(0, 100) as u8
}

#[cfg(any(target_os = "linux", test))]
fn parse_wpctl_volume(output: &str) -> Option<(u8, bool)> {
    let muted = output.contains("[MUTED]");
    let raw_volume = output.split("Volume:").nth(1)?.split_whitespace().next()?;
    let parsed = raw_volume.parse::<f32>().ok()?;
    if !parsed.is_finite() {
        return None;
    }
    Some(((parsed * 100.0).round().clamp(0.0, 100.0) as u8, muted))
}

#[cfg(any(target_os = "linux", test))]
fn parse_first_percent(output: &str) -> Option<u8> {
    let percent_index = output.find('%')?;
    let prefix = &output[..percent_index];
    let digits_start = prefix
        .rfind(|character: char| !character.is_ascii_digit())
        .map_or(0, |index| index + 1);
    parse_percent(&prefix[digits_start..])
}

#[cfg(any(target_os = "linux", test))]
fn parse_pactl_mute(output: &str) -> Option<bool> {
    let normalized = output.trim().to_ascii_lowercase();
    if normalized.ends_with("yes") {
        return Some(true);
    }
    if normalized.ends_with("no") {
        return Some(false);
    }
    None
}

#[cfg(target_os = "macos")]
mod macos_system_audio {
    use super::SystemDefaultInputVolume;
    use std::{ffi::c_void, mem, ptr};

    type AudioObjectID = u32;
    type AudioObjectPropertySelector = u32;
    type AudioObjectPropertyScope = u32;
    type AudioObjectPropertyElement = u32;
    type OSStatus = i32;

    #[allow(non_snake_case)]
    #[derive(Clone, Copy)]
    #[repr(C)]
    struct AudioObjectPropertyAddress {
        mSelector: AudioObjectPropertySelector,
        mScope: AudioObjectPropertyScope,
        mElement: AudioObjectPropertyElement,
    }

    pub(super) const fn fourcc(bytes: &[u8; 4]) -> u32 {
        u32::from_be_bytes(*bytes)
    }

    const NO_ERR: OSStatus = 0;
    const K_AUDIO_OBJECT_SYSTEM_OBJECT: AudioObjectID = 1;
    const K_AUDIO_HARDWARE_PROPERTY_DEFAULT_INPUT_DEVICE: u32 = fourcc(b"dIn ");
    const K_AUDIO_DEVICE_PROPERTY_VOLUME_SCALAR: u32 = fourcc(b"volm");
    const K_AUDIO_DEVICE_PROPERTY_MUTE: u32 = fourcc(b"mute");
    const K_AUDIO_OBJECT_PROPERTY_SCOPE_GLOBAL: u32 = fourcc(b"glob");
    const K_AUDIO_OBJECT_PROPERTY_SCOPE_INPUT: u32 = fourcc(b"inpt");
    const K_AUDIO_OBJECT_PROPERTY_ELEMENT_MAIN: u32 = 0;

    #[link(name = "CoreAudio", kind = "framework")]
    extern "C" {
        fn AudioObjectHasProperty(
            in_object_id: AudioObjectID,
            in_address: *const AudioObjectPropertyAddress,
        ) -> u8;
        fn AudioObjectIsPropertySettable(
            in_object_id: AudioObjectID,
            in_address: *const AudioObjectPropertyAddress,
            out_is_settable: *mut u8,
        ) -> OSStatus;
        fn AudioObjectGetPropertyData(
            in_object_id: AudioObjectID,
            in_address: *const AudioObjectPropertyAddress,
            in_qualifier_data_size: u32,
            in_qualifier_data: *const c_void,
            io_data_size: *mut u32,
            out_data: *mut c_void,
        ) -> OSStatus;
        fn AudioObjectSetPropertyData(
            in_object_id: AudioObjectID,
            in_address: *const AudioObjectPropertyAddress,
            in_qualifier_data_size: u32,
            in_qualifier_data: *const c_void,
            in_data_size: u32,
            in_data: *const c_void,
        ) -> OSStatus;
    }

    pub(super) fn read() -> SystemDefaultInputVolume {
        match read_default_input_device_volume() {
            Ok((volume_percent, muted)) => {
                SystemDefaultInputVolume::supported(volume_percent, muted, "macos-coreaudio")
            }
            Err(error) => SystemDefaultInputVolume::unsupported(format!(
                "Could not read macOS default input volume with CoreAudio: {error}"
            )),
        }
    }

    pub(super) fn write(volume_percent: u8) -> SystemDefaultInputVolume {
        match set_default_input_device_volume(volume_percent) {
            Ok(()) => read(),
            Err(error) => SystemDefaultInputVolume::unsupported(format!(
                "Could not set macOS default input volume with CoreAudio: {error}"
            )),
        }
    }

    fn read_default_input_device_volume() -> Result<(u8, Option<bool>), String> {
        let device_id = default_input_device()?;
        let volume = read_input_volume_percent(device_id)?;
        let muted = read_input_mute(device_id);
        Ok((volume, muted))
    }

    fn set_default_input_device_volume(volume_percent: u8) -> Result<(), String> {
        let device_id = default_input_device()?;
        let scalar = f32::from(volume_percent) / 100.0;
        let mut wrote_volume = false;

        for address in volume_addresses() {
            if !is_property_settable(device_id, &address) {
                continue;
            }
            set_property_data(device_id, &address, &scalar).map_err(|status| {
                format!(
                    "CoreAudio returned status {status} while setting input volume element {}.",
                    address.mElement
                )
            })?;
            wrote_volume = true;
        }

        if !wrote_volume {
            return Err("default input device does not expose a settable volume.".to_string());
        }

        if volume_percent > 0 {
            let unmuted: u32 = 0;
            for address in mute_addresses() {
                if is_property_settable(device_id, &address) {
                    let _ = set_property_data(device_id, &address, &unmuted);
                }
            }
        }

        Ok(())
    }

    fn default_input_device() -> Result<AudioObjectID, String> {
        let address = property_address(
            K_AUDIO_HARDWARE_PROPERTY_DEFAULT_INPUT_DEVICE,
            K_AUDIO_OBJECT_PROPERTY_SCOPE_GLOBAL,
            K_AUDIO_OBJECT_PROPERTY_ELEMENT_MAIN,
        );
        let device_id = get_property_data::<AudioObjectID>(K_AUDIO_OBJECT_SYSTEM_OBJECT, &address)
            .map_err(|status| {
                format!("CoreAudio returned status {status} for the default input device.")
            })?;
        if device_id == 0 {
            return Err("no default input device is available.".to_string());
        }
        Ok(device_id)
    }

    fn read_input_volume_percent(device_id: AudioObjectID) -> Result<u8, String> {
        for address in volume_addresses() {
            if !has_property(device_id, &address) {
                continue;
            }
            if let Ok(volume) = get_property_data::<f32>(device_id, &address) {
                if volume.is_finite() {
                    return Ok((volume * 100.0).round().clamp(0.0, 100.0) as u8);
                }
            }
        }

        Err("default input device does not expose a readable volume.".to_string())
    }

    fn read_input_mute(device_id: AudioObjectID) -> Option<bool> {
        for address in mute_addresses() {
            if !has_property(device_id, &address) {
                continue;
            }
            if let Ok(muted) = get_property_data::<u32>(device_id, &address) {
                return Some(muted != 0);
            }
        }

        None
    }

    fn volume_addresses() -> [AudioObjectPropertyAddress; 9] {
        input_channel_addresses(K_AUDIO_DEVICE_PROPERTY_VOLUME_SCALAR)
    }

    fn mute_addresses() -> [AudioObjectPropertyAddress; 9] {
        input_channel_addresses(K_AUDIO_DEVICE_PROPERTY_MUTE)
    }

    fn input_channel_addresses(
        selector: AudioObjectPropertySelector,
    ) -> [AudioObjectPropertyAddress; 9] {
        [
            property_address(
                selector,
                K_AUDIO_OBJECT_PROPERTY_SCOPE_INPUT,
                K_AUDIO_OBJECT_PROPERTY_ELEMENT_MAIN,
            ),
            property_address(selector, K_AUDIO_OBJECT_PROPERTY_SCOPE_INPUT, 1),
            property_address(selector, K_AUDIO_OBJECT_PROPERTY_SCOPE_INPUT, 2),
            property_address(selector, K_AUDIO_OBJECT_PROPERTY_SCOPE_INPUT, 3),
            property_address(selector, K_AUDIO_OBJECT_PROPERTY_SCOPE_INPUT, 4),
            property_address(selector, K_AUDIO_OBJECT_PROPERTY_SCOPE_INPUT, 5),
            property_address(selector, K_AUDIO_OBJECT_PROPERTY_SCOPE_INPUT, 6),
            property_address(selector, K_AUDIO_OBJECT_PROPERTY_SCOPE_INPUT, 7),
            property_address(selector, K_AUDIO_OBJECT_PROPERTY_SCOPE_INPUT, 8),
        ]
    }

    fn property_address(
        selector: AudioObjectPropertySelector,
        scope: AudioObjectPropertyScope,
        element: AudioObjectPropertyElement,
    ) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress {
            mSelector: selector,
            mScope: scope,
            mElement: element,
        }
    }

    fn has_property(object_id: AudioObjectID, address: &AudioObjectPropertyAddress) -> bool {
        unsafe { AudioObjectHasProperty(object_id, address) != 0 }
    }

    fn is_property_settable(
        object_id: AudioObjectID,
        address: &AudioObjectPropertyAddress,
    ) -> bool {
        if !has_property(object_id, address) {
            return false;
        }

        let mut settable = 0u8;
        let status = unsafe { AudioObjectIsPropertySettable(object_id, address, &mut settable) };
        status == NO_ERR && settable != 0
    }

    fn get_property_data<T: Copy>(
        object_id: AudioObjectID,
        address: &AudioObjectPropertyAddress,
    ) -> Result<T, OSStatus> {
        let mut value = mem::MaybeUninit::<T>::uninit();
        let mut data_size = mem::size_of::<T>() as u32;
        let status = unsafe {
            AudioObjectGetPropertyData(
                object_id,
                address,
                0,
                ptr::null(),
                &mut data_size,
                value.as_mut_ptr().cast::<c_void>(),
            )
        };
        if status != NO_ERR {
            return Err(status);
        }
        if data_size < mem::size_of::<T>() as u32 {
            return Err(-1);
        }

        Ok(unsafe { value.assume_init() })
    }

    fn set_property_data<T>(
        object_id: AudioObjectID,
        address: &AudioObjectPropertyAddress,
        value: &T,
    ) -> Result<(), OSStatus> {
        let status = unsafe {
            AudioObjectSetPropertyData(
                object_id,
                address,
                0,
                ptr::null(),
                mem::size_of::<T>() as u32,
                (value as *const T).cast::<c_void>(),
            )
        };
        if status == NO_ERR {
            Ok(())
        } else {
            Err(status)
        }
    }
}

#[cfg(target_os = "macos")]
fn read_system_default_input_volume() -> SystemDefaultInputVolume {
    macos_system_audio::read()
}

#[cfg(target_os = "macos")]
fn write_system_default_input_volume(volume_percent: u8) -> SystemDefaultInputVolume {
    macos_system_audio::write(volume_percent)
}

#[cfg(target_os = "linux")]
fn read_wpctl_default_input_volume() -> Result<SystemDefaultInputVolume, String> {
    let output = run_host_audio_command("wpctl", &["get-volume", "@DEFAULT_AUDIO_SOURCE@"])?;
    let (volume_percent, muted) = parse_wpctl_volume(&output)
        .ok_or_else(|| "Could not parse wpctl default input volume.".to_string())?;
    Ok(SystemDefaultInputVolume::supported(
        volume_percent,
        Some(muted),
        "linux-wpctl",
    ))
}

#[cfg(target_os = "linux")]
fn read_pactl_default_input_volume() -> Result<SystemDefaultInputVolume, String> {
    let volume_output =
        run_host_audio_command("pactl", &["get-source-volume", "@DEFAULT_SOURCE@"])?;
    let volume_percent = parse_first_percent(&volume_output)
        .ok_or_else(|| "Could not parse pactl default source volume.".to_string())?;
    let muted = run_host_audio_command("pactl", &["get-source-mute", "@DEFAULT_SOURCE@"])
        .ok()
        .and_then(|output| parse_pactl_mute(&output));
    Ok(SystemDefaultInputVolume::supported(
        volume_percent,
        muted,
        "linux-pactl",
    ))
}

#[cfg(target_os = "linux")]
fn read_system_default_input_volume() -> SystemDefaultInputVolume {
    read_wpctl_default_input_volume()
        .or_else(|wpctl_error| {
            read_pactl_default_input_volume().map_err(|pactl_error| {
                format!(
                    "Could not read default input volume with wpctl ({wpctl_error}) or pactl ({pactl_error})."
                )
            })
        })
        .unwrap_or_else(SystemDefaultInputVolume::unsupported)
}

#[cfg(target_os = "linux")]
fn write_wpctl_default_input_volume(
    volume_percent: u8,
) -> Result<SystemDefaultInputVolume, String> {
    let volume = format!("{volume_percent}%");
    run_host_audio_command("wpctl", &["set-mute", "@DEFAULT_AUDIO_SOURCE@", "0"])?;
    run_host_audio_command("wpctl", &["set-volume", "@DEFAULT_AUDIO_SOURCE@", &volume])?;
    read_wpctl_default_input_volume()
}

#[cfg(target_os = "linux")]
fn write_pactl_default_input_volume(
    volume_percent: u8,
) -> Result<SystemDefaultInputVolume, String> {
    let volume = format!("{volume_percent}%");
    run_host_audio_command("pactl", &["set-source-mute", "@DEFAULT_SOURCE@", "0"])?;
    run_host_audio_command("pactl", &["set-source-volume", "@DEFAULT_SOURCE@", &volume])?;
    read_pactl_default_input_volume()
}

#[cfg(target_os = "linux")]
fn write_system_default_input_volume(volume_percent: u8) -> SystemDefaultInputVolume {
    write_wpctl_default_input_volume(volume_percent)
        .or_else(|wpctl_error| {
            write_pactl_default_input_volume(volume_percent).map_err(|pactl_error| {
                format!(
                    "Could not set default input volume with wpctl ({wpctl_error}) or pactl ({pactl_error})."
                )
            })
        })
        .unwrap_or_else(SystemDefaultInputVolume::unsupported)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn read_system_default_input_volume() -> SystemDefaultInputVolume {
    SystemDefaultInputVolume::unsupported(
        "System input volume control is only available on macOS and Linux.",
    )
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn write_system_default_input_volume(_volume_percent: u8) -> SystemDefaultInputVolume {
    read_system_default_input_volume()
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
            get_system_default_input_volume,
            set_system_default_input_volume,
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

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_fourcc_constants_use_core_audio_byte_order() {
        assert_eq!(macos_system_audio::fourcc(b"dIn "), 0x6449_6e20);
        assert_eq!(macos_system_audio::fourcc(b"volm"), 0x766f_6c6d);
    }

    #[test]
    fn clamps_input_volume_command_values() {
        assert_eq!(clamp_input_volume_percent(-20), 0);
        assert_eq!(clamp_input_volume_percent(87), 87);
        assert_eq!(clamp_input_volume_percent(160), 100);
    }

    #[test]
    fn parses_wpctl_volume_and_mute_state() {
        assert_eq!(parse_wpctl_volume("Volume: 0.37"), Some((37, false)));
        assert_eq!(parse_wpctl_volume("Volume: 0.82 [MUTED]"), Some((82, true)));
    }

    #[test]
    fn parses_pactl_volume_and_mute_state() {
        assert_eq!(
            parse_first_percent(
                "Volume: front-left: 49152 / 75% / -7.50 dB, front-right: 49152 / 75% / -7.50 dB",
            ),
            Some(75),
        );
        assert_eq!(parse_pactl_mute("Mute: yes"), Some(true));
        assert_eq!(parse_pactl_mute("Mute: no"), Some(false));
    }
}
