use serde::Serialize;
use std::{
    collections::VecDeque,
    env,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::Instant,
};
use tauri::AppHandle;

const ENABLE_ENV: &str = "TUNEFORGE_NATIVE_AUDIO_DIAGNOSTICS";
const SCHEMA_VERSION: &str = "tuneforge-native-audio-diagnostics-v1";
const MAX_OPERATIONS: usize = 256;
const MAX_LANES: usize = 6;
const SAFE_CODE_COUNT: usize = 8;
const TIMESTAMP_PENDING: u64 = u64::MAX;

static DIAGNOSTICS: OnceLock<DiagnosticsRecorder> = OnceLock::new();

pub fn initialize() {
    let _ = global();
}

fn global() -> &'static DiagnosticsRecorder {
    DIAGNOSTICS.get_or_init(|| {
        DiagnosticsRecorder::new(
            env::var(ENABLE_ENV).ok().as_deref() == Some("1"),
            Arc::new(SystemClock::new()),
        )
    })
}

pub fn begin_operation(kind: DiagnosticOperationKind, lane_count: usize) -> u64 {
    global().begin_operation(kind, lane_count)
}

pub fn record_checkpoint(
    generation: u64,
    checkpoint: DiagnosticCheckpoint,
    lane_ordinal: Option<usize>,
) {
    if generation == 0 {
        return;
    }
    global().record_checkpoint(generation, checkpoint, lane_ordinal);
}

pub fn record_callback_nonzero(generation: u64) {
    if generation == 0 {
        return;
    }
    if let Some(recorder) = DIAGNOSTICS.get() {
        recorder.record_callback(generation, CallbackCheckpoint::FirstNonzero);
    }
}

pub fn record_gain_first_change(generation: u64) {
    if generation == 0 {
        return;
    }
    if let Some(recorder) = DIAGNOSTICS.get() {
        recorder.record_callback(generation, CallbackCheckpoint::GainFirstChange);
    }
}

pub fn record_gain_ramp_complete(generation: u64) {
    if generation == 0 {
        return;
    }
    if let Some(recorder) = DIAGNOSTICS.get() {
        recorder.record_callback(generation, CallbackCheckpoint::GainRampComplete);
    }
}

pub fn record_underrun(generation: u64) {
    if generation == 0 {
        return;
    }
    if let Some(recorder) = DIAGNOSTICS.get() {
        recorder.record_callback(generation, CallbackCheckpoint::Underrun);
    }
}

pub fn record_capacities(
    generation: u64,
    lane_count: usize,
    ring_capacity_samples: usize,
    scratch_capacity_samples: usize,
) {
    if generation == 0 {
        return;
    }
    global().record_capacities(
        generation,
        lane_count,
        ring_capacity_samples,
        scratch_capacity_samples,
    );
}

pub fn record_safe_code(generation: u64, code: DiagnosticSafeCode) {
    if generation == 0 {
        return;
    }
    global().record_safe_code(generation, code);
}

