use std::sync::Mutex;
#[cfg(any(target_os = "android", test))]
use std::{
    io::{Read, Seek, SeekFrom, Write},
    net::{Shutdown, SocketAddr, TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver},
        Arc,
    },
    thread::{self, JoinHandle},
    time::Duration,
};

#[cfg(any(target_os = "android", test))]
use rand::{rngs::SysRng, TryRng};

use tauri::AppHandle;

#[cfg(any(target_os = "android", test))]
const MAX_REQUEST_BYTES: usize = 8 * 1024;
#[cfg(any(target_os = "android", test))]
const STREAM_BUFFER_BYTES: usize = 64 * 1024;
#[cfg(any(target_os = "android", test))]
const WORKER_COUNT: usize = 4;
#[cfg(any(target_os = "android", test))]
const QUEUE_DEPTH: usize = 8;

#[cfg(any(target_os = "android", test))]
type Resolver = Arc<dyn Fn(&str) -> Result<ResolvedMedia, String> + Send + Sync>;

#[cfg(any(target_os = "android", test))]
struct ResolvedMedia {
    file: std::fs::File,
    size_bytes: u64,
    content_type: &'static str,
}

#[cfg(any(target_os = "android", test))]
struct ServerRuntime {
    base_url: String,
    address: SocketAddr,
    stop: Arc<AtomicBool>,
    active: Arc<Mutex<Vec<Option<TcpStream>>>>,
    listener: Mutex<Option<JoinHandle<()>>>,
    workers: Mutex<Vec<JoinHandle<()>>>,
}

#[cfg(not(any(target_os = "android", test)))]
struct ServerRuntime;

#[cfg(any(target_os = "android", test))]
impl ServerRuntime {
    fn start(resolver: Resolver) -> Result<Self, String> {
        Self::start_internal(resolver, None)
    }

    fn start_internal(
        resolver: Resolver,
        stream_chunk_delay: Option<Duration>,
    ) -> Result<Self, String> {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .map_err(|_| "Mobile media transport could not start.".to_string())?;
        let address = listener
            .local_addr()
            .map_err(|_| "Mobile media transport could not start.".to_string())?;
        listener
            .set_nonblocking(true)
            .map_err(|_| "Mobile media transport could not start.".to_string())?;
        let capability = capability_token()?;
        let artifact_route_prefix: Arc<str> = format!("/{capability}/artifacts/").into();
        let stop = Arc::new(AtomicBool::new(false));
        let active = Arc::new(Mutex::new(
            (0..WORKER_COUNT).map(|_| None).collect::<Vec<_>>(),
        ));
        let (sender, receiver) = mpsc::sync_channel::<TcpStream>(QUEUE_DEPTH);
        let receiver = Arc::new(Mutex::new(receiver));
        let workers = (0..WORKER_COUNT)
            .map(|worker_index| {
                let receiver = receiver.clone();
                let resolver = resolver.clone();
                let stop = stop.clone();
                let active = active.clone();
                let artifact_route_prefix = artifact_route_prefix.clone();
                thread::spawn(move || {
                    worker_loop(
                        worker_index,
                        receiver,
                        resolver,
                        artifact_route_prefix,
                        stop,
                        active,
                        stream_chunk_delay,
                    )
                })
            })
            .collect();
        let listener_stop = stop.clone();
        let listener_thread = thread::spawn(move || {
            while !listener_stop.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let _ = sender.try_send(stream);
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(10));
                    }
                    Err(_) => break,
                }
            }
        });
        Ok(Self {
            base_url: format!("http://{address}/{capability}"),
            address,
            stop,
            active,
            listener: Mutex::new(Some(listener_thread)),
            workers: Mutex::new(workers),
        })
    }

    fn shutdown(&self) {
        if self.stop.swap(true, Ordering::AcqRel) {
            return;
        }
        let _ = TcpStream::connect(self.address);
        if let Ok(active) = self.active.lock() {
            for stream in active.iter().flatten() {
                let _ = stream.shutdown(Shutdown::Both);
            }
        }
        if let Ok(mut listener) = self.listener.lock() {
            if let Some(handle) = listener.take() {
                let _ = handle.join();
            }
        }
        if let Ok(mut workers) = self.workers.lock() {
            for handle in workers.drain(..) {
                let _ = handle.join();
            }
        }
    }
}

