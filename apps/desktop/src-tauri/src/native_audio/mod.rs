use serde::Serialize;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, State};

pub mod android_media;
pub mod capture;
pub mod decode;
pub mod mixer;
pub mod platform;
pub mod system_input;
pub mod transport;

pub const AUDIO_EVENT_STATE: &str = "audio://state";
pub const AUDIO_EVENT_POSITION: &str = "audio://position";
pub const AUDIO_EVENT_ENDED: &str = "audio://ended";
pub const AUDIO_EVENT_ERROR: &str = "audio://error";
pub const AUDIO_EVENT_INPUT_LEVEL: &str = "audio://input-level";
pub const AUDIO_EVENT_INPUT_FRAME: &str = "audio://input-frame";
pub const AUDIO_EVENT_DEVICES_CHANGED: &str = "audio://devices-changed";

#[derive(Clone)]
pub struct NativeAudioState {
    capabilities: AudioCapabilities,
    mixer: Arc<Mutex<mixer::MixerState>>,
    transport: Arc<Mutex<transport::TransportState>>,
    capture: Arc<Mutex<capture::CaptureState>>,
}

impl NativeAudioState {
    pub fn new() -> Self {
        Self {
            capabilities: AudioCapabilities::detect(),
            mixer: Arc::new(Mutex::new(mixer::MixerState::default())),
            transport: Arc::new(Mutex::new(transport::TransportState::default())),
            capture: Arc::new(Mutex::new(capture::CaptureState::default())),
        }
    }

    fn capabilities(&self) -> AudioCapabilities {
        self.capabilities.clone()
    }
}

impl Default for NativeAudioState {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioCapabilities {
    platform: &'static str,
    backend: &'static str,
    native_playback_supported: bool,
    mic_capture_supported: bool,
    mic_monitoring_supported: bool,
    system_input_volume_supported: bool,
    emits_events: Vec<&'static str>,
    fallback_required: bool,
    fallback_reason: Option<&'static str>,
}

impl AudioCapabilities {
    fn detect() -> Self {
        let platform = platform::current_platform();
        Self {
            platform: platform.name,
            backend: platform.backend,
            native_playback_supported: platform.native_playback_supported,
            mic_capture_supported: platform.mic_capture_supported,
            mic_monitoring_supported: platform.mic_monitoring_supported,
            system_input_volume_supported: platform.system_input_volume_supported,
            emits_events: vec![
                AUDIO_EVENT_STATE,
                AUDIO_EVENT_POSITION,
                AUDIO_EVENT_ENDED,
                AUDIO_EVENT_ERROR,
                AUDIO_EVENT_INPUT_LEVEL,
                AUDIO_EVENT_INPUT_FRAME,
                AUDIO_EVENT_DEVICES_CHANGED,
            ],
            fallback_required: !platform.native_playback_supported,
            fallback_reason: (!platform.native_playback_supported).then_some(
                "Native audio playback is not wired yet; use existing WebView playback.",
            ),
        }
    }
}

#[tauri::command]
pub fn audio_get_capabilities(state: State<'_, NativeAudioState>) -> AudioCapabilities {
    state.capabilities()
}

#[tauri::command]
pub async fn audio_prepare_session(
    app: AppHandle,
    state: State<'_, NativeAudioState>,
    payload: transport::AudioSessionRequest,
) -> Result<transport::AudioSession, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let effective_lanes = {
            let mut mixer = state
                .mixer
                .lock()
                .map_err(|_| "Native audio mixer state is unavailable.".to_string())?;
            mixer.set_lanes(payload.lanes.clone());
            mixer.effective_lanes()
        };

        let mut transport = state
            .transport
            .lock()
            .map_err(|_| "Native audio transport state is unavailable.".to_string())?;
        Ok(transport.prepare(Some(app), payload, effective_lanes, state.capabilities()))
    })
    .await
    .map_err(|error| format!("Native audio prepare task failed: {error}"))?
}

#[tauri::command]
pub fn audio_play(
    state: State<'_, NativeAudioState>,
    payload: transport::AudioPlayRequest,
) -> Result<transport::AudioSnapshot, String> {
    if !state.capabilities.native_playback_supported {
        return Err("Native audio playback is not available yet.".to_string());
    }

    let mut transport = state
        .transport
        .lock()
        .map_err(|_| "Native audio transport state is unavailable.".to_string())?;
    transport.play(payload)
}

#[tauri::command]
pub fn audio_pause(state: State<'_, NativeAudioState>) -> Result<transport::AudioSnapshot, String> {
    let mut transport = state
        .transport
        .lock()
        .map_err(|_| "Native audio transport state is unavailable.".to_string())?;
    Ok(transport.pause())
}