pub fn record_callback_safe_code(generation: u64, code: DiagnosticSafeCode) {
    if generation == 0 {
        return;
    }
    if let Some(recorder) = DIAGNOSTICS.get() {
        recorder.record_safe_code(generation, code);
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticOperationKind {
    Prepare,
    Play,
    Seek,
    Tempo,
    LaneUpdate,
    LaneRoute,
}

#[derive(Clone, Copy, Debug)]
pub enum DiagnosticCheckpoint {
    RingClear,
    WorkerFirstPcm,
    PrebufferReady,
    GainRampBegin,
    SkippedPacketError,
    SkippedDecodeError,
}

#[derive(Clone, Copy, Debug)]
enum CallbackCheckpoint {
    FirstNonzero,
    GainFirstChange,
    GainRampComplete,
    Underrun,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticSafeCode {
    PrebufferTimeout,
    SustainedUnderrun,
    RuntimeStartFailure,
    DecoderWorkerFailure,
    OutputStreamFailure,
    DeviceChanged,
    DeviceNotAvailable,
    StreamInvalidated,
}

const SAFE_CODES: [DiagnosticSafeCode; SAFE_CODE_COUNT] = [
    DiagnosticSafeCode::PrebufferTimeout,
    DiagnosticSafeCode::SustainedUnderrun,
    DiagnosticSafeCode::RuntimeStartFailure,
    DiagnosticSafeCode::DecoderWorkerFailure,
    DiagnosticSafeCode::OutputStreamFailure,
    DiagnosticSafeCode::DeviceChanged,
    DiagnosticSafeCode::DeviceNotAvailable,
    DiagnosticSafeCode::StreamInvalidated,
];

impl DiagnosticSafeCode {
    const fn index(self) -> usize {
        match self {
            Self::PrebufferTimeout => 0,
            Self::SustainedUnderrun => 1,
            Self::RuntimeStartFailure => 2,
            Self::DecoderWorkerFailure => 3,
            Self::OutputStreamFailure => 4,
            Self::DeviceChanged => 5,
            Self::DeviceNotAvailable => 6,
            Self::StreamInvalidated => 7,
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAudioDiagnosticsAvailability {
    pub enabled: bool,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAudioDiagnosticCounters {
    pub operation_count: u64,
    pub ring_clear_count: u64,
    pub worker_first_pcm_event_count: u64,
    pub prebuffer_ready_count: u64,
    pub callback_first_nonzero_count: u64,
    pub gain_ramp_begin_count: u64,
    pub gain_ramp_complete_count: u64,
    pub underrun_count: u64,
    pub skipped_packet_error_count: u64,
    pub skipped_decode_error_count: u64,
    pub stale_generation_event_count: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAudioOperationExportV1 {
    pub sequence: u64,
    pub kind: DiagnosticOperationKind,
    pub lane_count: usize,
    pub command_start_us: u64,
    pub ring_clear_count: u64,
    pub ring_clear_us: Vec<u64>,
    pub worker_first_pcm_count: u64,
    pub worker_first_pcm_us: Vec<Option<u64>>,
    pub all_workers_first_pcm_us: Option<u64>,
    pub prebuffer_ready_us: Option<u64>,
    pub callback_first_nonzero_us: Option<u64>,
    pub gain_ramp_begin_count: u64,
    pub gain_ramp_begin_us: Option<u64>,
    pub gain_first_change_us: Option<u64>,
    pub gain_ramp_complete_count: u64,
    pub first_gain_ramp_complete_us: Option<u64>,
    pub underrun_count: u64,
    pub first_underrun_us: Option<u64>,
    pub skipped_packet_error_count: u64,
    pub skipped_decode_error_count: u64,
    pub ring_capacity_samples: Option<usize>,
    pub scratch_capacity_samples: Option<usize>,
    pub rss_kib_at_begin: Option<u64>,
    pub safe_codes: Vec<DiagnosticSafeCodeCount>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticSafeCodeCount {
    pub code: DiagnosticSafeCode,
    pub count: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAudioDiagnosticExportV1 {
    pub schema_version: &'static str,
    pub relative_now_us: u64,
    pub reset_count: u64,
    pub counters: NativeAudioDiagnosticCounters,
    pub operations: Vec<NativeAudioOperationExportV1>,
    pub safe_codes: Vec<DiagnosticSafeCodeCount>,
    pub rss_kib_at_export: Option<u64>,
}

trait DiagnosticClock: Send + Sync {
    fn now_us(&self) -> u64;
}

struct SystemClock {
    started: Instant,
}

impl SystemClock {
    fn new() -> Self {
        Self {
            started: Instant::now(),
        }
    }
}

impl DiagnosticClock for SystemClock {
    fn now_us(&self) -> u64 {
        self.started.elapsed().as_micros().min(u128::from(u64::MAX)) as u64
    }
}

#[derive(Default)]
struct AtomicCounters {
    operation_count: AtomicU64,
    ring_clear_count: AtomicU64,
    worker_first_pcm_event_count: AtomicU64,
    prebuffer_ready_count: AtomicU64,
    callback_first_nonzero_count: AtomicU64,
    gain_ramp_begin_count: AtomicU64,
    gain_ramp_complete_count: AtomicU64,
    underrun_count: AtomicU64,
    skipped_packet_error_count: AtomicU64,
    skipped_decode_error_count: AtomicU64,
    stale_generation_event_count: AtomicU64,
}

impl AtomicCounters {
    fn snapshot(&self) -> NativeAudioDiagnosticCounters {
        NativeAudioDiagnosticCounters {
            operation_count: self.operation_count.load(Ordering::Relaxed),
            ring_clear_count: self.ring_clear_count.load(Ordering::Relaxed),
            worker_first_pcm_event_count: self.worker_first_pcm_event_count.load(Ordering::Relaxed),
            prebuffer_ready_count: self.prebuffer_ready_count.load(Ordering::Relaxed),
            callback_first_nonzero_count: self.callback_first_nonzero_count.load(Ordering::Relaxed),
            gain_ramp_begin_count: self.gain_ramp_begin_count.load(Ordering::Relaxed),
            gain_ramp_complete_count: self.gain_ramp_complete_count.load(Ordering::Relaxed),
            underrun_count: self.underrun_count.load(Ordering::Relaxed),
            skipped_packet_error_count: self.skipped_packet_error_count.load(Ordering::Relaxed),
            skipped_decode_error_count: self.skipped_decode_error_count.load(Ordering::Relaxed),
            stale_generation_event_count: self.stale_generation_event_count.load(Ordering::Relaxed),
        }
    }

    fn reset(&self) {
        for counter in [
            &self.operation_count,
            &self.ring_clear_count,
            &self.worker_first_pcm_event_count,
            &self.prebuffer_ready_count,
            &self.callback_first_nonzero_count,
            &self.gain_ramp_begin_count,
            &self.gain_ramp_complete_count,
            &self.underrun_count,
            &self.skipped_packet_error_count,
            &self.skipped_decode_error_count,
            &self.stale_generation_event_count,
        ] {
            counter.store(0, Ordering::Relaxed);
        }
    }
}

struct CallbackSlot {
    generation: AtomicU64,
    first_nonzero_us: AtomicU64,
    gain_first_change_us: AtomicU64,
    gain_ramp_complete_count: AtomicU64,
    first_gain_ramp_complete_us: AtomicU64,
    underrun_count: AtomicU64,
    first_underrun_us: AtomicU64,
    safe_code_counts: [AtomicU64; SAFE_CODE_COUNT],
}

impl CallbackSlot {
    fn new() -> Self {
        Self {
            generation: AtomicU64::new(0),
            first_nonzero_us: AtomicU64::new(0),
            gain_first_change_us: AtomicU64::new(0),
            gain_ramp_complete_count: AtomicU64::new(0),
            first_gain_ramp_complete_us: AtomicU64::new(0),
            underrun_count: AtomicU64::new(0),
            first_underrun_us: AtomicU64::new(0),
            safe_code_counts: std::array::from_fn(|_| AtomicU64::new(0)),
        }
    }

    fn assign(&self, generation: u64) {
        self.first_nonzero_us.store(0, Ordering::Relaxed);
        self.gain_first_change_us.store(0, Ordering::Relaxed);
        self.gain_ramp_complete_count.store(0, Ordering::Relaxed);
        self.first_gain_ramp_complete_us.store(0, Ordering::Relaxed);
        self.underrun_count.store(0, Ordering::Relaxed);
        self.first_underrun_us.store(0, Ordering::Relaxed);
        for count in &self.safe_code_counts {
            count.store(0, Ordering::Relaxed);
        }
        self.generation.store(generation, Ordering::Release);
    }
}

struct OperationState {
    generation: u64,
    sequence: u64,
    kind: DiagnosticOperationKind,
    lane_count: usize,
    began_us: u64,
    ring_clear_count: u64,
    ring_clear_us: Vec<u64>,
    worker_first_pcm_us: [Option<u64>; MAX_LANES],
    prebuffer_ready_us: Option<u64>,
    gain_ramp_begin_count: u64,
    gain_ramp_begin_us: Option<u64>,
    skipped_packet_error_count: u64,
    skipped_decode_error_count: u64,
    ring_capacity_samples: Option<usize>,
    scratch_capacity_samples: Option<usize>,
    rss_kib_at_begin: Option<u64>,
}

#[derive(Default)]
struct DiagnosticInner {
    operations: VecDeque<OperationState>,
    reset_count: u64,
}

struct DiagnosticsRecorder {
    enabled: bool,
    clock: Arc<dyn DiagnosticClock>,
    next_generation: AtomicU64,
    current_generation: AtomicU64,
    counters: AtomicCounters,
    safe_code_counts: [AtomicU64; SAFE_CODE_COUNT],
    callback_slots: [CallbackSlot; MAX_OPERATIONS],
    inner: Mutex<DiagnosticInner>,
}

impl DiagnosticsRecorder {
    fn new(enabled: bool, clock: Arc<dyn DiagnosticClock>) -> Self {
        Self {
            enabled,
            clock,
            next_generation: AtomicU64::new(0),
            current_generation: AtomicU64::new(0),
            counters: AtomicCounters::default(),
            safe_code_counts: std::array::from_fn(|_| AtomicU64::new(0)),
            callback_slots: std::array::from_fn(|_| CallbackSlot::new()),
            inner: Mutex::new(DiagnosticInner::default()),
        }
    }

    fn begin_operation(&self, kind: DiagnosticOperationKind, lane_count: usize) -> u64 {
        if !self.enabled {
            return 0;
        }
        let generation = self
            .next_generation
            .fetch_add(1, Ordering::Relaxed)
            .saturating_add(1);
        self.current_generation.store(generation, Ordering::Release);
        self.counters
            .operation_count
            .fetch_add(1, Ordering::Relaxed);
        self.callback_slot(generation).assign(generation);
        if let Ok(mut inner) = self.inner.lock() {
            if inner.operations.len() == MAX_OPERATIONS {
                inner.operations.pop_front();
            }
            let sequence = inner
                .operations
                .back()
                .map(|operation| operation.sequence.saturating_add(1))
                .unwrap_or(1);
            inner.operations.push_back(OperationState {
                generation,
                sequence,
                kind,
                lane_count: lane_count.min(MAX_LANES),
                began_us: self.clock.now_us(),
                ring_clear_count: 0,
                ring_clear_us: Vec::with_capacity(MAX_LANES),
                worker_first_pcm_us: [None; MAX_LANES],
                prebuffer_ready_us: None,
                gain_ramp_begin_count: 0,
                gain_ramp_begin_us: None,
                skipped_packet_error_count: 0,
                skipped_decode_error_count: 0,
                ring_capacity_samples: None,
                scratch_capacity_samples: None,
                rss_kib_at_begin: current_rss_kib(),
            });
        }
        generation
    }

    fn record_checkpoint(
        &self,
        generation: u64,
        checkpoint: DiagnosticCheckpoint,
        lane_ordinal: Option<usize>,
    ) {
        let counter = match checkpoint {
            DiagnosticCheckpoint::RingClear => &self.counters.ring_clear_count,
            DiagnosticCheckpoint::WorkerFirstPcm => &self.counters.worker_first_pcm_event_count,
            DiagnosticCheckpoint::PrebufferReady => &self.counters.prebuffer_ready_count,
            DiagnosticCheckpoint::GainRampBegin => &self.counters.gain_ramp_begin_count,
            DiagnosticCheckpoint::SkippedPacketError => &self.counters.skipped_packet_error_count,
            DiagnosticCheckpoint::SkippedDecodeError => &self.counters.skipped_decode_error_count,
        };
        if generation == 0 {
            return;
        }
        if !self.accepts_generation(generation) {
            return;
        }
        counter.fetch_add(1, Ordering::Relaxed);
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        let Some(operation) = inner
            .operations
            .iter_mut()
            .find(|operation| operation.generation == generation)
        else {
            return;
        };
        let elapsed_us = self.clock.now_us().saturating_sub(operation.began_us);
        match checkpoint {
            DiagnosticCheckpoint::RingClear => {
                operation.ring_clear_count = operation.ring_clear_count.saturating_add(1);
                if operation.ring_clear_us.len() < MAX_LANES {
                    operation.ring_clear_us.push(elapsed_us);
                }
            }
            DiagnosticCheckpoint::WorkerFirstPcm => {
                if let Some(ordinal) =
                    lane_ordinal.filter(|ordinal| *ordinal < operation.lane_count)
                {
                    operation.worker_first_pcm_us[ordinal].get_or_insert(elapsed_us);
                }
            }
            DiagnosticCheckpoint::PrebufferReady => {
                operation.prebuffer_ready_us.get_or_insert(elapsed_us);
            }
            DiagnosticCheckpoint::GainRampBegin => {
                operation.gain_ramp_begin_count = operation.gain_ramp_begin_count.saturating_add(1);
                operation.gain_ramp_begin_us.get_or_insert(elapsed_us);
            }
            DiagnosticCheckpoint::SkippedPacketError => {
                operation.skipped_packet_error_count =
                    operation.skipped_packet_error_count.saturating_add(1)
            }
            DiagnosticCheckpoint::SkippedDecodeError => {
                operation.skipped_decode_error_count =
                    operation.skipped_decode_error_count.saturating_add(1)
            }
        }
    }

    fn record_callback(&self, generation: u64, checkpoint: CallbackCheckpoint) {
        if generation == 0 {
            return;
        }
        if !self.accepts_generation(generation) {
            return;
        }
        let slot = self.callback_slot(generation);
        if slot.generation.load(Ordering::Acquire) != generation {
            return;
        }
        match checkpoint {
            CallbackCheckpoint::FirstNonzero => {
                if self.record_first_callback_timestamp(&slot.first_nonzero_us) {
                    self.counters
                        .callback_first_nonzero_count
                        .fetch_add(1, Ordering::Relaxed);
                }
            }
            CallbackCheckpoint::GainFirstChange => {
                self.record_first_callback_timestamp(&slot.gain_first_change_us);
            }
            CallbackCheckpoint::GainRampComplete => {
                slot.gain_ramp_complete_count
                    .fetch_add(1, Ordering::Relaxed);
                self.record_first_callback_timestamp(&slot.first_gain_ramp_complete_us);
                self.counters
                    .gain_ramp_complete_count
                    .fetch_add(1, Ordering::Relaxed);
            }
            CallbackCheckpoint::Underrun => {
                slot.underrun_count.fetch_add(1, Ordering::Relaxed);
                self.record_first_callback_timestamp(&slot.first_underrun_us);
                self.counters.underrun_count.fetch_add(1, Ordering::Relaxed);
            }
        }
    }

    fn record_first_callback_timestamp(&self, timestamp: &AtomicU64) -> bool {
        if timestamp.load(Ordering::Relaxed) != 0 {
            return false;
        }
        if timestamp
            .compare_exchange(0, TIMESTAMP_PENDING, Ordering::AcqRel, Ordering::Relaxed)
            .is_err()
        {
            return false;
        }
        let captured = if self.enabled {
            self.clock.now_us().max(1)
        } else {
            1
        };
        timestamp.store(captured, Ordering::Release);
        true
    }

    fn record_capacities(
        &self,
        generation: u64,
        lane_count: usize,
        ring_capacity_samples: usize,
        scratch_capacity_samples: usize,
    ) {
        if !self.enabled || generation != self.current_generation.load(Ordering::Acquire) {
            return;
        }
        if let Ok(mut inner) = self.inner.lock() {
            if let Some(operation) = inner
                .operations
                .iter_mut()
                .find(|operation| operation.generation == generation)
            {
                operation.lane_count = lane_count.min(MAX_LANES);
                operation.ring_capacity_samples = Some(ring_capacity_samples);
                operation.scratch_capacity_samples = Some(scratch_capacity_samples);
            }
        }
    }

    fn record_safe_code(&self, generation: u64, code: DiagnosticSafeCode) {
        if generation == 0 {
            return;
        }
        if !self.accepts_generation(generation) {
            return;
        }
        self.safe_code_counts[code.index()].fetch_add(1, Ordering::Relaxed);
        let slot = self.callback_slot(generation);
        if slot.generation.load(Ordering::Acquire) == generation {
            slot.safe_code_counts[code.index()].fetch_add(1, Ordering::Relaxed);
        }
    }

    fn callback_slot(&self, generation: u64) -> &CallbackSlot {
        &self.callback_slots[(generation as usize) % MAX_OPERATIONS]
    }

    fn accepts_generation(&self, generation: u64) -> bool {
        if generation == 0 {
            return false;
        }
        let current = self.current_generation.load(Ordering::Acquire);
        if generation == current {
            return true;
        }
        if current != 0 {
            self.counters
                .stale_generation_event_count
                .fetch_add(1, Ordering::Relaxed);
        }
        false
    }

    fn availability(&self) -> NativeAudioDiagnosticsAvailability {
        NativeAudioDiagnosticsAvailability {
            enabled: self.enabled,
        }
    }

    fn export(&self) -> Result<NativeAudioDiagnosticExportV1, String> {
        self.require_enabled()?;
        let inner = self
            .inner
            .lock()
            .map_err(|_| "Native audio diagnostics are unavailable.".to_string())?;
        let operations = inner
            .operations
            .iter()
            .map(|operation| {
                let slot = self.callback_slot(operation.generation);
                let slot_matches = slot.generation.load(Ordering::Acquire) == operation.generation;
                let worker_first_pcm_us =
                    operation.worker_first_pcm_us[..operation.lane_count].to_vec();
                let worker_first_pcm_count = worker_first_pcm_us
                    .iter()
                    .filter(|timestamp| timestamp.is_some())
                    .count() as u64;
                let all_workers_first_pcm_us = (worker_first_pcm_count
                    == operation.lane_count as u64)
                    .then(|| worker_first_pcm_us.iter().flatten().copied().max())
                    .flatten();
                NativeAudioOperationExportV1 {
                    sequence: operation.sequence,
                    kind: operation.kind,
                    lane_count: operation.lane_count,
                    command_start_us: 0,
                    ring_clear_count: operation.ring_clear_count,
                    ring_clear_us: operation.ring_clear_us.clone(),
                    worker_first_pcm_count,
                    worker_first_pcm_us,
                    all_workers_first_pcm_us,
                    prebuffer_ready_us: operation.prebuffer_ready_us,
                    callback_first_nonzero_us: slot_matches
                        .then(|| callback_timestamp(&slot.first_nonzero_us))
                        .flatten()
                        .map(|timestamp| timestamp.saturating_sub(operation.began_us)),
                    gain_ramp_begin_count: operation.gain_ramp_begin_count,
                    gain_ramp_begin_us: operation.gain_ramp_begin_us,
                    gain_first_change_us: slot_matches
                        .then(|| callback_timestamp(&slot.gain_first_change_us))
                        .flatten()
                        .map(|timestamp| timestamp.saturating_sub(operation.began_us)),
                    gain_ramp_complete_count: slot_matches
                        .then(|| slot.gain_ramp_complete_count.load(Ordering::Relaxed))
                        .unwrap_or(0),
                    first_gain_ramp_complete_us: slot_matches
                        .then(|| callback_timestamp(&slot.first_gain_ramp_complete_us))
                        .flatten()
                        .map(|timestamp| timestamp.saturating_sub(operation.began_us)),
                    underrun_count: slot_matches
                        .then(|| slot.underrun_count.load(Ordering::Relaxed))
                        .unwrap_or(0),
                    first_underrun_us: slot_matches
                        .then(|| callback_timestamp(&slot.first_underrun_us))
                        .flatten()
                        .map(|timestamp| timestamp.saturating_sub(operation.began_us)),
                    skipped_packet_error_count: operation.skipped_packet_error_count,
                    skipped_decode_error_count: operation.skipped_decode_error_count,
                    ring_capacity_samples: operation.ring_capacity_samples,
                    scratch_capacity_samples: operation.scratch_capacity_samples,
                    rss_kib_at_begin: operation.rss_kib_at_begin,
                    safe_codes: slot_matches
                        .then(|| safe_code_counts(&slot.safe_code_counts))
                        .unwrap_or_default(),
                }
            })
            .collect();
        Ok(NativeAudioDiagnosticExportV1 {
            schema_version: SCHEMA_VERSION,
            relative_now_us: self.clock.now_us(),
            reset_count: inner.reset_count,
            counters: self.counters.snapshot(),
            operations,
            safe_codes: safe_code_counts(&self.safe_code_counts),
            rss_kib_at_export: current_rss_kib(),
        })
    }

    fn reset(&self) -> Result<NativeAudioDiagnosticExportV1, String> {
        self.require_enabled()?;
        self.current_generation.store(0, Ordering::Release);
        self.counters.reset();
        for count in &self.safe_code_counts {
            count.store(0, Ordering::Relaxed);
        }
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Native audio diagnostics are unavailable.".to_string())?;
        inner.operations.clear();
        inner.reset_count = inner.reset_count.saturating_add(1);
        drop(inner);
        self.export()
    }

    fn require_enabled(&self) -> Result<(), String> {
        if self.enabled {
            Ok(())
        } else {
            Err("Native audio diagnostics are disabled.".to_string())
        }
    }
}

#[cfg(test)]
pub(super) struct TestDiagnosticsRecorder {
    recorder: DiagnosticsRecorder,
}

#[cfg(test)]
impl TestDiagnosticsRecorder {
    pub(super) fn new() -> Self {
        Self {
            recorder: DiagnosticsRecorder::new(true, Arc::new(SystemClock::new())),
        }
    }

    pub(super) fn begin_operation(&self, kind: DiagnosticOperationKind) -> u64 {
        self.recorder.begin_operation(kind, 1)
    }

    pub(super) fn record_skipped_decode_error(&self, generation: u64, lane_ordinal: usize) {
        self.recorder.record_checkpoint(
            generation,
            DiagnosticCheckpoint::SkippedDecodeError,
            Some(lane_ordinal),
        );
    }

    pub(super) fn export(&self) -> NativeAudioDiagnosticExportV1 {
        self.recorder.export().expect("test diagnostics export")
    }
}

fn callback_timestamp(timestamp: &AtomicU64) -> Option<u64> {
    let value = timestamp.load(Ordering::Acquire);
    (value != 0 && value != TIMESTAMP_PENDING).then_some(value)
}

fn safe_code_counts(counts: &[AtomicU64; SAFE_CODE_COUNT]) -> Vec<DiagnosticSafeCodeCount> {
    SAFE_CODES
        .iter()
        .zip(counts)
        .filter_map(|(code, count)| {
            let count = count.load(Ordering::Relaxed);
            (count != 0).then_some(DiagnosticSafeCodeCount { code: *code, count })
        })
        .collect()
}

#[tauri::command]
pub fn native_audio_diagnostics_availability() -> NativeAudioDiagnosticsAvailability {
    global().availability()
}

#[tauri::command]
pub fn native_audio_diagnostics_read() -> Result<NativeAudioDiagnosticExportV1, String> {
    global().export()
}

#[tauri::command]
pub fn native_audio_diagnostics_reset() -> Result<NativeAudioDiagnosticExportV1, String> {
    global().reset()
}

#[tauri::command]
pub async fn native_audio_diagnostics_export(app: AppHandle) -> Result<bool, String> {
    let json = serde_json::to_string_pretty(&global().export()?)
        .map_err(|_| "Native audio diagnostics could not be serialized.".to_string())?;
    let title = "Export Native Audio Diagnostics".to_string();
    let file_name = "tuneforge-native-audio-diagnostics.json".to_string();
    let fallback_file_name = file_name.clone();
    let purpose = "native audio diagnostics".to_string();
    dispatch_diagnostics_export_write(move || {
        crate::file_dialog_scope::write_user_selected_json_file(
            &app,
            &title,
            file_name,
            &fallback_file_name,
            json,
            &purpose,
        )
    })
    .await
}

async fn dispatch_diagnostics_export_write<F>(write: F) -> Result<bool, String>
where
    F: FnOnce() -> Result<bool, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(write)
        .await
        .map_err(|_| "Native audio diagnostics export worker stopped unexpectedly.".to_string())?
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn current_rss_kib() -> Option<u64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    parse_proc_status_rss_kib(&status)
}

#[cfg(any(target_os = "linux", target_os = "android", test))]
fn parse_proc_status_rss_kib(status: &str) -> Option<u64> {
    status.lines().find_map(|line| {
        let value = line.strip_prefix("VmRSS:")?.trim();
        let kib = value.strip_suffix("kB")?.trim().parse::<u64>().ok()?;
        Some(kib)
    })
}

#[cfg(target_os = "macos")]
fn current_rss_kib() -> Option<u64> {
    #[repr(C)]
    struct MachTaskBasicInfo {
        virtual_size: u64,
        resident_size: u64,
        resident_size_max: u64,
        user_time: [i32; 2],
        system_time: [i32; 2],
        policy: i32,
        suspend_count: i32,
    }
    unsafe extern "C" {
        static mach_task_self_: u32;
        fn task_info(target: u32, flavor: u32, info: *mut i32, count: *mut u32) -> i32;
    }
    const MACH_TASK_BASIC_INFO: u32 = 20;
    let mut info = MachTaskBasicInfo {
        virtual_size: 0,
        resident_size: 0,
        resident_size_max: 0,
        user_time: [0; 2],
        system_time: [0; 2],
        policy: 0,
        suspend_count: 0,
    };
    let mut count = (std::mem::size_of::<MachTaskBasicInfo>() / std::mem::size_of::<i32>()) as u32;
    let result = unsafe {
        task_info(
            mach_task_self_,
            MACH_TASK_BASIC_INFO,
            (&mut info as *mut MachTaskBasicInfo).cast::<i32>(),
            &mut count,
        )
    };
    (result == 0).then_some(info.resident_size / 1024)
}

#[cfg(not(any(target_os = "android", target_os = "linux", target_os = "macos")))]
fn current_rss_kib() -> Option<u64> {
    None
}

#[cfg(test)]
#[path = "diagnostics_tests.rs"]
mod tests;
