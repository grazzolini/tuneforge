use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioLaneRequest {
    pub id: String,
    pub artifact_id: Option<String>,
    pub source_path: Option<String>,
    pub role: AudioLaneRole,
    pub gain: f32,
    pub muted: bool,
    pub solo: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AudioLaneRole {
    Primary,
    Stem,
    Click,
    MicMonitor,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioLaneUpdate {
    pub lanes: Vec<AudioLaneRequest>,
    pub playback_rate: Option<f64>,
    pub project_output: AudioOutputRequest,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioOutputRequest {
    pub gain: f32,
    pub muted: bool,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CueOutputRequest {
    pub count_in_gain: f32,
    pub count_in_muted: bool,
    pub metronome_gain: f32,
    pub metronome_muted: bool,
}

impl CueOutputRequest {
    pub fn validate(self) -> Result<Self, &'static str> {
        if !self.count_in_gain.is_finite() || !self.metronome_gain.is_finite() {
            return Err("invalid_cue_output_gain");
        }
        Ok(Self {
            count_in_gain: self.count_in_gain.clamp(0.0, 1.0),
            count_in_muted: self.count_in_muted,
            metronome_gain: self.metronome_gain.clamp(0.0, 1.0),
            metronome_muted: self.metronome_muted,
        })
    }
}

impl AudioOutputRequest {
    pub fn validate(self) -> Result<Self, &'static str> {
        if !self.gain.is_finite() {
            return Err("invalid_audio_output_gain");
        }
        Ok(Self {
            gain: self.gain.clamp(0.0, 1.0),
            muted: self.muted,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioOutputSnapshot {
    pub configured_gain: f32,
    pub muted: bool,
    pub target_gain: f32,
    pub current_gain: f32,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CueOutputSnapshot {
    pub count_in: AudioOutputSnapshot,
    pub metronome: AudioOutputSnapshot,
}

#[derive(Clone, Copy, Debug)]
pub struct AudioOutputState {
    configured_gain: f32,
    muted: bool,
    target_gain: f32,
    current_gain: f32,
}

impl Default for AudioOutputState {
    fn default() -> Self {
        Self {
            configured_gain: 1.0,
            muted: false,
            target_gain: 1.0,
            current_gain: 1.0,
        }
    }
}

impl AudioOutputState {
    pub fn with_gain(gain: f32) -> Self {
        Self {
            configured_gain: gain,
            muted: false,
            target_gain: gain,
            current_gain: gain,
        }
    }

    pub fn set(&mut self, request: AudioOutputRequest, ramp: bool) -> Result<(), &'static str> {
        let request = request.validate()?;
        self.configured_gain = request.gain;
        self.muted = request.muted;
        self.target_gain = if request.muted { 0.0 } else { request.gain };
        if !ramp {
            self.current_gain = self.target_gain;
        }
        Ok(())
    }

    pub fn advance_frame(&mut self, sample_rate: u32, ramp_seconds: f64) {
        let step = (1.0 / (sample_rate as f64 * ramp_seconds)).max(0.0001) as f32;
        if self.current_gain < self.target_gain {
            self.current_gain = (self.current_gain + step).min(self.target_gain);
        } else if self.current_gain > self.target_gain {
            self.current_gain = (self.current_gain - step).max(self.target_gain);
        }
    }

    pub fn gain(&self) -> f32 {
        self.current_gain
    }

    pub fn settled(mut self) -> Self {
        self.current_gain = self.target_gain;
        self
    }

    pub fn snapshot(&self) -> AudioOutputSnapshot {
        AudioOutputSnapshot {
            configured_gain: self.configured_gain,
            muted: self.muted,
            target_gain: self.target_gain,
            current_gain: self.current_gain,
        }
    }
}

#[cfg(test)]
mod output_tests {
    use super::{AudioOutputRequest, AudioOutputState};

    #[test]
    fn finite_gains_clamp_and_non_finite_updates_preserve_state() {
        let mut output = AudioOutputState::default();
        output
            .set(AudioOutputRequest { gain: 2.0, muted: true }, false)
            .unwrap();
        assert_eq!(output.snapshot().configured_gain, 1.0);
        assert!(output.snapshot().muted);

        assert!(output
            .set(AudioOutputRequest { gain: f32::NAN, muted: false }, false)
            .is_err());
        assert_eq!(output.snapshot().configured_gain, 1.0);
        assert!(output.snapshot().muted);
        assert_eq!(output.snapshot().current_gain, 0.0);
    }

    #[test]
    fn unmute_restores_the_configured_gain() {
        let mut output = AudioOutputState::default();
        output
            .set(AudioOutputRequest { gain: 0.35, muted: true }, false)
            .unwrap();
        output
            .set(AudioOutputRequest { gain: 0.35, muted: false }, false)
            .unwrap();

        assert_eq!(output.snapshot().configured_gain, 0.35);
        assert_eq!(output.snapshot().target_gain, 0.35);
        assert_eq!(output.snapshot().current_gain, 0.35);
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveAudioLane {
    pub id: String,
    pub artifact_id: Option<String>,
    pub role: AudioLaneRole,
    pub effective_gain: f32,
    pub muted: bool,
    pub solo: bool,
}

#[derive(Default)]
pub struct MixerState {
    lanes: Vec<AudioLaneRequest>,
}

impl MixerState {
    pub fn set_lanes(&mut self, lanes: Vec<AudioLaneRequest>) {
        self.lanes = lanes;
    }

    pub fn effective_lanes(&self) -> Vec<EffectiveAudioLane> {
        effective_lanes(&self.lanes)
    }
}

pub fn effective_lanes(lanes: &[AudioLaneRequest]) -> Vec<EffectiveAudioLane> {
    let has_solo = lanes.iter().any(|lane| lane.solo);
    lanes
        .iter()
        .map(|lane| {
            let active = if has_solo { lane.solo } else { !lane.muted };
            let effective_gain = if active {
                lane.gain.clamp(0.0, 1.0)
            } else {
                0.0
            };
            EffectiveAudioLane {
                id: lane.id.clone(),
                artifact_id: lane.artifact_id.clone(),
                role: lane.role,
                effective_gain,
                muted: lane.muted,
                solo: lane.solo,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stem(id: &str, muted: bool, solo: bool) -> AudioLaneRequest {
        AudioLaneRequest {
            id: id.to_string(),
            artifact_id: Some(id.to_string()),
            source_path: None,
            role: AudioLaneRole::Stem,
            gain: 1.0,
            muted,
            solo,
        }
    }

    #[test]
    fn muted_lane_gets_zero_gain_without_solo() {
        let lanes = effective_lanes(&[
            stem("vocals", true, false),
            stem("instrumental", false, false),
        ]);

        assert_eq!(lanes[0].effective_gain, 0.0);
        assert_eq!(lanes[1].effective_gain, 1.0);
    }

    #[test]
    fn solo_wins_over_mute_state() {
        let lanes = effective_lanes(&[
            stem("vocals", true, true),
            stem("instrumental", false, false),
        ]);

        assert_eq!(lanes[0].effective_gain, 1.0);
        assert_eq!(lanes[1].effective_gain, 0.0);
    }
}
