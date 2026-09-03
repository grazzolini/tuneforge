use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
use std::time::Instant;

static PROCESS_EPOCH: OnceLock<Instant> = OnceLock::new();

pub fn native_time_us() -> u64 {
    PROCESS_EPOCH
        .get_or_init(Instant::now)
        .elapsed()
        .as_micros()
        .min(u128::from(u64::MAX)) as u64
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CueKind {
    #[default]
    Marker,
    PrecountBeat,
    PrecountCompletion,
    Metronome,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CueRequest {
    pub cue_index: u32,
    pub position_seconds: f64,
    #[serde(default)]
    pub kind: CueKind,
    #[serde(default)]
    pub accent: bool,
    #[serde(default = "default_cue_gain")]
    pub gain: f32,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CueEvent {
    pub resource: &'static str,
    pub source: &'static str,
    pub generation: u64,
    pub revision: u64,
    pub cue_index: u32,
    pub kind: CueKind,
    pub accent: bool,
    pub gain: f32,
    pub scheduled_native_time_us: u64,
    pub actual_native_time_us: u64,
    pub insertion_sequence: u64,
}

struct Cue {
    index: u32,
    position: f64,
    sequence: u64,
    kind: CueKind,
    accent: bool,
    gain: f32,
    native_time: Option<u64>,
}

pub struct FiredCue {
    pub event: CueEvent,
    pub frame_offset: usize,
}

pub struct Advance {
    pub cues: Vec<FiredCue>,
    pub ended: bool,
    pub start_offset: usize,
}

pub struct Timeline {
    generation: u64,
    revision: u64,
    sample_rate: u32,
    duration: f64,
    position: f64,
    rate: f64,
    running: bool,
    start_at: Option<u64>,
    anchor_time: Option<u64>,
    anchor_position: f64,
    next_sequence: u64,
    cues: Vec<Cue>,
}

impl Default for Timeline {
    fn default() -> Self {
        Self {
            generation: 0,
            revision: 0,
            sample_rate: 48_000,
            duration: 0.0,
            position: 0.0,
            rate: 1.0,
            running: false,
            start_at: None,
            anchor_time: None,
            anchor_position: 0.0,
            next_sequence: 0,
            cues: Vec::new(),
        }
    }
}

impl Timeline {
    pub fn reset(&mut self, generation: u64, duration: f64, rate: f64) {
        self.generation = generation;
        self.revision = 1;
        self.duration = duration.max(0.0);
        self.position = 0.0;
        self.rate = normalize_rate(rate);
        self.running = false;
        self.start_at = None;
        self.anchor_time = None;
        self.cues.clear();
    }

    pub fn configure_sample_rate(&mut self, sample_rate: u32) {
        self.sample_rate = sample_rate.max(1);
    }

    pub fn restart_generation(&mut self, generation: u64) {
        self.generation = generation;
        self.revision = self.revision.wrapping_add(1).max(1);
        self.running = false;
        self.start_at = None;
        self.anchor_time = None;
        self.cues.clear();
    }

    pub fn arm(
        &mut self,
        expected_revision: u64,
        position: Option<f64>,
        start_at: Option<u64>,
        now: u64,
    ) -> Result<(), &'static str> {
        self.require_revision(expected_revision)?;
        if start_at.is_some_and(|deadline| deadline <= now) {
            return Err("start_deadline_missed");
        }
        if let Some(position) = position {
            self.position = self.clamp(position);
            self.revision = self.revision.wrapping_add(1).max(1);
            self.cues.clear();
        }
        self.running = true;
        self.start_at = start_at;
        self.anchor_time = None;
        self.anchor_position = self.position;
        Ok(())
    }

    pub fn pause(&mut self) {
        self.running = false;
        self.start_at = None;
        self.anchor_time = None;
    }

    pub fn stop(&mut self) {
        self.running = false;
        self.position = 0.0;
        self.start_at = None;
        self.anchor_time = None;
        self.cues.clear();
    }

    pub fn seek(&mut self, expected_revision: u64, position: f64) -> Result<(), &'static str> {
        self.require_revision(expected_revision)?;
        self.position = self.clamp(position);
        self.revision = self.revision.wrapping_add(1).max(1);
        self.anchor_time = None;
        self.anchor_position = self.position;
        self.cues.clear();
        Ok(())
    }

    pub fn set_rate(&mut self, expected_revision: u64, rate: f64) -> Result<(), &'static str> {
        self.require_revision(expected_revision)?;
        let rate = normalize_rate(rate);
        if rate == self.rate {
            return Ok(());
        }
        self.rate = rate;
        self.revision = self.revision.wrapping_add(1).max(1);
        self.anchor_time = None;
        self.anchor_position = self.position;
        self.cues.retain(|cue| cue.native_time.is_some());
        Ok(())
    }

    pub fn schedule(
        &mut self,
        expected_revision: u64,
        requests: Vec<CueRequest>,
    ) -> Result<(), &'static str> {
        self.require_revision(expected_revision)?;
        validate_cues(&requests)?;
        if requests.iter().any(|cue| cue.kind == CueKind::Metronome) {
            self.cues.retain(|cue| cue.kind != CueKind::Metronome);
        }
        self.insert_cues(requests);
        Ok(())
    }

    pub fn replace_metronome(
        &mut self,
        expected_revision: u64,
        requests: Vec<CueRequest>,
    ) -> Result<(), &'static str> {
        self.require_revision(expected_revision)?;
        validate_cues(&requests)?;
        if requests.iter().any(|cue| cue.kind != CueKind::Metronome) {
            return Err("invalid_cue_schedule");
        }
        self.cues.retain(|cue| cue.kind != CueKind::Metronome);
        self.insert_cues(requests);
        Ok(())
    }

    fn insert_cues(&mut self, requests: Vec<CueRequest>) {
        for request in requests {
            self.next_sequence = self.next_sequence.wrapping_add(1);
            self.cues.push(Cue {
                index: request.cue_index,
                position: self.clamp(request.position_seconds),
                sequence: self.next_sequence,
                kind: request.kind,
                accent: request.accent,
                gain: request.gain,
                native_time: None,
            });
        }
        self.cues.sort_by(|left, right| {
            left.position
                .total_cmp(&right.position)
                .then(left.sequence.cmp(&right.sequence))
        });
    }

    pub fn schedule_precount(
        &mut self,
        expected_revision: u64,
        intervals: &[f64],
        first_native_time: u64,
    ) -> Result<(), &'static str> {
        self.require_revision(expected_revision)?;
        if intervals.is_empty()
            || intervals.len() > 8
            || intervals
                .iter()
                .any(|value| !value.is_finite() || *value <= 0.0)
        {
            return Err("invalid_precount_schedule");
        }
        let mut native_time = first_native_time;
        for (index, interval) in intervals.iter().enumerate() {
            self.push_native_cue(CueKind::PrecountBeat, index as u32, native_time);
            native_time = native_time.saturating_add((interval * 1_000_000.0) as u64);
        }
        self.push_native_cue(
            CueKind::PrecountCompletion,
            intervals.len() as u32,
            native_time,
        );
        Ok(())
    }

    pub fn cancel(
        &mut self,
        expected_revision: u64,
        kind: Option<CueKind>,
    ) -> Result<(), &'static str> {
        self.require_revision(expected_revision)?;
        if let Some(kind) = kind {
            self.cues.retain(|cue| cue.kind != kind);
        } else {
            self.cues.clear();
        }
        Ok(())
    }

    pub fn advance(&mut self, frames: usize, callback_time: u64) -> Advance {
        if !self.running || frames == 0 {
            return Advance {
                cues: Vec::new(),
                ended: false,
                start_offset: frames,
            };
        }
        let frame_us = 1_000_000.0 / f64::from(self.sample_rate);
        let start_offset = self.start_offset(frames, callback_time);
        let callback_end = callback_time.saturating_add((frames as f64 * frame_us) as u64);
        let source_started = start_offset < frames;
        let actual_start = callback_time.saturating_add((start_offset as f64 * frame_us) as u64);
        if source_started {
            self.start_at = None;
        }
        let anchor = if source_started {
            Some(*self.anchor_time.get_or_insert(actual_start))
        } else {
            self.anchor_time
        };
        let audible_frames = frames.saturating_sub(start_offset);
        let end = self
            .clamp(self.position + audible_frames as f64 * self.rate / f64::from(self.sample_rate));
        let mut due = Vec::new();
        let mut remaining = Vec::with_capacity(self.cues.len());
        for cue in self.cues.drain(..) {
            if cue.native_time.is_none() && cue.position < self.position {
                continue;
            }
            let timing = if let Some(scheduled) = cue.native_time {
                (scheduled < callback_end).then(|| {
                    let frame = (((scheduled.saturating_sub(callback_time)) as f64 / frame_us)
                        .ceil() as usize)
                        .min(frames.saturating_sub(1));
                    (
                        scheduled,
                        callback_time.saturating_add((frame as f64 * frame_us) as u64),
                        frame,
                    )
                })
            } else if source_started && cue.position >= self.position && cue.position <= end {
                let frame = start_offset
                    + (((cue.position - self.position) * f64::from(self.sample_rate) / self.rate)
                        .ceil() as usize);
                let frame = frame.min(frames.saturating_sub(1));
                let scheduled = anchor.unwrap_or(actual_start).saturating_add(
                    (((cue.position - self.anchor_position).max(0.0) / self.rate) * 1_000_000.0)
                        as u64,
                );
                Some((
                    scheduled,
                    actual_start.saturating_add(((frame - start_offset) as f64 * frame_us) as u64),
                    frame,
                ))
            } else {
                None
            };
            let Some((scheduled, actual, frame_offset)) = timing else {
                remaining.push(cue);
                continue;
            };
            due.push(FiredCue {
                event: CueEvent {
                    resource: "output",
                    source: "project_playback",
                    generation: self.generation,
                    revision: self.revision,
                    cue_index: cue.index,
                    kind: cue.kind,
                    accent: cue.accent,
                    gain: cue.gain,
                    scheduled_native_time_us: scheduled,
                    actual_native_time_us: actual,
                    insertion_sequence: cue.sequence,
                },
                frame_offset,
            });
        }
        self.cues = remaining;
        due.sort_by_key(|cue| (cue.frame_offset, cue.event.insertion_sequence));
        self.position = end;
        let ended = self.duration > 0.0 && self.position >= self.duration;
        if ended {
            self.stop();
        }
        Advance {
            cues: due,
            ended,
            start_offset,
        }
    }

    pub fn start_offset(&self, frames: usize, callback_time: u64) -> usize {
        if !self.running || frames == 0 {
            return frames;
        }
        self.start_at.map_or(0, |start| {
            let frame_us = 1_000_000.0 / f64::from(self.sample_rate);
            if start <= callback_time {
                0
            } else {
                (((start - callback_time) as f64 / frame_us).ceil() as usize).min(frames)
            }
        })
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn position(&self) -> f64 {
        self.position
    }

    pub fn rate(&self) -> f64 {
        self.rate
    }

    fn require_revision(&self, expected: u64) -> Result<(), &'static str> {
        (expected == self.revision)
            .then_some(())
            .ok_or("stale_timeline_revision")
    }

    fn push_native_cue(&mut self, kind: CueKind, index: u32, native_time: u64) {
        self.next_sequence = self.next_sequence.wrapping_add(1);
        self.cues.push(Cue {
            index,
            position: self.position,
            sequence: self.next_sequence,
            kind,
            accent: false,
            gain: 1.0,
            native_time: Some(native_time),
        });
    }

    fn clamp(&self, value: f64) -> f64 {
        value.max(0.0).min(if self.duration > 0.0 {
            self.duration
        } else {
            f64::MAX
        })
    }
}

