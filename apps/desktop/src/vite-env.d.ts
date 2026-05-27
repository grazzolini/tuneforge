/// <reference types="vite/client" />

import type { PlaybackE2ETelemetryApi } from "./lib/playbackE2ETelemetry";

declare global {
  interface Window {
    __TUNEFORGE_PLAYBACK_E2E__?: PlaybackE2ETelemetryApi;
  }
}