#[cfg(any(target_os = "android", test))]
fn capability_token() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    SysRng
        .try_fill_bytes(&mut bytes)
        .map_err(|_| "Mobile media transport could not start.".to_string())?;
    let mut token = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;

        write!(&mut token, "{byte:02x}").expect("writing to String cannot fail");
    }
    Ok(token)
}

#[cfg(any(target_os = "android", test))]
impl Drop for ServerRuntime {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[cfg(not(any(target_os = "android", test)))]
impl ServerRuntime {
    fn shutdown(&self) {}
}

pub struct MobileMediaTransportState {
    #[cfg(target_os = "android")]
    resolver: Resolver,
    server: Mutex<Option<ServerRuntime>>,
}

impl MobileMediaTransportState {
    pub fn new(app: AppHandle) -> Result<Self, String> {
        #[cfg(target_os = "android")]
        {
            let resolver = Arc::new(move |artifact_id: &str| {
                let artifact = crate::mobile_backend::mobile_sync_transport_artifact_file(
                    app.clone(),
                    artifact_id,
                )?;
                let media = artifact.media?;
                let content_type = content_type_for_format(&media.format)
                    .ok_or_else(|| "Media artifact is unavailable.".to_string())?;
                Ok(ResolvedMedia {
                    file: std::fs::File::open(media.path)
                        .map_err(|_| "Media artifact is unavailable.".to_string())?,
                    size_bytes: media.size_bytes,
                    content_type,
                })
            });
            return Ok(Self {
                resolver,
                server: Mutex::new(None),
            });
        }
        #[cfg(not(target_os = "android"))]
        {
            let _ = app;
            Ok(Self {
                server: Mutex::new(None),
            })
        }
    }

    pub fn shutdown(&self) {
        shutdown_server(&self.server);
    }