#[tauri::command]
pub fn audio_stop(state: State<'_, NativeAudioState>) -> Result<transport::AudioSnapshot, String> {
    let mut transport = state
        .transport
        .lock()
        .map_err(|_| "Native audio transport state is unavailable.".to_string())?;
    Ok(transport.stop())
}

#[tauri::command]
pub fn audio_seek(
    state: State<'_, NativeAudioState>,
    payload: transport::AudioSeekRequest,
) -> Result<transport::AudioSnapshot, String> {
    let mut transport = state
        .transport
        .lock()
        .map_err(|_| "Native audio transport state is unavailable.".to_string())?;
    Ok(transport.seek(payload))
}

#[tauri::command]
pub fn audio_set_lanes(
    state: State<'_, NativeAudioState>,
    payload: mixer::AudioLaneUpdate,
) -> Result<transport::AudioSnapshot, String> {
    let raw_lanes = payload.lanes;
    let effective_lanes = {
        let mut mixer = state
            .mixer
            .lock()
            .map_err(|_| "Native audio mixer state is unavailable.".to_string())?;
        mixer.set_lanes(raw_lanes.clone());
        mixer.effective_lanes()
    };
    let mut transport = state
        .transport
        .lock()
        .map_err(|_| "Native audio transport state is unavailable.".to_string())?;
    transport.set_lanes(raw_lanes, effective_lanes);
    Ok(transport.snapshot())
}

#[tauri::command]
pub fn audio_set_click(
    state: State<'_, NativeAudioState>,
    payload: transport::AudioClickRequest,
) -> Result<transport::AudioSnapshot, String> {
    let mut transport = state
        .transport
        .lock()
        .map_err(|_| "Native audio transport state is unavailable.".to_string())?;
    Ok(transport.set_click(payload))
}

#[tauri::command]
pub fn audio_get_snapshot(
    state: State<'_, NativeAudioState>,
) -> Result<transport::AudioSnapshot, String> {
    let transport = state
        .transport
        .lock()
        .map_err(|_| "Native audio transport state is unavailable.".to_string())?;
    Ok(transport.snapshot())
}

#[tauri::command]
pub fn audio_list_input_devices(
    state: State<'_, NativeAudioState>,
) -> Result<capture::AudioInputDevices, String> {
    let capture = state
        .capture
        .lock()
        .map_err(|_| "Native audio capture state is unavailable.".to_string())?;
    Ok(capture.list_devices(state.capabilities()))
}

#[tauri::command]
pub fn audio_list_output_devices(
    state: State<'_, NativeAudioState>,
) -> Result<capture::AudioOutputDevices, String> {
    let capture = state
        .capture
        .lock()
        .map_err(|_| "Native audio capture state is unavailable.".to_string())?;
    Ok(capture.list_output_devices(state.capabilities()))
}

#[tauri::command]
pub fn audio_get_input_state(
    state: State<'_, NativeAudioState>,
) -> Result<capture::AudioInputState, String> {
    let capture = state
        .capture
        .lock()
        .map_err(|_| "Native audio capture state is unavailable.".to_string())?;
    Ok(capture.state())
}

#[tauri::command]
pub fn audio_start_input(
    app: AppHandle,
    state: State<'_, NativeAudioState>,
    payload: capture::AudioInputRequest,
) -> Result<capture::AudioInputState, String> {
    if !state.capabilities.mic_capture_supported {
        return Err("Native microphone capture is not available yet.".to_string());
    }
    if !state.capabilities.mic_monitoring_supported && payload.monitor_enabled.unwrap_or(false) {
        return Err("Native microphone monitoring is not available yet.".to_string());
    }

    let mut capture = state
        .capture
        .lock()
        .map_err(|_| "Native audio capture state is unavailable.".to_string())?;
    capture.start(app, payload)
}

#[tauri::command]
pub fn audio_stop_input(
    state: State<'_, NativeAudioState>,
) -> Result<capture::AudioInputState, String> {
    let mut capture = state
        .capture
        .lock()
        .map_err(|_| "Native audio capture state is unavailable.".to_string())?;
    Ok(capture.stop())
}

#[tauri::command]
pub fn audio_set_monitor(
    state: State<'_, NativeAudioState>,
    payload: capture::AudioMonitorRequest,
) -> Result<capture::AudioInputState, String> {
    if !state.capabilities.mic_monitoring_supported && payload.enabled {
        return Err("Native microphone monitoring is not available yet.".to_string());
    }

    let mut capture = state
        .capture
        .lock()
        .map_err(|_| "Native audio capture state is unavailable.".to_string())?;
    Ok(capture.set_monitor(payload))
}
