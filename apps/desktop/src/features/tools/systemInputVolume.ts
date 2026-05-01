import { invoke } from "@tauri-apps/api/core";

export type SystemDefaultInputVolume = {
  supported: boolean;
  volumePercent: number | null;
  muted: boolean | null;
  backend: string | null;
  error: string | null;
};

export async function getSystemDefaultInputVolume() {
  return invoke<SystemDefaultInputVolume>("get_system_default_input_volume");
}

export async function setSystemDefaultInputVolume(volumePercent: number) {
  return invoke<SystemDefaultInputVolume>("set_system_default_input_volume", {
    volumePercent: clampSystemInputVolume(volumePercent),
  });
}

export function clampSystemInputVolume(volumePercent: number) {
  if (!Number.isFinite(volumePercent)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(volumePercent)));
}
