use serde::{Deserialize, Serialize};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

#[cfg(any(target_os = "linux", target_os = "macos"))]
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
#[cfg(any(target_os = "linux", target_os = "macos"))]
use tauri::Emitter;

use super::{AudioCapabilities, AUDIO_EVENT_INPUT_FRAME};

const DEFAULT_INPUT_DEVICE_ID: &str = "default";
const INPUT_FRAME_SAMPLES: usize = 2048;
const INPUT_FRAME_HOP_SAMPLES: usize = 1024;
const INPUT_FRAME_EVENT_INTERVAL: Duration = Duration::from_millis(30);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioInputDevice {
    pub id: String,
    pub label: String,
    pub is_default: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioInputDevices {
    pub supported: bool,
    pub devices: Vec<AudioInputDevice>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioOutputDevice {
    pub id: String,
    pub label: String,
    pub is_default: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioOutputDevices {
    pub supported: bool,
    pub devices: Vec<AudioOutputDevice>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioInputRequest {
    pub device_id: Option<String>,
    pub monitor_enabled: Option<bool>,
    pub monitor_gain: Option<f32>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioMonitorRequest {
    pub enabled: bool,
    pub gain: Option<f32>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioInputState {
    pub active: bool,
    pub device_id: Option<String>,
    pub monitor_enabled: bool,
    pub monitor_gain: f32,
    pub input_level: f32,
    pub sample_rate: Option<u32>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioInputFrame {
    pub device_id: Option<String>,
    pub sample_rate: u32,
    pub input_level: f32,
    pub samples: Vec<f32>,
    pub timestamp_ms: u64,
}

pub struct CaptureState {
    active: bool,
    device_id: Option<String>,
    monitor_enabled: bool,
    monitor_gain: f32,
    input_level: f32,
    sample_rate: Option<u32>,
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    runtime: Option<CaptureRuntime>,
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
struct CaptureRuntime {
    stop_sender: mpsc::Sender<CaptureControl>,
    shared: Arc<Mutex<CaptureSharedState>>,
    worker_thread: Option<JoinHandle<()>>,
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
struct CaptureRuntime;

#[derive(Default)]
struct CaptureSharedState {
    input_level: f32,
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
enum CaptureControl {
    Stop,
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
struct CaptureStreamStartup {
    effective_device_id: String,
    sample_rate: u32,
    stream: cpal::Stream,
    frame_receiver: mpsc::Receiver<AudioInputFrame>,
}

impl Default for CaptureState {
    fn default() -> Self {
        Self {
            active: false,
            device_id: None,
            monitor_enabled: false,
            monitor_gain: 0.0,
            input_level: 0.0,
            sample_rate: None,
            #[cfg(any(target_os = "linux", target_os = "macos"))]
            runtime: None,
        }
    }
}

impl CaptureState {
    pub fn list_devices(&self, capabilities: AudioCapabilities) -> AudioInputDevices {
        if !capabilities.mic_capture_supported {
            return AudioInputDevices {
                supported: false,
                devices: Vec::new(),
                error: Some("Native microphone capture is not wired yet.".to_string()),
            };
        }

        match list_desktop_input_devices() {
            Ok(devices) => AudioInputDevices {
                supported: true,
                devices,
                error: None,
            },
            Err(error) => AudioInputDevices {
                supported: false,
                devices: Vec::new(),
                error: Some(error),
            },
        }
    }

    pub fn list_output_devices(&self, capabilities: AudioCapabilities) -> AudioOutputDevices {
        if !capabilities.native_playback_supported {
            return AudioOutputDevices {
                supported: false,
                devices: Vec::new(),
                error: Some("Native audio output device discovery is not wired yet.".to_string()),
            };
        }

        AudioOutputDevices {
            supported: true,
            devices: Vec::new(),
            error: None,
        }
    }

    pub fn start(
        &mut self,
        app: AppHandle,
        request: AudioInputRequest,
    ) -> Result<AudioInputState, String> {
        self.stop_runtime();
        self.monitor_enabled = request.monitor_enabled.unwrap_or(false);
        self.monitor_gain = normalize_gain(request.monitor_gain);
        self.input_level = 0.0;

        let (device_id, sample_rate, runtime) = start_desktop_input(app, request.device_id)?;
        self.active = true;
        self.device_id = Some(device_id);
        self.sample_rate = Some(sample_rate);
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        {
            self.runtime = Some(runtime);
        }
        Ok(self.state())
    }

    pub fn stop(&mut self) -> AudioInputState {
        self.stop_runtime();
        self.active = false;
        self.input_level = 0.0;
        self.sample_rate = None;
        self.state()
    }

    pub fn set_monitor(&mut self, request: AudioMonitorRequest) -> AudioInputState {
        self.monitor_enabled = request.enabled;
        self.monitor_gain = normalize_gain(request.gain);
        self.state()
    }

    pub fn state(&self) -> AudioInputState {
        AudioInputState {
            active: self.active,
            device_id: self.device_id.clone(),
            monitor_enabled: self.monitor_enabled,
            monitor_gain: self.monitor_gain,
            input_level: self.current_input_level(),
            sample_rate: self.sample_rate,
        }
    }

    fn current_input_level(&self) -> f32 {
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        if let Some(runtime) = &self.runtime {
            if let Ok(shared) = runtime.shared.lock() {
                return shared.input_level;
            }
        }

        self.input_level
    }

    fn stop_runtime(&mut self) {
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        if let Some(mut runtime) = self.runtime.take() {
            let _ = runtime.stop_sender.send(CaptureControl::Stop);
            if let Some(worker_thread) = runtime.worker_thread.take() {
                let _ = worker_thread.join();
            }
        }
    }
}

impl Drop for CaptureState {
    fn drop(&mut self) {
        self.stop_runtime();
    }
}

fn normalize_gain(value: Option<f32>) -> f32 {
    value.unwrap_or(0.0).clamp(0.0, 1.0)
}

fn calculate_input_level(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum_squares = samples.iter().map(|sample| sample * sample).sum::<f32>();
    (sum_squares / samples.len() as f32).sqrt().clamp(0.0, 1.0)
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
struct DesktopInputDeviceDescriptor {
    exposed_id: String,
    stable_hash: u64,
    label: String,
    cpal_id: Option<cpal::DeviceId>,
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn list_desktop_input_devices() -> Result<Vec<AudioInputDevice>, String> {
    let host = cpal::default_host();
    let default_device_id = host
        .default_input_device()
        .and_then(|device| device.id().ok());
    let devices = host
        .input_devices()
        .map_err(|error| format!("Could not list native input devices: {error}"))?;
    let mut marked_default = false;

    Ok(devices
        .enumerate()
        .map(|(index, device)| {
            let descriptor = describe_desktop_input_device(index, &device);
            let is_default =
                !marked_default && descriptor.cpal_id.as_ref() == default_device_id.as_ref();
            if is_default {
                marked_default = true;
            }
            AudioInputDevice {
                id: descriptor.exposed_id,
                label: descriptor.label,
                is_default,
            }
        })
        .collect())
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn list_desktop_input_devices() -> Result<Vec<AudioInputDevice>, String> {
    Err("Native microphone capture is only available on macOS and Linux.".to_string())
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn start_desktop_input(
    app: AppHandle,
    requested_device_id: Option<String>,
) -> Result<(String, u32, CaptureRuntime), String> {
    let (ready_sender, ready_receiver) = mpsc::sync_channel(1);
    let (stop_sender, stop_receiver) = mpsc::channel();
    let shared = Arc::new(Mutex::new(CaptureSharedState::default()));
    let worker_shared = Arc::clone(&shared);
    let worker_thread = thread::spawn(move || {
        run_capture_worker(
            app,
            requested_device_id,
            ready_sender,
            stop_receiver,
            worker_shared,
        );
    });

    match ready_receiver
        .recv()
        .map_err(|_| "Native input worker stopped before startup completed.".to_string())?
    {
        Ok((effective_device_id, sample_rate)) => Ok((
            effective_device_id,
            sample_rate,
            CaptureRuntime {
                stop_sender,
                shared,
                worker_thread: Some(worker_thread),
            },
        )),
        Err(error) => {
            let _ = worker_thread.join();
            Err(error)
        }
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn run_capture_worker(
    app: AppHandle,
    requested_device_id: Option<String>,
    ready_sender: mpsc::SyncSender<Result<(String, u32), String>>,
    stop_receiver: mpsc::Receiver<CaptureControl>,
    shared: Arc<Mutex<CaptureSharedState>>,
) {
    let startup = start_capture_stream(requested_device_id, shared);
    match startup {
        Ok(startup) => {
            let _ = ready_sender.send(Ok((startup.effective_device_id, startup.sample_rate)));
            emit_input_frames(app, startup.frame_receiver, stop_receiver, startup.stream);
        }
        Err(error) => {
            let _ = ready_sender.send(Err(error));
        }
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn start_capture_stream(
    requested_device_id: Option<String>,
    shared: Arc<Mutex<CaptureSharedState>>,
) -> Result<CaptureStreamStartup, String> {
    let host = cpal::default_host();
    let (device, effective_device_id) = select_input_device(&host, requested_device_id.as_deref())?;
    let supported_config = device
        .default_input_config()
        .map_err(|error| format!("Could not open native input configuration: {error}"))?;
    let sample_format = supported_config.sample_format();
    let config: cpal::StreamConfig = supported_config.into();
    let sample_rate = config.sample_rate;
    let channels = usize::from(config.channels.max(1));
    let (sender, receiver) = mpsc::sync_channel::<AudioInputFrame>(2);
    let device_id = Some(effective_device_id.clone());

    let stream = match sample_format {
        cpal::SampleFormat::I8 => build_input_stream(
            &device,
            &config,
            channels,
            sample_rate,
            device_id.clone(),
            sender.clone(),
            Arc::clone(&shared),
            convert_i8_sample,
        ),
        cpal::SampleFormat::F32 => build_input_stream(
            &device,
            &config,
            channels,
            sample_rate,
            device_id.clone(),
            sender.clone(),
            Arc::clone(&shared),
            convert_f32_sample,
        ),
        cpal::SampleFormat::I16 => build_input_stream(
            &device,
            &config,
            channels,
            sample_rate,
            device_id.clone(),
            sender.clone(),
            Arc::clone(&shared),
            convert_i16_sample,
        ),
        cpal::SampleFormat::I32 => build_input_stream(
            &device,
            &config,
            channels,
            sample_rate,
            device_id.clone(),
            sender.clone(),
            Arc::clone(&shared),
            convert_i32_sample,
        ),
        cpal::SampleFormat::I64 => build_input_stream(
            &device,
            &config,
            channels,
            sample_rate,
            device_id.clone(),
            sender.clone(),
            Arc::clone(&shared),
            convert_i64_sample,
        ),
        cpal::SampleFormat::U8 => build_input_stream(
            &device,
            &config,
            channels,
            sample_rate,
            device_id.clone(),
            sender.clone(),
            Arc::clone(&shared),
            convert_u8_sample,
        ),
        cpal::SampleFormat::U16 => build_input_stream(
            &device,
            &config,
            channels,
            sample_rate,
            device_id,
            sender,
            Arc::clone(&shared),
            convert_u16_sample,
        ),
        cpal::SampleFormat::U32 => build_input_stream(
            &device,
            &config,
            channels,
            sample_rate,
            device_id.clone(),
            sender.clone(),
            Arc::clone(&shared),
            convert_u32_sample,
        ),
        cpal::SampleFormat::U64 => build_input_stream(
            &device,
            &config,
            channels,
            sample_rate,
            device_id.clone(),
            sender.clone(),
            Arc::clone(&shared),
            convert_u64_sample,
        ),
        cpal::SampleFormat::F64 => build_input_stream(
            &device,
            &config,
            channels,
            sample_rate,
            device_id,
            sender,
            Arc::clone(&shared),
            convert_f64_sample,
        ),
        unsupported => Err(format!(
            "Unsupported native input sample format: {unsupported:?}."
        )),
    }?;

    stream
        .play()
        .map_err(|error| format!("Could not start native input stream: {error}"))?;

    Ok(CaptureStreamStartup {
        effective_device_id,
        sample_rate,
        stream,
        frame_receiver: receiver,
    })
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn start_desktop_input(
    _app: AppHandle,
    _requested_device_id: Option<String>,
) -> Result<(String, u32, CaptureRuntime), String> {
    Err("Native microphone capture is only available on macOS and Linux.".to_string())
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn select_input_device(
    host: &cpal::Host,
    requested_device_id: Option<&str>,
) -> Result<(cpal::Device, String), String> {
    let requested_device_id = requested_device_id.filter(|device_id| !device_id.is_empty());
    if requested_device_id.is_none() || requested_device_id == Some(DEFAULT_INPUT_DEVICE_ID) {
        let device = host
            .default_input_device()
            .ok_or_else(|| "No default native input device is available.".to_string())?;
        return Ok((device, DEFAULT_INPUT_DEVICE_ID.to_string()));
    }

    let requested_device_id = requested_device_id.unwrap_or(DEFAULT_INPUT_DEVICE_ID);
    let requested_hash = native_input_device_hash(requested_device_id);
    let devices = host
        .input_devices()
        .map_err(|error| format!("Could not list native input devices: {error}"))?;
    let mut hash_match: Option<(cpal::Device, String)> = None;

    for (index, device) in devices.enumerate() {
        let descriptor = describe_desktop_input_device(index, &device);
        if descriptor.exposed_id == requested_device_id {
            return Ok((device, descriptor.exposed_id));
        }
        if requested_hash == Some(descriptor.stable_hash) && hash_match.is_none() {
            hash_match = Some((device, descriptor.exposed_id));
        }
    }

    hash_match.ok_or_else(|| "Selected native input device was not found.".to_string())
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn build_input_stream<T, F>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    channels: usize,
    sample_rate: u32,
    device_id: Option<String>,
    sender: mpsc::SyncSender<AudioInputFrame>,
    shared: Arc<Mutex<CaptureSharedState>>,
    convert_sample: F,
) -> Result<cpal::Stream, String>
where
    T: cpal::SizedSample + Copy + Send + 'static,
    F: Fn(T) -> f32 + Copy + Send + 'static,
{
    let mut pending_samples = Vec::with_capacity(INPUT_FRAME_SAMPLES + INPUT_FRAME_HOP_SAMPLES);
    device
        .build_input_stream(
            config,
            move |data: &[T], _| {
                process_interleaved_input(
                    data,
                    channels,
                    sample_rate,
                    device_id.clone(),
                    &sender,
                    &shared,
                    convert_sample,
                    &mut pending_samples,
                );
            },
            |error| eprintln!("Native microphone input stream error: {error}"),
            None,
        )
        .map_err(|error| format!("Could not build native input stream: {error}"))
}

fn process_interleaved_input<T, F>(
    data: &[T],
    channels: usize,
    sample_rate: u32,
    device_id: Option<String>,
    sender: &mpsc::SyncSender<AudioInputFrame>,
    shared: &Arc<Mutex<CaptureSharedState>>,
    convert_sample: F,
    pending_samples: &mut Vec<f32>,
) where
    T: Copy,
    F: Fn(T) -> f32,
{
    append_mono_samples(data, channels, convert_sample, pending_samples);

    while pending_samples.len() >= INPUT_FRAME_SAMPLES {
        let samples = pending_samples[..INPUT_FRAME_SAMPLES].to_vec();
        let input_level = calculate_input_level(&samples);
        if let Ok(mut shared) = shared.lock() {
            shared.input_level = input_level;
        }
        let _ = sender.try_send(AudioInputFrame {
            device_id: device_id.clone(),
            sample_rate,
            input_level,
            samples,
            timestamp_ms: current_timestamp_ms(),
        });
        pending_samples.drain(..INPUT_FRAME_HOP_SAMPLES.min(pending_samples.len()));
    }
}

fn append_mono_samples<T, F>(
    data: &[T],
    channels: usize,
    convert_sample: F,
    pending_samples: &mut Vec<f32>,
) where
    T: Copy,
    F: Fn(T) -> f32,
{
    if channels == 0 {
        return;
    }

    for frame in data.chunks(channels) {
        let sum = frame
            .iter()
            .map(|sample| convert_sample(*sample))
            .sum::<f32>();
        pending_samples.push((sum / frame.len() as f32).clamp(-1.0, 1.0));
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn emit_input_frames(
    app: AppHandle,
    receiver: mpsc::Receiver<AudioInputFrame>,
    stop_receiver: mpsc::Receiver<CaptureControl>,
    _stream: cpal::Stream,
) {
    let mut last_emit_at = Instant::now() - INPUT_FRAME_EVENT_INTERVAL;
    loop {
        if stop_receiver.try_recv().is_ok() {
            break;
        }
        match receiver.recv_timeout(INPUT_FRAME_EVENT_INTERVAL) {
            Ok(frame) => {
                if last_emit_at.elapsed() < INPUT_FRAME_EVENT_INTERVAL {
                    continue;
                }
                last_emit_at = Instant::now();
                let _ = app.emit(AUDIO_EVENT_INPUT_FRAME, frame);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
}

fn convert_f32_sample(sample: f32) -> f32 {
    sample.clamp(-1.0, 1.0)
}

fn convert_f64_sample(sample: f64) -> f32 {
    sample.clamp(-1.0, 1.0) as f32
}

fn convert_i8_sample(sample: i8) -> f32 {
    (sample as f32 / i8::MAX as f32).clamp(-1.0, 1.0)
}

fn convert_i16_sample(sample: i16) -> f32 {
    (sample as f32 / i16::MAX as f32).clamp(-1.0, 1.0)
}

fn convert_i32_sample(sample: i32) -> f32 {
    (sample as f32 / i32::MAX as f32).clamp(-1.0, 1.0)
}

fn convert_i64_sample(sample: i64) -> f32 {
    (sample as f64 / i64::MAX as f64).clamp(-1.0, 1.0) as f32
}

fn convert_u8_sample(sample: u8) -> f32 {
    ((sample as f32 - 128.0) / 128.0).clamp(-1.0, 1.0)
}

fn convert_u16_sample(sample: u16) -> f32 {
    ((sample as f32 - 32768.0) / 32768.0).clamp(-1.0, 1.0)
}

fn convert_u32_sample(sample: u32) -> f32 {
    ((sample as f64 - 2_147_483_648.0) / 2_147_483_648.0).clamp(-1.0, 1.0) as f32
}

fn convert_u64_sample(sample: u64) -> f32 {
    ((sample as f64 - 9_223_372_036_854_775_808.0) / 9_223_372_036_854_775_808.0).clamp(-1.0, 1.0)
        as f32
}

#[cfg(test)]
fn native_input_device_id(index: usize, label: &str) -> String {
    native_input_device_id_from_hash(index, stable_name_hash(label))
}

fn native_input_device_id_from_hash(index: usize, hash: u64) -> String {
    format!("cpal:{index}:{hash:016x}")
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn describe_desktop_input_device(
    index: usize,
    device: &cpal::Device,
) -> DesktopInputDeviceDescriptor {
    let label = device
        .description()
        .map(|description| description.name().trim().to_string())
        .ok()
        .filter(|label| !label.is_empty())
        .unwrap_or_else(|| format!("Input Device {}", index + 1));

    let cpal_id = device.id().ok();
    let stable_hash = stable_name_hash(native_input_device_hash_source(&label, cpal_id.as_ref()));

    DesktopInputDeviceDescriptor {
        exposed_id: native_input_device_id_from_hash(index, stable_hash),
        stable_hash,
        label,
        cpal_id,
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn native_input_device_hash_source<'a>(
    label: &'a str,
    cpal_id: Option<&'a cpal::DeviceId>,
) -> &'a str {
    native_input_device_hash_source_for_platform(
        label,
        cpal_id.map(|device_id| device_id.1.as_str()),
        cfg!(target_os = "linux"),
    )
}

fn native_input_device_hash_source_for_platform<'a>(
    label: &'a str,
    backend_device_id: Option<&'a str>,
    prefer_backend_device_id: bool,
) -> &'a str {
    if prefer_backend_device_id {
        if let Some(backend_device_id) =
            backend_device_id.filter(|device_id| !device_id.trim().is_empty())
        {
            return backend_device_id;
        }
    }
    label
}

fn native_input_device_hash(device_id: &str) -> Option<u64> {
    let mut parts = device_id.split(':');
    if parts.next()? != "cpal" {
        return None;
    }
    let _index = parts.next()?;
    u64::from_str_radix(parts.next()?, 16).ok()
}

fn stable_name_hash(value: &str) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

fn current_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn capabilities(
        native_playback_supported: bool,
        mic_capture_supported: bool,
    ) -> AudioCapabilities {
        AudioCapabilities {
            platform: "test",
            backend: "test",
            native_playback_supported,
            mic_capture_supported,
            mic_monitoring_supported: false,
            system_input_volume_supported: false,
            emits_events: Vec::new(),
            fallback_required: !native_playback_supported,
            fallback_reason: None,
        }
    }

    #[test]
    fn list_input_devices_reports_unsupported_when_capture_not_wired() {
        let state = CaptureState::default();

        let devices = state.list_devices(capabilities(false, false));

        assert!(!devices.supported);
        assert!(devices.devices.is_empty());
        assert_eq!(
            devices.error,
            Some("Native microphone capture is not wired yet.".to_string())
        );
    }

    #[test]
    fn list_output_devices_reports_unsupported_when_playback_not_wired() {
        let state = CaptureState::default();

        let devices = state.list_output_devices(capabilities(false, false));

        assert!(!devices.supported);
        assert!(devices.devices.is_empty());
        assert_eq!(
            devices.error,
            Some("Native audio output device discovery is not wired yet.".to_string())
        );
    }

    #[test]
    fn list_output_devices_returns_empty_supported_skeleton_when_playback_wired() {
        let state = CaptureState::default();

        let devices = state.list_output_devices(capabilities(true, false));

        assert!(devices.supported);
        assert!(devices.devices.is_empty());
        assert_eq!(devices.error, None);
    }

    #[test]
    fn gain_normalization_clamps_monitor_values() {
        assert_eq!(normalize_gain(Some(-0.1)), 0.0);
        assert_eq!(normalize_gain(Some(0.5)), 0.5);
        assert_eq!(normalize_gain(Some(2.0)), 1.0);
        assert_eq!(normalize_gain(None), 0.0);
    }

    #[test]
    fn sample_conversion_normalizes_common_formats() {
        assert_eq!(convert_f32_sample(2.0), 1.0);
        assert_eq!(convert_f64_sample(-2.0), -1.0);
        assert_eq!(convert_i8_sample(i8::MAX), 1.0);
        assert_eq!(convert_i8_sample(i8::MIN), -1.0);
        assert_eq!(convert_i16_sample(i16::MAX), 1.0);
        assert_eq!(convert_i16_sample(i16::MIN), -1.0);
        assert_eq!(convert_i32_sample(i32::MAX), 1.0);
        assert_eq!(convert_i32_sample(i32::MIN), -1.0);
        assert_eq!(convert_i64_sample(i64::MAX), 1.0);
        assert_eq!(convert_i64_sample(i64::MIN), -1.0);
        assert_eq!(convert_u8_sample(255), 0.9921875);
        assert_eq!(convert_u8_sample(0), -1.0);
        assert_eq!(convert_u16_sample(65535), 0.9999695);
        assert_eq!(convert_u16_sample(0), -1.0);
        assert!((convert_u32_sample(u32::MAX) - 1.0).abs() < 0.000001);
        assert_eq!(convert_u32_sample(0), -1.0);
        assert!((convert_u64_sample(u64::MAX) - 1.0).abs() < 0.000001);
        assert_eq!(convert_u64_sample(0), -1.0);
    }

    #[test]
    fn input_level_uses_rms() {
        let level = calculate_input_level(&[0.0, 0.5, -0.5, 0.0]);

        assert!((level - 0.35355338).abs() < 0.000001);
    }

    #[test]
    fn interleaved_samples_are_mixed_to_mono_frames() {
        let mut pending_samples = Vec::new();

        append_mono_samples(
            &[1.0_f32, -1.0, 0.5, 0.25],
            2,
            convert_f32_sample,
            &mut pending_samples,
        );

        assert_eq!(pending_samples, vec![0.0, 0.375]);
    }

    #[test]
    fn native_device_ids_match_reordered_same_name() {
        let original = native_input_device_id(0, "USB Interface");
        let reordered = native_input_device_id(2, "USB Interface");

        assert_eq!(
            native_input_device_hash(&original),
            native_input_device_hash(&reordered)
        );
        assert_ne!(original, reordered);
    }

    #[test]
    fn native_device_hash_source_can_preserve_linux_backend_ids() {
        let display_label = "USB Audio Interface";
        let legacy_backend_id = "alsa_input.usb-interface";
        let hash_source = native_input_device_hash_source_for_platform(
            display_label,
            Some(legacy_backend_id),
            true,
        );

        assert_eq!(hash_source, legacy_backend_id);
        assert_eq!(
            native_input_device_hash(&native_input_device_id_from_hash(
                0,
                stable_name_hash(hash_source),
            )),
            native_input_device_hash(&native_input_device_id(0, legacy_backend_id)),
        );
        assert_ne!(
            stable_name_hash(display_label),
            stable_name_hash(hash_source)
        );
    }

    #[test]
    fn native_device_hash_source_keeps_display_label_when_backend_id_is_not_preferred() {
        let display_label = "USB Audio Interface";

        assert_eq!(
            native_input_device_hash_source_for_platform(
                display_label,
                Some("coreaudio-device-uid"),
                false,
            ),
            display_label,
        );
    }

    #[test]
    fn stop_clears_active_status_and_level() {
        let mut state = CaptureState {
            active: true,
            device_id: Some("cpal:0:test".to_string()),
            monitor_enabled: false,
            monitor_gain: 0.0,
            input_level: 0.42,
            sample_rate: Some(48_000),
            #[cfg(any(target_os = "linux", target_os = "macos"))]
            runtime: None,
        };

        let stopped = state.stop();

        assert!(!stopped.active);
        assert_eq!(stopped.input_level, 0.0);
        assert_eq!(stopped.sample_rate, None);
    }
}
