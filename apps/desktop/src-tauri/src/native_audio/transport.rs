use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};
use tauri::AppHandle;

#[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::mpsc,
    thread::{self, JoinHandle},
};

#[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
#[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
use cpal::{FromSample, Sample, SampleFormat, SizedSample};
#[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
use symphonia::core::{
    codecs::audio::{AudioDecoder, AudioDecoderOptions},
    errors::Error as SymphoniaError,
    formats::{probe::Hint, FormatOptions, FormatReader, SeekMode, SeekTo, TrackType},
    io::MediaSourceStream,
    meta::MetadataOptions,
    units::Time,
};
#[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
use tauri::Emitter;

use super::{
    diagnostics::{self, DiagnosticCheckpoint, DiagnosticSafeCode},
    mixer::{AudioLaneRequest, AudioLaneRole, EffectiveAudioLane},
    AudioCapabilities,
};

#[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
use super::{
    decode::{
        convert_interleaved_channels, decode_wav_sample, read_u16_le, read_u32_le,
        resample_interleaved,
    },
    source_scope::PlaybackSourceScope,
    AUDIO_EVENT_ENDED, AUDIO_EVENT_ERROR, AUDIO_EVENT_POSITION, AUDIO_EVENT_STATE,
};

const DEFAULT_PLAYBACK_RATE: f64 = 1.0;
const RATE_TOLERANCE: f64 = 0.0001;
const GAIN_RAMP_SECONDS: f64 = 0.015;
const POSITION_EVENT_INTERVAL: Duration = Duration::from_millis(40);
const CLICK_DURATION_SECONDS: f64 = 0.032;
const CLICK_ACCENT_DURATION_SECONDS: f64 = 0.045;
const CLICK_FREQUENCY_HZ: f64 = 1175.0;
const CLICK_ACCENT_FREQUENCY_HZ: f64 = 1760.0;
#[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
const STREAM_CHUNK_FRAMES: usize = 2048;
#[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
const RING_BUFFER_SECONDS: usize = 8;
#[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
const PREBUFFER_TARGET_SECONDS: f64 = 0.12;
#[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
const PREBUFFER_TIMEOUT: Duration = Duration::from_millis(1500);
#[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
const PREBUFFER_POLL_INTERVAL: Duration = Duration::from_millis(5);
const SUSTAINED_UNDERRUN_ERROR_SECONDS: f64 = 0.5;
const AUDIBLE_GAIN_FLOOR: f32 = 0.0001;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioSessionRequest {
    pub session_id: String,
    pub duration_seconds: Option<f64>,
    pub playback_rate: Option<f64>,
    pub lanes: Vec<AudioLaneRequest>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioSession {
    pub id: String,
    pub native_playback_supported: bool,
    pub fallback_reason: Option<String>,
    pub lane_count: usize,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioPlayRequest {
    pub start_time_seconds: Option<f64>,
    pub scheduled_start_time_seconds: Option<f64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioSeekRequest {
    pub time_seconds: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioClickRequest {
    pub enabled: bool,
    pub bpm: Option<f64>,
    pub beats_per_bar: Option<u32>,
    pub accent_first_beat: Option<bool>,
    pub gain: Option<f32>,
    pub follow_transport: Option<bool>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioPositionEvent {
    pub session_id: Option<String>,
    pub position_seconds: f64,
    pub duration_seconds: f64,
    pub state: &'static str,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioStateEvent {
    pub session_id: Option<String>,
    pub state: &'static str,
    pub position_seconds: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioErrorEvent {
    pub session_id: Option<String>,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioSnapshot {
    pub session_id: Option<String>,
    pub state: &'static str,
    pub position_seconds: f64,
    pub duration_seconds: f64,
    pub playback_rate: f64,
    pub native_playback_supported: bool,
    pub fallback_reason: Option<String>,
    pub lanes: Vec<EffectiveAudioLane>,
    pub buffer_health: Vec<AudioBufferHealth>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioBufferHealth {
    pub lane_id: String,
    pub artifact_id: Option<String>,
    pub role: AudioLaneRole,
    pub ring_fill_samples: usize,
    pub ring_capacity_samples: usize,
    pub underrun_count: u64,
    pub worker_error_count: u64,
    pub last_worker_error: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TransportStatus {
    Stopped,
    Playing,
    Paused,
}

impl TransportStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Stopped => "stopped",
            Self::Playing => "playing",
            Self::Paused => "paused",
        }
    }
}

#[derive(Clone)]
enum PlaybackLaneSource {
    Stream(Arc<StreamingLane>),
}

#[derive(Clone)]
struct PlaybackLane {
    id: String,
    artifact_id: Option<String>,
    role: AudioLaneRole,
    muted: bool,
    solo: bool,
    current_gain: f32,
    target_gain: f32,
    scratch: Vec<f32>,
    source: PlaybackLaneSource,
    underrun_count: u64,
    worker_error_count: u64,
    last_worker_error: Option<String>,
}

struct StreamingLane {
    ring: Arc<Mutex<RingBuffer>>,
    capacity_samples: usize,
    eof: Arc<AtomicBool>,
}

struct RingBuffer {
    samples: VecDeque<f32>,
    capacity_samples: usize,
}

impl RingBuffer {
    fn new(capacity_samples: usize) -> Self {
        Self {
            samples: VecDeque::with_capacity(capacity_samples),
            capacity_samples,
        }
    }

    fn available_capacity(&self) -> usize {
        self.capacity_samples.saturating_sub(self.samples.len())
    }

    fn fill_samples(&self) -> usize {
        self.samples.len()
    }

    fn clear(&mut self) {
        self.samples.clear();
    }

    fn pop_into(&mut self, output: &mut [f32]) -> RingReadStatus {
        let available = self.samples.len().min(output.len());
        for sample in &mut output[..available] {
            *sample = self.samples.pop_front().unwrap_or(0.0);
        }
        for sample in &mut output[available..] {
            *sample = 0.0;
        }
        if available == output.len() {
            RingReadStatus::Full
        } else if available == 0 {
            RingReadStatus::Empty
        } else {
            RingReadStatus::Partial
        }
    }

    fn push_samples(&mut self, samples: &[f32]) -> bool {
        if samples.len() > self.available_capacity() {
            return false;
        }
        self.samples.extend(samples.iter().copied());
        true
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RingReadStatus {
    Full,
    Empty,
    Partial,
    LockMiss,
}

impl RingReadStatus {
    fn is_underrun(self) -> bool {
        !matches!(self, Self::Full)
    }
}

#[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
enum WorkerControl {
    SetPlaybackRate {
        playback_rate: f64,
        position_seconds: f64,
        diagnostics_generation: u64,
    },
    Seek {
        position_seconds: f64,
        diagnostics_generation: u64,
    },
    Stop,
}

#[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
struct WorkerError {
    lane_id: String,
    message: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum NativePlaybackFallbackCause {
    PrebufferTimeout,
    SustainedUnderrun,
}

impl NativePlaybackFallbackCause {
    fn message(self) -> &'static str {
        match self {
            Self::PrebufferTimeout => "Native playback prebuffer timed out.",
            Self::SustainedUnderrun => {
                "Native playback underrun persisted; falling back to Web Audio."
            }
        }
    }
}

#[derive(Clone)]
struct ClickState {
    enabled: bool,
    bpm: f64,
    beats_per_bar: u32,
    accent_first_beat: bool,
    gain: f32,
    follow_transport: bool,
}

impl Default for ClickState {
    fn default() -> Self {
        Self {
            enabled: false,
            bpm: 120.0,
            beats_per_bar: 4,
            accent_first_beat: true,
            gain: 0.75,
            follow_transport: true,
        }
    }
}

struct PlaybackShared {
    session_id: Option<String>,
    status: TransportStatus,
    position_seconds: f64,
    duration_seconds: f64,
    playback_rate: f64,
    native_playback_supported: bool,
    fallback_reason: Option<String>,
    sample_rate: u32,
    channels: usize,
    lanes: Vec<PlaybackLane>,
    snapshot_lanes: Vec<EffectiveAudioLane>,
    click: ClickState,
    ended_pending: bool,
    error_pending: Option<String>,
    terminal_error: Option<String>,
    buffering: bool,
    sustained_underrun_frames: usize,
    underrun_error_pending: bool,
    fallback_cause: Option<NativePlaybackFallbackCause>,
    diagnostics_generation: u64,
    diagnostics_gain_first_change_recorded: bool,
}

impl PlaybackShared {
    fn snapshot(&self) -> AudioSnapshot {
        let fallback_reason = self
            .terminal_error
            .clone()
            .or_else(|| self.fallback_reason.clone())
            .or_else(|| self.fallback_cause.map(|cause| cause.message().to_string()));

        let native_playback_supported = self.native_playback_supported
            && self.terminal_error.is_none()
            && self.fallback_cause.is_none();

        AudioSnapshot {
            session_id: self.session_id.clone(),
            state: self.status.as_str(),
            position_seconds: self.position_seconds,
            duration_seconds: self.duration_seconds,
            playback_rate: self.playback_rate,
            native_playback_supported,
            fallback_reason,
            lanes: self.snapshot_lanes.clone(),
            buffer_health: runtime_buffer_health(&self.snapshot_lanes, &self.lanes),
        }
    }

    #[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
    fn prebuffer_ready(&self) -> bool {
        if self.duration_seconds > 0.0 && self.position_seconds >= self.duration_seconds {
            return true;
        }

        let target_samples = prebuffer_target_samples(self.sample_rate, self.channels);
        let mut has_audible_lane = false;
        for lane in &self.lanes {
            if !lane.is_audible() {
                continue;
            }
            has_audible_lane = true;
            match &lane.source {
                PlaybackLaneSource::Stream(stream) => {
                    let target = target_samples.min(stream.capacity_samples);
                    let Ok(ring) = stream.ring.lock() else {
                        return false;
                    };
                    if ring.fill_samples() < target {
                        return false;
                    }
                }
            }
        }

        !has_audible_lane || self.fallback_cause.is_none()
    }
}

#[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
fn mark_terminal_runtime_error(
    shared: &mut PlaybackShared,
    message: String,
    diagnostic_code: DiagnosticSafeCode,
) {
    if shared.terminal_error.is_none() {
        shared.error_pending = Some(message.clone());
        shared.terminal_error = Some(message);
    }
    shared.status = TransportStatus::Paused;
    shared.buffering = false;
    diagnostics::record_callback_safe_code(shared.diagnostics_generation, diagnostic_code);
}

#[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
fn prebuffer_target_samples(sample_rate: u32, channels: usize) -> usize {
    let target_frames = (sample_rate as f64 * PREBUFFER_TARGET_SECONDS).ceil() as usize;
    target_frames
        .saturating_mul(channels)
        .max(STREAM_CHUNK_FRAMES.saturating_mul(channels))
}

#[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
struct PlaybackRuntime {
    shared: Arc<Mutex<PlaybackShared>>,
    audio_stop_sender: mpsc::Sender<RuntimeControl>,
    reporter_stop_sender: mpsc::Sender<RuntimeControl>,
    worker_control_senders: Vec<mpsc::Sender<WorkerControl>>,
    audio_thread: Option<JoinHandle<()>>,
    reporter_thread: Option<JoinHandle<()>>,
    worker_threads: Vec<JoinHandle<()>>,
}

#[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
enum RuntimeControl {
    Stop,
}

pub struct TransportState {
    session_id: Option<String>,
    status: TransportStatus,
    started_at: Option<Instant>,
    position_seconds: f64,
    duration_seconds: f64,
    playback_rate: f64,
    native_playback_supported: bool,
    fallback_reason: Option<String>,
    raw_lanes: Vec<AudioLaneRequest>,
    lanes: Vec<EffectiveAudioLane>,
    click: ClickState,
    diagnostics_generation: u64,
    #[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
    app: Option<AppHandle>,
    #[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
    runtime: Option<PlaybackRuntime>,
}

impl Default for TransportState {
    fn default() -> Self {
        Self {
            session_id: None,
            status: TransportStatus::Stopped,
            started_at: None,
            position_seconds: 0.0,
            duration_seconds: 0.0,
            playback_rate: DEFAULT_PLAYBACK_RATE,
            native_playback_supported: false,
            fallback_reason: None,
            raw_lanes: Vec::new(),
            lanes: Vec::new(),
            click: ClickState::default(),
            diagnostics_generation: 0,
            #[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
            app: None,
            #[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
            runtime: None,
        }
    }
}

impl TransportState {
    pub fn lane_count(&self) -> usize {
        self.raw_lanes.len().min(6)
    }

    pub fn set_diagnostics_generation(&mut self, generation: u64) {
        self.diagnostics_generation = generation;
        #[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
        if let Some(runtime) = &self.runtime {
            if let Ok(mut shared) = runtime.shared.lock() {
                shared.diagnostics_generation = generation;
                shared.diagnostics_gain_first_change_recorded = false;
            }
        }
    }

    pub fn diagnostic_route_changed(&self, next: &[AudioLaneRequest]) -> bool {
        self.raw_lanes.len() != next.len()
            || self.raw_lanes.iter().zip(next).any(|(current, next)| {
                current.id != next.id
                    || current.artifact_id != next.artifact_id
                    || current.source_path != next.source_path
                    || current.role != next.role
            })
    }

    pub fn diagnostic_playback_rate_changed(&self, next: Option<f64>) -> bool {
        next.map(|next| normalize_playback_rate(Some(next)))
            .map(|next| (next - self.playback_rate).abs() > RATE_TOLERANCE)
            .unwrap_or(false)
    }

    pub fn prepare(
        &mut self,
        app: Option<AppHandle>,
        request: AudioSessionRequest,
        lanes: Vec<EffectiveAudioLane>,
        capabilities: AudioCapabilities,
    ) -> AudioSession {
        let duration_seconds = request.duration_seconds.unwrap_or(0.0).max(0.0);
        let playback_rate = normalize_playback_rate(request.playback_rate);
        #[cfg(all(
            not(test),
            any(target_os = "android", target_os = "linux", target_os = "macos")
        ))]
        let runtime_unavailable_reason = (capabilities.native_playback_supported && app.is_none())
            .then(|| "Native audio runtime is unavailable.".to_string());
        #[cfg(all(
            test,
            any(target_os = "android", target_os = "linux", target_os = "macos")
        ))]
        let runtime_unavailable_reason: Option<String> = None;
        #[cfg(not(any(target_os = "android", target_os = "linux", target_os = "macos")))]
        let runtime_unavailable_reason = capabilities
            .native_playback_supported
            .then(|| "Native playback is unsupported on this platform.".to_string());
        let native_playback_supported =
            capabilities.native_playback_supported && runtime_unavailable_reason.is_none();
        let fallback_reason =
            runtime_unavailable_reason.or_else(|| capabilities.fallback_reason.map(str::to_string));
        self.stop_runtime();

        self.session_id = Some(request.session_id.clone());
        self.status = TransportStatus::Stopped;
        self.started_at = None;
        self.position_seconds = 0.0;
        self.duration_seconds = duration_seconds;
        self.playback_rate = playback_rate;
        self.raw_lanes = request.lanes.clone();
        self.lanes = lanes.clone();
        self.native_playback_supported = native_playback_supported;
        self.fallback_reason = fallback_reason;
        #[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
        {
            self.app = app;
            self.runtime = None;
        }

        AudioSession {
            id: request.session_id,
            native_playback_supported: self.native_playback_supported,
            fallback_reason: self.fallback_reason.clone(),
            lane_count: self.lanes.len(),
        }
    }

    pub fn set_lanes(
        &mut self,
        raw_lanes: Vec<AudioLaneRequest>,
        lanes: Vec<EffectiveAudioLane>,
        playback_rate: Option<f64>,
    ) {
        self.raw_lanes = raw_lanes;
        self.lanes = lanes.clone();
        let mut next_playback_rate = None;
        if playback_rate.is_some() {
            let rate = normalize_playback_rate(playback_rate);
            if (rate - self.playback_rate).abs() > RATE_TOLERANCE {
                self.position_seconds = self.current_position();
                self.playback_rate = rate;
                if self.status == TransportStatus::Playing {
                    self.started_at = Some(Instant::now());
                }
                next_playback_rate = Some(rate);
            }
        }
        #[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
        if let Some(runtime) = &self.runtime {
            let mut should_prebuffer = false;
            if let Ok(mut shared) = runtime.shared.lock() {
                update_shared_lanes(&mut shared, &lanes);
                if let Some(rate) = next_playback_rate {
                    let position_seconds = shared.position_seconds;
                    self.position_seconds = position_seconds;
                    shared.playback_rate = rate;
                    shared.sustained_underrun_frames = 0;
                    shared.underrun_error_pending = false;
                    if shared.status == TransportStatus::Playing {
                        shared.buffering = true;
                        clear_lane_rings(shared.diagnostics_generation, &mut shared.lanes);
                        should_prebuffer = true;
                    }
                    for sender in &runtime.worker_control_senders {
                        let _ = sender.send(WorkerControl::SetPlaybackRate {
                            playback_rate: rate,
                            position_seconds,
                            diagnostics_generation: shared.diagnostics_generation,
                        });
                    }
                }
            }
            if should_prebuffer {
                match wait_for_runtime_prebuffer(runtime) {
                    Ok(()) => {
                        if let Ok(mut shared) = runtime.shared.lock() {
                            shared.buffering = false;
                            shared.sustained_underrun_frames = 0;
                        }
                    }
                    Err(cause) => mark_runtime_fallback(runtime, cause),
                }
            }
        }
    }

    pub fn set_click(&mut self, request: AudioClickRequest) -> AudioSnapshot {
        self.click = ClickState {
            enabled: request.enabled,
            bpm: request.bpm.unwrap_or(120.0).clamp(30.0, 300.0),
            beats_per_bar: request.beats_per_bar.unwrap_or(4).clamp(1, 12),
            accent_first_beat: request.accent_first_beat.unwrap_or(true),
            gain: request.gain.unwrap_or(0.75).clamp(0.0, 1.0),
            follow_transport: request.follow_transport.unwrap_or(true),
        };

        #[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
        if let Some(runtime) = &self.runtime {
            if let Ok(mut shared) = runtime.shared.lock() {
                shared.click = self.click.clone();
            }
        }

        self.snapshot()
    }

    pub fn play(&mut self, request: AudioPlayRequest) -> Result<AudioSnapshot, String> {
        if self.session_id.is_none() {
            return Err("Native audio session is not prepared.".to_string());
        }
        if !self.native_playback_supported {
            return Err(self
                .fallback_reason
                .clone()
                .unwrap_or_else(|| "Native audio playback is unavailable.".to_string()));
        }

        if let Some(start_time_seconds) = request.start_time_seconds {
            self.position_seconds = self.clamp_position(start_time_seconds);
        }
        let _ = request.scheduled_start_time_seconds;
        #[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
        let runtime_started = self.ensure_runtime()?;
        #[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
        let terminal_runtime = self.runtime.as_ref().and_then(|runtime| {
            let shared = runtime.shared.lock().ok()?;
            let reason = shared.terminal_error.clone().or_else(|| {
                shared
                    .fallback_cause
                    .map(|cause| cause.message().to_string())
            })?;
            Some((shared.position_seconds, reason))
        });
        #[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
        if let Some((position_seconds, reason)) = terminal_runtime {
            self.position_seconds = position_seconds;
            self.status = TransportStatus::Paused;
            self.started_at = None;
            self.native_playback_supported = false;
            self.fallback_reason = Some(reason.clone());
            self.stop_runtime();
            return Err(reason);
        }
        #[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
        if let Some(runtime) = &self.runtime {
            if runtime_started || request.start_time_seconds.is_some() {
                seek_runtime_workers(runtime, self.position_seconds, self.diagnostics_generation);
            }
            if let Ok(mut shared) = runtime.shared.lock() {
                shared.position_seconds = self.position_seconds;
                shared.ended_pending = false;
            }
            if let Err(cause) = wait_for_runtime_prebuffer(runtime) {
                self.position_seconds = runtime
                    .shared
                    .lock()
                    .map(|shared| shared.position_seconds)
                    .unwrap_or(self.position_seconds);
                self.status = TransportStatus::Paused;
                self.started_at = None;
                self.native_playback_supported = false;
                self.fallback_reason = Some(cause.message().to_string());
                self.stop_runtime();
                return Ok(self.snapshot());
            }
            self.status = TransportStatus::Playing;
            self.started_at = Some(Instant::now());
            let mut shared = runtime
                .shared
                .lock()
                .map_err(|_| "Native playback state is unavailable.".to_string())?;
            shared.position_seconds = self.position_seconds;
            shared.status = TransportStatus::Playing;
            shared.ended_pending = false;
            shared.buffering = false;
            shared.sustained_underrun_frames = 0;
            shared.underrun_error_pending = false;
            shared.fallback_cause = None;
            return Ok(shared.snapshot());
        }

        self.status = TransportStatus::Playing;
        self.started_at = Some(Instant::now());

        Ok(self.snapshot())
    }

    pub fn pause(&mut self) -> AudioSnapshot {
        self.position_seconds = self.current_position();
        self.status = TransportStatus::Paused;
        self.started_at = None;

        #[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
        if let Some(runtime) = &self.runtime {
            if let Ok(shared) = runtime.shared.lock() {
                self.position_seconds = shared.position_seconds;
                if let Some(reason) = shared.terminal_error.clone().or_else(|| {
                    shared
                        .fallback_cause
                        .map(|cause| cause.message().to_string())
                }) {
                    self.native_playback_supported = false;
                    self.fallback_reason = Some(reason);
                }
            }
        }
        self.stop_runtime();

        self.snapshot()
    }

    pub fn stop(&mut self) -> AudioSnapshot {
        #[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
        let failed_runtime = self.runtime.as_ref().and_then(|runtime| {
            let shared = runtime.shared.lock().ok()?;
            let reason = shared.terminal_error.clone().or_else(|| {
                shared
                    .fallback_cause
                    .map(|cause| cause.message().to_string())
            })?;
            Some((shared.position_seconds, reason))
        });
        #[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
        if let Some((position_seconds, reason)) = failed_runtime {
            self.position_seconds = position_seconds;
            self.status = TransportStatus::Paused;
            self.started_at = None;
            self.native_playback_supported = false;
            self.fallback_reason = Some(reason);
            self.stop_runtime();
            return self.snapshot();
        }

        self.position_seconds = 0.0;
        self.status = TransportStatus::Stopped;
        self.started_at = None;
        self.stop_runtime();

        self.snapshot()
    }

    pub fn seek(&mut self, request: AudioSeekRequest) -> AudioSnapshot {
        self.position_seconds = self.clamp_position(request.time_seconds);
        if self.status == TransportStatus::Playing {
            self.started_at = Some(Instant::now());
        }

        #[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
        if let Some(runtime) = &self.runtime {
            let was_playing = self.status == TransportStatus::Playing;
            if was_playing {
                if let Ok(mut shared) = runtime.shared.lock() {
                    shared.buffering = true;
                    clear_lane_rings(shared.diagnostics_generation, &mut shared.lanes);
                }
            }
            seek_runtime_workers(runtime, self.position_seconds, self.diagnostics_generation);
            if let Ok(mut shared) = runtime.shared.lock() {
                shared.position_seconds = self.position_seconds;
                shared.ended_pending = false;
            }
            if was_playing {
                match wait_for_runtime_prebuffer(runtime) {
                    Ok(()) => {
                        if let Ok(mut shared) = runtime.shared.lock() {
                            shared.buffering = false;
                            shared.sustained_underrun_frames = 0;
                            shared.underrun_error_pending = false;
                        }
                    }
                    Err(cause) => mark_runtime_fallback(runtime, cause),
                }
            }
            if let Ok(mut shared) = runtime.shared.lock() {
                shared.position_seconds = self.position_seconds;
                shared.ended_pending = false;
            }
        }

        self.snapshot()
    }

    pub fn snapshot(&self) -> AudioSnapshot {
        #[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
        if let Some(runtime) = &self.runtime {
            if let Ok(shared) = runtime.shared.lock() {
                return shared.snapshot();
            }
        }

        AudioSnapshot {
            session_id: self.session_id.clone(),
            state: self.status.as_str(),
            position_seconds: self.current_position(),
            duration_seconds: self.duration_seconds,
            playback_rate: self.playback_rate,
            native_playback_supported: self.native_playback_supported,
            fallback_reason: self.fallback_reason.clone(),
            lanes: self.lanes.clone(),
            buffer_health: empty_buffer_health(&self.lanes),
        }
    }

    fn current_position(&self) -> f64 {
        if self.status != TransportStatus::Playing {
            return self.position_seconds;
        }

        let elapsed_seconds = self
            .started_at
            .map(|started_at| started_at.elapsed().as_secs_f64())
            .unwrap_or(0.0);
        self.clamp_position(self.position_seconds + elapsed_seconds * self.playback_rate)
    }

    fn clamp_position(&self, value: f64) -> f64 {
        clamp_position(value, self.duration_seconds)
    }

    #[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
    fn ensure_runtime(&mut self) -> Result<bool, String> {
        let runtime_finished = self.runtime.as_ref().is_some_and(|runtime| {
            runtime
                .audio_thread
                .as_ref()
                .is_some_and(JoinHandle::is_finished)
                || runtime
                    .reporter_thread
                    .as_ref()
                    .is_some_and(JoinHandle::is_finished)
        });
        if runtime_finished {
            self.stop_runtime();
        }
        if self.runtime.is_some() {
            return Ok(false);
        }

        let Some(app) = self.app.clone() else {
            #[cfg(test)]
            return Ok(false);
            #[cfg(not(test))]
            return Err("Native audio runtime is unavailable.".to_string());
        };
        let session_id = self
            .session_id
            .as_deref()
            .ok_or_else(|| "Native audio session is not prepared.".to_string())?;
        match start_native_runtime(
            app,
            session_id,
            self.duration_seconds,
            self.playback_rate,
            &self.raw_lanes,
            &self.lanes,
            &self.click,
            self.diagnostics_generation,
        ) {
            Ok(runtime) => {
                self.runtime = Some(runtime);
                Ok(true)
            }
            Err(error) => {
                diagnostics::record_safe_code(
                    self.diagnostics_generation,
                    DiagnosticSafeCode::RuntimeStartFailure,
                );
                self.native_playback_supported = false;
                self.fallback_reason = Some(error.clone());
                Err(error)
            }
        }
    }

    fn stop_runtime(&mut self) {
        #[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
        if let Some(mut runtime) = self.runtime.take() {
            for sender in &runtime.worker_control_senders {
                let _ = sender.send(WorkerControl::Stop);
            }
            let _ = runtime.audio_stop_sender.send(RuntimeControl::Stop);
            let _ = runtime.reporter_stop_sender.send(RuntimeControl::Stop);
            if let Some(audio_thread) = runtime.audio_thread.take() {
                let _ = audio_thread.join();
            }
            if let Some(reporter_thread) = runtime.reporter_thread.take() {
                let _ = reporter_thread.join();
            }
            for worker_thread in runtime.worker_threads {
                let _ = worker_thread.join();
            }
        }
    }
}

#[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
fn seek_runtime_workers(
    runtime: &PlaybackRuntime,
    position_seconds: f64,
    diagnostics_generation: u64,
) {
    if let Ok(mut shared) = runtime.shared.lock() {
        shared.diagnostics_generation = diagnostics_generation;
        clear_lane_rings(diagnostics_generation, &mut shared.lanes);
        shared.sustained_underrun_frames = 0;
        shared.underrun_error_pending = false;
    }
    for sender in &runtime.worker_control_senders {
        let _ = sender.send(WorkerControl::Seek {
            position_seconds,
            diagnostics_generation,
        });
    }
}

#[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
fn wait_for_runtime_prebuffer(
    runtime: &PlaybackRuntime,
) -> Result<(), NativePlaybackFallbackCause> {
    let started_at = Instant::now();
    loop {
        let (ready, generation) = runtime
            .shared
            .lock()
            .map(|shared| (shared.prebuffer_ready(), shared.diagnostics_generation))
            .unwrap_or((false, 0));
        if ready {
            diagnostics::record_checkpoint(generation, DiagnosticCheckpoint::PrebufferReady, None);
            return Ok(());
        }
        if started_at.elapsed() >= PREBUFFER_TIMEOUT {
            diagnostics::record_safe_code(generation, DiagnosticSafeCode::PrebufferTimeout);
            return Err(NativePlaybackFallbackCause::PrebufferTimeout);
        }
        thread::sleep(PREBUFFER_POLL_INTERVAL);
    }
}

#[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
fn mark_runtime_fallback(runtime: &PlaybackRuntime, cause: NativePlaybackFallbackCause) {
    if let Ok(mut shared) = runtime.shared.lock() {
        shared.status = TransportStatus::Paused;
        shared.buffering = false;
        shared.fallback_cause = Some(cause);
        shared.underrun_error_pending = true;
    }
}

impl Drop for TransportState {
    fn drop(&mut self) {
        self.stop_runtime();
    }
}

fn normalize_playback_rate(value: Option<f64>) -> f64 {
    let rate = value.unwrap_or(DEFAULT_PLAYBACK_RATE);
    if !rate.is_finite() || rate <= 0.0 {
        return DEFAULT_PLAYBACK_RATE;
    }
    rate
}

fn clamp_position(value: f64, duration_seconds: f64) -> f64 {
    if !value.is_finite() {
        return 0.0;
    }
    if duration_seconds <= 0.0 {
        return value.max(0.0);
    }
    value.clamp(0.0, duration_seconds)
}

fn effective_gain_for_lane(lanes: &[EffectiveAudioLane], id: &str) -> f32 {
    lanes
        .iter()
        .find(|lane| lane.id == id)
        .map(|lane| lane.effective_gain.clamp(0.0, 1.0))
        .unwrap_or(0.0)
}

fn update_shared_lanes(shared: &mut PlaybackShared, lanes: &[EffectiveAudioLane]) {
    shared.snapshot_lanes = lanes.to_vec();
    for lane in &mut shared.lanes {
        let next_gain = effective_gain_for_lane(lanes, &lane.id);
        if (lane.target_gain - next_gain).abs() > f32::EPSILON {
            diagnostics::record_checkpoint(
                shared.diagnostics_generation,
                DiagnosticCheckpoint::GainRampBegin,
                None,
            );
        }
        lane.target_gain = next_gain;
        if let Some(effective) = lanes.iter().find(|candidate| candidate.id == lane.id) {
            lane.muted = effective.muted;
            lane.solo = effective.solo;
        }
    }
}

fn empty_buffer_health(lanes: &[EffectiveAudioLane]) -> Vec<AudioBufferHealth> {
    lanes
        .iter()
        .map(|lane| AudioBufferHealth {
            lane_id: lane.id.clone(),
            artifact_id: lane.artifact_id.clone(),
            role: lane.role,
            ring_fill_samples: 0,
            ring_capacity_samples: 0,
            underrun_count: 0,
            worker_error_count: 0,
            last_worker_error: None,
        })
        .collect()
}

fn runtime_buffer_health(
    snapshot_lanes: &[EffectiveAudioLane],
    playback_lanes: &[PlaybackLane],
) -> Vec<AudioBufferHealth> {
    if snapshot_lanes.is_empty() {
        return playback_lanes
            .iter()
            .map(|lane| lane.buffer_health(None))
            .collect();
    }

    snapshot_lanes
        .iter()
        .map(|snapshot_lane| {
            playback_lanes
                .iter()
                .find(|lane| lane.id == snapshot_lane.id)
                .map(|lane| lane.buffer_health(Some(snapshot_lane)))
                .unwrap_or_else(|| AudioBufferHealth {
                    lane_id: snapshot_lane.id.clone(),
                    artifact_id: snapshot_lane.artifact_id.clone(),
                    role: snapshot_lane.role,
                    ring_fill_samples: 0,
                    ring_capacity_samples: 0,
                    underrun_count: 0,
                    worker_error_count: 0,
                    last_worker_error: None,
                })
        })
        .collect()
}

impl PlaybackLane {
    fn is_audible(&self) -> bool {
        self.current_gain > AUDIBLE_GAIN_FLOOR || self.target_gain > AUDIBLE_GAIN_FLOOR
    }

    fn buffer_health(&self, metadata: Option<&EffectiveAudioLane>) -> AudioBufferHealth {
        let (ring_fill_samples, ring_capacity_samples) = match &self.source {
            PlaybackLaneSource::Stream(stream) => {
                let fill = stream
                    .ring
                    .try_lock()
                    .map(|ring| ring.fill_samples())
                    .unwrap_or(0);
                (fill, stream.capacity_samples)
            }
        };

        AudioBufferHealth {
            lane_id: metadata
                .map(|lane| lane.id.clone())
                .unwrap_or_else(|| self.id.clone()),
            artifact_id: metadata
                .map(|lane| lane.artifact_id.clone())
                .unwrap_or_else(|| self.artifact_id.clone()),
            role: metadata.map(|lane| lane.role).unwrap_or(self.role),
            ring_fill_samples,
            ring_capacity_samples,
            underrun_count: self.underrun_count,
            worker_error_count: self.worker_error_count,
            last_worker_error: self.last_worker_error.clone(),
        }
    }
}

fn click_sample(click: &ClickState, position_seconds: f64, channel: usize) -> f32 {
    if !click.enabled || click.bpm <= 0.0 || click.gain <= 0.0 {
        return 0.0;
    }

    let beat_seconds = 60.0 / click.bpm;
    if beat_seconds <= 0.0 {
        return 0.0;
    }
    let beat_index = (position_seconds / beat_seconds).floor().max(0.0) as u64;
    let beat_offset = position_seconds - beat_index as f64 * beat_seconds;
    let accented = click.accent_first_beat && beat_index % u64::from(click.beats_per_bar) == 0;
    let duration = if accented {
        CLICK_ACCENT_DURATION_SECONDS
    } else {
        CLICK_DURATION_SECONDS
    };
    if !(0.0..=duration).contains(&beat_offset) {
        return 0.0;
    }

    let frequency = if accented {
        CLICK_ACCENT_FREQUENCY_HZ
    } else {
        CLICK_FREQUENCY_HZ
    };
    let phase = (beat_offset * frequency).fract();
    let square = if phase < 0.5 { 1.0 } else { -1.0 };
    let envelope = (1.0 - beat_offset / duration).max(0.0);
    let pan = if channel == 0 { 1.0 } else { 0.92 };
    (square * envelope * f64::from(click.gain) * pan * 0.35) as f32
}

fn mix_shared_frame(shared: &mut PlaybackShared, channel: usize, sample_index: usize) -> f32 {
    if shared.diagnostics_generation == 0 {
        return mix_shared_frame_without_diagnostics(shared, channel, sample_index);
    }

    let mut sample = 0.0;
    let ramp_step = (1.0 / (shared.sample_rate as f64 * GAIN_RAMP_SECONDS)).max(0.0001) as f32;

    for lane in &mut shared.lanes {
        let was_ramping = (lane.current_gain - lane.target_gain).abs() > f32::EPSILON;
        if lane.current_gain < lane.target_gain {
            lane.current_gain = (lane.current_gain + ramp_step).min(lane.target_gain);
        } else if lane.current_gain > lane.target_gain {
            lane.current_gain = (lane.current_gain - ramp_step).max(lane.target_gain);
        }
        if was_ramping && !shared.diagnostics_gain_first_change_recorded {
            diagnostics::record_gain_first_change(shared.diagnostics_generation);
            shared.diagnostics_gain_first_change_recorded = true;
        }
        if was_ramping && (lane.current_gain - lane.target_gain).abs() <= f32::EPSILON {
            diagnostics::record_gain_ramp_complete(shared.diagnostics_generation);
        }

        let lane_sample = lane.scratch.get(sample_index).copied().unwrap_or(0.0);

        if lane.current_gain > 0.0001 {
            sample += lane_sample * lane.current_gain;
        }
    }

    if !shared.click.follow_transport || shared.status == TransportStatus::Playing {
        sample += click_sample(&shared.click, shared.position_seconds, channel);
    }

    sample.clamp(-1.0, 1.0)
}

fn mix_shared_frame_without_diagnostics(
    shared: &mut PlaybackShared,
    channel: usize,
    sample_index: usize,
) -> f32 {
    let mut sample = 0.0;
    let ramp_step = (1.0 / (shared.sample_rate as f64 * GAIN_RAMP_SECONDS)).max(0.0001) as f32;

    for lane in &mut shared.lanes {
        if lane.current_gain < lane.target_gain {
            lane.current_gain = (lane.current_gain + ramp_step).min(lane.target_gain);
        } else if lane.current_gain > lane.target_gain {
            lane.current_gain = (lane.current_gain - ramp_step).max(lane.target_gain);
        }
        let lane_sample = lane.scratch.get(sample_index).copied().unwrap_or(0.0);
        if lane.current_gain > 0.0001 {
            sample += lane_sample * lane.current_gain;
        }
    }

    if !shared.click.follow_transport || shared.status == TransportStatus::Playing {
        sample += click_sample(&shared.click, shared.position_seconds, channel);
    }

    sample.clamp(-1.0, 1.0)
}

fn prepare_lane_scratch(
    diagnostics_generation: u64,
    lanes: &mut [PlaybackLane],
    sample_count: usize,
) -> bool {
    let mut audible_underrun = false;

    for lane in lanes {
        if lane.scratch.len() < sample_count {
            lane.scratch.resize(sample_count, 0.0);
        } else {
            lane.scratch[..sample_count].fill(0.0);
        }

        let is_audible = lane.is_audible();
        let read_status = match &lane.source {
            PlaybackLaneSource::Stream(stream) => match stream.ring.try_lock() {
                Ok(mut ring) => ring.pop_into(&mut lane.scratch[..sample_count]),
                Err(_) => RingReadStatus::LockMiss,
            },
        };

        if read_status.is_underrun() {
            lane.underrun_count = lane.underrun_count.saturating_add(1);
            if diagnostics_generation != 0 {
                diagnostics::record_underrun(diagnostics_generation);
            }
            if is_audible {
                audible_underrun = true;
            }
        }
    }

    audible_underrun
}

fn update_underrun_state(shared: &mut PlaybackShared, audible_underrun: bool, frame_count: usize) {
    if shared.status != TransportStatus::Playing || shared.buffering {
        shared.sustained_underrun_frames = 0;
        return;
    }

    if !audible_underrun {
        shared.sustained_underrun_frames = 0;
        return;
    }

    shared.sustained_underrun_frames = shared
        .sustained_underrun_frames
        .saturating_add(frame_count.max(1));
    let threshold_frames =
        (shared.sample_rate as f64 * SUSTAINED_UNDERRUN_ERROR_SECONDS).ceil() as usize;
    if shared.fallback_cause.is_none() && shared.sustained_underrun_frames >= threshold_frames {
        shared.status = TransportStatus::Paused;
        shared.buffering = false;
        shared.fallback_cause = Some(NativePlaybackFallbackCause::SustainedUnderrun);
        shared.underrun_error_pending = true;
        diagnostics::record_callback_safe_code(
            shared.diagnostics_generation,
            DiagnosticSafeCode::SustainedUnderrun,
        );
    }
}

fn clear_lane_rings(diagnostics_generation: u64, lanes: &mut [PlaybackLane]) {
    for lane in lanes {
        match &lane.source {
            PlaybackLaneSource::Stream(stream) => {
                stream.eof.store(false, Ordering::Release);
                if let Ok(mut ring) = stream.ring.lock() {
                    ring.clear();
                    diagnostics::record_checkpoint(
                        diagnostics_generation,
                        DiagnosticCheckpoint::RingClear,
                        None,
                    );
                }
            }
        }
    }
}

fn playback_lanes_drained(lanes: &[PlaybackLane]) -> bool {
    !lanes.is_empty()
        && lanes.iter().all(|lane| match &lane.source {
            PlaybackLaneSource::Stream(stream) => {
                stream.eof.load(Ordering::Acquire)
                    && stream
                        .ring
                        .try_lock()
                        .map(|ring| ring.fill_samples() == 0)
                        .unwrap_or(false)
            }
        })
}

#[cfg(test)]
fn render_shared_output(shared: &mut PlaybackShared, output: &mut [f32]) {
    if shared.channels == 0 {
        output.fill(0.0);
        return;
    }
    if shared.status == TransportStatus::Playing && !shared.buffering {
        let frame_count = output.len() / shared.channels;
        let audible_underrun = prepare_lane_scratch(
            shared.diagnostics_generation,
            &mut shared.lanes,
            output.len(),
        );
        update_underrun_state(shared, audible_underrun, frame_count);
    }
    for (frame_index, frame) in output.chunks_mut(shared.channels).enumerate() {
        if shared.status != TransportStatus::Playing || shared.buffering {
            frame.fill(0.0);
            continue;
        }

        for (channel, sample) in frame.iter_mut().enumerate() {
            *sample = mix_shared_frame(shared, channel, frame_index * shared.channels + channel);
        }

        shared.position_seconds += shared.playback_rate / shared.sample_rate as f64;
        if shared.duration_seconds > 0.0 && shared.position_seconds >= shared.duration_seconds {
            shared.position_seconds = 0.0;
            shared.status = TransportStatus::Stopped;
            shared.ended_pending = true;
        }
    }
    if shared.diagnostics_generation != 0
        && output
            .iter()
            .any(|sample| sample.abs() > AUDIBLE_GAIN_FLOOR)
    {
        diagnostics::record_callback_nonzero(shared.diagnostics_generation);
    }
    if shared.status == TransportStatus::Playing && playback_lanes_drained(&shared.lanes) {
        shared.position_seconds = 0.0;
        shared.status = TransportStatus::Stopped;
        shared.ended_pending = true;
    }
}

#[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
fn render_shared_output_typed<T>(shared: &mut PlaybackShared, output: &mut [T])
where
    T: Sample + FromSample<f32> + Copy,
{
    let silent = T::from_sample(0.0);
    if shared.channels == 0 {
        for sample in output {
            *sample = silent;
        }
        return;
    }
    if shared.status == TransportStatus::Playing && !shared.buffering {
        let frame_count = output.len() / shared.channels;
        let audible_underrun = prepare_lane_scratch(
            shared.diagnostics_generation,
            &mut shared.lanes,
            output.len(),
        );
        update_underrun_state(shared, audible_underrun, frame_count);
    }

    let track_nonzero = shared.diagnostics_generation != 0;
    let mut any_nonzero = false;
    for (frame_index, frame) in output.chunks_mut(shared.channels).enumerate() {
        if shared.status != TransportStatus::Playing || shared.buffering {
            for sample in frame {
                *sample = silent;
            }
            continue;
        }

        for (channel, sample) in frame.iter_mut().enumerate() {
            let mixed = mix_shared_frame(shared, channel, frame_index * shared.channels + channel);
            if track_nonzero {
                any_nonzero |= mixed.abs() > AUDIBLE_GAIN_FLOOR;
            }
            *sample = T::from_sample(mixed);
        }

        shared.position_seconds += shared.playback_rate / shared.sample_rate as f64;
        if shared.duration_seconds > 0.0 && shared.position_seconds >= shared.duration_seconds {
            shared.position_seconds = 0.0;
            shared.status = TransportStatus::Stopped;
            shared.ended_pending = true;
        }
    }
    if track_nonzero && any_nonzero {
        diagnostics::record_callback_nonzero(shared.diagnostics_generation);
    }
    if shared.status == TransportStatus::Playing && playback_lanes_drained(&shared.lanes) {
        shared.position_seconds = 0.0;
        shared.status = TransportStatus::Stopped;
        shared.ended_pending = true;
    }
}

#[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
fn start_native_runtime(
    app: AppHandle,
    session_id: &str,
    duration_seconds: f64,
    playback_rate: f64,
    raw_lanes: &[AudioLaneRequest],
    effective_lanes: &[EffectiveAudioLane],
    click: &ClickState,
    diagnostics_generation: u64,
) -> Result<PlaybackRuntime, String> {
    let host = cpal::default_host();
    let device = host
        .default_output_device()
        .ok_or_else(|| "Native audio output device is unavailable.".to_string())?;
    let supported_config = device
        .default_output_config()
        .map_err(|error| format!("Native audio output config is unavailable: {error}"))?;
    let sample_format = supported_config.sample_format();
    let stream_config: cpal::StreamConfig = supported_config.into();
    let sample_rate = stream_config.sample_rate;
    let channels = usize::from(stream_config.channels).max(1);
    let (worker_error_sender, worker_error_receiver) = mpsc::channel();
    let LoadedPlaybackLanes {
        lanes,
        workers: decoder_workers,
    } = load_playback_lanes(
        &app,
        raw_lanes,
        effective_lanes,
        sample_rate,
        channels,
        playback_rate,
        worker_error_sender,
        diagnostics_generation,
    )?;
    let snapshot_lanes = effective_lanes.to_vec();
    let shared = Arc::new(Mutex::new(PlaybackShared {
        session_id: Some(session_id.to_string()),
        status: TransportStatus::Stopped,
        position_seconds: 0.0,
        duration_seconds,
        playback_rate,
        native_playback_supported: true,
        fallback_reason: None,
        sample_rate,
        channels,
        lanes,
        snapshot_lanes,
        click: click.clone(),
        ended_pending: false,
        error_pending: None,
        terminal_error: None,
        buffering: false,
        sustained_underrun_frames: 0,
        underrun_error_pending: false,
        fallback_cause: None,
        diagnostics_generation,
        diagnostics_gain_first_change_recorded: false,
    }));

    drop(device);

    let (audio_stop_sender, audio_stop_receiver) = mpsc::channel();
    let (ready_sender, ready_receiver) = mpsc::channel();
    let audio_thread = thread::spawn({
        let shared = shared.clone();
        move || {
            start_output_stream_thread(
                stream_config,
                sample_format,
                shared,
                audio_stop_receiver,
                ready_sender,
            );
        }
    });

    match ready_receiver.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            let _ = audio_thread.join();
            return Err(error);
        }
        Err(_) => {
            let _ = audio_stop_sender.send(RuntimeControl::Stop);
            let _ = audio_thread.join();
            return Err("Native audio output stream did not start in time.".to_string());
        }
    }

    let (worker_control_senders, worker_threads) = decoder_workers.into_parts();
    let reporter_worker_control_senders = worker_control_senders.clone();
    let reporter_audio_stop_sender = audio_stop_sender.clone();
    let (reporter_stop_sender, reporter_stop_receiver) = mpsc::channel();
    let reporter_thread = thread::spawn({
        let shared = shared.clone();
        move || loop {
            if reporter_stop_receiver.try_recv().is_ok() {
                break;
            }
            while let Ok(worker_error) = worker_error_receiver.try_recv() {
                if let Ok(mut shared) = shared.lock() {
                    if let Some(lane) = shared
                        .lanes
                        .iter_mut()
                        .find(|lane| lane.id == worker_error.lane_id)
                    {
                        lane.worker_error_count = lane.worker_error_count.saturating_add(1);
                        lane.last_worker_error = Some(worker_error.message.clone());
                    }
                    mark_terminal_runtime_error(
                        &mut shared,
                        worker_error.message,
                        DiagnosticSafeCode::DecoderWorkerFailure,
                    );
                }
            }
            if emit_runtime_events(&app, &shared) {
                for sender in &reporter_worker_control_senders {
                    let _ = sender.send(WorkerControl::Stop);
                }
                let _ = reporter_audio_stop_sender.send(RuntimeControl::Stop);
                break;
            }
            thread::sleep(POSITION_EVENT_INTERVAL);
        }
    });

    Ok(PlaybackRuntime {
        shared,
        audio_stop_sender,
        reporter_stop_sender,
        worker_control_senders,
        audio_thread: Some(audio_thread),
        reporter_thread: Some(reporter_thread),
        worker_threads,
    })
}

