use super::*;
use std::sync::atomic::AtomicU64;

struct FakeClock {
    now_us: AtomicU64,
    read_count: AtomicU64,
}

impl FakeClock {
    fn new(now_us: u64) -> Self {
        Self {
            now_us: AtomicU64::new(now_us),
            read_count: AtomicU64::new(0),
        }
    }

    fn set(&self, now_us: u64) {
        self.now_us.store(now_us, Ordering::Relaxed);
    }
}

impl DiagnosticClock for FakeClock {
    fn now_us(&self) -> u64 {
        self.read_count.fetch_add(1, Ordering::Relaxed);
        self.now_us.load(Ordering::Relaxed)
    }
}

fn recorder() -> (DiagnosticsRecorder, Arc<FakeClock>) {
    let clock = Arc::new(FakeClock::new(10));
    (DiagnosticsRecorder::new(true, clock.clone()), clock)
}

#[test]
fn recorder_exports_bounded_relative_checkpoints_and_capacities() {
    let (recorder, clock) = recorder();
    let generation = recorder.begin_operation(DiagnosticOperationKind::Play, 9);
    clock.set(25);
    recorder.record_checkpoint(generation, DiagnosticCheckpoint::RingClear, None);
    recorder.record_checkpoint(generation, DiagnosticCheckpoint::WorkerFirstPcm, Some(0));
    recorder.record_checkpoint(generation, DiagnosticCheckpoint::WorkerFirstPcm, Some(5));
    recorder.record_checkpoint(generation, DiagnosticCheckpoint::PrebufferReady, None);
    recorder.record_capacities(generation, 6, 18_432_000, 2_304_000);
    clock.set(30);
    recorder.record_callback(generation, CallbackCheckpoint::FirstNonzero);
    recorder.record_callback(generation, CallbackCheckpoint::GainFirstChange);
    recorder.record_callback(generation, CallbackCheckpoint::GainRampComplete);
    recorder.record_callback(generation, CallbackCheckpoint::Underrun);

    let export = recorder.export().expect("export");
    assert_eq!(export.schema_version, SCHEMA_VERSION);
    assert_eq!(export.operations.len(), 1);
    let operation = &export.operations[0];
    assert_eq!(operation.sequence, 1);
    assert_eq!(operation.lane_count, 6);
    assert_eq!(operation.command_start_us, 0);
    assert_eq!(operation.ring_clear_us, vec![15]);
    assert_eq!(operation.worker_first_pcm_count, 2);
    assert_eq!(
        operation.worker_first_pcm_us,
        vec![Some(15), None, None, None, None, Some(15)]
    );
    assert_eq!(operation.all_workers_first_pcm_us, None);
    assert_eq!(operation.prebuffer_ready_us, Some(15));
    assert_eq!(operation.callback_first_nonzero_us, Some(20));
    assert_eq!(operation.gain_first_change_us, Some(20));
    assert_eq!(operation.gain_ramp_complete_count, 1);
    assert_eq!(operation.first_gain_ramp_complete_us, Some(20));
    assert_eq!(operation.underrun_count, 1);
    assert_eq!(operation.first_underrun_us, Some(20));
    assert_eq!(operation.ring_capacity_samples, Some(18_432_000));
    assert_eq!(operation.scratch_capacity_samples, Some(2_304_000));
    let json = serde_json::to_value(&export).expect("json");
    assert_eq!(json["counters"]["workerFirstPcmEventCount"], 2);
    assert_eq!(json["operations"][0]["workerFirstPcmCount"], 2);
}

#[test]
fn later_generation_rejects_stale_worker_and_callback_events() {
    let (recorder, _) = recorder();
    let stale_generation = recorder.begin_operation(DiagnosticOperationKind::Play, 1);
    let active_generation = recorder.begin_operation(DiagnosticOperationKind::Seek, 1);

    recorder.record_checkpoint(
        stale_generation,
        DiagnosticCheckpoint::WorkerFirstPcm,
        Some(0),
    );
    recorder.record_callback(stale_generation, CallbackCheckpoint::FirstNonzero);
    recorder.record_checkpoint(
        active_generation,
        DiagnosticCheckpoint::WorkerFirstPcm,
        Some(0),
    );

    let export = recorder.export().expect("export");
    assert_eq!(export.counters.stale_generation_event_count, 2);
    assert_eq!(export.operations[0].worker_first_pcm_count, 0);
    assert_eq!(export.operations[1].worker_first_pcm_count, 1);
    assert_eq!(export.operations[0].callback_first_nonzero_us, None);
}

