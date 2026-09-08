use serde::Serialize;
use std::sync::{mpsc, Arc, Mutex, MutexGuard};
use tauri::{AppHandle, Emitter, State};

pub mod android_media;
pub mod capture;
pub mod decode;
pub mod diagnostics;
pub mod mixer;
pub mod platform;
pub mod session;
#[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
mod source_scope;
pub mod system_input;
pub mod timeline;
pub mod transport;

pub const AUDIO_EVENT_STATE: &str = "audio://state";
pub const AUDIO_EVENT_POSITION: &str = "audio://position";
pub const AUDIO_EVENT_ENDED: &str = "audio://ended";
pub const AUDIO_EVENT_ERROR: &str = "audio://error";
pub const AUDIO_EVENT_INPUT_LEVEL: &str = "audio://input-level";
pub const AUDIO_EVENT_INPUT_FRAME: &str = "audio://input-frame";
pub const AUDIO_EVENT_INPUT_STATE: &str = "audio://input-state";
pub const AUDIO_EVENT_DEVICES_CHANGED: &str = "audio://devices-changed";
pub const AUDIO_EVENT_SESSION: &str = "audio://session";
pub const AUDIO_EVENT_CUE: &str = "audio://cue";
pub const AUDIO_EVENT_TERMINAL: &str = "audio://terminal";

#[derive(Clone)]
pub struct NativeAudioState {
    capabilities: AudioCapabilities,
    engine: Arc<Mutex<NativeAudioEngine>>,
}

struct NativeAudioEngine {
    mixer: mixer::MixerState,
    transport: transport::TransportState,
    capture: capture::CaptureState,
    session: session::SessionCoordinator,
    report_sender: mpsc::SyncSender<session::RuntimeReport>,
    report_receiver: mpsc::Receiver<session::RuntimeReport>,
}

impl NativeAudioState {
    pub fn new() -> Self {
        diagnostics::initialize();
        let capabilities = AudioCapabilities::detect();
        let (report_sender, report_receiver) = mpsc::sync_channel(32);
        Self {
            capabilities: capabilities.clone(),
            engine: Arc::new(Mutex::new(NativeAudioEngine {
                mixer: mixer::MixerState::default(),
                transport: transport::TransportState::default(),
                capture: capture::CaptureState::default(),
                session: session::SessionCoordinator::new(
                    capabilities.native_playback_supported,
                    capabilities.mic_capture_supported,
                ),
                report_sender,
                report_receiver,
            })),
        }
    }

    fn capabilities(&self) -> AudioCapabilities {
        self.capabilities.clone()
    }

    fn engine(&self) -> Result<MutexGuard<'_, NativeAudioEngine>, String> {
        self.engine
            .lock()
            .map_err(|_| "Native audio engine is unavailable.".to_string())
    }
}

impl NativeAudioEngine {
    fn drain_reports(&mut self) {
        while let Ok(report) = self.report_receiver.try_recv() {
            match report.kind {
                session::RuntimeReportKind::Ended => self.session.runtime_ended(report.generation),
                session::RuntimeReportKind::Terminal(code) => {
                    self.session.mark_terminal(report.generation, code);
                }
            }
        }
    }

    fn acquire(
        &mut self,
        app: &AppHandle,
        owner: session::SessionOwner,
        command: &session::SessionCommand,
        duration: f64,
        rate: f64,
    ) -> Result<Option<u64>, String> {
        self.drain_reports();
        if self.session.snapshot().terminal_diagnostic == Some("release_timeout") {
            return Err("release_timeout".to_string());
        }
        let session::Acquire::Release {
            token,
            previous,
            lease,
        } = self.session.begin_acquire(owner, command)
        else {
            return Ok(None);
        };
        let released = match previous {
            Some(previous) if previous.is_output() => self.transport.release_for_transfer(),
            Some(session::SessionOwner::Capture) => self.capture.release_for_transfer(),
            None | Some(_) => Ok(()),
        };
        if released.is_err() {
            if let Some(event) = self.session.fail_release(token) {
                let _ = app.emit(AUDIO_EVENT_TERMINAL, event);
            }
            return Err("release_timeout".to_string());
        }
        let generation = self
            .session
            .finish_acquire(token, owner, lease, command, duration, rate)
            .map_err(str::to_string)?;
        if owner.is_output() {
            self.transport.bind_session(
                generation,
                self.session.timeline(),
                self.report_sender.clone(),
            );
        } else {
            self.capture
                .bind_session(generation, self.report_sender.clone());
        }
        Ok(Some(generation))
    }