#[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
fn start_output_stream_thread(
    config: cpal::StreamConfig,
    sample_format: SampleFormat,
    shared: Arc<Mutex<PlaybackShared>>,
    stop_receiver: mpsc::Receiver<RuntimeControl>,
    ready_sender: mpsc::Sender<Result<(), String>>,
) {
    let host = cpal::default_host();
    let result = (|| {
        let device = host
            .default_output_device()
            .ok_or_else(|| "Native audio output device is unavailable.".to_string())?;
        let (stream, callback_receiver) =
            build_output_stream(&device, &config, sample_format, shared)?;
        stream
            .play()
            .map_err(|error| format!("Native audio output stream could not start: {error}"))?;
        callback_receiver
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| {
                "Native audio output stream did not deliver a playback callback in time."
                    .to_string()
            })?;
        Ok(stream)
    })();
    let stream = match result {
        Ok(stream) => {
            let _ = ready_sender.send(Ok(()));
            stream
        }
        Err(error) => {
            let _ = ready_sender.send(Err(error));
            return;
        }
    };
    loop {
        if stop_receiver
            .recv_timeout(Duration::from_millis(250))
            .is_ok()
        {
            break;
        }
    }
    drop(stream);
}

#[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
fn build_output_stream(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    sample_format: SampleFormat,
    shared: Arc<Mutex<PlaybackShared>>,
) -> Result<(cpal::Stream, mpsc::Receiver<()>), String> {
    match sample_format {
        SampleFormat::F32 => build_typed_output_stream::<f32>(device, config, shared),
        SampleFormat::I16 => build_typed_output_stream::<i16>(device, config, shared),
        SampleFormat::U16 => build_typed_output_stream::<u16>(device, config, shared),
        other => Err(format!(
            "Native audio sample format {other:?} is unsupported."
        )),
    }
}

