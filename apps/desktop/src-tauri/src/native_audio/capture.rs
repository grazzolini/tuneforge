use serde::{Deserialize, Serialize};

use super::AudioCapabilities;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioInputDevice {
    pub id: String,
    pub label: String,
    pub is_default: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioInputDevices {
    pub supported: bool,
    pub devices: Vec<AudioInputDevice>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioInputRequest {
    pub device_id: Option<String>,
    pub monitor_enabled: Option<bool>,
    pub monitor_gain: Option<f32>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioMonitorRequest {
    pub enabled: bool,
    pub gain: Option<f32>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioInputState {
    pub active: bool,
    pub device_id: Option<String>,
    pub monitor_enabled: bool,
    pub monitor_gain: f32,
    pub input_level: f32,
}

#[derive(Default)]
pub struct CaptureState {
    active: bool,
    device_id: Option<String>,
    monitor_enabled: bool,
    monitor_gain: f32,
    input_level: f32,
}

impl CaptureState {
    pub fn list_devices(&self, capabilities: AudioCapabilities) -> AudioInputDevices {
        if !capabilities.mic_capture_supported {
            return AudioInputDevices {
                supported: false,
                devices: Vec::new(),
                error: Some("Native microphone capture is not wired yet.".to_string()),
            };
        }

        AudioInputDevices {
            supported: true,
            devices: Vec::new(),
            error: None,
        }
    }

    pub fn start(&mut self, request: AudioInputRequest) -> Result<AudioInputState, String> {
        self.active = true;
        self.device_id = request.device_id;
        self.monitor_enabled = request.monitor_enabled.unwrap_or(false);
        self.monitor_gain = normalize_gain(request.monitor_gain);
        self.input_level = 0.0;
        Ok(self.state())
    }

    pub fn stop(&mut self) -> AudioInputState {
        self.active = false;
        self.input_level = 0.0;
        self.state()
    }

    pub fn set_monitor(&mut self, request: AudioMonitorRequest) -> AudioInputState {
        self.monitor_enabled = request.enabled;
        self.monitor_gain = normalize_gain(request.gain);
        self.state()
    }

    fn state(&self) -> AudioInputState {
        AudioInputState {
            active: self.active,
            device_id: self.device_id.clone(),
            monitor_enabled: self.monitor_enabled,
            monitor_gain: self.monitor_gain,
            input_level: self.input_level,
        }
    }
}

fn normalize_gain(value: Option<f32>) -> f32 {
    value.unwrap_or(0.0).clamp(0.0, 1.0)
}
