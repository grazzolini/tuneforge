import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../lib/api";
import { isAndroidRuntime } from "../../../lib/nativeAudio";
import { usePreferences, type DefaultBeatAnalysisBackend } from "../../../lib/preferences";

declare const __TUNEFORGE_BEAT_THIS_INCLUDED__: boolean;

export const ADVANCED_BEAT_UNAVAILABLE_MESSAGE =
  "Advanced Beat Analysis is unavailable on this device. Choose Built-in Beat Analysis in Settings.";

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
      !runtime.androidRuntime && !runtime.beatThisIncluded
        ? "built-in"
        : defaultBeatAnalysisBackend,
  };
}

export function useBeatBackendActionSelection() {
  const { defaultBeatAnalysisBackend } = usePreferences();
  const mobileCapabilitiesQuery = useQuery({
    queryKey: ["runtime", "mobile-capabilities"],
    queryFn: () => api.getMobileCapabilities(),
    staleTime: Infinity,
  });

  const beatBackendForAction = useCallback(async (): Promise<BeatBackendActionSelection> => {
    const mobileCapabilities = mobileCapabilitiesQuery.data;
    const mobileRuntime = isAndroidRuntime() || mobileCapabilities !== null && mobileCapabilities !== undefined;
    if (
      mobileRuntime &&
      defaultBeatAnalysisBackend === "beat-this" &&
      (mobileCapabilities?.platform !== "android" || mobileCapabilities.beatThisAvailable !== true)
    ) {
      throw new Error(ADVANCED_BEAT_UNAVAILABLE_MESSAGE);
    }
    return resolveBeatBackendActionSelection(defaultBeatAnalysisBackend);
  }, [defaultBeatAnalysisBackend, mobileCapabilitiesQuery.data]);

  return { beatBackendForAction };
}
