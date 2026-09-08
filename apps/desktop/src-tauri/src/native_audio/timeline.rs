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

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CueRequest {
    pub cue_index: u32,
    pub position_seconds: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CueEvent {
    pub generation: u64,
    pub revision: u64,
    pub cue_index: u32,
    pub scheduled_native_time_us: u64,
    pub actual_native_time_us: u64,
    pub insertion_sequence: u64,
}

struct Cue {
    index: u32,
    position: f64,
    sequence: u64,
}

pub struct Advance {
    pub cues: Vec<CueEvent>,
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
        self.rate = normalize_rate(rate);
        self.revision = self.revision.wrapping_add(1).max(1);
        self.anchor_time = None;
        self.anchor_position = self.position;
        Ok(())
    }

    pub fn schedule(
        &mut self,
        expected_revision: u64,
        requests: Vec<CueRequest>,
    ) -> Result<(), &'static str> {
        self.require_revision(expected_revision)?;
        for request in requests {
            self.next_sequence = self.next_sequence.wrapping_add(1);
            self.cues.push(Cue {
                index: request.cue_index,
                position: self.clamp(request.position_seconds),
                sequence: self.next_sequence,
            });
        }
        self.cues.sort_by(|left, right| {
            left.position
                .total_cmp(&right.position)
                .then(left.sequence.cmp(&right.sequence))
        });
        Ok(())
    }

    pub fn cancel(&mut self, expected_revision: u64) -> Result<(), &'static str> {
        self.require_revision(expected_revision)?;
        self.cues.clear();
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
        let start_offset = self.start_at.map_or(0, |start| {
            if start <= callback_time {
                0
            } else {
                (((start - callback_time) as f64 / frame_us).ceil() as usize).min(frames)
            }
        });
        if start_offset == frames {
            return Advance {
                cues: Vec::new(),
                ended: false,
                start_offset,
            };
        }
        let actual_start = callback_time.saturating_add((start_offset as f64 * frame_us) as u64);
        self.start_at = None;
        let anchor = *self.anchor_time.get_or_insert(actual_start);
        let audible_frames = frames - start_offset;
        let end = self
            .clamp(self.position + audible_frames as f64 * self.rate / f64::from(self.sample_rate));
        let mut due = Vec::new();
        while self.cues.first().is_some_and(|cue| cue.position <= end) {
            let cue = self.cues.remove(0);
            if cue.position < self.position {
                continue;
            }
            let offset_frames = ((cue.position - self.position) * f64::from(self.sample_rate)
                / self.rate)
                .ceil()
                .max(0.0) as u64;
            let actual = actual_start.saturating_add((offset_frames as f64 * frame_us) as u64);
            let scheduled = anchor.saturating_add(
                (((cue.position - self.anchor_position).max(0.0) / self.rate) * 1_000_000.0) as u64,
            );
            due.push(CueEvent {
                generation: self.generation,
                revision: self.revision,
                cue_index: cue.index,
                scheduled_native_time_us: scheduled,
                actual_native_time_us: actual,
                insertion_sequence: cue.sequence,
            });
        }
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

    fn clamp(&self, value: f64) -> f64 {
        value.max(0.0).min(if self.duration > 0.0 {
            self.duration
        } else {
            f64::MAX
        })
    }
}

pub fn normalize_rate(rate: f64) -> f64 {
    if rate.is_finite() && rate > 0.0 {
        rate.clamp(0.25, 4.0)
    } else {
        1.0
    }
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
    fn cues_are_sample_aligned_stable_and_cancel_on_discontinuity() {
        let mut timeline = timeline();
        timeline
            .schedule(
                1,
                vec![
                    CueRequest {
                        cue_index: 2,
                        position_seconds: 0.002,
                    },
                    CueRequest {
                        cue_index: 1,
                        position_seconds: 0.002,
                    },
                ],
            )
            .unwrap();
        timeline.arm(1, None, None, 100).unwrap();
        let events = timeline.advance(3, 1_000).cues;
        assert_eq!(
            events
                .iter()
                .map(|event| event.cue_index)
                .collect::<Vec<_>>(),
            [2, 1]
        );
        assert_eq!(events[0].actual_native_time_us, 3_000);
        timeline
            .schedule(
                1,
                vec![CueRequest {
                    cue_index: 3,
                    position_seconds: 1.0,
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
}