#[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
fn build_typed_output_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    shared: Arc<Mutex<PlaybackShared>>,
) -> Result<(cpal::Stream, mpsc::Receiver<()>), String>
where
    T: Sample + SizedSample + FromSample<f32>,
{
    let data_shared = shared.clone();
    let error_shared = shared;
    let (callback_sender, callback_receiver) = mpsc::sync_channel(1);
    let mut callback_sender = Some(callback_sender);
    let stream = device
        .build_output_stream(
            *config,
            move |output: &mut [T], _| {
                if let Some(sender) = callback_sender.take() {
                    let _ = sender.try_send(());
                }
                if let Ok(mut shared) = data_shared.lock() {
                    render_shared_output_typed(&mut shared, output);
                    return;
                }
                let silent = T::from_sample(0.0);
                for sample in output {
                    *sample = silent;
                }
            },
            move |error| {
                let message = format!("Native audio output stream error: {error}");
                if let Ok(mut shared) = error_shared.lock() {
                    mark_terminal_runtime_error(
                        &mut shared,
                        message,
                        DiagnosticSafeCode::OutputStreamFailure,
                    );
                }
            },
            None,
        )
        .map_err(|error| format!("Native audio output stream could not be built: {error}"))?;
    Ok((stream, callback_receiver))
}