#[test]
fn reset_clears_diagnostics_only_and_counts_resets() {
    let (recorder, _) = recorder();
    let generation = recorder.begin_operation(DiagnosticOperationKind::Prepare, 4);
    recorder.record_checkpoint(generation, DiagnosticCheckpoint::RingClear, None);

    let export = recorder.reset().expect("reset export");
    assert!(export.operations.is_empty());
    assert_eq!(export.counters.operation_count, 0);
    assert_eq!(export.counters.ring_clear_count, 0);
    assert_eq!(export.reset_count, 1);
}

#[test]
fn reset_drops_old_producer_events_until_a_new_generation_is_active() {
    let (recorder, _) = recorder();
    let old_generation = recorder.begin_operation(DiagnosticOperationKind::Play, 1);
    recorder.reset().expect("reset");

    recorder.record_checkpoint(old_generation, DiagnosticCheckpoint::RingClear, None);
    recorder.record_callback(old_generation, CallbackCheckpoint::FirstNonzero);
    recorder.record_safe_code(old_generation, DiagnosticSafeCode::DecoderWorkerFailure);
    assert_eq!(
        recorder
            .export()
            .expect("post-reset export")
            .counters
            .stale_generation_event_count,
        0
    );

    recorder.begin_operation(DiagnosticOperationKind::Seek, 1);
    recorder.record_checkpoint(old_generation, DiagnosticCheckpoint::RingClear, None);
    recorder.record_callback(old_generation, CallbackCheckpoint::FirstNonzero);
    recorder.record_safe_code(old_generation, DiagnosticSafeCode::DecoderWorkerFailure);
    assert_eq!(
        recorder
            .export()
            .expect("active-generation export")
            .counters
            .stale_generation_event_count,
        3
    );
}

#[test]
fn skipped_errors_and_safe_fallback_codes_are_counted_without_raw_errors() {
    let (recorder, _) = recorder();
    let generation = recorder.begin_operation(DiagnosticOperationKind::Play, 1);
    recorder.record_checkpoint(
        generation,
        DiagnosticCheckpoint::SkippedPacketError,
        Some(0),
    );
    recorder.record_checkpoint(
        generation,
        DiagnosticCheckpoint::SkippedDecodeError,
        Some(0),
    );
    recorder.record_safe_code(generation, DiagnosticSafeCode::PrebufferTimeout);
    recorder.record_safe_code(generation, DiagnosticSafeCode::DecoderWorkerFailure);

    let export = recorder.export().expect("export");
    let json = serde_json::to_string(&export).expect("json");
    assert_eq!(export.counters.skipped_packet_error_count, 1);
    assert_eq!(export.counters.skipped_decode_error_count, 1);
    assert!(json.contains("prebuffer_timeout"));
    assert!(json.contains("decoder_worker_failure"));
    assert!(!json.contains("raw error"));
}

#[test]
fn safe_code_recording_uses_fixed_atomic_slots_and_resets() {
    let (recorder, _) = recorder();
    let generation = recorder.begin_operation(DiagnosticOperationKind::Play, 1);
    recorder.record_safe_code(generation, DiagnosticSafeCode::SustainedUnderrun);
    recorder.record_safe_code(generation, DiagnosticSafeCode::SustainedUnderrun);

    let export = recorder.export().expect("export");
    assert_eq!(export.safe_codes.len(), 1);
    assert_eq!(export.safe_codes[0].count, 2);
    assert_eq!(export.operations[0].safe_codes[0].count, 2);

    let reset = recorder.reset().expect("reset");
    assert!(reset.safe_codes.is_empty());
}

#[test]
fn callback_timestamps_read_clock_only_for_first_winning_event() {
    let (recorder, clock) = recorder();
    let generation = recorder.begin_operation(DiagnosticOperationKind::Play, 1);
    let baseline = clock.read_count.load(Ordering::Relaxed);

    for _ in 0..10 {
        recorder.record_callback(generation, CallbackCheckpoint::FirstNonzero);
        recorder.record_callback(generation, CallbackCheckpoint::GainFirstChange);
        recorder.record_callback(generation, CallbackCheckpoint::GainRampComplete);
        recorder.record_callback(generation, CallbackCheckpoint::Underrun);
    }

    assert_eq!(clock.read_count.load(Ordering::Relaxed) - baseline, 4);
    let operation = &recorder.export().expect("export").operations[0];
    assert_eq!(operation.gain_ramp_complete_count, 10);
    assert_eq!(operation.underrun_count, 10);
}