    fn base_url(&self) -> Result<String, String> {
        #[cfg(target_os = "android")]
        {
            return ensure_server_with(&self.server, || {
                ServerRuntime::start(self.resolver.clone())
            });
        }
        #[cfg(not(target_os = "android"))]
        {
            Err("Mobile media transport is unavailable.".to_string())
        }
    }
}

fn shutdown_server(server: &Mutex<Option<ServerRuntime>>) {
    let server = server
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .take();
    if let Some(server) = server {
        server.shutdown();
    }
}

#[tauri::command]
pub fn mobile_media_base_url(
    state: tauri::State<'_, MobileMediaTransportState>,
) -> Result<String, String> {
    state.base_url()
}

#[cfg(any(target_os = "android", test))]
fn ensure_server_with(
    server: &Mutex<Option<ServerRuntime>>,
    start: impl FnOnce() -> Result<ServerRuntime, String>,
) -> Result<String, String> {
    let mut server = server
        .lock()
        .map_err(|_| "Mobile media transport could not start.".to_string())?;
    if let Some(server) = server.as_ref() {
        return Ok(server.base_url.clone());
    }
    let started = start()?;
    let base_url = started.base_url.clone();
    *server = Some(started);
    Ok(base_url)
}

#[cfg(any(target_os = "android", test))]
fn worker_loop(
    worker_index: usize,
    receiver: Arc<Mutex<Receiver<TcpStream>>>,
    resolver: Resolver,
    artifact_route_prefix: Arc<str>,
    stop: Arc<AtomicBool>,
    active: Arc<Mutex<Vec<Option<TcpStream>>>>,
    stream_chunk_delay: Option<Duration>,
) {
    while !stop.load(Ordering::Acquire) {
        let stream = receiver
            .lock()
            .ok()
            .and_then(|receiver| receiver.recv_timeout(Duration::from_millis(100)).ok());
        if let Some(stream) = stream {
            let tracked = match stream.try_clone() {
                Ok(tracked) => tracked,
                Err(_) => continue,
            };
            if let Ok(mut sockets) = active.lock() {
                sockets[worker_index] = Some(tracked);
            }
            if stop.load(Ordering::Acquire) {
                let _ = stream.shutdown(Shutdown::Both);
            } else {
                let _ = serve(
                    stream,
                    &resolver,
                    &artifact_route_prefix,
                    &stop,
                    stream_chunk_delay,
                );
            }
            if let Ok(mut sockets) = active.lock() {
                sockets[worker_index] = None;
            }
        }
    }
}

#[cfg(any(target_os = "android", test))]
fn serve(
    mut stream: TcpStream,
    resolver: &Resolver,
    artifact_route_prefix: &str,
    stop: &AtomicBool,
    stream_chunk_delay: Option<Duration>,
) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(3)))?;
    stream.set_write_timeout(Some(Duration::from_secs(10)))?;
    let request = match read_request(&mut stream) {
        Ok(request) => request,
        Err(status) => return write_empty(&mut stream, status, &[], None),
    };
    let cors = match request.origin.as_deref() {
        Some(origin) if is_allowed_origin(origin) => Some(origin),
        Some(_) => return write_empty(&mut stream, 403, &[], None),
        None => None,
    };
    let artifact_id = match request.path.strip_prefix(artifact_route_prefix) {
        Some(value) if !value.is_empty() && !value.contains('/') => decode_path_segment(value),
        _ => return write_empty(&mut stream, 404, &[], cors),
    };
    let Some(artifact_id) = artifact_id else {
        return write_empty(&mut stream, 404, &[], cors);
    };
    if request.method == "OPTIONS" {
        if cors.is_none() || request.requested_headers.as_deref() != Some("range") {
            return write_empty(&mut stream, 403, &[], cors);
        }
        return write_empty(
            &mut stream,
            204,
            &[
                ("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS".into()),
                ("Access-Control-Allow-Headers", "Range".into()),
                ("Access-Control-Max-Age", "600".into()),
            ],
            cors,
        );
    }
    if request.method != "GET" && request.method != "HEAD" {
        return write_empty(
            &mut stream,
            405,
            &[("Allow", "GET, HEAD, OPTIONS".into())],
            cors,
        );
    }
    let mut media = match resolver(&artifact_id) {
        Ok(media) => media,
        Err(_) => return write_empty(&mut stream, 404, &[], cors),
    };
    let range = match request.range.as_deref() {
        Some(value) => match parse_range(value, media.size_bytes) {
            Ok(range) => Some(range),
            Err(()) => {
                return write_empty(
                    &mut stream,
                    416,
                    &[("Content-Range", format!("bytes */{}", media.size_bytes))],
                    cors,
                )
            }
        },
        None => None,
    };
    let (status, start, end) = range.map(|(start, end)| (206, start, end)).unwrap_or((
        200,
        0,
        media.size_bytes.saturating_sub(1),
    ));
    let length = if media.size_bytes == 0 {
        0
    } else {
        end - start + 1
    };
    let mut headers = vec![
        ("Accept-Ranges", "bytes".into()),
        ("Content-Length", length.to_string()),
        ("Content-Type", media.content_type.into()),
    ];
    if status == 206 {
        headers.push((
            "Content-Range",
            format!("bytes {start}-{end}/{}", media.size_bytes),
        ));
    }
    write_head(&mut stream, status, &headers, cors)?;
    if request.method == "HEAD" || length == 0 {
        return Ok(());
    }
    media.file.seek(SeekFrom::Start(start))?;
    let mut remaining = length;
    let mut buffer = [0_u8; STREAM_BUFFER_BYTES];
    while remaining > 0 {
        if stop.load(Ordering::Acquire) {
            return Ok(());
        }
        let count = media
            .file
            .read(&mut buffer[..remaining.min(STREAM_BUFFER_BYTES as u64) as usize])?;
        if count == 0 {
            break;
        }
        stream.write_all(&buffer[..count])?;
        remaining -= count as u64;
        if let Some(delay) = stream_chunk_delay {
            let deadline = std::time::Instant::now() + delay;
            while std::time::Instant::now() < deadline {
                if stop.load(Ordering::Acquire) {
                    return Ok(());
                }
                thread::sleep(Duration::from_millis(5));
            }
        }
    }
    Ok(())
}

#[cfg(any(target_os = "android", test))]
fn decode_path_segment(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let high = bytes.get(index + 1).and_then(|value| hex_digit(*value))?;
            let low = bytes.get(index + 2).and_then(|value| hex_digit(*value))?;
            decoded.push(high << 4 | low);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).ok()
}

