//! One execution owner for complete mobile processing jobs, including cleanup.
use std::collections::VecDeque;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Arc, Mutex};
use std::time::Duration;

type Action = Arc<dyn Fn() + Send + Sync>;

pub(crate) trait Protection: Send + Sync {
    fn start(&self) -> Result<(), String>;
    fn active(&self, active: bool) -> Result<(), String>;
    fn healthy(&self) -> bool;
    fn stop(&self);
}

pub(super) struct Task {
    pub run: Box<dyn FnOnce() + Send>,
    pub cancel: Action,
    pub fail: Action,
}

#[derive(Default)]
struct State {
    waiting: VecDeque<Task>,
    active: Option<(Action, Action)>,
    running: bool,
    failed: bool,
    generation: u64,
}

pub(super) struct ProcessingQueue {
    state: Mutex<State>,
    protection: Arc<dyn Protection>,
}

impl ProcessingQueue {
    pub(super) fn new(protection: Arc<dyn Protection>) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(State::default()),
            protection,
        })
    }

    pub(super) fn submit(self: &Arc<Self>, task: Task) -> Result<(), String> {
        let mut state = self.state.lock().unwrap();
        if state.running && state.failed {
            (task.fail)();
            return Err("Android processing stopped. Wait for cleanup, then retry.".into());
        }
        if !state.running {
            if let Err(error) = self.protection.start() {
                (task.fail)();
                self.protection.stop();
                return Err(error);
            }
            state.failed = false;
            state.running = true;
            state.generation += 1;
            let generation = state.generation;
            state.waiting.push_back(task);
            let queue = self.clone();
            std::thread::spawn(move || queue.drain());
            let queue = self.clone();
            std::thread::spawn(move || queue.watch(generation));
        } else {
            state.waiting.push_back(task);
        }
        Ok(())
    }

    fn stop_failed(&self, state: &mut State) {
        state.failed = true;
        for task in state.waiting.drain(..) {
            (task.fail)();
        }
        if let Some((cancel, fail)) = &state.active {
            fail();
            cancel();
        }
        self.protection.stop();
    }

    fn watch(&self, generation: u64) {
        loop {
            std::thread::sleep(Duration::from_millis(250));
            let mut state = self.state.lock().unwrap();
            if !state.running || state.generation != generation || state.failed {
                return;
            }
            if !self.protection.healthy() {
                self.stop_failed(&mut state);
                return;
            }
        }
    }

    fn drain(&self) {
        loop {
            let task = {
                let mut state = self.state.lock().unwrap();
                let Some(task) = state.waiting.pop_front() else {
                    // Stop under the admission lock: a new submission cannot lose its service.
                    self.protection.stop();
                    state.active = None;
                    state.running = false;
                    return;
                };
                state.active = Some((task.cancel.clone(), task.fail.clone()));
                if self.protection.active(true).is_err() {
                    self.stop_failed(&mut state);
                    state.active = None;
                    continue;
                }
                task
            };
            if catch_unwind(AssertUnwindSafe(task.run)).is_err() {
                (task.fail)();
            }
            let mut state = self.state.lock().unwrap();
            state.active = None;
            if !state.failed && self.protection.active(false).is_err() {
                self.stop_failed(&mut state);
            }
        }
    }
}

#[cfg(target_os = "android")]
use super::*;