fn default_cue_gain() -> f32 {
    1.0
}

pub fn normalize_rate(rate: f64) -> f64 {
    if rate.is_finite() && rate > 0.0 {
        rate.clamp(0.25, 4.0)
    } else {
        1.0
    }
}

pub fn validate_cues(requests: &[CueRequest]) -> Result<(), &'static str> {
    requests
        .iter()
        .any(|request| {
            !request.position_seconds.is_finite()
                || request.position_seconds < 0.0
                || !request.gain.is_finite()
                || !(0.0..=1.0).contains(&request.gain)
        })
        .then_some(())
        .map_or(Ok(()), |_| Err("invalid_cue_schedule"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn timeline() -> Timeline {
        let mut timeline = Timeline::default();
        timeline.reset(3, 10.0, 1.0);
        timeline.configure_sample_rate(1_000);
        timeline
    }

    #[test]
    fn monotonic_start_pause_resume_seek_rate_and_stop() {
        let mut timeline = timeline();
        timeline.arm(1, Some(2.0), None, 10).unwrap();
        timeline.advance(500, 20);
        assert_eq!(timeline.position(), 2.5);
        timeline.pause();
        timeline.advance(500, 30);
        assert_eq!(timeline.position(), 2.5);
        timeline.arm(2, None, None, 40).unwrap();
        timeline.advance(500, 50);
        assert_eq!(timeline.position(), 3.0);
        timeline.seek(2, 9.0).unwrap();
        timeline.set_rate(3, 9.0).unwrap();
        assert_eq!(timeline.rate(), 4.0);
        timeline.stop();
        assert_eq!(timeline.position(), 0.0);
        assert!(!timeline.running);
    }

    #[test]
    fn same_rate_preserves_cues_changed_rate_and_advance_discard_position_cues() {
        let mut timeline = timeline();
        let cue = |index, position| CueRequest {
            cue_index: index,
            position_seconds: position,
            kind: CueKind::Metronome,
            accent: false,
            gain: 1.0,
        };
        timeline.schedule(1, vec![cue(1, 0.5)]).unwrap();
        timeline.set_rate(1, 1.0).unwrap();
        assert_eq!(timeline.revision(), 1);
        timeline.arm(1, None, None, 0).unwrap();
        assert_eq!(timeline.advance(600, 0).cues.len(), 1);

        timeline.schedule(1, vec![cue(2, 0.8)]).unwrap();
        timeline.set_rate(1, 2.0).unwrap();
        assert_eq!(timeline.revision(), 2);
        assert!(timeline.advance(200, 600_000).cues.is_empty());
        timeline.schedule(2, vec![cue(3, 0.1)]).unwrap();
        assert!(timeline.advance(10, 800_000).cues.is_empty());
    }

    #[test]
    fn cues_are_sample_aligned_stable_and_cancel_on_discontinuity() {
        let mut timeline = timeline();
        timeline
            .schedule(
                1,
                vec![
                    CueRequest {
                        cue_index: 2,
                        position_seconds: 0.002,
                        kind: CueKind::Marker,
                        accent: false,
                        gain: 1.0,
                    },
                    CueRequest {
                        cue_index: 1,
                        position_seconds: 0.002,
                        kind: CueKind::Marker,
                        accent: false,
                        gain: 1.0,
                    },
                ],
            )
            .unwrap();
        timeline.arm(1, None, None, 100).unwrap();
        let events = timeline.advance(3, 1_000).cues;
        assert_eq!(
            events
                .iter()
                .map(|event| event.event.cue_index)
                .collect::<Vec<_>>(),
            [2, 1]
        );
        assert_eq!(events[0].event.actual_native_time_us, 3_000);
        timeline
            .schedule(
                1,
                vec![CueRequest {
                    cue_index: 3,
                    position_seconds: 1.0,
                    kind: CueKind::Marker,
                    accent: false,
                    gain: 1.0,
                }],
            )
            .unwrap();
        timeline.seek(1, 2.0).unwrap();
        assert!(timeline.advance(2_000, 4_000).cues.is_empty());
    }

    #[test]
    fn future_start_is_silent_until_deadline_and_past_start_rejects() {
        let mut timeline = timeline();
        assert_eq!(
            timeline.arm(1, None, Some(99), 100),
            Err("start_deadline_missed")
        );
        timeline.arm(1, None, Some(2_000), 100).unwrap();
        timeline.advance(1, 1_000);
        assert_eq!(timeline.position(), 0.0);
        timeline.advance(2, 1_000);
        assert_eq!(timeline.position(), 0.001);
        timeline.stop();
        timeline.advance(100, 3_000);
        assert_eq!(timeline.position(), 0.0);
    }

    #[test]
    fn precount_completes_on_the_source_start_sample() {
        let mut timeline = timeline();
        timeline.arm(1, None, Some(4_000), 100).unwrap();
        timeline
            .schedule_precount(1, &[0.001, 0.002], 1_000)
            .unwrap();
        timeline
            .schedule(
                1,
                vec![CueRequest {
                    cue_index: 3,
                    position_seconds: 0.0,
                    kind: CueKind::Metronome,
                    accent: true,
                    gain: 0.8,
                }],
            )
            .unwrap();
        let advance = timeline.advance(4, 1_000);
        assert_eq!(advance.start_offset, 3);
        assert_eq!(timeline.position(), 0.001);
        assert_eq!(
            advance
                .cues
                .iter()
                .map(|cue| (cue.event.kind, cue.frame_offset))
                .collect::<Vec<_>>(),
            [
                (CueKind::PrecountBeat, 0),
                (CueKind::PrecountBeat, 1),
                (CueKind::PrecountCompletion, 3),
                (CueKind::Metronome, 3)
            ]
        );
    }

    #[test]
    fn replacement_metronome_cues_align_fresh_start_and_resume() {
        let mut timeline = timeline();
        let cue = |index, position| CueRequest {
            cue_index: index,
            position_seconds: position,
            kind: CueKind::Metronome,
            accent: false,
            gain: 1.0,
        };
        timeline.schedule(1, vec![cue(1, 0.0)]).unwrap();
        timeline.arm(1, Some(2.0), None, 0).unwrap();
        let revision = timeline.revision();
        timeline.schedule(revision, vec![cue(2, 2.0)]).unwrap();
        let fresh = timeline.advance(1, 0);
        assert_eq!((fresh.start_offset, fresh.cues[0].frame_offset), (0, 0));
        assert_eq!(fresh.cues[0].event.cue_index, 2);

        timeline.pause();
        let position = timeline.position();
        timeline.arm(revision, None, None, 1_000).unwrap();
        timeline.cancel(revision, Some(CueKind::Metronome)).unwrap();
        timeline.schedule(revision, vec![cue(3, position)]).unwrap();
        let resumed = timeline.advance(1, 1_000);
        assert_eq!((resumed.start_offset, resumed.cues[0].frame_offset), (0, 0));

        timeline
            .schedule(revision, vec![cue(4, position + 0.1)])
            .unwrap();
        timeline.replace_metronome(revision, Vec::new()).unwrap();
        assert!(timeline.advance(200, 2_000).cues.is_empty());
    }

    #[test]
    fn play_cue_validation_rejects_invalid_plans() {
        assert_eq!(
            validate_cues(&[CueRequest {
                cue_index: 0,
                position_seconds: f64::NAN,
                kind: CueKind::Metronome,
                accent: false,
                gain: 1.0,
            }]),
            Err("invalid_cue_schedule")
        );
    }

    #[test]
    fn metronome_cancellation_preserves_markers_and_rejects_stale_revision() {
        let mut timeline = timeline();
        timeline
            .schedule(
                1,
                vec![
                    CueRequest {
                        cue_index: 1,
                        position_seconds: 0.001,
                        kind: CueKind::Marker,
                        accent: false,
                        gain: 1.0,
                    },
                    CueRequest {
                        cue_index: 2,
                        position_seconds: 0.001,
                        kind: CueKind::Metronome,
                        accent: true,
                        gain: 0.4,
                    },
                ],
            )
            .unwrap();
        timeline.cancel(1, Some(CueKind::Metronome)).unwrap();
        assert_eq!(timeline.cancel(0, None), Err("stale_timeline_revision"));
        timeline.arm(1, None, None, 100).unwrap();
        let cues = timeline.advance(2, 1_000).cues;
        assert_eq!(cues.len(), 1);
        assert_eq!(cues[0].event.kind, CueKind::Marker);
    }
}