#[cfg(any(target_os = "android", test))]
fn hex_digit(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

#[cfg(any(target_os = "android", test))]
fn content_type_for_format(format: &str) -> Option<&'static str> {
    match format.to_ascii_lowercase().as_str() {
        "aac" => Some("audio/aac"),
        "flac" => Some("audio/flac"),
        "m4a" | "mp4" => Some("audio/mp4"),
        "mka" => Some("audio/x-matroska"),
        "mkv" => Some("video/x-matroska"),
        "mp3" => Some("audio/mpeg"),
        "ogg" | "oga" | "opus" => Some("audio/ogg"),
        "wav" | "wave" => Some("audio/wav"),
        "webm" => Some("audio/webm"),
        _ => None,
    }
}

#[cfg(any(target_os = "android", test))]
struct Request {
    method: String,
    path: String,
    origin: Option<String>,
    range: Option<String>,
    requested_headers: Option<String>,
}

#[cfg(any(target_os = "android", test))]
fn read_request(stream: &mut TcpStream) -> Result<Request, u16> {
    let mut bytes = Vec::with_capacity(1024);
    let mut chunk = [0_u8; 1024];
    while !bytes.windows(4).any(|window| window == b"\r\n\r\n") {
        let count = stream.read(&mut chunk).map_err(|_| 408_u16)?;
        if count == 0 {
            return Err(400);
        }
        bytes.extend_from_slice(&chunk[..count]);
        if bytes.len() > MAX_REQUEST_BYTES {
            return Err(431);
        }
    }
    let text = std::str::from_utf8(&bytes).map_err(|_| 400_u16)?;
    let mut lines = text.split("\r\n");
    let mut parts = lines.next().ok_or(400_u16)?.split_whitespace();
    let method = parts.next().ok_or(400_u16)?.to_string();
    let path = parts.next().ok_or(400_u16)?.to_string();
    if parts
        .next()
        .filter(|value| value.starts_with("HTTP/1."))
        .is_none()
        || parts.next().is_some()
    {
        return Err(400);
    }
    let mut request = Request {
        method,
        path,
        origin: None,
        range: None,
        requested_headers: None,
    };
    for line in lines.take_while(|line| !line.is_empty()) {
        let (name, value) = line.split_once(':').ok_or(400_u16)?;
        let value = value.trim();
        match name.to_ascii_lowercase().as_str() {
            "origin" => request.origin = Some(value.to_string()),
            "range" => match request.range.as_mut() {
                Some(existing) => {
                    existing.push(',');
                    existing.push_str(value);
                }
                None => request.range = Some(value.to_string()),
            },
            "access-control-request-headers" => {
                request.requested_headers = Some(value.to_ascii_lowercase())
            }
            _ => {}
        }
    }
    Ok(request)
}

#[cfg(any(target_os = "android", test))]
fn parse_range(value: &str, length: u64) -> Result<(u64, u64), ()> {
    let value = value.strip_prefix("bytes=").ok_or(())?;
    if value.contains(',') || length == 0 {
        return Err(());
    }
    let (start, end) = value.split_once('-').ok_or(())?;
    if start.is_empty() {
        let suffix = end.parse::<u64>().map_err(|_| ())?;
        if suffix == 0 {
            return Err(());
        }
        return Ok((length.saturating_sub(suffix), length - 1));
    }
    let start = start.parse::<u64>().map_err(|_| ())?;
    let end = if end.is_empty() {
        length - 1
    } else {
        end.parse::<u64>().map_err(|_| ())?.min(length - 1)
    };
    if start >= length || end < start {
        return Err(());
    }
    Ok((start, end))
}

#[cfg(any(target_os = "android", test))]
fn is_allowed_origin(origin: &str) -> bool {
    matches!(
        origin,
        "http://tauri.localhost"
            | "https://tauri.localhost"
            | "http://127.0.0.1:1420"
            | "http://localhost:1420"
    )
}

#[cfg(any(target_os = "android", test))]
fn write_empty(
    stream: &mut TcpStream,
    status: u16,
    headers: &[(&str, String)],
    origin: Option<&str>,
) -> std::io::Result<()> {
    let mut headers = headers.to_vec();
    headers.push(("Content-Length", "0".into()));
    write_head(stream, status, &headers, origin)
}

