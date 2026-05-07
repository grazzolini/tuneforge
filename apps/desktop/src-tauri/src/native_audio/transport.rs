use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::AppHandle;

#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::{
    collections::VecDeque,
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::mpsc,
    thread::{self, JoinHandle},
};

#[cfg(any(target_os = "linux", target_os = "macos"))]
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
#[cfg(any(target_os = "linux", target_os = "macos"))]
use cpal::{FromSample, Sample, SampleFormat, SizedSample};
#[cfg(any(target_os = "linux", target_os = "macos"))]
use symphonia::core::{
    audio::SampleBuffer,
    codecs::{Decoder, DecoderOptions, CODEC_TYPE_NULL},
    errors::Error as SymphoniaError,
    formats::{FormatOptions, FormatReader, SeekMode, SeekTo},
    io::MediaSourceStream,
    meta::MetadataOptions,
    probe::Hint,
    units::Time,
};
#[cfg(any(target_os = "linux", target_os = "macos"))]
use tauri::Emitter;

use super::{mixer::AudioLaneRequest, mixer::EffectiveAudioLane, AudioCapabilities};

#[cfg(any(target_os = "linux", target_os = "macos"))]
use super::{
    decode::{
        convert_interleaved_channels, decode_wav_sample, read_u16_le, read_u32_le,
        resample_interleaved,
    },
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
#[cfg(any(target_os = "linux", target_os = "macos"))]
const STREAM_CHUNK_FRAMES: usize = 2048;
#[cfg(any(target_os = "linux", target_os = "macos"))]
const RING_BUFFER_SECONDS: usize = 8;

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
    muted: bool,
    solo: bool,
    current_gain: f32,
    target_gain: f32,
    scratch: Vec<f32>,
    source: PlaybackLaneSource,
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
struct StreamingLane {
    ring: Arc<Mutex<RingBuffer>>,
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
struct RingBuffer {
    samples: VecDeque<f32>,
    capacity_samples: usize,
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
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

    fn clear(&mut self) {
        self.samples.clear();
    }

    fn pop_into(&mut self, output: &mut [f32]) {
        for sample in output {
            *sample = self.samples.pop_front().unwrap_or(0.0);
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

#[cfg(any(target_os = "linux", target_os = "macos"))]
enum WorkerControl {
    SetPlaybackRate {
        playback_rate: f64,
        position_seconds: f64,
    },
    Seek(f64),
    Stop,
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
}

impl PlaybackShared {
    fn snapshot(&self) -> AudioSnapshot {
        AudioSnapshot {
            session_id: self.session_id.clone(),
            state: self.status.as_str(),
            position_seconds: self.position_seconds,
            duration_seconds: self.duration_seconds,
            playback_rate: self.playback_rate,
            native_playback_supported: self.native_playback_supported,
            fallback_reason: self.fallback_reason.clone(),
            lanes: self.snapshot_lanes.clone(),
        }
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
struct PlaybackRuntime {
    shared: Arc<Mutex<PlaybackShared>>,
    audio_stop_sender: mpsc::Sender<RuntimeControl>,
    reporter_stop_sender: mpsc::Sender<RuntimeControl>,
    worker_control_senders: Vec<mpsc::Sender<WorkerControl>>,
    audio_thread: Option<JoinHandle<()>>,
    reporter_thread: Option<JoinHandle<()>>,
    worker_threads: Vec<JoinHandle<()>>,
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
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
    #[cfg(any(target_os = "linux", target_os = "macos"))]
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
            #[cfg(any(target_os = "linux", target_os = "macos"))]
            runtime: None,
        }
    }
}

impl TransportState {
    pub fn prepare(
        &mut self,
        app: Option<AppHandle>,
        request: AudioSessionRequest,
        lanes: Vec<EffectiveAudioLane>,
        capabilities: AudioCapabilities,
    ) -> AudioSession {
        let duration_seconds = request.duration_seconds.unwrap_or(0.0).max(0.0);
        let playback_rate = normalize_playback_rate(request.playback_rate);
        let mut native_playback_supported = capabilities.native_playback_supported;
        let mut fallback_reason = capabilities.fallback_reason.map(str::to_string);
        let mut next_runtime = None;

        self.stop_runtime();

        if native_playback_supported {
            #[cfg(any(target_os = "linux", target_os = "macos"))]
            if let Some(app) = app {
                match start_desktop_runtime(
                    app,
                    &request.session_id,
                    duration_seconds,
                    playback_rate,
                    &request.lanes,
                    &lanes,
                    &self.click,
                ) {
                    Ok(runtime) => {
                        next_runtime = Some(runtime);
                    }
                    Err(error) => {
                        native_playback_supported = false;
                        fallback_reason = Some(error);
                    }
                }
            }

            #[cfg(not(any(target_os = "linux", target_os = "macos")))]
            {
                native_playback_supported = false;
                fallback_reason =
                    Some("Native playback is unsupported on this platform.".to_string());
            }
        }

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
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        {
            self.runtime = next_runtime;
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
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        if let Some(runtime) = &self.runtime {
            if let Ok(mut shared) = runtime.shared.lock() {
                update_shared_lanes(&mut shared, &lanes);
                if let Some(rate) = next_playback_rate {
                    let position_seconds = shared.position_seconds;
                    self.position_seconds = position_seconds;
                    shared.playback_rate = rate;
                    for sender in &runtime.worker_control_senders {
                        let _ = sender.send(WorkerControl::SetPlaybackRate {
                            playback_rate: rate,
                            position_seconds,
                        });
                    }
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

        #[cfg(any(target_os = "linux", target_os = "macos"))]
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

        let should_seek_workers = request.start_time_seconds.is_some();
        if let Some(start_time_seconds) = request.start_time_seconds {
            self.position_seconds = self.clamp_position(start_time_seconds);
        }
        let _ = request.scheduled_start_time_seconds;
        self.status = TransportStatus::Playing;
        self.started_at = Some(Instant::now());

        #[cfg(any(target_os = "linux", target_os = "macos"))]
        if let Some(runtime) = &self.runtime {
            if should_seek_workers {
                seek_runtime_workers(runtime, self.position_seconds);
            }
            let mut shared = runtime
                .shared
                .lock()
                .map_err(|_| "Native playback state is unavailable.".to_string())?;
            shared.position_seconds = self.position_seconds;
            shared.status = TransportStatus::Playing;
            shared.ended_pending = false;
        }

        Ok(self.snapshot())
    }

    pub fn pause(&mut self) -> AudioSnapshot {
        self.position_seconds = self.current_position();
        self.status = TransportStatus::Paused;
        self.started_at = None;

        #[cfg(any(target_os = "linux", target_os = "macos"))]
        if let Some(runtime) = &self.runtime {
            if let Ok(mut shared) = runtime.shared.lock() {
                self.position_seconds = shared.position_seconds;
                shared.status = TransportStatus::Paused;
            }
        }

        self.snapshot()
    }

    pub fn stop(&mut self) -> AudioSnapshot {
        self.position_seconds = 0.0;
        self.status = TransportStatus::Stopped;
        self.started_at = None;

        #[cfg(any(target_os = "linux", target_os = "macos"))]
        if let Some(runtime) = &self.runtime {
            seek_runtime_workers(runtime, 0.0);
            if let Ok(mut shared) = runtime.shared.lock() {
                shared.position_seconds = 0.0;
                shared.status = TransportStatus::Stopped;
                shared.ended_pending = false;
            }
        }

        self.snapshot()
    }

    pub fn seek(&mut self, request: AudioSeekRequest) -> AudioSnapshot {
        self.position_seconds = self.clamp_position(request.time_seconds);
        if self.status == TransportStatus::Playing {
            self.started_at = Some(Instant::now());
        }

        #[cfg(any(target_os = "linux", target_os = "macos"))]
        if let Some(runtime) = &self.runtime {
            seek_runtime_workers(runtime, self.position_seconds);
            if let Ok(mut shared) = runtime.shared.lock() {
                shared.position_seconds = self.position_seconds;
                shared.ended_pending = false;
            }
        }

        self.snapshot()
    }

    pub fn snapshot(&self) -> AudioSnapshot {
        #[cfg(any(target_os = "linux", target_os = "macos"))]
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

    fn stop_runtime(&mut self) {
        #[cfg(any(target_os = "linux", target_os = "macos"))]
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

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn seek_runtime_workers(runtime: &PlaybackRuntime, position_seconds: f64) {
    for sender in &runtime.worker_control_senders {
        let _ = sender.send(WorkerControl::Seek(position_seconds));
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
        lane.target_gain = effective_gain_for_lane(lanes, &lane.id);
        if let Some(effective) = lanes.iter().find(|candidate| candidate.id == lane.id) {
            lane.muted = effective.muted;
            lane.solo = effective.solo;
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

fn prepare_lane_scratch(lanes: &mut [PlaybackLane], sample_count: usize) {
    for lane in lanes {
        if lane.scratch.len() < sample_count {
            lane.scratch.resize(sample_count, 0.0);
        } else {
            lane.scratch[..sample_count].fill(0.0);
        }

        match &lane.source {
            PlaybackLaneSource::Stream(stream) => {
                if let Ok(mut ring) = stream.ring.try_lock() {
                    ring.pop_into(&mut lane.scratch[..sample_count]);
                }
            }
        }
    }
}

#[cfg(test)]
fn render_shared_output(shared: &mut PlaybackShared, output: &mut [f32]) {
    if shared.channels == 0 {
        output.fill(0.0);
        return;
    }
    if shared.status == TransportStatus::Playing {
        prepare_lane_scratch(&mut shared.lanes, output.len());
    }

    for (frame_index, frame) in output.chunks_mut(shared.channels).enumerate() {
        if shared.status != TransportStatus::Playing {
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
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
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
    if shared.status == TransportStatus::Playing {
        prepare_lane_scratch(&mut shared.lanes, output.len());
    }

    for (frame_index, frame) in output.chunks_mut(shared.channels).enumerate() {
        if shared.status != TransportStatus::Playing {
            for sample in frame {
                *sample = silent;
            }
            continue;
        }

        for (channel, sample) in frame.iter_mut().enumerate() {
            *sample = T::from_sample(mix_shared_frame(
                shared,
                channel,
                frame_index * shared.channels + channel,
            ));
        }

        shared.position_seconds += shared.playback_rate / shared.sample_rate as f64;
        if shared.duration_seconds > 0.0 && shared.position_seconds >= shared.duration_seconds {
            shared.position_seconds = 0.0;
            shared.status = TransportStatus::Stopped;
            shared.ended_pending = true;
        }
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn start_desktop_runtime(
    app: AppHandle,
    session_id: &str,
    duration_seconds: f64,
    playback_rate: f64,
    raw_lanes: &[AudioLaneRequest],
    effective_lanes: &[EffectiveAudioLane],
    click: &ClickState,
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
    let sample_rate = stream_config.sample_rate.0;
    let channels = usize::from(stream_config.channels).max(1);
    let (worker_error_sender, worker_error_receiver) = mpsc::channel();
    let loaded_lanes = load_playback_lanes(
        raw_lanes,
        effective_lanes,
        sample_rate,
        channels,
        playback_rate,
        worker_error_sender,
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
        lanes: loaded_lanes.lanes,
        snapshot_lanes,
        click: click.clone(),
        ended_pending: false,
        error_pending: None,
    }));

    drop(device);

    let (audio_stop_sender, audio_stop_receiver) = mpsc::channel();
    let (ready_sender, ready_receiver) = mpsc::channel();
    let audio_thread = thread::spawn({
        let shared = shared.clone();
        let app = app.clone();
        move || {
            start_output_stream_thread(
                stream_config,
                sample_format,
                shared,
                app,
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

    let (reporter_stop_sender, reporter_stop_receiver) = mpsc::channel();
    let reporter_thread = thread::spawn({
        let shared = shared.clone();
        move || loop {
            if reporter_stop_receiver.try_recv().is_ok() {
                break;
            }
            while let Ok(message) = worker_error_receiver.try_recv() {
                if let Ok(mut shared) = shared.lock() {
                    shared.error_pending = Some(message);
                    shared.status = TransportStatus::Paused;
                }
            }
            emit_runtime_events(&app, &shared);
            thread::sleep(POSITION_EVENT_INTERVAL);
        }
    });

    Ok(PlaybackRuntime {
        shared,
        audio_stop_sender,
        reporter_stop_sender,
        worker_control_senders: loaded_lanes.worker_control_senders,
        audio_thread: Some(audio_thread),
        reporter_thread: Some(reporter_thread),
        worker_threads: loaded_lanes.worker_threads,
    })
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn start_output_stream_thread(
    config: cpal::StreamConfig,
    sample_format: SampleFormat,
    shared: Arc<Mutex<PlaybackShared>>,
    app: AppHandle,
    stop_receiver: mpsc::Receiver<RuntimeControl>,
    ready_sender: mpsc::Sender<Result<(), String>>,
) {
    let host = cpal::default_host();
    let result = (|| {
        let device = host
            .default_output_device()
            .ok_or_else(|| "Native audio output device is unavailable.".to_string())?;
        let stream = build_output_stream(&device, &config, sample_format, shared, app)?;
        stream
            .play()
            .map_err(|error| format!("Native audio output stream could not start: {error}"))?;
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

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn build_output_stream(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    sample_format: SampleFormat,
    shared: Arc<Mutex<PlaybackShared>>,
    app: AppHandle,
) -> Result<cpal::Stream, String> {
    match sample_format {
        SampleFormat::F32 => build_typed_output_stream::<f32>(device, config, shared, app),
        SampleFormat::I16 => build_typed_output_stream::<i16>(device, config, shared, app),
        SampleFormat::U16 => build_typed_output_stream::<u16>(device, config, shared, app),
        other => Err(format!(
            "Native audio sample format {other:?} is unsupported."
        )),
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn build_typed_output_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    shared: Arc<Mutex<PlaybackShared>>,
    app: AppHandle,
) -> Result<cpal::Stream, String>
where
    T: Sample + SizedSample + FromSample<f32>,
{
    let data_shared = shared.clone();
    let error_shared = shared;
    device
        .build_output_stream(
            config,
            move |output: &mut [T], _| {
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
                    shared.error_pending = Some(message.clone());
                    shared.status = TransportStatus::Paused;
                }
                let _ = app.emit(
                    AUDIO_EVENT_ERROR,
                    AudioErrorEvent {
                        session_id: None,
                        message,
                    },
                );
            },
            None,
        )
        .map_err(|error| format!("Native audio output stream could not be built: {error}"))
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn emit_runtime_events(app: &AppHandle, shared: &Arc<Mutex<PlaybackShared>>) {
    let (snapshot, ended, error) = {
        let mut shared = match shared.lock() {
            Ok(shared) => shared,
            Err(_) => return,
        };
        let snapshot = shared.snapshot();
        let ended = shared.ended_pending;
        shared.ended_pending = false;
        let error = shared.error_pending.take();
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
    if let Some(message) = error {
        let _ = app.emit(
            AUDIO_EVENT_ERROR,
            AudioErrorEvent {
                session_id: snapshot.session_id,
                message,
            },
        );
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
struct LoadedPlaybackLanes {
    lanes: Vec<PlaybackLane>,
    worker_control_senders: Vec<mpsc::Sender<WorkerControl>>,
    worker_threads: Vec<JoinHandle<()>>,
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn load_playback_lanes(
    raw_lanes: &[AudioLaneRequest],
    effective_lanes: &[EffectiveAudioLane],
    sample_rate: u32,
    channels: usize,
    playback_rate: f64,
    worker_error_sender: mpsc::Sender<String>,
) -> Result<LoadedPlaybackLanes, String> {
    let mut lanes = Vec::new();
    let mut worker_control_senders = Vec::new();
    let mut worker_threads = Vec::new();

    for lane in raw_lanes {
        let Some(source_path) = &lane.source_path else {
            continue;
        };
        let path = PathBuf::from(source_path);
        if !path.exists() {
            return Err(format!("Native playback source is missing: {source_path}"));
        }

        let capacity_samples = (sample_rate as usize)
            .saturating_mul(channels)
            .saturating_mul(RING_BUFFER_SECONDS)
            .max(
                STREAM_CHUNK_FRAMES
                    .saturating_mul(channels)
                    .saturating_mul(2),
            );
        let ring = Arc::new(Mutex::new(RingBuffer::new(capacity_samples)));
        let (sender, worker_thread) = spawn_decoder_worker(
            path,
            ring.clone(),
            sample_rate,
            channels,
            playback_rate,
            worker_error_sender.clone(),
        )?;
        let target_gain = effective_gain_for_lane(effective_lanes, &lane.id);
        worker_control_senders.push(sender);
        worker_threads.push(worker_thread);
        lanes.push(PlaybackLane {
            id: lane.id.clone(),
            muted: lane.muted,
            solo: lane.solo,
            current_gain: target_gain,
            target_gain,
            scratch: vec![0.0; sample_rate as usize * channels],
            source: PlaybackLaneSource::Stream(Arc::new(StreamingLane { ring })),
        });
    }

    Ok(LoadedPlaybackLanes {
        lanes,
        worker_control_senders,
        worker_threads,
    })
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn spawn_decoder_worker(
    path: PathBuf,
    ring: Arc<Mutex<RingBuffer>>,
    target_sample_rate: u32,
    target_channels: usize,
    playback_rate: f64,
    error_sender: mpsc::Sender<String>,
) -> Result<(mpsc::Sender<WorkerControl>, JoinHandle<()>), String> {
    let mut playback_rate = normalize_playback_rate(Some(playback_rate));
    let mut decoder = StreamingDecoder::open(
        path.clone(),
        target_sample_rate,
        target_channels,
        playback_rate,
        0.0,
    )?;
    let (sender, receiver) = mpsc::channel();
    let worker_thread = thread::spawn(move || loop {
        while let Ok(control) = receiver.try_recv() {
            match control {
                WorkerControl::SetPlaybackRate {
                    playback_rate: next_playback_rate,
                    position_seconds,
                } => {
                    playback_rate = normalize_playback_rate(Some(next_playback_rate));
                    if let Ok(mut guard) = ring.lock() {
                        guard.clear();
                    }
                    decoder.set_playback_rate(playback_rate);
                    if decoder.seek(position_seconds).is_err() {
                        match StreamingDecoder::open(
                            path.clone(),
                            target_sample_rate,
                            target_channels,
                            playback_rate,
                            position_seconds,
                        ) {
                            Ok(reopened) => {
                                decoder = reopened;
                            }
                            Err(error) => {
                                let _ = error_sender.send(error);
                                return;
                            }
                        }
                    }
                }
                WorkerControl::Seek(position_seconds) => {
                    if let Ok(mut guard) = ring.lock() {
                        guard.clear();
                    }
                    if decoder.seek(position_seconds).is_err() {
                        match StreamingDecoder::open(
                            path.clone(),
                            target_sample_rate,
                            target_channels,
                            playback_rate,
                            position_seconds,
                        ) {
                            Ok(reopened) => {
                                decoder = reopened;
                            }
                            Err(error) => {
                                let _ = error_sender.send(error);
                                return;
                            }
                        }
                    }
                }
                WorkerControl::Stop => return,
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
                if let Ok(mut guard) = ring.lock() {
                    if !guard.push_samples(&samples) {
                        drop(guard);
                        thread::sleep(Duration::from_millis(5));
                    }
                } else {
                    return;
                }
            }
            Ok(None) => {
                thread::sleep(Duration::from_millis(20));
            }
            Err(error) => {
                let _ = error_sender.send(error);
                return;
            }
        }
    });

    Ok((sender, worker_thread))
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
enum StreamingDecoder {
    Wav(WavStreamDecoder),
    Symphonia(SymphoniaStreamDecoder),
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
impl StreamingDecoder {
    fn open(
        path: PathBuf,
        target_sample_rate: u32,
        target_channels: usize,
        playback_rate: f64,
        start_seconds: f64,
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
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
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

#[cfg(any(target_os = "linux", target_os = "macos"))]
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

#[cfg(any(target_os = "linux", target_os = "macos"))]
struct SymphoniaStreamDecoder {
    format: Box<dyn FormatReader>,
    decoder: Box<dyn Decoder>,
    track_id: u32,
    sample_buffer: Option<SampleBuffer<f32>>,
    sample_buffer_spec: Option<(u32, usize)>,
    target_sample_rate: u32,
    target_channels: usize,
    playback_rate: f64,
    stretch: signalsmith_stretch::Stretch,
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
impl SymphoniaStreamDecoder {
    fn open(
        path: PathBuf,
        target_sample_rate: u32,
        target_channels: usize,
        playback_rate: f64,
        start_seconds: f64,
    ) -> Result<Self, String> {
        let file = File::open(&path).map_err(|error| error.to_string())?;
        let mss = MediaSourceStream::new(Box::new(file), Default::default());
        let mut hint = Hint::new();
        if let Some(extension) = path.extension().and_then(|value| value.to_str()) {
            hint.with_extension(extension);
        }
        let probed = symphonia::default::get_probe()
            .format(
                &hint,
                mss,
                &FormatOptions::default(),
                &MetadataOptions::default(),
            )
            .map_err(|error| format!("Native playback could not probe media: {error}"))?;
        let format = probed.format;
        let track = format
            .default_track()
            .or_else(|| {
                format
                    .tracks()
                    .iter()
                    .find(|track| track.codec_params.codec != CODEC_TYPE_NULL)
            })
            .ok_or_else(|| "Native playback source does not contain an audio track.".to_string())?;
        let track_id = track.id;
        let codec_params = track.codec_params.clone();
        let decoder = symphonia::default::get_codecs()
            .make(&codec_params, &DecoderOptions::default())
            .map_err(|error| format!("Native playback codec is unsupported: {error}"))?;

        let mut stream = Self {
            format,
            decoder,
            track_id,
            sample_buffer: None,
            sample_buffer_spec: None,
            target_sample_rate,
            target_channels,
            playback_rate,
            stretch: signalsmith_stretch::Stretch::preset_default(
                target_channels as u32,
                target_sample_rate,
            ),
        };
        if start_seconds > 0.0 {
            stream.seek(start_seconds)?;
        }
        Ok(stream)
    }

    fn next_chunk(&mut self) -> Result<Option<Vec<f32>>, String> {
        loop {
            let packet = match self.format.next_packet() {
                Ok(packet) => packet,
                Err(SymphoniaError::IoError(error))
                    if error.kind() == std::io::ErrorKind::UnexpectedEof =>
                {
                    return Ok(None)
                }
                Err(SymphoniaError::DecodeError(_)) => continue,
                Err(SymphoniaError::ResetRequired) => {
                    self.decoder.reset();
                    continue;
                }
                Err(error) => {
                    return Err(format!("Native playback demux failed: {error}"));
                }
            };

            if packet.track_id() != self.track_id {
                continue;
            }

            let decoded = match self.decoder.decode(&packet) {
                Ok(decoded) => decoded,
                Err(SymphoniaError::DecodeError(_)) => continue,
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
            let spec = *decoded.spec();
            let duration = decoded.capacity() as u64;
            let spec_key = (spec.rate, spec.channels.count());
            let needs_buffer = self
                .sample_buffer
                .as_ref()
                .map(|buffer| {
                    self.sample_buffer_spec != Some(spec_key)
                        || buffer.capacity() < duration as usize * spec.channels.count()
                })
                .unwrap_or(true);
            if needs_buffer {
                self.sample_buffer = Some(SampleBuffer::<f32>::new(duration, spec));
                self.sample_buffer_spec = Some(spec_key);
            }
            let buffer = self
                .sample_buffer
                .as_mut()
                .ok_or_else(|| "Native playback sample buffer is unavailable.".to_string())?;
            buffer.copy_interleaved_ref(decoded);

            return prepare_stream_chunk(
                buffer.samples(),
                spec.channels.count() as u32,
                spec.rate,
                self.target_sample_rate,
                self.target_channels,
                self.playback_rate,
                &mut self.stretch,
            )
            .map(Some);
        }
    }

    fn seek(&mut self, position_seconds: f64) -> Result<(), String> {
        match self.format.seek(
            SeekMode::Accurate,
            SeekTo::Time {
                time: Time::from(position_seconds.max(0.0)),
                track_id: Some(self.track_id),
            },
        ) {
            Ok(_) => {
                self.decoder.reset();
                self.stretch.reset();
                self.sample_buffer = None;
                self.sample_buffer_spec = None;
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

#[cfg(any(target_os = "linux", target_os = "macos"))]
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
    fn render_shared_output_advances_source_position_by_rate() {
        let ring = Arc::new(Mutex::new(RingBuffer::new(1_000)));
        ring.lock()
            .expect("ring lock")
            .push_samples(&vec![0.5; 1_000]);
        let mut shared = PlaybackShared {
            session_id: Some("session".to_string()),
            status: TransportStatus::Playing,
            position_seconds: 0.0,
            duration_seconds: 10.0,
            playback_rate: 2.0,
            native_playback_supported: true,
            fallback_reason: None,
            sample_rate: 1_000,
            channels: 1,
            lanes: vec![PlaybackLane {
                id: "lane".to_string(),
                muted: false,
                solo: false,
                current_gain: 1.0,
                target_gain: 1.0,
                scratch: vec![0.0; 1_000],
                source: PlaybackLaneSource::Stream(Arc::new(StreamingLane { ring })),
            }],
            snapshot_lanes: Vec::new(),
            click: ClickState::default(),
            ended_pending: false,
            error_pending: None,
        };
        let mut output = vec![0.0; 10];

        render_shared_output(&mut shared, &mut output);

        assert_eq!(output[0], 0.5);
        assert!((shared.position_seconds - 0.02).abs() < 0.0001);
    }

    #[test]
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