    fn emit_session(&self, app: &AppHandle) {
        let snapshot = self.session.snapshot();
        let _ = app.emit(AUDIO_EVENT_SESSION, snapshot);
    }

    fn authorize(
        &mut self,
        owner: session::SessionOwner,
        command: &session::SessionCommand,
        explicit: bool,
    ) -> Result<bool, String> {
        self.drain_reports();
        self.session
            .authorize(owner, command, explicit)
            .map_err(str::to_string)
    }

    fn output_snapshot(&self) -> transport::AudioSnapshot {
        let mut output = self.transport.snapshot();
        let session = self.session.snapshot();
        output.lease_id = session.lease_id;
        output.generation = Some(session.generation);
        output.timeline_revision = Some(session.timeline_revision);
        output.native_time_us = Some(session.native_time_us);
        output.position_seconds = session.position_seconds;
        output.playback_rate = session.playback_rate;
        output
    }

    fn input_snapshot(&self, mut input: capture::AudioInputState) -> capture::AudioInputState {
        let session = self.session.snapshot();
        input.lease_id = session.lease_id;
        input.generation = Some(session.generation);
        input.native_time_us = Some(session.native_time_us);
        input
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
                AUDIO_EVENT_INPUT_STATE,
                AUDIO_EVENT_DEVICES_CHANGED,
                AUDIO_EVENT_SESSION,
                AUDIO_EVENT_CUE,
                AUDIO_EVENT_TERMINAL,
            ],
            fallback_required: !platform.native_playback_supported,
            fallback_reason: platform.fallback_reason,
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
        let diagnostic_generation = diagnostics::begin_operation(
            diagnostics::DiagnosticOperationKind::Prepare,
            payload.lanes.len(),
        );
        let mut engine = state.engine()?;
        let owner = payload.owner.unwrap_or(session::SessionOwner::Playback);
        if !owner.is_output() {
            return Err("session_owner_mismatch".to_string());
        }
        let acquired = engine.acquire(
            &app,
            owner,
            &payload.control,
            payload.duration_seconds.unwrap_or(0.0),
            payload.playback_rate.unwrap_or(1.0),
        )?;
        if acquired.is_none() {
            let snapshot = engine.output_snapshot();
            return Ok(transport::AudioSession {
                id: payload.session_id,
                native_playback_supported: snapshot.native_playback_supported,
                fallback_reason: snapshot.fallback_reason,
                lane_count: snapshot.lanes.len(),
                generation: snapshot.generation,
                timeline_revision: snapshot.timeline_revision,
                native_time_us: snapshot.native_time_us,
            });
        }
        engine.mixer.set_lanes(payload.lanes.clone());
        let effective_lanes = engine.mixer.effective_lanes();
        engine
            .transport
            .set_diagnostics_generation(diagnostic_generation);
        let prepared = engine.transport.prepare(
            Some(app.clone()),
            payload,
            effective_lanes,
            state.capabilities(),
        );
        engine.emit_session(&app);
        Ok(prepared)
    })
    .await
    .map_err(|error| format!("Native audio prepare task failed: {error}"))?
}