#[test]
fn disabled_recorder_is_a_zero_generation_no_op() {
    let clock = Arc::new(FakeClock::new(10));
    let recorder = DiagnosticsRecorder::new(false, clock.clone());
    let generation = recorder.begin_operation(DiagnosticOperationKind::Play, 1);

    assert_eq!(generation, 0);
    recorder.record_checkpoint(generation, DiagnosticCheckpoint::RingClear, None);
    recorder.record_callback(generation, CallbackCheckpoint::FirstNonzero);
    recorder.record_callback(generation, CallbackCheckpoint::GainFirstChange);
    recorder.record_callback(generation, CallbackCheckpoint::GainRampComplete);
    recorder.record_callback(generation, CallbackCheckpoint::Underrun);
    recorder.record_capacities(generation, 1, 64, 64);
    recorder.record_safe_code(generation, DiagnosticSafeCode::PrebufferTimeout);

    assert_eq!(clock.read_count.load(Ordering::Relaxed), 0);
    assert_eq!(recorder.next_generation.load(Ordering::Relaxed), 0);
    assert_eq!(recorder.current_generation.load(Ordering::Relaxed), 0);
    let counters = recorder.counters.snapshot();
    assert_eq!(counters.operation_count, 0);
    assert_eq!(counters.ring_clear_count, 0);
    assert_eq!(counters.callback_first_nonzero_count, 0);
    assert_eq!(counters.underrun_count, 0);
    assert_eq!(counters.stale_generation_event_count, 0);
    assert!(recorder
        .inner
        .lock()
        .expect("diagnostic state")
        .operations
        .is_empty());
}

#[test]
fn export_write_dispatches_off_caller_thread_and_maps_failures_safely() {
    let caller_thread = std::thread::current().id();
    let observed_thread = Arc::new(Mutex::new(None));
    let observed_thread_for_write = observed_thread.clone();

    let exported = tauri::async_runtime::block_on(dispatch_diagnostics_export_write(move || {
        *observed_thread_for_write.lock().expect("observed thread") =
            Some(std::thread::current().id());
        Ok(true)
    }))
    .expect("export dispatch");
    assert!(exported);
    assert_ne!(
        observed_thread.lock().expect("observed thread").as_ref(),
        Some(&caller_thread)
    );

    let cancelled = tauri::async_runtime::block_on(dispatch_diagnostics_export_write(|| Ok(false)))
        .expect("cancel dispatch");
    assert!(!cancelled);

    let write_error = tauri::async_runtime::block_on(dispatch_diagnostics_export_write(|| {
        Err("bounded write error".to_string())
    }));
    assert_eq!(write_error, Err("bounded write error".to_string()));

    let join_error = tauri::async_runtime::block_on(dispatch_diagnostics_export_write(
        || -> Result<bool, String> { panic!("worker panic details") },
    ));
    assert_eq!(
        join_error,
        Err("Native audio diagnostics export worker stopped unexpectedly.".to_string())
    );
}

#[test]
fn serialized_export_has_no_identity_or_filesystem_fields() {
    let (recorder, _) = recorder();
    let generation = recorder.begin_operation(DiagnosticOperationKind::LaneUpdate, 6);
    recorder.record_safe_code(generation, DiagnosticSafeCode::OutputStreamFailure);

    let json = serde_json::to_string(&recorder.export().expect("export")).expect("json");
    let lower = json.to_ascii_lowercase();
    for forbidden in [
        "artifactid",
        "deviceid",
        "laneid",
        "sessionid",
        "sourcepath",
        "filepath",
        "timestamp",
        "http://",
        "https://",
        "/users/",
        "/private/tmp/",
    ] {
        assert!(
            !lower.contains(forbidden),
            "found forbidden field: {forbidden}"
        );
    }
}

#[test]
fn proc_status_rss_parser_accepts_only_vmrss_kib() {
    assert_eq!(
        parse_proc_status_rss_kib("Name:\ttuneforge\nVmSize:\t100 kB\nVmRSS:\t 4242 kB\n"),
        Some(4242)
    );
    assert_eq!(parse_proc_status_rss_kib("VmRSS:\tunknown kB\n"), None);
    assert_eq!(parse_proc_status_rss_kib("VmHWM:\t4242 kB\n"), None);
}
