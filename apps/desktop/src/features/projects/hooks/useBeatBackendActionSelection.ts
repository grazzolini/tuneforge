import { useCallback } from "react";
import { isAndroidRuntime } from "../../../lib/nativeAudio";
import { usePreferences, type DefaultBeatAnalysisBackend } from "../../../lib/preferences";

declare const __TUNEFORGE_BEAT_THIS_INCLUDED__: boolean;

export type BeatBackendActionSelection = {
  beat_backend: DefaultBeatAnalysisBackend;
};

type BeatBackendRuntime = {
  androidRuntime: boolean;
  beatThisIncluded: boolean;
};

export function resolveBeatBackendActionSelection(
  defaultBeatAnalysisBackend: DefaultBeatAnalysisBackend,
  runtime: BeatBackendRuntime = {
    androidRuntime: isAndroidRuntime(),
    beatThisIncluded: __TUNEFORGE_BEAT_THIS_INCLUDED__,
  },
): BeatBackendActionSelection {
  return {
    beat_backend:
      runtime.androidRuntime || !runtime.beatThisIncluded
        ? "built-in"
        : defaultBeatAnalysisBackend,
  };
}

export function useBeatBackendActionSelection() {
  const { defaultBeatAnalysisBackend } = usePreferences();

  const beatBackendForAction = useCallback(async (): Promise<BeatBackendActionSelection> => {
    return resolveBeatBackendActionSelection(defaultBeatAnalysisBackend);
  }, [defaultBeatAnalysisBackend]);

  return { beatBackendForAction };
}