#[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
fn emit_runtime_events(app: &AppHandle, shared: &Arc<Mutex<PlaybackShared>>) -> bool {
    let (snapshot, ended, error) = {
        let mut shared = match shared.lock() {
            Ok(shared) => shared,
            Err(_) => return false,
        };
        let snapshot = shared.snapshot();
        let ended = shared.ended_pending;
        shared.ended_pending = false;
        let mut error = shared.error_pending.take();
        if shared.underrun_error_pending {
            shared.underrun_error_pending = false;
            if error.is_none() {
                error = shared
                    .fallback_cause
                    .map(|cause| cause.message().to_string());
            }
        }
        (snapshot, ended, error)
    };

    let _ = app.emit(
        AUDIO_EVENT_POSITION,
        AudioPositionEvent {
            session_id: snapshot.session_id.clone(),
            position_seconds: snapshot.position_seconds,
            duration_seconds: snapshot.duration_seconds,
            state: snapshot.state,
        },
    );
    let _ = app.emit(
        AUDIO_EVENT_STATE,
        AudioStateEvent {
            session_id: snapshot.session_id.clone(),
            state: snapshot.state,
            position_seconds: snapshot.position_seconds,
        },
    );
    if ended {
        let _ = app.emit(AUDIO_EVENT_ENDED, snapshot.clone());
    }
    if let Some(message) = &error {
        let _ = app.emit(
            AUDIO_EVENT_ERROR,
            AudioErrorEvent {
                session_id: snapshot.session_id,
                message: message.clone(),
            },
        );
    }
    ended || error.is_some()
}

#[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
struct LoadedPlaybackLanes {
    lanes: Vec<PlaybackLane>,
    workers: DecoderWorkers,
}

#[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
#[derive(Default)]
struct DecoderWorkers {
    control_senders: Vec<mpsc::Sender<WorkerControl>>,
    threads: Vec<JoinHandle<()>>,
}

#[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
fn sourced_playback_lanes(
    raw_lanes: &[AudioLaneRequest],
) -> impl Iterator<Item = (usize, &AudioLaneRequest)> {
    raw_lanes
        .iter()
        .filter(|lane| lane.source_path.is_some())
        .enumerate()
}

#[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
impl DecoderWorkers {
    fn into_parts(mut self) -> (Vec<mpsc::Sender<WorkerControl>>, Vec<JoinHandle<()>>) {
        (
            std::mem::take(&mut self.control_senders),
            std::mem::take(&mut self.threads),
        )
    }
}

#[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
impl Drop for DecoderWorkers {
    fn drop(&mut self) {
        for sender in &self.control_senders {
            let _ = sender.send(WorkerControl::Stop);
        }
        for worker_thread in self.threads.drain(..) {
            let _ = worker_thread.join();
        }
    }
}

#[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
fn load_playback_lanes(
    app: &AppHandle,
    raw_lanes: &[AudioLaneRequest],
    effective_lanes: &[EffectiveAudioLane],
    sample_rate: u32,
    channels: usize,
    playback_rate: f64,
    worker_error_sender: mpsc::Sender<WorkerError>,
    diagnostics_generation: u64,
) -> Result<LoadedPlaybackLanes, String> {
    let mut lanes = Vec::new();
    let mut workers = DecoderWorkers::default();
    let mut source_scope = None;

    for (lane_ordinal, lane) in sourced_playback_lanes(raw_lanes) {
        let source_path = lane
            .source_path
            .as_ref()
            .expect("sourced playback lane has a source path");
        if source_scope.is_none() {
            source_scope = Some(PlaybackSourceScope::from_app(app)?);
        }
        let path = source_scope
            .as_ref()
            .expect("source scope initialized")
            .validate(lane.artifact_id.as_deref(), source_path)
            .map_err(|error| error.message().to_string())?;

        let capacity_samples = (sample_rate as usize)
            .saturating_mul(channels)
            .saturating_mul(RING_BUFFER_SECONDS)
            .max(
                STREAM_CHUNK_FRAMES
                    .saturating_mul(channels)
                    .saturating_mul(2),
            );
        let ring = Arc::new(Mutex::new(RingBuffer::new(capacity_samples)));
        let eof = Arc::new(AtomicBool::new(false));
        let (sender, worker_thread) = spawn_decoder_worker(
            lane.id.clone(),
            lane_ordinal.min(5),
            path,
            ring.clone(),
            eof.clone(),
            sample_rate,
            channels,
            playback_rate,
            worker_error_sender.clone(),
            diagnostics_generation,
        )?;
        let target_gain = effective_gain_for_lane(effective_lanes, &lane.id);
        workers.control_senders.push(sender);
        workers.threads.push(worker_thread);
        lanes.push(PlaybackLane {
            id: lane.id.clone(),
            artifact_id: lane.artifact_id.clone(),
            role: lane.role,
            muted: lane.muted,
            solo: lane.solo,
            current_gain: target_gain,
            target_gain,
            scratch: vec![0.0; sample_rate as usize * channels],
            source: PlaybackLaneSource::Stream(Arc::new(StreamingLane {
                ring,
                capacity_samples,
                eof,
            })),
            underrun_count: 0,
            worker_error_count: 0,
            last_worker_error: None,
        });
    }

    let ring_capacity_samples = lanes
        .iter()
        .map(|lane| match &lane.source {
            PlaybackLaneSource::Stream(stream) => stream.capacity_samples,
        })
        .sum();
    let scratch_capacity_samples = lanes.iter().map(|lane| lane.scratch.capacity()).sum();
    diagnostics::record_capacities(
        diagnostics_generation,
        lanes.len(),
        ring_capacity_samples,
        scratch_capacity_samples,
    );

    Ok(LoadedPlaybackLanes { lanes, workers })
}