#[tauri::command]
pub fn audio_play(
    app: AppHandle,
    state: State<'_, NativeAudioState>,
    payload: transport::AudioPlayRequest,
) -> Result<transport::AudioSnapshot, String> {
    if !state.capabilities.native_playback_supported {
        return Err("Native audio playback is not available yet.".to_string());
    }

    let mut engine = state.engine()?;
    engine.drain_reports();
    let previous_generation = engine.session.snapshot().generation;
    if !engine
        .session
        .authorize(session::SessionOwner::Playback, &payload.control, true)
        .map_err(str::to_string)?
    {
        return Ok(engine.output_snapshot());
    }
    let session_generation = engine.session.snapshot().generation;
    if session_generation != previous_generation {
        engine
            .transport
            .begin_explicit_attempt(state.capabilities());
        let timeline = engine.session.timeline();
        let reporter = engine.report_sender.clone();
        engine
            .transport
            .bind_session(session_generation, timeline, reporter);
    }
    let generation = diagnostics::begin_operation(
        diagnostics::DiagnosticOperationKind::Play,
        engine.transport.lane_count(),
    );
    engine.transport.set_diagnostics_generation(generation);
    let position = payload.start_time_seconds;
    let start_at = payload.start_at_native_us;
    let expected = payload
        .control
        .timeline_revision
        .unwrap_or_else(|| engine.session.snapshot().timeline_revision);
    if start_at.is_some_and(|deadline| deadline <= timeline::native_time_us()) {
        return Err("start_deadline_missed".to_string());
    }
    if let Err(error) = engine.transport.play(payload) {
        if let Some(event) = engine
            .session
            .mark_terminal(session_generation, "runtime_start_failure")
        {
            let _ = app.emit(AUDIO_EVENT_TERMINAL, event);
        }
        return Err(error);
    }
    let timeline = engine.session.timeline();
    let armed = timeline
        .lock()
        .map_err(|_| "timeline_unavailable".to_string())?
        .arm(expected, position, start_at, timeline::native_time_us());
    if let Err(code) = armed {
        engine.transport.pause();
        return Err(code.to_string());
    }
    engine.emit_session(&app);
    Ok(engine.output_snapshot())
}

#[tauri::command]
pub fn audio_pause(
    app: AppHandle,
    state: State<'_, NativeAudioState>,
    payload: Option<session::SessionCommand>,
) -> Result<transport::AudioSnapshot, String> {
    let mut engine = state.engine()?;
    engine.authorize(
        session::SessionOwner::Playback,
        &payload.unwrap_or_default(),
        false,
    )?;
    engine.transport.pause();
    engine
        .session
        .timeline()
        .lock()
        .map_err(|_| "timeline_unavailable")?
        .pause();
    engine.emit_session(&app);
    Ok(engine.output_snapshot())
}

#[tauri::command]
pub fn audio_stop(
    app: AppHandle,
    state: State<'_, NativeAudioState>,
    payload: Option<session::SessionCommand>,
) -> Result<transport::AudioSnapshot, String> {
    let mut engine = state.engine()?;
    engine.authorize(
        session::SessionOwner::Playback,
        &payload.unwrap_or_default(),
        false,
    )?;
    engine.transport.stop();
    engine
        .session
        .timeline()
        .lock()
        .map_err(|_| "timeline_unavailable")?
        .stop();
    engine.emit_session(&app);
    Ok(engine.output_snapshot())
}

#[tauri::command]
pub fn audio_seek(
    app: AppHandle,
    state: State<'_, NativeAudioState>,
    payload: transport::AudioSeekRequest,
) -> Result<transport::AudioSnapshot, String> {
    let mut engine = state.engine()?;
    engine.authorize(session::SessionOwner::Playback, &payload.control, false)?;
    let expected = payload
        .control
        .timeline_revision
        .unwrap_or_else(|| engine.session.snapshot().timeline_revision);
    engine
        .session
        .timeline()
        .lock()
        .map_err(|_| "timeline_unavailable")?
        .seek(expected, payload.time_seconds)
        .map_err(str::to_string)?;
    let generation = diagnostics::begin_operation(
        diagnostics::DiagnosticOperationKind::Seek,
        engine.transport.lane_count(),
    );
    engine.transport.set_diagnostics_generation(generation);
    engine.transport.seek(payload);
    engine.emit_session(&app);
    Ok(engine.output_snapshot())
}

