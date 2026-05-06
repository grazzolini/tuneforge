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