#[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
fn spawn_decoder_worker(
    lane_id: String,
    lane_ordinal: usize,
    path: PathBuf,
    ring: Arc<Mutex<RingBuffer>>,
    eof: Arc<AtomicBool>,
    target_sample_rate: u32,
    target_channels: usize,
    playback_rate: f64,
    error_sender: mpsc::Sender<WorkerError>,
    diagnostics_generation: u64,
) -> Result<(mpsc::Sender<WorkerControl>, JoinHandle<()>), String> {
    let mut playback_rate = normalize_playback_rate(Some(playback_rate));
    let mut diagnostics_generation = diagnostics_generation;
    let mut decoder = StreamingDecoder::open_with_diagnostics(
        path.clone(),
        target_sample_rate,
        target_channels,
        playback_rate,
        0.0,
        diagnostics_generation,
        lane_ordinal,
    )?;
    let (sender, receiver) = mpsc::channel();
    let mut pending_samples: Option<Vec<f32>> = None;
    let mut first_pcm_recorded = false;
    let worker_thread = thread::spawn(move || loop {
        loop {
            let control = match receiver.try_recv() {
                Ok(control) => control,
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => return,
            };
            apply_worker_control_diagnostics_generation(
                &control,
                &mut diagnostics_generation,
                &mut decoder,
                lane_ordinal,
            );
            match control {
                WorkerControl::SetPlaybackRate {
                    playback_rate: next_playback_rate,
                    position_seconds,
                    ..
                } => {
                    eof.store(false, Ordering::Release);
                    playback_rate = normalize_playback_rate(Some(next_playback_rate));
                    if let Ok(mut guard) = ring.lock() {
                        guard.clear();
                    }
                    pending_samples = None;
                    first_pcm_recorded = false;
                    decoder.set_playback_rate(playback_rate);
                    if decoder.seek(position_seconds).is_err() {
                        match StreamingDecoder::open_with_diagnostics(
                            path.clone(),
                            target_sample_rate,
                            target_channels,
                            playback_rate,
                            position_seconds,
                            diagnostics_generation,
                            lane_ordinal,
                        ) {
                            Ok(reopened) => {
                                decoder = reopened;
                            }
                            Err(error) => {
                                let _ = error_sender.send(WorkerError {
                                    lane_id: lane_id.clone(),
                                    message: error,
                                });
                                return;
                            }
                        }
                    }
                }
                WorkerControl::Seek {
                    position_seconds, ..
                } => {
                    eof.store(false, Ordering::Release);
                    if let Ok(mut guard) = ring.lock() {
                        guard.clear();
                    }
                    pending_samples = None;
                    first_pcm_recorded = false;
                    if decoder.seek(position_seconds).is_err() {
                        match StreamingDecoder::open_with_diagnostics(
                            path.clone(),
                            target_sample_rate,
                            target_channels,
                            playback_rate,
                            position_seconds,
                            diagnostics_generation,
                            lane_ordinal,
                        ) {
                            Ok(reopened) => {
                                decoder = reopened;
                            }
                            Err(error) => {
                                let _ = error_sender.send(WorkerError {
                                    lane_id: lane_id.clone(),
                                    message: error,
                                });
                                return;
                            }
                        }
                    }
                }
                WorkerControl::Stop => return,
            }
        }

        if let Some(samples) = pending_samples.take() {
            match push_or_defer_worker_samples(&ring, &mut pending_samples, samples) {
                Ok(true) => continue,
                Ok(false) => {
                    thread::sleep(Duration::from_millis(5));
                    continue;
                }
                Err(()) => return,
            }
        }

        let requested_samples = STREAM_CHUNK_FRAMES.saturating_mul(target_channels);
        let has_capacity = ring
            .lock()
            .map(|guard| guard.available_capacity() >= requested_samples)
            .unwrap_or(false);
        if !has_capacity {
            thread::sleep(Duration::from_millis(5));
            continue;
        }

        match decoder.next_chunk() {
            Ok(Some(samples)) => {
                if samples.is_empty() {
                    thread::sleep(Duration::from_millis(2));
                    continue;
                }
                if !first_pcm_recorded {
                    diagnostics::record_checkpoint(
                        diagnostics_generation,
                        DiagnosticCheckpoint::WorkerFirstPcm,
                        Some(lane_ordinal),
                    );
                    first_pcm_recorded = true;
                }
                match push_or_defer_worker_samples(&ring, &mut pending_samples, samples) {
                    Ok(true) => {}
                    Ok(false) => thread::sleep(Duration::from_millis(5)),
                    Err(()) => return,
                }
            }
            Ok(None) => {
                eof.store(true, Ordering::Release);
                thread::sleep(Duration::from_millis(20));
            }
            Err(error) => {
                let _ = error_sender.send(WorkerError {
                    lane_id: lane_id.clone(),
                    message: error,
                });
                return;
            }
        }
    });

    Ok((sender, worker_thread))
}

#[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
fn push_or_defer_worker_samples(
    ring: &Arc<Mutex<RingBuffer>>,
    pending_samples: &mut Option<Vec<f32>>,
    samples: Vec<f32>,
) -> Result<bool, ()> {
    let mut guard = ring.lock().map_err(|_| ())?;
    if guard.push_samples(&samples) {
        Ok(true)
    } else {
        *pending_samples = Some(samples);
        Ok(false)
    }
}

#[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
enum StreamingDecoder {
    Wav(WavStreamDecoder),
    Symphonia(SymphoniaStreamDecoder),
}

#[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
trait WorkerDiagnosticsGenerationTarget {
    fn set_worker_diagnostics_generation(&mut self, generation: u64, lane_ordinal: usize);
}

#[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
fn apply_worker_control_diagnostics_generation<T: WorkerDiagnosticsGenerationTarget>(
    control: &WorkerControl,
    current_generation: &mut u64,
    decoder: &mut T,
    lane_ordinal: usize,
) {
    let next_generation = match control {
        WorkerControl::SetPlaybackRate {
            diagnostics_generation,
            ..
        }
        | WorkerControl::Seek {
            diagnostics_generation,
            ..
        } => Some(*diagnostics_generation),
        WorkerControl::Stop => None,
    };
    if let Some(next_generation) = next_generation {
        *current_generation = next_generation;
        decoder.set_worker_diagnostics_generation(next_generation, lane_ordinal);
    }
}

#[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
impl StreamingDecoder {
    fn open_with_diagnostics(
        path: PathBuf,
        target_sample_rate: u32,
        target_channels: usize,
        playback_rate: f64,
        start_seconds: f64,
        diagnostics_generation: u64,
        lane_ordinal: usize,
    ) -> Result<Self, String> {
        Self::open_inner(
            path,
            target_sample_rate,
            target_channels,
            playback_rate,
            start_seconds,
            decoder_diagnostics_context(diagnostics_generation, lane_ordinal),
        )
    }

    fn open_inner(
        path: PathBuf,
        target_sample_rate: u32,
        target_channels: usize,
        playback_rate: f64,
        start_seconds: f64,
        diagnostics_context: Option<(u64, usize)>,
    ) -> Result<Self, String> {
        let is_wav = path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.eq_ignore_ascii_case("wav"))
            .unwrap_or(false);
        if is_wav {
            match WavStreamDecoder::open(
                &path,
                target_sample_rate,
                target_channels,
                playback_rate,
                start_seconds,
            ) {
                Ok(decoder) => return Ok(Self::Wav(decoder)),
                Err(wav_error) => {
                    return SymphoniaStreamDecoder::open(
                        path,
                        target_sample_rate,
                        target_channels,
                        playback_rate,
                        start_seconds,
                        diagnostics_context,
                    )
                    .map(Self::Symphonia)
                    .map_err(|symphonia_error| {
                        format!(
                            "Native playback could not decode WAV source. Fast path failed: {wav_error}. Symphonia failed: {symphonia_error}"
                        )
                    });
                }
            }
        }

        SymphoniaStreamDecoder::open(
            path,
            target_sample_rate,
            target_channels,
            playback_rate,
            start_seconds,
            diagnostics_context,
        )
        .map(Self::Symphonia)
    }

    fn next_chunk(&mut self) -> Result<Option<Vec<f32>>, String> {
        match self {
            Self::Wav(decoder) => decoder.next_chunk(),
            Self::Symphonia(decoder) => decoder.next_chunk(),
        }
    }

    fn seek(&mut self, position_seconds: f64) -> Result<(), String> {
        match self {
            Self::Wav(decoder) => decoder.seek(position_seconds),
            Self::Symphonia(decoder) => decoder.seek(position_seconds),
        }
    }

    fn set_playback_rate(&mut self, playback_rate: f64) {
        match self {
            Self::Wav(decoder) => decoder.set_playback_rate(playback_rate),
            Self::Symphonia(decoder) => decoder.set_playback_rate(playback_rate),
        }
    }

    fn set_diagnostics_generation(&mut self, generation: u64, lane_ordinal: usize) {
        if let Self::Symphonia(decoder) = self {
            set_decoder_diagnostics_context(
                &mut decoder.diagnostics_context,
                generation,
                lane_ordinal,
            );
        }
    }
}

#[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
impl WorkerDiagnosticsGenerationTarget for StreamingDecoder {
    fn set_worker_diagnostics_generation(&mut self, generation: u64, lane_ordinal: usize) {
        self.set_diagnostics_generation(generation, lane_ordinal);
    }
}

#[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
fn decoder_diagnostics_context(generation: u64, lane_ordinal: usize) -> Option<(u64, usize)> {
    (generation != 0).then_some((generation, lane_ordinal))
}

#[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
fn set_decoder_diagnostics_context(
    context: &mut Option<(u64, usize)>,
    generation: u64,
    lane_ordinal: usize,
) {
    *context = decoder_diagnostics_context(generation, lane_ordinal);
}

#[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
struct WavStreamDecoder {
    file: File,
    audio_format: u16,
    channels: u16,
    sample_rate: u32,
    block_align: u16,
    bits_per_sample: u16,
    bytes_per_sample: usize,
    data_start: u64,
    data_end: u64,
    target_sample_rate: u32,
    target_channels: usize,
    playback_rate: f64,
    stretch: signalsmith_stretch::Stretch,
}

#[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
impl WavStreamDecoder {
    fn open(
        path: &Path,
        target_sample_rate: u32,
        target_channels: usize,
        playback_rate: f64,
        start_seconds: f64,
    ) -> Result<Self, String> {
        let mut file = File::open(path).map_err(|error| error.to_string())?;
        let mut riff = [0u8; 12];
        file.read_exact(&mut riff)
            .map_err(|error| error.to_string())?;
        if &riff[0..4] != b"RIFF" || &riff[8..12] != b"WAVE" {
            return Err("Not a PCM WAV file.".to_string());
        }

        let mut audio_format = 0u16;
        let mut channels = 0u16;
        let mut sample_rate = 0u32;
        let mut block_align = 0u16;
        let mut bits_per_sample = 0u16;
        let mut data_range: Option<(u64, u64)> = None;

        loop {
            let mut header = [0u8; 8];
            match file.read_exact(&mut header) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => break,
                Err(error) => return Err(error.to_string()),
            }

            let chunk_size = read_u32_le(&header, 4)
                .ok_or_else(|| "Invalid WAV chunk header.".to_string())?
                as u64;
            let chunk_start = file.stream_position().map_err(|error| error.to_string())?;
            let chunk_end = chunk_start.saturating_add(chunk_size);

            if &header[0..4] == b"fmt " {
                if chunk_size < 16 {
                    return Err("Invalid WAV fmt chunk.".to_string());
                }
                let mut fmt = vec![0u8; chunk_size as usize];
                file.read_exact(&mut fmt)
                    .map_err(|error| error.to_string())?;
                audio_format =
                    read_u16_le(&fmt, 0).ok_or_else(|| "Invalid WAV audio format.".to_string())?;
                channels =
                    read_u16_le(&fmt, 2).ok_or_else(|| "Invalid WAV channel count.".to_string())?;
                sample_rate =
                    read_u32_le(&fmt, 4).ok_or_else(|| "Invalid WAV sample rate.".to_string())?;
                block_align = read_u16_le(&fmt, 12)
                    .ok_or_else(|| "Invalid WAV block alignment.".to_string())?;
                bits_per_sample =
                    read_u16_le(&fmt, 14).ok_or_else(|| "Invalid WAV bit depth.".to_string())?;
            } else if &header[0..4] == b"data" {
                data_range = Some((chunk_start, chunk_end));
                file.seek(SeekFrom::Start(chunk_end + (chunk_size % 2)))
                    .map_err(|error| error.to_string())?;
            } else {
                file.seek(SeekFrom::Start(chunk_end + (chunk_size % 2)))
                    .map_err(|error| error.to_string())?;
            }
        }

        if audio_format != 1 && audio_format != 3 {
            return Err("WAV decode supports PCM and 32-bit float WAV files.".to_string());
        }
        if channels == 0 || sample_rate == 0 || block_align == 0 || bits_per_sample == 0 {
            return Err("Invalid WAV stream metadata.".to_string());
        }
        let bytes_per_sample = (bits_per_sample / 8) as usize;
        if bytes_per_sample == 0 {
            return Err("Invalid WAV bit depth.".to_string());
        }
        let (data_start, data_end) =
            data_range.ok_or_else(|| "WAV data chunk is missing.".to_string())?;

