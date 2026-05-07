import { invoke } from "@tauri-apps/api/core";

export type SystemDefaultInputVolume = {
  supported: boolean;
  volumePercent: number | null;
  muted: boolean | null;
  backend: string | null;
  error: string | null;
};

export async function getSystemDefaultInputVolume(deviceId?: string | null) {
  return invoke<SystemDefaultInputVolume>("get_system_default_input_volume", {
    deviceId: deviceId ?? null,
  });
}

export async function setSystemDefaultInputVolume(
  volumePercent: number,
  deviceId?: string | null,
) {
  return invoke<SystemDefaultInputVolume>("set_system_default_input_volume", {
    deviceId: deviceId ?? null,
    volumePercent: clampSystemInputVolume(volumePercent),
  });
}

export function clampSystemInputVolume(volumePercent: number) {
  if (!Number.isFinite(volumePercent)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(volumePercent)));
}