#[tauri::command]
pub fn audio_set_lanes(
    app: AppHandle,
    state: State<'_, NativeAudioState>,
    payload: mixer::AudioLaneUpdate,
    control: Option<session::SessionCommand>,
) -> Result<transport::AudioSnapshot, String> {
    let mut engine = state.engine()?;
    engine.authorize(
        session::SessionOwner::Playback,
        &control.unwrap_or_default(),
        false,
    )?;
    let raw_lanes = payload.lanes;
    let playback_rate = payload.playback_rate;
    engine.mixer.set_lanes(raw_lanes.clone());
    let effective_lanes = engine.mixer.effective_lanes();
    let operation_kind = if engine.transport.diagnostic_route_changed(&raw_lanes) {
        diagnostics::DiagnosticOperationKind::LaneRoute
    } else if engine
        .transport
        .diagnostic_playback_rate_changed(playback_rate)
    {
        diagnostics::DiagnosticOperationKind::Tempo
    } else {
        diagnostics::DiagnosticOperationKind::LaneUpdate
    };
    let generation = diagnostics::begin_operation(operation_kind, raw_lanes.len());
    engine.transport.set_diagnostics_generation(generation);
    if let Some(rate) = playback_rate {
        let revision = engine.session.snapshot().timeline_revision;
        engine
            .session
            .timeline()
            .lock()
            .map_err(|_| "timeline_unavailable")?
            .set_rate(revision, rate)
            .map_err(str::to_string)?;
    }
    engine
        .transport
        .set_lanes(raw_lanes, effective_lanes, playback_rate);
    engine.emit_session(&app);
    Ok(engine.output_snapshot())
}

#[tauri::command]
pub fn audio_set_click(
    state: State<'_, NativeAudioState>,
    payload: transport::AudioClickRequest,
    control: Option<session::SessionCommand>,
) -> Result<transport::AudioSnapshot, String> {
    let mut engine = state.engine()?;
    engine.authorize(
        session::SessionOwner::Playback,
        &control.unwrap_or_default(),
        false,
    )?;
    engine.transport.set_click(payload);
    Ok(engine.output_snapshot())
}

#[tauri::command]
pub fn audio_get_snapshot(
    state: State<'_, NativeAudioState>,
) -> Result<transport::AudioSnapshot, String> {
    let mut engine = state.engine()?;
    engine.drain_reports();
    Ok(engine.output_snapshot())
}

#[tauri::command]
pub fn audio_get_session_snapshot(
    state: State<'_, NativeAudioState>,
) -> Result<session::SessionSnapshot, String> {
    let mut engine = state.engine()?;
    engine.drain_reports();
    Ok(engine.session.snapshot())
}

#[tauri::command]
pub fn audio_list_input_devices(
    state: State<'_, NativeAudioState>,
) -> Result<capture::AudioInputDevices, String> {
    Ok(state.engine()?.capture.list_devices(state.capabilities()))
}

#[tauri::command]
pub fn audio_list_output_devices(
    state: State<'_, NativeAudioState>,
) -> Result<capture::AudioOutputDevices, String> {
    Ok(state
        .engine()?
        .capture
        .list_output_devices(state.capabilities()))
}

#[tauri::command]
pub fn audio_get_input_state(
    app: AppHandle,
    state: State<'_, NativeAudioState>,
) -> Result<capture::AudioInputState, String> {
    let mut engine = state.engine()?;
    engine.drain_reports();
    let input = engine.capture.refresh(&app);
    engine.drain_reports();
    Ok(engine.input_snapshot(input))
}

#[tauri::command]
pub fn audio_get_input_permission_status() -> capture::AudioInputPermissionStatus {
    capture::input_permission_status(false)
}

#[tauri::command]
pub fn audio_request_input_permission() -> capture::AudioInputPermissionStatus {
    capture::input_permission_status(true)
}

#[cfg(target_os = "android")]
pub fn stop_input_for_lifecycle(app: &AppHandle, state: &NativeAudioState) {
    if let Ok(mut engine) = state.engine() {
        engine.capture.stop_for_background(app);
    }
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

    let mut engine = state.engine()?;
    let acquired = engine.acquire(
        &app,
        session::SessionOwner::Capture,
        &payload.control,
        0.0,
        1.0,
    )?;
    if acquired.is_none() {
        let input = engine.capture.state();
        return Ok(engine.input_snapshot(input));
    }
    let input = engine.capture.start(app.clone(), payload)?;
    if let Some(code) = input.error.as_ref().map(|error| error.code) {
        let generation = engine.session.snapshot().generation;
        if let Some(event) = engine.session.mark_terminal(generation, code) {
            let _ = app.emit(AUDIO_EVENT_TERMINAL, event);
        }
    }
    engine.emit_session(&app);
    Ok(engine.input_snapshot(input))
}

