use super::timeline::{self, CueRequest, Timeline};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::{Arc, Mutex};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionOwner {
    Playback,
    Cue,
    Capture,
}

impl SessionOwner {
    pub fn is_output(self) -> bool {
        matches!(self, Self::Playback | Self::Cue)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    Released,
    Output,
    Capture,
    Releasing,
    Terminal,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCommand {
    pub lease_id: Option<String>,
    pub operation_id: Option<String>,
    pub generation: Option<u64>,
    pub timeline_revision: Option<u64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshot {
    pub status: SessionStatus,
    pub owner: Option<SessionOwner>,
    pub lease_id: Option<String>,
    pub generation: u64,
    pub timeline_revision: u64,
    pub native_time_us: u64,
    pub position_seconds: f64,
    pub playback_rate: f64,
    pub availability_reason: Option<&'static str>,
    pub terminal_diagnostic: Option<&'static str>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalEvent {
    pub generation: u64,
    pub code: &'static str,
    pub native_time_us: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CueCommand {
    #[serde(flatten)]
    pub session: SessionCommand,
    #[serde(default)]
    pub cues: Vec<CueRequest>,
}

#[derive(Clone, Copy)]
pub enum RuntimeReportKind {
    Ended,
    Terminal(&'static str),
}

#[derive(Clone, Copy)]
pub struct RuntimeReport {
    pub generation: u64,
    pub kind: RuntimeReportKind,
}

pub enum Acquire {
    Idempotent,
    Release {
        token: u64,
        previous: Option<SessionOwner>,
        lease: String,
    },
}

pub struct SessionCoordinator {
    status: SessionStatus,
    owner: Option<SessionOwner>,
    lease: Option<String>,
    generation: u64,
    release_token: u64,
    terminal: Option<&'static str>,
    terminal_emitted: bool,
    operations: HashSet<(u64, String)>,
    timeline: Arc<Mutex<Timeline>>,
    availability_reason: Option<&'static str>,
}

impl SessionCoordinator {
    pub fn new(native_output: bool, native_input: bool) -> Self {
        Self {
            status: SessionStatus::Released,
            owner: None,
            lease: None,
            generation: 0,
            release_token: 0,
            terminal: None,
            terminal_emitted: false,
            operations: HashSet::new(),
            timeline: Arc::new(Mutex::new(Timeline::default())),
            availability_reason: (!native_output && !native_input)
                .then_some("native_audio_unavailable"),
        }
    }

    pub fn timeline(&self) -> Arc<Mutex<Timeline>> {
        Arc::clone(&self.timeline)
    }

    pub fn snapshot(&self) -> SessionSnapshot {
        let now = timeline::native_time_us();
        let timeline = self.timeline.lock().ok();
        SessionSnapshot {
            status: self.status,
            owner: self.owner,
            lease_id: self.lease.clone(),
            generation: self.generation,
            timeline_revision: timeline.as_ref().map_or(0, |state| state.revision()),
            native_time_us: now,
            position_seconds: timeline.as_ref().map_or(0.0, |state| state.position()),
            playback_rate: timeline.as_ref().map_or(1.0, |state| state.rate()),
            availability_reason: self.availability_reason,
            terminal_diagnostic: self.terminal,
        }
    }

    pub fn begin_acquire(&mut self, owner: SessionOwner, command: &SessionCommand) -> Acquire {
        let lease = command.lease_id.clone().unwrap_or_else(|| {
            if owner.is_output() {
                "legacy-output"
            } else {
                "legacy-capture"
            }
            .to_string()
        });
        if command.operation_id.as_ref().is_some_and(|operation| {
            self.lease.as_deref() == Some(&lease)
                && self.owner == Some(owner)
                && self
                    .operations
                    .contains(&(self.generation, operation.clone()))
        }) {
            return Acquire::Idempotent;
        }
        self.release_token = self.release_token.wrapping_add(1).max(1);
        self.status = SessionStatus::Releasing;
        if let Ok(mut timeline) = self.timeline.lock() {
            timeline.stop();
        }
        Acquire::Release {
            token: self.release_token,
            previous: self.owner,
            lease,
        }
    }

    pub fn finish_acquire(
        &mut self,
        token: u64,
        owner: SessionOwner,
        lease: String,
        command: &SessionCommand,
        duration: f64,
        rate: f64,
    ) -> Result<u64, &'static str> {
        if self.status != SessionStatus::Releasing || token != self.release_token {
            return Err("stale_release_generation");
        }
        self.generation = self.generation.wrapping_add(1).max(1);
        self.status = if owner.is_output() {
            SessionStatus::Output
        } else {
            SessionStatus::Capture
        };
        self.owner = Some(owner);
        self.lease = Some(lease);
        self.terminal = None;
        self.terminal_emitted = false;
        self.operations.clear();
        self.record(command);
        self.timeline
            .lock()
            .map_err(|_| "timeline_unavailable")?
            .reset(self.generation, duration, rate);
        Ok(self.generation)
    }

    pub fn fail_release(&mut self, token: u64) -> Option<TerminalEvent> {
        if token != self.release_token || self.status != SessionStatus::Releasing {
            return None;
        }
        self.mark_terminal(self.generation, "release_timeout")
    }

    pub fn authorize(
        &mut self,
        owner: SessionOwner,
        command: &SessionCommand,
        explicit_attempt: bool,
    ) -> Result<bool, &'static str> {
        if self.status == SessionStatus::Released && command.lease_id.is_none() {
            return Ok(true);
        }
        if command
            .lease_id
            .as_deref()
            .is_some_and(|lease| self.lease.as_deref() != Some(lease))
            || command
                .generation
                .is_some_and(|generation| generation != self.generation)
        {
            return Err("stale_session_generation");
        }
        if self.owner != Some(owner)
            && !(owner.is_output() && self.owner.is_some_and(SessionOwner::is_output))
        {
            return Err("session_owner_mismatch");
        }
        if command.operation_id.as_ref().is_some_and(|operation| {
            self.operations
                .contains(&(self.generation, operation.clone()))
        }) {
            return Ok(false);
        }
        if self.status == SessionStatus::Terminal && explicit_attempt {
            self.generation = self.generation.wrapping_add(1).max(1);
            self.status = if owner.is_output() {
                SessionStatus::Output
            } else {
                SessionStatus::Capture
            };
            self.terminal = None;
            self.terminal_emitted = false;
            self.timeline
                .lock()
                .map_err(|_| "timeline_unavailable")?
                .restart_generation(self.generation);
        } else if matches!(
            self.status,
            SessionStatus::Terminal | SessionStatus::Released | SessionStatus::Releasing
        ) {
            return Err("session_not_active");
        }
        if let Some(revision) = command.timeline_revision {
            let current = self
                .timeline
                .lock()
                .map_err(|_| "timeline_unavailable")?
                .revision();
            if revision != current {
                return Err("stale_timeline_revision");
            }
        }
        self.record(command);
        Ok(true)
    }

    pub fn mark_terminal(&mut self, generation: u64, code: &'static str) -> Option<TerminalEvent> {
        if generation != self.generation || self.terminal_emitted {
            return None;
        }
        self.status = SessionStatus::Terminal;
        self.terminal = Some(code);
        self.terminal_emitted = true;
        if let Ok(mut timeline) = self.timeline.lock() {
            timeline.stop();
        }
        Some(TerminalEvent {
            generation,
            code,
            native_time_us: timeline::native_time_us(),
        })
    }

    pub fn runtime_ended(&mut self, generation: u64) {
        if generation != self.generation {
            return;
        }
        if let Ok(mut timeline) = self.timeline.lock() {
            timeline.stop();
        }
    }

    fn record(&mut self, command: &SessionCommand) {
        if let Some(operation) = &command.operation_id {
            self.operations.insert((self.generation, operation.clone()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn acquire(state: &mut SessionCoordinator, owner: SessionOwner, lease: &str) -> u64 {
        let command = SessionCommand {
            lease_id: Some(lease.into()),
            operation_id: Some("prepare".into()),
            ..Default::default()
        };
        let Acquire::Release { token, lease, .. } = state.begin_acquire(owner, &command) else {
            panic!()
        };
        state
            .finish_acquire(token, owner, lease, &command, 10.0, 1.0)
            .unwrap()
    }

    #[test]
    fn every_owner_pair_transfers_and_stale_generation_rejects() {
        for from in [
            SessionOwner::Playback,
            SessionOwner::Cue,
            SessionOwner::Capture,
        ] {
            for to in [
                SessionOwner::Playback,
                SessionOwner::Cue,
                SessionOwner::Capture,
            ] {
                let mut state = SessionCoordinator::new(true, true);
                let old = acquire(&mut state, from, "old");
                let command = SessionCommand {
                    lease_id: Some("new".into()),
                    ..Default::default()
                };
                let Acquire::Release { token, lease, .. } = state.begin_acquire(to, &command)
                else {
                    panic!()
                };
                state
                    .finish_acquire(token, to, lease, &command, 10.0, 1.0)
                    .unwrap();
                assert_eq!(
                    state.authorize(
                        to,
                        &SessionCommand {
                            generation: Some(old),
                            ..command
                        },
                        false
                    ),
                    Err("stale_session_generation")
                );
            }
        }
    }

    #[test]
    fn timeout_is_terminal_idempotency_prevents_aba_and_retry_is_explicit() {
        let mut state = SessionCoordinator::new(true, true);
        let generation = acquire(&mut state, SessionOwner::Capture, "same");
        let same = SessionCommand {
            lease_id: Some("same".into()),
            operation_id: Some("prepare".into()),
            generation: Some(generation),
            timeline_revision: None,
        };
        assert!(matches!(
            state.begin_acquire(SessionOwner::Capture, &same),
            Acquire::Idempotent
        ));
        let next = SessionCommand {
            operation_id: Some("next".into()),
            ..same.clone()
        };
        let Acquire::Release { token, .. } = state.begin_acquire(SessionOwner::Capture, &next)
        else {
            panic!()
        };
        assert!(state.fail_release(token).is_some());
        assert_eq!(
            state.authorize(SessionOwner::Capture, &next, false),
            Err("session_not_active")
        );
        assert!(state.authorize(SessionOwner::Capture, &next, true).unwrap());
        assert!(state.snapshot().generation > generation);
    }

    #[test]
    fn terminal_is_once_per_generation_and_payload_is_safe_camel_case() {
        let mut state = SessionCoordinator::new(true, true);
        let generation = acquire(&mut state, SessionOwner::Playback, "play");
        assert!(state
            .mark_terminal(generation, "output_stream_failure")
            .is_some());
        assert!(state
            .mark_terminal(generation, "output_stream_failure")
            .is_none());
        let value = serde_json::to_value(state.snapshot()).unwrap();
        assert_eq!(value["terminalDiagnostic"], "output_stream_failure");
        assert!(value.get("fallbackReason").is_none());
    }

    #[test]
    fn released_legacy_command_remains_a_safe_noop() {
        let mut state = SessionCoordinator::new(true, true);
        assert!(state
            .authorize(SessionOwner::Playback, &SessionCommand::default(), false)
            .unwrap());
    }
}