#[cfg(any(target_os = "android", test))]
fn write_head(
    stream: &mut TcpStream,
    status: u16,
    headers: &[(&str, String)],
    origin: Option<&str>,
) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        204 => "No Content",
        206 => "Partial Content",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        408 => "Request Timeout",
        416 => "Range Not Satisfiable",
        431 => "Request Header Fields Too Large",
        _ => "Error",
    };
    write!(stream, "HTTP/1.1 {status} {reason}\r\nVary: Origin\r\n")?;
    if let Some(origin) = origin {
        write!(stream, "Access-Control-Allow-Origin: {origin}\r\n")?;
        write!(
            stream,
            "Access-Control-Expose-Headers: Accept-Ranges, Content-Length, Content-Range\r\n"
        )?;
    }
    for (name, value) in headers {
        write!(stream, "{name}: {value}\r\n")?;
    }
    write!(stream, "Connection: close\r\n\r\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        path::{Path, PathBuf},
        sync::atomic::{AtomicU64, AtomicUsize},
        time::Instant,
    };

    const ID: &str = "art_0123456789ab";
    const MANIFEST_ID: &str = "manifest/source v1";
    const ORIGIN: &str = "http://tauri.localhost";
    static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(1);

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            loop {
                let sequence = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
                let path = std::env::temp_dir().join(format!(
                    "tuneforge-mobile-media-{}-{sequence}",
                    std::process::id()
                ));
                match fs::create_dir(&path) {
                    Ok(()) => return Self(path),
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                    Err(error) => panic!("create exclusive test directory: {error}"),
                }
            }
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn resolver(path: &Path, content_type: &'static str) -> Resolver {
        let resolver_path = path.to_path_buf();
        Arc::new(move |artifact_id| {
            if artifact_id != ID && artifact_id != MANIFEST_ID {
                return Err("unavailable".into());
            }
            Ok(ResolvedMedia {
                file: std::fs::File::open(&resolver_path).unwrap(),
                size_bytes: fs::metadata(&resolver_path).unwrap().len(),
                content_type,
            })
        })
    }

    fn start_server(path: &Path, content_type: &'static str) -> ServerRuntime {
        ServerRuntime::start(resolver(path, content_type)).unwrap()
    }

    struct Fixture {
        server: ServerRuntime,
        _directory: TestDirectory,
        bytes: Vec<u8>,
    }

    #[test]
    fn lazy_server_starts_once_for_concurrent_callers() {
        let directory = TestDirectory::new();
        let path = directory.0.join("fixture.wav");
        fs::write(&path, b"media").unwrap();
        let server = Arc::new(Mutex::new(None));
        let starts = Arc::new(AtomicUsize::new(0));
        let mut callers = Vec::new();
        for _ in 0..8 {
            let server = server.clone();
            let starts = starts.clone();
            let resolver = resolver(&path, "audio/wav");
            callers.push(thread::spawn(move || {
                ensure_server_with(&server, || {
                    starts.fetch_add(1, Ordering::Relaxed);
                    ServerRuntime::start(resolver)
                })
                .unwrap()
            }));
        }
        let urls = callers
            .into_iter()
            .map(|caller| caller.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(starts.load(Ordering::Relaxed), 1);
        assert!(urls.iter().all(|url| url == &urls[0]));
        server.lock().unwrap().take().unwrap().shutdown();
    }

    #[test]
    fn lazy_server_can_retry_after_start_failure() {
        let directory = TestDirectory::new();
        let path = directory.0.join("fixture.wav");
        fs::write(&path, b"media").unwrap();
        let server = Mutex::new(None);
        assert_eq!(
            ensure_server_with(&server, || Err("first start failed".to_string())),
            Err("first start failed".to_string())
        );
        assert!(server.lock().unwrap().is_none());

        let base_url = ensure_server_with(&server, || {
            ServerRuntime::start(resolver(&path, "audio/wav"))
        })
        .unwrap();
        assert_eq!(
            ensure_server_with(&server, || panic!("cached server should be reused")).unwrap(),
            base_url
        );
        shutdown_server(&server);
        shutdown_server(&server);
    }

    impl Fixture {
        fn new() -> Self {
            let directory = TestDirectory::new();
            let path = directory.0.join("fixture.wav");
            let bytes = (0..STREAM_BUFFER_BYTES * 3 + 17)
                .map(|index| (index % 251) as u8)
                .collect::<Vec<_>>();
            fs::write(&path, &bytes).unwrap();
            let server = start_server(&path, "audio/wav");
            Self {
                server,
                _directory: directory,
                bytes,
            }
        }

        fn artifact_path(&self, artifact_id: &str) -> String {
            let origin = format!("http://{}", self.server.address);
            format!(
                "{}/artifacts/{artifact_id}",
                self.server.base_url.strip_prefix(&origin).unwrap()
            )
        }

        fn request_text(&self, method: &str, headers: &str) -> String {
            format!(
                "{method} {} HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: {ORIGIN}\r\n{headers}\r\n",
                self.artifact_path(ID)
            )
        }

        fn exchange(&self, request: &str) -> Vec<u8> {
            let mut stream = TcpStream::connect(self.server.address).unwrap();
            stream.write_all(request.as_bytes()).unwrap();
            stream.shutdown(Shutdown::Write).unwrap();
            let mut response = Vec::new();
            stream.read_to_end(&mut response).unwrap();
            response
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            self.server.shutdown();
        }
    }

    fn split_response(response: &[u8]) -> (&str, &[u8]) {
        let split = response
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .unwrap();
        (
            std::str::from_utf8(&response[..split]).unwrap(),
            &response[split + 4..],
        )
    }

    fn active_connection_count(server: &ServerRuntime) -> usize {
        server.active.lock().unwrap().iter().flatten().count()
    }

    fn wait_for_active_connection(server: &ServerRuntime) {
        let deadline = Instant::now() + Duration::from_secs(1);
        while active_connection_count(server) == 0 {
            assert!(
                Instant::now() < deadline,
                "worker did not accept test connection"
            );
            thread::yield_now();
        }
    }

    #[test]
    fn serves_full_head_options_and_rejects_methods_and_origins() {
        let fixture = Fixture::new();
        let response = fixture.exchange(&fixture.request_text("GET", ""));
        let (headers, body) = split_response(&response);
        assert!(headers.starts_with("HTTP/1.1 200"));
        assert!(headers.contains("Accept-Ranges: bytes"));
        assert!(headers.contains("Content-Type: audio/wav"));
        assert!(headers.contains(&format!("Content-Length: {}", fixture.bytes.len())));
        assert!(headers.contains(&format!("Access-Control-Allow-Origin: {ORIGIN}")));
        assert!(headers.contains("Vary: Origin"));
        assert_eq!(body, fixture.bytes);

        let response = fixture.exchange(&fixture.request_text("HEAD", ""));
        let (headers, body) = split_response(&response);
        assert!(headers.starts_with("HTTP/1.1 200"));
        assert!(body.is_empty());

        let response = fixture.exchange(
            &fixture.request_text("OPTIONS", "Access-Control-Request-Headers: Range\r\n"),
        );
        let (headers, body) = split_response(&response);
        assert!(headers.starts_with("HTTP/1.1 204"));
        assert!(headers.contains("Access-Control-Allow-Headers: Range"));
        assert!(body.is_empty());

        assert!(
            split_response(&fixture.exchange(&fixture.request_text("POST", "")))
                .0
                .starts_with("HTTP/1.1 405")
        );
        let unknown = fixture
            .request_text("GET", "")
            .replace(ID, "manifest-preserved-unknown");
        assert!(split_response(&fixture.exchange(&unknown))
            .0
            .starts_with("HTTP/1.1 404"));
        let foreign = fixture
            .request_text("GET", "")
            .replace(ORIGIN, "https://example.invalid");
        assert!(split_response(&fixture.exchange(&foreign))
            .0
            .starts_with("HTTP/1.1 403"));
        let missing = fixture
            .request_text("GET", "")
            .replace(&format!("Origin: {ORIGIN}\r\n"), "");
        let response = fixture.exchange(&missing);
        let (headers, body) = split_response(&response);
        assert!(headers.starts_with("HTTP/1.1 200"));
        assert!(!headers.contains("Access-Control-Allow-Origin"));
        assert_eq!(body, fixture.bytes);

        let manifest_request = fixture
            .request_text("GET", "")
            .replace(ID, "manifest%2Fsource%20v1");
        let response = fixture.exchange(&manifest_request);
        let (headers, body) = split_response(&response);
        assert!(headers.starts_with("HTTP/1.1 200"));
        assert_eq!(body, fixture.bytes);

        for invalid_path in [
            format!("/artifacts/{ID}"),
            format!("/{}/artifacts/{ID}", "f".repeat(64)),
        ] {
            let request = format!(
                "GET {invalid_path} HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: {ORIGIN}\r\n\r\n"
            );
            let response = fixture.exchange(&request);
            let (headers, body) = split_response(&response);
            assert!(headers.starts_with("HTTP/1.1 404"));
            assert!(body.is_empty());
        }
        assert_eq!(content_type_for_format("aac"), Some("audio/aac"));
        assert_eq!(content_type_for_format("webm"), Some("audio/webm"));
        assert_eq!(content_type_for_format("m4a"), Some("audio/mp4"));
    }

    #[test]
    fn serves_closed_open_and_suffix_ranges_without_a_response_cap() {
        let fixture = Fixture::new();
        for (range, start, end) in [
            ("bytes=10-19", 10, 19),
            ("bytes=65530-", 65530, fixture.bytes.len() - 1),
            (
                "bytes=-25",
                fixture.bytes.len() - 25,
                fixture.bytes.len() - 1,
            ),
        ] {
            let response =
                fixture.exchange(&fixture.request_text("GET", &format!("Range: {range}\r\n")));
            let (headers, body) = split_response(&response);
            assert!(headers.starts_with("HTTP/1.1 206"));
            assert!(headers.contains(&format!(
                "Content-Range: bytes {start}-{end}/{}",
                fixture.bytes.len()
            )));
            assert_eq!(body, &fixture.bytes[start..=end]);
        }
        assert!(fixture.bytes.len() > STREAM_BUFFER_BYTES * 3);
        assert!(STREAM_BUFFER_BYTES <= 64 * 1024);
    }

    #[test]
    fn rejects_malformed_multiple_and_unsatisfiable_ranges_and_shuts_down() {
        let fixture = Fixture::new();
        for headers in [
            "Range: items=0-1\r\n".to_string(),
            "Range: bytes=1-2,4-5\r\n".to_string(),
            "Range: bytes=1-2\r\nRange: bytes=4-5\r\n".to_string(),
            "Range: bytes=999999-\r\n".to_string(),
            "Range: bytes=-0\r\n".to_string(),
        ] {
            let response = fixture.exchange(&fixture.request_text("GET", &headers));
            let (headers, body) = split_response(&response);
            assert!(headers.starts_with("HTTP/1.1 416"));
            assert!(headers.contains(&format!("Content-Range: bytes */{}", fixture.bytes.len())));
            assert!(body.is_empty());
        }
        let address = fixture.server.address;
        fixture.server.shutdown();
        assert!(TcpStream::connect(address).is_err());
    }

    #[test]
    fn shutdown_interrupts_an_incomplete_request() {
        let fixture = Fixture::new();
        let mut stream = TcpStream::connect(fixture.server.address).unwrap();
        write!(
            stream,
            "GET {} HTTP/1.1\r\nHost: 127.0.0.1\r\n",
            fixture.artifact_path(ID)
        )
        .unwrap();
        wait_for_active_connection(&fixture.server);

        let started = Instant::now();
        fixture.server.shutdown();
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn shutdown_interrupts_a_stalled_large_response() {
        let directory = TestDirectory::new();
        let path = directory.0.join("large.wav");
        std::fs::File::create(&path)
            .unwrap()
            .set_len(16 * 1024 * 1024)
            .unwrap();
        let server = ServerRuntime::start_internal(
            resolver(&path, "audio/wav"),
            Some(Duration::from_millis(250)),
        )
        .unwrap();
        let origin = format!("http://{}", server.address);
        let route = format!(
            "{}/artifacts/{ID}",
            server.base_url.strip_prefix(&origin).unwrap()
        );
        let mut stream = TcpStream::connect(server.address).unwrap();
        write!(
            stream,
            "GET {route} HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: {ORIGIN}\r\n\r\n"
        )
        .unwrap();
        wait_for_active_connection(&server);
        thread::sleep(Duration::from_millis(50));
        assert_eq!(active_connection_count(&server), 1);

        let started = Instant::now();
        server.shutdown();
        assert!(started.elapsed() < Duration::from_secs(1));
        drop(stream);
    }
}
