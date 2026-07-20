import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { setPowerInhibitionActivity } from "./powerInhibition";

export const SYSTEM_MEDIA_CONTROL_EVENT = "system-media://control";

export type SystemMediaPlaybackState = "none" | "playing" | "paused";

export type SystemMediaState = {
  title: string;
  artist: string;
  album?: string | null;
  playbackState: SystemMediaPlaybackState;
  durationSeconds?: number | null;
  positionSeconds?: number | null;
  playbackRate?: number | null;
  canSeek: boolean;
};

export type SystemMediaControlAction =
  | "play"
  | "pause"
  | "playPause"
  | "stop"
  | "seekBackward"
  | "seekForward"
  | "seekTo";

export type SystemMediaControlEvent = {
  action: SystemMediaControlAction;
  positionSeconds?: number | null;
  seekOffsetSeconds?: number | null;
};

export function updateSystemMediaState(payload: SystemMediaState) {
  return invoke<void>("system_media_update_state", { payload });
}

export function clearSystemMediaState() {
  return invoke<void>("system_media_clear_state");
}

export async function releaseSystemMediaControls() {
  await Promise.all([
    clearSystemMediaState(),
    setPowerInhibitionActivity("playback", false),
  ]);
}

export function listenSystemMediaControls(
  handler: (event: SystemMediaControlEvent) => void,
) {
  return listen<SystemMediaControlEvent>(SYSTEM_MEDIA_CONTROL_EVENT, (event) => {
    handler(event.payload);
  });
}