#[cfg(target_os = "android")]
pub(super) fn enqueue(
    root: PathBuf,
    job_id: String,
    run: impl FnOnce() + Send + 'static,
) -> Result<(), String> {
    use std::sync::LazyLock;
    static QUEUE: LazyLock<Arc<ProcessingQueue>> = LazyLock::new(|| {
        ProcessingQueue::new(Arc::new(crate::processing_service::AndroidProtection))
    });
    let failure_root = root.clone();
    let failure_id = job_id.clone();
    let fail: Action = Arc::new(move || {
        if let Ok(connection) = db_at_root(&failure_root) {
            let _ = fail_running_job(
                &connection,
                &failure_id,
                "Android processing stopped unexpectedly. Retry this job.",
                0.0,
            );
        }
    });
    let cancel_id = job_id.clone();
    let cancel: Action = Arc::new(move || {
        super::audio::request_audio_job_cancellation(&cancel_id);
        crate::native_audio::whisper_model::cancel(&cancel_id);
        crate::native_audio::crema::cancel_android_model(&cancel_id);
        crate::native_audio::beat_this::cancel_android_model(&cancel_id);
    });
    QUEUE.submit(Task {
        run: Box::new(move || {
            let _cancellation = super::audio::AudioJobCancellation::begin(&job_id);
            let connection = match db_at_root(&root) {
                Ok(connection) => connection,
                Err(_) => return,
            };
            // Queued cancellation never starts native work; started_at belongs to dequeue.
            match dequeue_processing_job(&connection, &job_id) {
                Ok(true) => {}
                Ok(false) => return,
                Err(_) => {
                    let _ = fail_running_job(
                        &connection,
                        &job_id,
                        "Could not start Android processing. Retry this job.",
                        0.0,
                    );
                    return;
                }
            }
            run();
        }),
        cancel,
        fail,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        mpsc,
    };
    #[derive(Default)]
    struct FakeProtection {
        healthy: AtomicBool,
        events: Mutex<Vec<&'static str>>,
    }
    impl Protection for FakeProtection {
        fn start(&self) -> Result<(), String> {
            self.healthy.store(true, Ordering::SeqCst);
            self.events.lock().unwrap().push("start");
            Ok(())
        }
        fn active(&self, active: bool) -> Result<(), String> {
            self.events
                .lock()
                .unwrap()
                .push(if active { "active" } else { "idle" });
            Ok(())
        }
        fn healthy(&self) -> bool {
            self.healthy.load(Ordering::SeqCst)
        }
        fn stop(&self) {
            self.events.lock().unwrap().push("stop");
        }
    }
    fn task(run: impl FnOnce() + Send + 'static) -> Task {
        Task {
            run: Box::new(run),
            cancel: Arc::new(|| {}),
            fail: Arc::new(|| {}),
        }
    }
    #[test]
    fn mixed_jobs_keep_fifo_through_cleanup_and_panic() {
        let protection = Arc::new(FakeProtection::default());
        let queue = ProcessingQueue::new(protection.clone());
        let (entered, enter) = mpsc::channel();
        let (release, wait) = mpsc::channel();
        queue
            .submit(task(move || {
                entered.send(()).unwrap();
                wait.recv().unwrap();
            }))
            .unwrap();
        enter.recv_timeout(Duration::from_secs(2)).unwrap();
        let (done, results) = mpsc::channel();
        for name in ["analysis", "chords", "lyrics"] {
            let done = done.clone();
            queue
                .submit(task(move || {
                    done.send(name).unwrap();
                    if name == "chords" {
                        panic!("synthetic panic");
                    }
                }))
                .unwrap();
        }
        assert!(results.try_recv().is_err());
        release.send(()).unwrap();
        for name in ["analysis", "chords", "lyrics"] {
            assert_eq!(results.recv_timeout(Duration::from_secs(2)).unwrap(), name);
        }
    }
    #[test]
    fn start_failure_fails_admission_without_running_or_acquiring_cpu() {
        struct Rejected;
        impl Protection for Rejected {
            fn start(&self) -> Result<(), String> {
                Err("synthetic foreground failure".into())
            }
            fn active(&self, _: bool) -> Result<(), String> {
                panic!("CPU ownership after rejected start")
            }
            fn healthy(&self) -> bool {
                false
            }
            fn stop(&self) {}
        }
        let queue = ProcessingQueue::new(Arc::new(Rejected));
        let (failed, failure) = mpsc::channel();
        assert!(queue
            .submit(Task {
                run: Box::new(|| panic!("work after rejected start")),
                cancel: Arc::new(|| {}),
                fail: Arc::new(move || {
                    failed.send(()).unwrap();
                })
            })
            .is_err());
        failure.recv_timeout(Duration::from_secs(2)).unwrap();
    }

    #[test]
    fn next_job_waits_for_full_stage_work_and_cleanup() {
        struct Cleanup(mpsc::Sender<&'static str>);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                self.0.send("cleanup").unwrap();
            }
        }
        let queue = ProcessingQueue::new(Arc::new(FakeProtection::default()));
        let (events, received) = mpsc::channel();
        let (release, wait) = mpsc::channel();
        let first = events.clone();
        queue
            .submit(task(move || {
                let _cleanup = Cleanup(first.clone());
                for stage in [
                    "prepare", "verify", "decode", "infer", "fallback", "persist",
                ] {
                    first.send(stage).unwrap();
                }
                wait.recv().unwrap();
            }))
            .unwrap();
        queue
            .submit(task(move || {
                events.send("next").unwrap();
            }))
            .unwrap();
        for stage in [
            "prepare", "verify", "decode", "infer", "fallback", "persist",
        ] {
            assert_eq!(
                received.recv_timeout(Duration::from_secs(2)).unwrap(),
                stage
            );
        }
        assert!(received.try_recv().is_err());
        release.send(()).unwrap();
        assert_eq!(
            received.recv_timeout(Duration::from_secs(2)).unwrap(),
            "cleanup"
        );
        assert_eq!(
            received.recv_timeout(Duration::from_secs(2)).unwrap(),
            "next"
        );
    }

    #[test]
    fn timeout_cancels_active_holds_slot_and_fails_waiting() {
        let protection = Arc::new(FakeProtection::default());
        let queue = ProcessingQueue::new(protection.clone());
        let (entered, enter) = mpsc::channel();
        let (release, wait) = mpsc::channel();
        let (cancelled, cancel) = mpsc::channel();
        queue
            .submit(Task {
                run: Box::new(move || {
                    entered.send(()).unwrap();
                    wait.recv().unwrap();
                }),
                cancel: Arc::new(move || {
                    cancelled.send(()).unwrap();
                }),
                fail: Arc::new(|| {}),
            })
            .unwrap();
        enter.recv_timeout(Duration::from_secs(2)).unwrap();
        let (failed, failure) = mpsc::channel();
        queue
            .submit(Task {
                run: Box::new(|| panic!("waiting work ran")),
                cancel: Arc::new(|| {}),
                fail: Arc::new(move || {
                    failed.send(()).unwrap();
                }),
            })
            .unwrap();
        protection.healthy.store(false, Ordering::SeqCst);
        cancel.recv_timeout(Duration::from_secs(2)).unwrap();
        failure.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(queue.submit(task(|| {})).is_err());
        release.send(()).unwrap();
    }
}