#[tauri::command]
pub fn audio_stop_input(
    app: AppHandle,
    state: State<'_, NativeAudioState>,
    payload: Option<session::SessionCommand>,
) -> Result<capture::AudioInputState, String> {
    let mut engine = state.engine()?;
    engine.authorize(
        session::SessionOwner::Capture,
        &payload.unwrap_or_default(),
        false,
    )?;
    let input = engine.capture.stop();
    engine.emit_session(&app);
    Ok(engine.input_snapshot(input))
}

#[tauri::command]
pub fn audio_set_monitor(
    state: State<'_, NativeAudioState>,
    payload: capture::AudioMonitorRequest,
) -> Result<capture::AudioInputState, String> {
    if !state.capabilities.mic_monitoring_supported && payload.enabled {
        return Err("Native microphone monitoring is not available yet.".to_string());
    }

    let mut engine = state.engine()?;
    engine.authorize(
        session::SessionOwner::Capture,
        &session::SessionCommand::default(),
        false,
    )?;
    let input = engine.capture.set_monitor(payload);
    Ok(engine.input_snapshot(input))
}

#[tauri::command]
pub fn audio_schedule_cues(
    app: AppHandle,
    state: State<'_, NativeAudioState>,
    payload: session::CueCommand,
) -> Result<session::SessionSnapshot, String> {
    let mut engine = state.engine()?;
    engine.authorize(session::SessionOwner::Cue, &payload.session, false)?;
    let revision = payload
        .session
        .timeline_revision
        .unwrap_or_else(|| engine.session.snapshot().timeline_revision);
    engine
        .session
        .timeline()
        .lock()
        .map_err(|_| "timeline_unavailable")?
        .schedule(revision, payload.cues)
        .map_err(str::to_string)?;
    engine.emit_session(&app);
    Ok(engine.session.snapshot())
}

#[tauri::command]
pub fn audio_cancel_cues(
    app: AppHandle,
    state: State<'_, NativeAudioState>,
    payload: Option<session::SessionCommand>,
) -> Result<session::SessionSnapshot, String> {
    let mut engine = state.engine()?;
    let payload = payload.unwrap_or_default();
    engine.authorize(session::SessionOwner::Cue, &payload, false)?;
    let revision = payload
        .timeline_revision
        .unwrap_or_else(|| engine.session.snapshot().timeline_revision);
    engine
        .session
        .timeline()
        .lock()
        .map_err(|_| "timeline_unavailable")?
        .cancel(revision)
        .map_err(str::to_string)?;
    engine.emit_session(&app);
    Ok(engine.session.snapshot())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_terminal_report_bridges_before_one_explicit_retry() {
        let capabilities = AudioCapabilities::detect();
        let (report_sender, report_receiver) = mpsc::sync_channel(1);
        let mut engine = NativeAudioEngine {
            mixer: mixer::MixerState::default(),
            transport: transport::TransportState::default(),
            capture: capture::CaptureState::default(),
            session: session::SessionCoordinator::new(true, true),
            report_sender: report_sender.clone(),
            report_receiver,
        };
        let command = session::SessionCommand::default();
        let session::Acquire::Release { token, lease, .. } = engine
            .session
            .begin_acquire(session::SessionOwner::Playback, &command)
        else {
            panic!()
        };
        let generation = engine
            .session
            .finish_acquire(
                token,
                session::SessionOwner::Playback,
                lease,
                &command,
                10.0,
                1.0,
            )
            .unwrap();
        report_sender
            .send(session::RuntimeReport {
                generation,
                kind: session::RuntimeReportKind::Terminal("output_stream_failure"),
            })
            .unwrap();

        engine.drain_reports();
        assert_eq!(
            engine.session.snapshot().terminal_diagnostic,
            Some("output_stream_failure")
        );
        assert!(engine
            .session
            .authorize(session::SessionOwner::Playback, &command, true)
            .unwrap());
        assert!(engine.session.snapshot().generation > generation);
        assert!(capabilities.emits_events.contains(&AUDIO_EVENT_TERMINAL));
    }
}