        let mut decoder = Self {
            file,
            audio_format,
            channels,
            sample_rate,
            block_align,
            bits_per_sample,
            bytes_per_sample,
            data_start,
            data_end,
            target_sample_rate,
            target_channels,
            playback_rate,
            stretch: signalsmith_stretch::Stretch::preset_default(
                target_channels as u32,
                target_sample_rate,
            ),
        };
        decoder.seek(start_seconds)?;
        Ok(decoder)
    }

    fn next_chunk(&mut self) -> Result<Option<Vec<f32>>, String> {
        let current = self
            .file
            .stream_position()
            .map_err(|error| error.to_string())?;
        if current >= self.data_end {
            return Ok(None);
        }

        let source_frames = STREAM_CHUNK_FRAMES
            .min(((self.data_end - current) / u64::from(self.block_align)) as usize);
        if source_frames == 0 {
            return Ok(None);
        }

        let byte_count = source_frames
            .checked_mul(self.block_align as usize)
            .ok_or_else(|| "WAV chunk is too large.".to_string())?;
        let mut bytes = vec![0u8; byte_count];
        let read_count = self
            .file
            .read(&mut bytes)
            .map_err(|error| error.to_string())?;
        bytes.truncate(read_count);
        let frames_read = bytes.len() / self.block_align as usize;
        if frames_read == 0 {
            return Ok(None);
        }

        let source_channels = self.channels as usize;
        let mut samples = Vec::with_capacity(frames_read.saturating_mul(source_channels));
        for frame_index in 0..frames_read {
            let frame_start = frame_index * self.block_align as usize;
            for channel_index in 0..source_channels {
                let sample_offset = frame_start + channel_index * self.bytes_per_sample;
                samples.push(
                    decode_wav_sample(
                        &bytes,
                        sample_offset,
                        self.audio_format,
                        self.bits_per_sample,
                    )?
                    .clamp(-1.0, 1.0) as f32,
                );
            }
        }

        prepare_stream_chunk(
            &samples,
            u32::from(self.channels),
            self.sample_rate,
            self.target_sample_rate,
            self.target_channels,
            self.playback_rate,
            &mut self.stretch,
        )
        .map(Some)
    }

    fn seek(&mut self, position_seconds: f64) -> Result<(), String> {
        let source_frame = (position_seconds.max(0.0) * self.sample_rate as f64).floor() as u64;
        let source_offset = source_frame.saturating_mul(u64::from(self.block_align));
        let bounded = self
            .data_start
            .saturating_add(source_offset)
            .min(self.data_end);
        self.file
            .seek(SeekFrom::Start(bounded))
            .map_err(|error| error.to_string())?;
        self.stretch.reset();
        Ok(())
    }

    fn set_playback_rate(&mut self, playback_rate: f64) {
        self.playback_rate = normalize_playback_rate(Some(playback_rate));
        self.stretch.reset();
    }
}

#[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
struct SymphoniaStreamDecoder {
    format: Box<dyn FormatReader>,
    decoder: Box<dyn AudioDecoder>,
    track_id: u32,
    sample_buffer: Vec<f32>,
    target_sample_rate: u32,
    target_channels: usize,
    playback_rate: f64,
    stretch: signalsmith_stretch::Stretch,
    diagnostics_context: Option<(u64, usize)>,
}

#[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
impl SymphoniaStreamDecoder {
    fn open(
        path: PathBuf,
        target_sample_rate: u32,
        target_channels: usize,
        playback_rate: f64,
        start_seconds: f64,
        diagnostics_context: Option<(u64, usize)>,
    ) -> Result<Self, String> {
        let file = File::open(&path).map_err(|error| error.to_string())?;
        let mss = MediaSourceStream::new(Box::new(file), Default::default());
        let mut hint = Hint::new();
        if let Some(extension) = path.extension().and_then(|value| value.to_str()) {
            hint.with_extension(extension);
        }
        let format = symphonia::default::get_probe()
            .probe(
                &hint,
                mss,
                FormatOptions::default(),
                MetadataOptions::default(),
            )
            .map_err(|error| format!("Native playback could not probe media: {error}"))?;
        let (track_id, codec_params) = {
            let track = format.default_track(TrackType::Audio).ok_or_else(|| {
                "Native playback source does not contain an audio track.".to_string()
            })?;
            let codec_params = track
                .codec_params
                .as_ref()
                .and_then(|params| params.audio())
                .cloned()
                .ok_or_else(|| {
                    "Native playback source does not contain a decodable audio track.".to_string()
                })?;
            (track.id, codec_params)
        };
        let decoder = symphonia::default::get_codecs()
            .make_audio_decoder(&codec_params, &AudioDecoderOptions::default())
            .map_err(|error| format!("Native playback codec is unsupported: {error}"))?;
        let mut stream = Self {
            format,
            decoder,
            track_id,
            sample_buffer: Vec::new(),
            target_sample_rate,
            target_channels,
            playback_rate,
            stretch: signalsmith_stretch::Stretch::preset_default(
                target_channels as u32,
                target_sample_rate,
            ),
            diagnostics_context,
        };
        if start_seconds > 0.0 {
            stream.seek(start_seconds)?;
        }
        Ok(stream)
    }

    fn next_chunk(&mut self) -> Result<Option<Vec<f32>>, String> {
        loop {
            let packet = match self.format.next_packet() {
                Ok(Some(packet)) => packet,
                Ok(None) => return Ok(None),
                Err(SymphoniaError::IoError(error))
                    if error.kind() == std::io::ErrorKind::UnexpectedEof =>
                {
                    return Ok(None)
                }
                Err(SymphoniaError::DecodeError(_)) => {
                    if let Some((generation, lane_ordinal)) = self.diagnostics_context {
                        diagnostics::record_checkpoint(
                            generation,
                            DiagnosticCheckpoint::SkippedPacketError,
                            Some(lane_ordinal),
                        );
                    }
                    continue;
                }
                Err(SymphoniaError::ResetRequired) => {
                    self.decoder.reset();
                    continue;
                }
                Err(error) => {
                    return Err(format!("Native playback demux failed: {error}"));
                }
            };

            if packet.track_id != self.track_id {
                continue;
            }

            let decoded = match self.decoder.decode(&packet) {
                Ok(decoded) => decoded,
                Err(SymphoniaError::DecodeError(_)) => {
                    if let Some((generation, lane_ordinal)) = self.diagnostics_context {
                        diagnostics::record_checkpoint(
                            generation,
                            DiagnosticCheckpoint::SkippedDecodeError,
                            Some(lane_ordinal),
                        );
                    }
                    continue;
                }
                Err(SymphoniaError::IoError(error))
                    if error.kind() == std::io::ErrorKind::UnexpectedEof =>
                {
                    return Ok(None)
                }
                Err(SymphoniaError::ResetRequired) => {
                    self.decoder.reset();
                    continue;
                }
                Err(error) => {
                    return Err(format!("Native playback decode failed: {error}"));
                }
            };
            let spec = decoded.spec().clone();
            self.sample_buffer
                .resize(decoded.samples_interleaved(), 0.0);
            decoded.copy_to_slice_interleaved::<f32, _>(&mut self.sample_buffer);

            return prepare_stream_chunk(
                &self.sample_buffer,
                spec.channels().count() as u32,
                spec.rate(),
                self.target_sample_rate,
                self.target_channels,
                self.playback_rate,
                &mut self.stretch,
            )
            .map(Some);
        }
    }

    fn seek(&mut self, position_seconds: f64) -> Result<(), String> {
        let time = Time::try_from_secs_f64(position_seconds.max(0.0)).ok_or_else(|| {
            "Native playback source cannot seek to the requested position.".to_string()
        })?;
        match self.format.seek(
            SeekMode::Accurate,
            SeekTo::Time {
                time,
                track_id: Some(self.track_id),
            },
        ) {
            Ok(_) => {
                self.decoder.reset();
                self.stretch.reset();
                self.sample_buffer.clear();
                Ok(())
            }
            Err(_) => {
                Err("Native playback source cannot seek to the requested position.".to_string())
            }
        }
    }

    fn set_playback_rate(&mut self, playback_rate: f64) {
        self.playback_rate = normalize_playback_rate(Some(playback_rate));
        self.stretch.reset();
    }
}

