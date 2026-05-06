use serde::{Deserialize, Serialize};
use std::time::Instant;

use super::{mixer::AudioLaneRequest, mixer::EffectiveAudioLane, AudioCapabilities};

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

pub struct TransportState {
    session_id: Option<String>,
    status: TransportStatus,
    started_at: Option<Instant>,
    position_seconds: f64,
    duration_seconds: f64,
    playback_rate: f64,
    native_playback_supported: bool,
    fallback_reason: Option<String>,
    lanes: Vec<EffectiveAudioLane>,
}

impl Default for TransportState {
    fn default() -> Self {
        Self {
            session_id: None,
            status: TransportStatus::Stopped,
            started_at: None,
            position_seconds: 0.0,
            duration_seconds: 0.0,
            playback_rate: 1.0,
            native_playback_supported: false,
            fallback_reason: None,
            lanes: Vec::new(),
        }
    }
}

impl TransportState {
    pub fn prepare(
        &mut self,
        request: AudioSessionRequest,
        lanes: Vec<EffectiveAudioLane>,
        capabilities: AudioCapabilities,
    ) -> AudioSession {
        self.session_id = Some(request.session_id.clone());
        self.status = TransportStatus::Stopped;
        self.started_at = None;
        self.position_seconds = 0.0;
        self.duration_seconds = request.duration_seconds.unwrap_or(0.0).max(0.0);
        self.playback_rate = request.playback_rate.unwrap_or(1.0).max(0.0);
        let default_rate_supported = (self.playback_rate - 1.0).abs() < f64::EPSILON;
        self.native_playback_supported =
            capabilities.native_playback_supported && default_rate_supported;
        self.fallback_reason = if default_rate_supported {
            capabilities.fallback_reason.map(str::to_string)
        } else {
            Some("Native audio playback only supports default-rate playback.".to_string())
        };
        self.lanes = lanes;

        AudioSession {
            id: request.session_id,
            native_playback_supported: self.native_playback_supported,
            fallback_reason: self.fallback_reason.clone(),
            lane_count: self.lanes.len(),
        }
    }

    pub fn set_effective_lanes(&mut self, lanes: Vec<EffectiveAudioLane>) {
        self.lanes = lanes;
    }

    pub fn play(&mut self, request: AudioPlayRequest) -> Result<AudioSnapshot, String> {
        if self.session_id.is_none() {
            return Err("Native audio session is not prepared.".to_string());
        }
        if let Some(start_time_seconds) = request.start_time_seconds {
            self.position_seconds = self.clamp_position(start_time_seconds);
        }
        let _ = request.scheduled_start_time_seconds;
        self.status = TransportStatus::Playing;
        self.started_at = Some(Instant::now());
        Ok(self.snapshot())
    }

    pub fn pause(&mut self) -> AudioSnapshot {
        self.position_seconds = self.current_position();
        self.status = TransportStatus::Paused;
        self.started_at = None;
        self.snapshot()
    }

    pub fn stop(&mut self) -> AudioSnapshot {
        self.position_seconds = 0.0;
        self.status = TransportStatus::Stopped;
        self.started_at = None;
        self.snapshot()
    }

    pub fn seek(&mut self, request: AudioSeekRequest) -> AudioSnapshot {
        self.position_seconds = self.clamp_position(request.time_seconds);
        if self.status == TransportStatus::Playing {
            self.started_at = Some(Instant::now());
        }
        self.snapshot()
    }

    pub fn snapshot(&self) -> AudioSnapshot {
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
        if !value.is_finite() {
            return 0.0;
        }
        if self.duration_seconds <= 0.0 {
            return value.max(0.0);
        }
        value.clamp(0.0, self.duration_seconds)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn non_default_rate_requires_fallback() {
        let mut state = TransportState::default();
        let session = state.prepare(
            AudioSessionRequest {
                session_id: "session".to_string(),
                duration_seconds: Some(30.0),
                playback_rate: Some(0.75),
                lanes: Vec::new(),
            },
            Vec::new(),
            capabilities(),
        );

        assert!(!session.native_playback_supported);
        assert_eq!(
            session.fallback_reason.as_deref(),
            Some("Native audio playback only supports default-rate playback.")
        );
    }
}