#[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
fn prepare_stream_chunk(
    samples: &[f32],
    source_channels: u32,
    source_sample_rate: u32,
    target_sample_rate: u32,
    target_channels: usize,
    playback_rate: f64,
    stretch: &mut signalsmith_stretch::Stretch,
) -> Result<Vec<f32>, String> {
    if samples.is_empty() || source_channels == 0 || target_channels == 0 {
        return Ok(Vec::new());
    }
    let resampled = resample_interleaved(
        samples,
        source_channels,
        source_sample_rate,
        target_sample_rate,
    );
    let converted =
        convert_interleaved_channels(&resampled, source_channels, target_channels as u32);
    if (playback_rate - DEFAULT_PLAYBACK_RATE).abs() <= RATE_TOLERANCE {
        return Ok(converted);
    }
    if playback_rate <= 0.0 {
        return Ok(converted);
    }

    let input_frames = converted.len() / target_channels;
    let output_frames = ((input_frames as f64) / playback_rate).ceil().max(1.0) as usize;
    let mut output = vec![0.0; output_frames * target_channels];
    stretch.process(&converted, &mut output);
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
    use std::fs;

    fn capabilities() -> AudioCapabilities {
        AudioCapabilities {
            platform: "test",
            backend: "test",
            native_playback_supported: true,
            mic_capture_supported: false,
            mic_monitoring_supported: false,
            system_input_volume_supported: false,
            emits_events: Vec::new(),
            fallback_required: false,
            fallback_reason: None,
        }
    }

    fn unsupported_capabilities(reason: &'static str) -> AudioCapabilities {
        AudioCapabilities {
            platform: "test",
            backend: "test-null",
            native_playback_supported: false,
            mic_capture_supported: false,
            mic_monitoring_supported: false,
            system_input_volume_supported: false,
            emits_events: Vec::new(),
            fallback_required: true,
            fallback_reason: Some(reason),
        }
    }

    fn stream_lane(id: &str, ring: Arc<Mutex<RingBuffer>>, target_gain: f32) -> PlaybackLane {
        PlaybackLane {
            id: id.to_string(),
            artifact_id: Some(format!("artifact-{id}")),
            role: AudioLaneRole::Stem,
            muted: false,
            solo: false,
            current_gain: target_gain,
            target_gain,
            scratch: vec![0.0; 1_000],
            source: PlaybackLaneSource::Stream(Arc::new(StreamingLane {
                ring,
                capacity_samples: 1_000,
                eof: Arc::new(AtomicBool::new(false)),
            })),
            underrun_count: 0,
            worker_error_count: 0,
            last_worker_error: None,
        }
    }

    fn shared_with_lane(
        ring: Arc<Mutex<RingBuffer>>,
        sample_rate: u32,
        channels: usize,
        target_gain: f32,
    ) -> PlaybackShared {
        PlaybackShared {
            session_id: Some("session".to_string()),
            status: TransportStatus::Playing,
            position_seconds: 0.0,
            duration_seconds: 10.0,
            playback_rate: 1.0,
            native_playback_supported: true,
            fallback_reason: None,
            sample_rate,
            channels,
            lanes: vec![stream_lane("lane", ring, target_gain)],
            snapshot_lanes: vec![EffectiveAudioLane {
                id: "lane".to_string(),
                artifact_id: Some("artifact-lane".to_string()),
                role: AudioLaneRole::Stem,
                effective_gain: target_gain,
                muted: false,
                solo: false,
            }],
            click: ClickState::default(),
            ended_pending: false,
            error_pending: None,
            terminal_error: None,
            buffering: false,
            sustained_underrun_frames: 0,
            underrun_error_pending: false,
            fallback_cause: None,
            diagnostics_generation: 0,
            diagnostics_gain_first_change_recorded: false,
        }
    }

    fn push_ring_samples(ring: &Arc<Mutex<RingBuffer>>, samples: &[f32]) {
        assert!(ring.lock().expect("ring lock").push_samples(samples));
    }

    #[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
    fn stoppable_runtime(shared: PlaybackShared) -> (PlaybackRuntime, Vec<mpsc::Receiver<()>>) {
        let (audio_stop_sender, audio_stop_receiver) = mpsc::channel();
        let (audio_exited_sender, audio_exited_receiver) = mpsc::channel();
        let audio_thread = thread::spawn(move || {
            let _ = audio_stop_receiver.recv();
            let _ = audio_exited_sender.send(());
        });
        let (reporter_stop_sender, reporter_stop_receiver) = mpsc::channel();
        let (reporter_exited_sender, reporter_exited_receiver) = mpsc::channel();
        let reporter_thread = thread::spawn(move || {
            let _ = reporter_stop_receiver.recv();
            let _ = reporter_exited_sender.send(());
        });
        let (worker_control_sender, worker_control_receiver) = mpsc::channel();
        let (worker_exited_sender, worker_exited_receiver) = mpsc::channel();
        let worker_thread = thread::spawn(move || {
            while let Ok(control) = worker_control_receiver.recv() {
                if matches!(control, WorkerControl::Stop) {
                    break;
                }
            }
            let _ = worker_exited_sender.send(());
        });
        (
            PlaybackRuntime {
                shared: Arc::new(Mutex::new(shared)),
                audio_stop_sender,
                reporter_stop_sender,
                worker_control_senders: vec![worker_control_sender],
                audio_thread: Some(audio_thread),
                reporter_thread: Some(reporter_thread),
                worker_threads: vec![worker_thread],
            },
            vec![
                audio_exited_receiver,
                reporter_exited_receiver,
                worker_exited_receiver,
            ],
        )
    }

    fn assert_seconds_close(actual: f64, expected: f64) {
        assert!(
            (actual - expected).abs() < 0.000_000_001,
            "expected {expected}, got {actual}"
        );
    }

    #[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
    fn assert_sample_close(actual: f32, expected: f32) {
        assert!(
            (actual - expected).abs() < 0.000_1,
            "expected {expected}, got {actual}"
        );
    }

    #[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
    fn write_mono_i16_wav(path: &std::path::Path, sample_rate: u32, samples: &[i16]) {
        let data_size = samples.len().checked_mul(2).expect("wav data size");
        let chunk_size = 36usize.checked_add(data_size).expect("wav chunk size") as u32;
        let data_size = data_size as u32;
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&chunk_size.to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&sample_rate.to_le_bytes());
        bytes.extend_from_slice(&(sample_rate * 2).to_le_bytes());
        bytes.extend_from_slice(&2u16.to_le_bytes());
        bytes.extend_from_slice(&16u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&data_size.to_le_bytes());
        for sample in samples {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
        fs::write(path, bytes).expect("write wav");
    }

    #[test]
    fn seek_clamps_to_duration() {
        let mut state = TransportState::default();
        state.prepare(
            None,
            AudioSessionRequest {
                session_id: "session".to_string(),
                duration_seconds: Some(30.0),
                playback_rate: Some(1.0),
                lanes: Vec::new(),
            },
            Vec::new(),
            capabilities(),
        );

        let snapshot = state.seek(AudioSeekRequest { time_seconds: 45.0 });

        assert_eq!(snapshot.position_seconds, 30.0);
    }

    #[test]
    fn play_rejects_session_without_native_runtime_support() {
        let mut state = TransportState::default();
        let reason = "Native output could not start.";
        let session = state.prepare(
            None,
            AudioSessionRequest {
                session_id: "session".to_string(),
                duration_seconds: Some(30.0),
                playback_rate: Some(1.0),
                lanes: Vec::new(),
            },
            Vec::new(),
            unsupported_capabilities(reason),
        );

        let error = state
            .play(AudioPlayRequest {
                start_time_seconds: Some(5.0),
                scheduled_start_time_seconds: None,
            })
            .expect_err("reject unavailable runtime");

        assert!(!session.native_playback_supported);
        assert_eq!(error, reason);
        assert_eq!(state.snapshot().state, "stopped");
        assert_eq!(state.snapshot().position_seconds, 0.0);
    }

    #[test]
    #[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
    fn play_rejects_a_retained_terminal_runtime_error() {
        let shared = Arc::new(Mutex::new(shared_with_lane(
            Arc::new(Mutex::new(RingBuffer::new(1_000))),
            1_000,
            1,
            1.0,
        )));
        mark_terminal_runtime_error(
            &mut shared.lock().expect("shared lock"),
            "Native audio output stream disconnected.".to_string(),
            DiagnosticSafeCode::OutputStreamFailure,
        );
        let (audio_stop_sender, _audio_stop_receiver) = mpsc::channel();
        let (reporter_stop_sender, _reporter_stop_receiver) = mpsc::channel();
        let mut state = TransportState::default();
        state.session_id = Some("session".to_string());
        state.native_playback_supported = true;
        state.runtime = Some(PlaybackRuntime {
            shared,
            audio_stop_sender,
            reporter_stop_sender,
            worker_control_senders: Vec::new(),
            audio_thread: None,
            reporter_thread: None,
            worker_threads: Vec::new(),
        });

        let error = state
            .play(AudioPlayRequest {
                start_time_seconds: Some(4.0),
                scheduled_start_time_seconds: None,
            })
            .expect_err("reject terminal runtime error");
        let snapshot = state.snapshot();

        assert_eq!(error, "Native audio output stream disconnected.");
        assert!(!snapshot.native_playback_supported);
        assert_eq!(
            snapshot.fallback_reason.as_deref(),
            Some("Native audio output stream disconnected.")
        );
        assert_eq!(snapshot.state, "paused");
    }

    #[test]
    #[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
    fn runtime_start_failure_cleanup_stops_decoder_workers() {
        let (control_sender, control_receiver) = mpsc::channel();
        let (exited_sender, exited_receiver) = mpsc::channel();
        let worker_thread = thread::spawn(move || {
            while let Ok(control) = control_receiver.recv() {
                if matches!(control, WorkerControl::Stop) {
                    break;
                }
            }
            let _ = exited_sender.send(());
        });
        let workers = DecoderWorkers {
            control_senders: vec![control_sender],
            threads: vec![worker_thread],
        };

        drop(workers);

        assert!(exited_receiver.try_recv().is_ok());
    }

    #[test]
    #[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
    fn stop_releases_failed_runtime_and_preserves_fallback_handoff_state() {
        let mut shared =
            shared_with_lane(Arc::new(Mutex::new(RingBuffer::new(1_000))), 1_000, 1, 1.0);
        shared.position_seconds = 4.25;
        shared.status = TransportStatus::Paused;
        shared.fallback_cause = Some(NativePlaybackFallbackCause::SustainedUnderrun);
        let (audio_stop_sender, _audio_stop_receiver) = mpsc::channel();
        let (reporter_stop_sender, _reporter_stop_receiver) = mpsc::channel();
        let mut state = TransportState::default();
        state.session_id = Some("session".to_string());
        state.duration_seconds = 10.0;
        state.native_playback_supported = true;
        state.runtime = Some(PlaybackRuntime {
            shared: Arc::new(Mutex::new(shared)),
            audio_stop_sender,
            reporter_stop_sender,
            worker_control_senders: Vec::new(),
            audio_thread: None,
            reporter_thread: None,
            worker_threads: Vec::new(),
        });

        let snapshot = state.stop();

        assert!(state.runtime.is_none());
        assert_eq!(snapshot.state, "paused");
        assert_seconds_close(snapshot.position_seconds, 4.25);
        assert!(!snapshot.native_playback_supported);
        assert_eq!(
            snapshot.fallback_reason.as_deref(),
            Some("Native playback underrun persisted; falling back to Web Audio.")
        );
    }

    #[test]
    #[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
    fn decoder_worker_exits_when_its_startup_owner_disconnects() {
        let path = std::env::temp_dir().join(format!(
            "tuneforge-decoder-worker-disconnect-test-{}.wav",
            std::process::id()
        ));
        write_mono_i16_wav(&path, 1_000, &[0; 4_096]);
        let ring = Arc::new(Mutex::new(RingBuffer::new(8_192)));
        let (error_sender, _error_receiver) = mpsc::channel();
        let (control_sender, worker_thread) = spawn_decoder_worker(
            "lane".to_string(),
            0,
            path.clone(),
            ring,
            Arc::new(AtomicBool::new(false)),
            1_000,
            1,
            1.0,
            error_sender,
            0,
        )
        .expect("spawn decoder worker");

        drop(control_sender);
        worker_thread.join().expect("decoder worker exits");
        let _ = fs::remove_file(path);
    }

    #[test]
    #[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
    fn sourced_lanes_receive_loaded_ordinals_when_raw_lanes_are_sparse() {
        let lane = |id: &str, source_path: Option<&str>| AudioLaneRequest {
            id: id.to_string(),
            artifact_id: Some(format!("artifact-{id}")),
            source_path: source_path.map(str::to_string),
            role: AudioLaneRole::Stem,
            gain: 1.0,
            muted: false,
            solo: false,
        };
        let raw_lanes = vec![
            lane("missing", None),
            lane("first-loaded", Some("first.wav")),
            lane("second-loaded", Some("second.wav")),
        ];

        let loaded = sourced_playback_lanes(&raw_lanes)
            .map(|(ordinal, lane)| (ordinal, lane.id.as_str()))
            .collect::<Vec<_>>();

        assert_eq!(loaded, vec![(0, "first-loaded"), (1, "second-loaded")]);
    }

    #[test]
    fn disabled_diagnostics_skip_gain_event_tracking_while_preserving_ramp_behavior() {
        let ring = Arc::new(Mutex::new(RingBuffer::new(1_000)));
        push_ring_samples(&ring, &[0.5]);
        let mut shared = shared_with_lane(ring, 1_000, 1, 1.0);
        shared.lanes[0].current_gain = 0.0;
        shared.diagnostics_generation = 0;
        let mut output = [0.0];

        render_shared_output(&mut shared, &mut output);

        assert!(shared.lanes[0].current_gain > 0.0);
        assert!(!shared.diagnostics_gain_first_change_recorded);
    }

    #[test]
    fn seek_clamps_to_zero() {
        let mut state = TransportState::default();
        state.prepare(
            None,
            AudioSessionRequest {
                session_id: "session".to_string(),
                duration_seconds: Some(30.0),
                playback_rate: Some(1.0),
                lanes: Vec::new(),
            },
            Vec::new(),
            capabilities(),
        );

        let snapshot = state.seek(AudioSeekRequest {
            time_seconds: -10.0,
        });

        assert_eq!(snapshot.position_seconds, 0.0);
    }

    #[test]
    fn stop_resets_transport_position() {
        let mut state = TransportState::default();
        state.prepare(
            None,
            AudioSessionRequest {
                session_id: "session".to_string(),
                duration_seconds: Some(30.0),
                playback_rate: Some(1.0),
                lanes: Vec::new(),
            },
            Vec::new(),
            capabilities(),
        );
        state.position_seconds = 12.0;

        let snapshot = state.stop();

        assert_eq!(snapshot.position_seconds, 0.0);
        assert_eq!(snapshot.state, "stopped");
        assert_eq!(snapshot.playback_rate, 1.0);
    }

    #[test]
    fn pause_preserves_current_position() {
        let mut state = TransportState::default();
        state.prepare(
            None,
            AudioSessionRequest {
                session_id: "session".to_string(),
                duration_seconds: Some(30.0),
                playback_rate: Some(1.0),
                lanes: Vec::new(),
            },
            Vec::new(),
            capabilities(),
        );
        state.position_seconds = 12.0;

        let snapshot = state.pause();

        assert_eq!(snapshot.position_seconds, 12.0);
        assert_eq!(snapshot.state, "paused");
    }

    #[test]
    #[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
    fn pause_releases_runtime_workers_and_preserves_confirmed_position() {
        let mut shared =
            shared_with_lane(Arc::new(Mutex::new(RingBuffer::new(1_000))), 1_000, 1, 1.0);
        shared.position_seconds = 6.5;
        let (runtime, exited_receivers) = stoppable_runtime(shared);
        let mut state = TransportState::default();
        state.session_id = Some("session".to_string());
        state.duration_seconds = 30.0;
        state.native_playback_supported = true;
        state.status = TransportStatus::Playing;
        state.runtime = Some(runtime);

        let snapshot = state.pause();

        assert!(state.runtime.is_none());
        assert_eq!(snapshot.state, "paused");
        assert_seconds_close(snapshot.position_seconds, 6.5);
        for receiver in exited_receivers {
            assert!(receiver.try_recv().is_ok());
        }
    }

    #[test]
    #[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
    fn stop_releases_runtime_workers_and_resets_position() {
        let mut shared =
            shared_with_lane(Arc::new(Mutex::new(RingBuffer::new(1_000))), 1_000, 1, 1.0);
        shared.position_seconds = 6.5;
        let (runtime, exited_receivers) = stoppable_runtime(shared);
        let mut state = TransportState::default();
        state.session_id = Some("session".to_string());
        state.duration_seconds = 30.0;
        state.native_playback_supported = true;
        state.status = TransportStatus::Playing;
        state.runtime = Some(runtime);

        let snapshot = state.stop();

        assert!(state.runtime.is_none());
        assert_eq!(snapshot.state, "stopped");
        assert_seconds_close(snapshot.position_seconds, 0.0);
        for receiver in exited_receivers {
            assert!(receiver.try_recv().is_ok());
        }
    }

    #[test]
    fn non_default_rate_is_native_supported_when_capability_allows_it() {
        let mut state = TransportState::default();
        let session = state.prepare(
            None,
            AudioSessionRequest {
                session_id: "session".to_string(),
                duration_seconds: Some(30.0),
                playback_rate: Some(0.75),
                lanes: Vec::new(),
            },
            Vec::new(),
            capabilities(),
        );

        assert!(session.native_playback_supported);
        assert_eq!(session.fallback_reason.as_deref(), None);
    }

    #[test]
    fn lane_update_can_change_playback_rate_without_reprepare() {
        let mut state = TransportState::default();
        state.prepare(
            None,
            AudioSessionRequest {
                session_id: "session".to_string(),
                duration_seconds: Some(30.0),
                playback_rate: Some(1.0),
                lanes: Vec::new(),
            },
            Vec::new(),
            capabilities(),
        );

        state.set_lanes(Vec::new(), Vec::new(), Some(1.5));
        let snapshot = state.snapshot();

        assert_eq!(snapshot.session_id.as_deref(), Some("session"));
        assert!((snapshot.playback_rate - 1.5).abs() < RATE_TOLERANCE);
    }

    #[test]
    fn count_in_play_uses_requested_start_offset_not_schedule_time() {
        let mut state = TransportState::default();
        state.prepare(
            None,
            AudioSessionRequest {
                session_id: "session".to_string(),
                duration_seconds: Some(30.0),
                playback_rate: Some(1.0),
                lanes: Vec::new(),
            },
            Vec::new(),
            capabilities(),
        );

        let snapshot = state
            .play(AudioPlayRequest {
                start_time_seconds: Some(6.25),
                scheduled_start_time_seconds: Some(2.0),
            })
            .expect("play");

        assert_eq!(snapshot.state, "playing");
        assert_eq!(state.status, TransportStatus::Playing);
        assert_seconds_close(state.position_seconds, 6.25);
    }

    #[test]
    fn click_sample_accents_first_beat() {
        let click = ClickState {
            enabled: true,
            bpm: 120.0,
            beats_per_bar: 4,
            accent_first_beat: true,
            gain: 1.0,
            follow_transport: true,
        };

        let accented = click_sample(&click, 0.001, 0).abs();
        let unaccented = click_sample(&click, 0.501, 0).abs();

        assert!(accented > unaccented);
    }

    #[test]
    fn offline_render_play_advances_position_deterministically() {
        let ring = Arc::new(Mutex::new(RingBuffer::new(1_000)));
        push_ring_samples(&ring, &vec![0.25; 1_000]);
        let mut shared = shared_with_lane(ring, 1_000, 1, 1.0);
        let mut output = vec![0.0; 128];

        render_shared_output(&mut shared, &mut output);

        assert_eq!(output[0], 0.25);
        assert_eq!(output[127], 0.25);
        assert_seconds_close(shared.position_seconds, 0.128);
        assert_eq!(shared.status, TransportStatus::Playing);
    }

    #[test]
    fn offline_render_stops_when_unknown_duration_stream_reaches_eof() {
        let ring = Arc::new(Mutex::new(RingBuffer::new(1_000)));
        push_ring_samples(&ring, &[0.25; 4]);
        let mut shared = shared_with_lane(ring, 1_000, 1, 1.0);
        shared.duration_seconds = 0.0;
        let PlaybackLaneSource::Stream(stream) = &shared.lanes[0].source;
        stream.eof.store(true, Ordering::Release);

        render_shared_output(&mut shared, &mut [0.0; 4]);

        assert_eq!(shared.status, TransportStatus::Stopped);
        assert!(shared.ended_pending);
        assert_seconds_close(shared.position_seconds, 0.0);
        assert!(shared.fallback_cause.is_none());
    }

    #[test]
    fn render_shared_output_advances_source_position_by_rate() {
        let ring = Arc::new(Mutex::new(RingBuffer::new(1_000)));
        push_ring_samples(&ring, &vec![0.5; 1_000]);
        let mut shared = shared_with_lane(ring, 1_000, 1, 1.0);
        shared.playback_rate = 2.0;
        let mut output = vec![0.0; 10];

        render_shared_output(&mut shared, &mut output);

        assert_eq!(output[0], 0.5);
        assert!((shared.position_seconds - 0.02).abs() < 0.0001);
    }

    #[test]
    fn offline_render_non_default_rate_advances_timing_by_rate() {
        let ring = Arc::new(Mutex::new(RingBuffer::new(2_000)));
        push_ring_samples(&ring, &vec![0.5; 2_000]);
        let mut shared = shared_with_lane(ring, 2_000, 1, 1.0);
        shared.playback_rate = 1.25;
        let mut output = vec![0.0; 40];

        render_shared_output(&mut shared, &mut output);

        assert_seconds_close(shared.position_seconds, 0.025);
        assert_eq!(shared.status, TransportStatus::Playing);
    }

    #[test]
    fn offline_render_pause_snapshot_stops_advancement_and_output() {
        let mut state = TransportState::default();
        state.prepare(
            None,
            AudioSessionRequest {
                session_id: "session".to_string(),
                duration_seconds: Some(30.0),
                playback_rate: Some(1.0),
                lanes: Vec::new(),
            },
            Vec::new(),
            capabilities(),
        );
        state.position_seconds = 4.0;

        let snapshot = state.pause();

        assert_eq!(snapshot.state, "paused");
        assert_seconds_close(snapshot.position_seconds, 4.0);

        let ring = Arc::new(Mutex::new(RingBuffer::new(1_000)));
        push_ring_samples(&ring, &vec![0.75; 1_000]);
        let mut shared = shared_with_lane(ring.clone(), 1_000, 1, 1.0);
        shared.status = state.status;
        shared.position_seconds = snapshot.position_seconds;
        let mut output = vec![1.0; 64];

        render_shared_output(&mut shared, &mut output);

        assert!(output.iter().all(|sample| *sample == 0.0));
        assert_seconds_close(shared.position_seconds, 4.0);
        assert_eq!(ring.lock().expect("ring lock").fill_samples(), 1_000);
    }

    #[test]
    fn offline_render_stop_snapshot_resets_position_and_output() {
        let mut state = TransportState::default();
        state.prepare(
            None,
            AudioSessionRequest {
                session_id: "session".to_string(),
                duration_seconds: Some(30.0),
                playback_rate: Some(1.0),
                lanes: Vec::new(),
            },
            Vec::new(),
            capabilities(),
        );
        state.position_seconds = 8.0;

        let snapshot = state.stop();

        assert_eq!(snapshot.state, "stopped");
        assert_seconds_close(snapshot.position_seconds, 0.0);

        let ring = Arc::new(Mutex::new(RingBuffer::new(1_000)));
        push_ring_samples(&ring, &vec![0.5; 1_000]);
        let mut shared = shared_with_lane(ring, 1_000, 1, 1.0);
        shared.status = TransportStatus::Stopped;
        shared.position_seconds = snapshot.position_seconds;
        let mut output = vec![1.0; 32];

        render_shared_output(&mut shared, &mut output);

        assert!(output.iter().all(|sample| *sample == 0.0));
        assert_seconds_close(shared.position_seconds, 0.0);
    }

    #[test]
    fn offline_loop_wrap_restarts_from_loop_start_after_owned_stop() {
        let loop_start = 0.5;
        let loop_end = 1.25;
        let mut state = TransportState::default();
        state.prepare(
            None,
            AudioSessionRequest {
                session_id: "session".to_string(),
                duration_seconds: Some(loop_end),
                playback_rate: Some(1.0),
                lanes: Vec::new(),
            },
            Vec::new(),
            capabilities(),
        );

        let ring = Arc::new(Mutex::new(RingBuffer::new(1_000)));
        push_ring_samples(&ring, &vec![0.2; 1_000]);
        let mut shared = shared_with_lane(ring, 1_000, 1, 1.0);
        shared.duration_seconds = loop_end;
        shared.position_seconds = 1.245;
        let mut output = vec![0.0; 6];

        render_shared_output(&mut shared, &mut output);
        assert_seconds_close(shared.position_seconds, 0.0);
        assert_eq!(shared.status, TransportStatus::Stopped);
        assert!(shared.ended_pending);

        state.position_seconds = shared.position_seconds;
        let snapshot = state
            .play(AudioPlayRequest {
                start_time_seconds: Some(loop_start),
                scheduled_start_time_seconds: None,
            })
            .expect("restart loop");
        assert_eq!(snapshot.state, "playing");
        assert_seconds_close(state.position_seconds, loop_start);

        clear_lane_rings(shared.diagnostics_generation, &mut shared.lanes);
        let PlaybackLaneSource::Stream(stream) = &shared.lanes[0].source;
        push_ring_samples(&stream.ring, &vec![0.8; 1_000]);
        shared.position_seconds = state.position_seconds;
        shared.ended_pending = false;
        shared.status = state.status;

        let mut wrapped_output = vec![0.0; 20];
        render_shared_output(&mut shared, &mut wrapped_output);

        assert_eq!(wrapped_output[0], 0.8);
        assert_seconds_close(shared.position_seconds, loop_start + 0.02);
        assert_eq!(shared.status, TransportStatus::Playing);
    }

    #[test]
    #[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
    fn offline_render_seek_starts_from_requested_wav_offset() {
        let sample_rate = 1_000;
        let path = std::env::temp_dir().join(format!(
            "tuneforge-transport-seek-offset-test-{}.wav",
            std::process::id()
        ));
        let samples: Vec<i16> = (0..100).collect();
        write_mono_i16_wav(&path, sample_rate, &samples);

        let mut decoder =
            WavStreamDecoder::open(&path, sample_rate, 1, 1.0, 0.0).expect("open stream decoder");
        decoder.seek(0.037).expect("seek stream decoder");
        let decoded = decoder
            .next_chunk()
            .expect("decode stream chunk")
            .expect("stream chunk");
        let _ = fs::remove_file(&path);

        assert_sample_close(decoded[0], 37.0 / i16::MAX as f32);
    }

    #[test]
    #[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
    fn tempo_and_seek_controls_attribute_skipped_events_to_active_generation() {
        assert_eq!(decoder_diagnostics_context(0, 3), None);
        let mut disabled_context = Some((9, 3));
        set_decoder_diagnostics_context(&mut disabled_context, 0, 3);
        assert_eq!(disabled_context, None);

        #[derive(Default)]
        struct DecoderProbe {
            context: Option<(u64, usize)>,
        }

        impl WorkerDiagnosticsGenerationTarget for DecoderProbe {
            fn set_worker_diagnostics_generation(&mut self, generation: u64, lane_ordinal: usize) {
                set_decoder_diagnostics_context(&mut self.context, generation, lane_ordinal);
            }
        }

        let mut decoder = DecoderProbe::default();
        let recorder = diagnostics::TestDiagnosticsRecorder::new();
        let mut current_generation =
            recorder.begin_operation(diagnostics::DiagnosticOperationKind::Play);

        let tempo_generation =
            recorder.begin_operation(diagnostics::DiagnosticOperationKind::Tempo);
        let tempo_control = WorkerControl::SetPlaybackRate {
            playback_rate: 1.25,
            position_seconds: 3.0,
            diagnostics_generation: tempo_generation,
        };
        apply_worker_control_diagnostics_generation(
            &tempo_control,
            &mut current_generation,
            &mut decoder,
            0,
        );
        recorder.record_skipped_decode_error(decoder.context.expect("tempo context").0, 0);

        let seek_generation = recorder.begin_operation(diagnostics::DiagnosticOperationKind::Seek);
        let seek_control = WorkerControl::Seek {
            position_seconds: 9.0,
            diagnostics_generation: seek_generation,
        };
        apply_worker_control_diagnostics_generation(
            &seek_control,
            &mut current_generation,
            &mut decoder,
            0,
        );
        recorder.record_skipped_decode_error(decoder.context.expect("seek context").0, 0);

        let export = recorder.export();
        assert_eq!(export.counters.stale_generation_event_count, 0);
        assert_eq!(export.operations[1].skipped_decode_error_count, 1);
        assert_eq!(export.operations[2].skipped_decode_error_count, 1);
        assert_eq!(decoder.context, Some((seek_generation, 0)));
    }

    #[test]
    fn snapshot_reports_buffer_health_for_stream_lane() {
        let ring = Arc::new(Mutex::new(RingBuffer::new(1_000)));
        push_ring_samples(&ring, &vec![0.5; 128]);
        let mut shared = shared_with_lane(ring, 1_000, 1, 1.0);
        shared.lanes[0].underrun_count = 2;
        shared.lanes[0].worker_error_count = 1;
        shared.lanes[0].last_worker_error = Some("decode failed".to_string());

        let snapshot = shared.snapshot();

        assert_eq!(snapshot.buffer_health.len(), 1);
        let health = &snapshot.buffer_health[0];
        assert_eq!(health.lane_id, "lane");
        assert_eq!(health.artifact_id.as_deref(), Some("artifact-lane"));
        assert_eq!(health.role, AudioLaneRole::Stem);
        assert_eq!(health.ring_fill_samples, 128);
        assert_eq!(health.ring_capacity_samples, 1_000);
        assert_eq!(health.underrun_count, 2);
        assert_eq!(health.worker_error_count, 1);
        assert_eq!(health.last_worker_error.as_deref(), Some("decode failed"));
    }

    #[test]
    fn prepare_lane_scratch_counts_empty_partial_and_lock_miss_underruns() {
        let empty_ring = Arc::new(Mutex::new(RingBuffer::new(1_000)));
        let mut empty_lane = stream_lane("empty", empty_ring, 1.0);
        assert!(prepare_lane_scratch(
            0,
            std::slice::from_mut(&mut empty_lane),
            10
        ));
        assert_eq!(empty_lane.underrun_count, 1);

        let partial_ring = Arc::new(Mutex::new(RingBuffer::new(1_000)));
        push_ring_samples(&partial_ring, &[0.25; 5]);
        let mut partial_lane = stream_lane("partial", partial_ring, 1.0);
        assert!(prepare_lane_scratch(
            0,
            std::slice::from_mut(&mut partial_lane),
            10
        ));
        assert_eq!(partial_lane.underrun_count, 1);
        assert_eq!(partial_lane.scratch[0], 0.25);
        assert_eq!(partial_lane.scratch[5], 0.0);

        let locked_ring = Arc::new(Mutex::new(RingBuffer::new(1_000)));
        let guard = locked_ring.lock().expect("ring lock");
        let mut locked_lane = stream_lane("locked", locked_ring.clone(), 1.0);
        assert!(prepare_lane_scratch(
            0,
            std::slice::from_mut(&mut locked_lane),
            10
        ));
        drop(guard);
        assert_eq!(locked_lane.underrun_count, 1);
    }

    #[test]
    fn sustained_underrun_marks_native_fallback_without_advancing() {
        let ring = Arc::new(Mutex::new(RingBuffer::new(1_000)));
        let mut shared = shared_with_lane(ring, 10, 1, 1.0);
        let mut output = vec![0.0; 5];

        render_shared_output(&mut shared, &mut output);
        let snapshot = shared.snapshot();

        assert_eq!(shared.status, TransportStatus::Paused);
        assert_eq!(
            shared.fallback_cause,
            Some(NativePlaybackFallbackCause::SustainedUnderrun)
        );
        assert!(!snapshot.native_playback_supported);
        assert_eq!(
            snapshot.fallback_reason.as_deref(),
            Some("Native playback underrun persisted; falling back to Web Audio.")
        );
        assert_eq!(shared.position_seconds, 0.0);
    }

    #[test]
    fn render_shared_output_does_not_advance_while_buffering() {
        let ring = Arc::new(Mutex::new(RingBuffer::new(1_000)));
        push_ring_samples(&ring, &vec![0.5; 1_000]);
        let mut shared = shared_with_lane(ring, 1_000, 1, 1.0);
        shared.buffering = true;
        let mut output = vec![1.0; 10];

        render_shared_output(&mut shared, &mut output);

        assert!(output.iter().all(|sample| *sample == 0.0));
        assert_eq!(shared.position_seconds, 0.0);
        assert_eq!(shared.lanes[0].underrun_count, 0);
    }

    #[test]
    fn worker_defers_stretched_tempo_chunks_instead_of_dropping_them() {
        let ring = Arc::new(Mutex::new(RingBuffer::new(8)));
        ring.lock()
            .expect("ring lock")
            .push_samples(&[0.1, 0.1, 0.1, 0.1, 0.1]);
        let mut pending_samples = None;

        let pushed =
            push_or_defer_worker_samples(&ring, &mut pending_samples, vec![1.0, 2.0, 3.0, 4.0])
                .expect("push samples");

        assert!(!pushed);
        assert_eq!(pending_samples.as_deref(), Some(&[1.0, 2.0, 3.0, 4.0][..]));
        assert_eq!(ring.lock().expect("ring lock").fill_samples(), 5);

        let mut drained = vec![0.0; 3];
        ring.lock().expect("ring lock").pop_into(&mut drained);
        let retry = pending_samples.take().expect("pending samples");

        let pushed = push_or_defer_worker_samples(&ring, &mut pending_samples, retry)
            .expect("retry pending samples");

        assert!(pushed);
        assert!(pending_samples.is_none());
        let mut output = vec![0.0; 6];
        ring.lock().expect("ring lock").pop_into(&mut output);
        assert_eq!(output, vec![0.1, 0.1, 1.0, 2.0, 3.0, 4.0]);
    }

    #[test]
    #[cfg(any(target_os = "android", target_os = "linux", target_os = "macos"))]
    fn wav_stream_decoder_preserves_stereo_channels() {
        let path = std::env::temp_dir().join(format!(
            "tuneforge-transport-stereo-stream-test-{}.wav",
            std::process::id()
        ));
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&44u32.to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&2u16.to_le_bytes());
        bytes.extend_from_slice(&48_000u32.to_le_bytes());
        bytes.extend_from_slice(&192_000u32.to_le_bytes());
        bytes.extend_from_slice(&4u16.to_le_bytes());
        bytes.extend_from_slice(&16u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&8u32.to_le_bytes());
        for sample in [i16::MAX, i16::MIN, 0, i16::MAX / 2] {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
        fs::write(&path, bytes).expect("write wav");

        let mut decoder =
            WavStreamDecoder::open(&path, 48_000, 2, 1.0, 0.0).expect("open stream decoder");
        let decoded = decoder
            .next_chunk()
            .expect("decode stream chunk")
            .expect("stream chunk");
        let _ = fs::remove_file(&path);

        assert_eq!(decoded.len(), 4);
        assert!(decoded[0] > 0.99);
        assert!(decoded[1] < -0.99);
        assert_eq!(decoded[2], 0.0);
        assert!(decoded[3] > 0.49);
    }
}
