import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type BeatBackendsResponse } from "../../../lib/api";
import { usePreferences, type DefaultBeatAnalysisBackend } from "../../../lib/preferences";

export type BeatBackendActionSelection = {
  beat_backend: DefaultBeatAnalysisBackend;
};

export function useBeatBackendActionSelection() {
  const queryClient = useQueryClient();
  const { defaultBeatAnalysisBackend } = usePreferences();
  const beatBackendsQuery = useQuery({
    queryKey: ["beat-backends"],
    queryFn: api.listBeatBackends,
  });

  const beatBackendForAction = useCallback(async (): Promise<BeatBackendActionSelection> => {
    if (defaultBeatAnalysisBackend === "built-in") {
      return { beat_backend: "built-in" };
    }

    let backendResponse: BeatBackendsResponse | undefined = beatBackendsQuery.data;
    if (!backendResponse) {
      try {
        backendResponse = await queryClient.fetchQuery({
          queryKey: ["beat-backends"],
          queryFn: api.listBeatBackends,
        });
      } catch {
        return { beat_backend: "built-in" };
      }
    }
    if (!backendResponse) {
      return { beat_backend: "built-in" };
    }

    const selectedBackend = backendResponse.backends.find(
      (backend) => backend.id === defaultBeatAnalysisBackend,
    );
    if (selectedBackend?.available) {
      return { beat_backend: defaultBeatAnalysisBackend };
    }
    return { beat_backend: "built-in" };
  }, [beatBackendsQuery.data, defaultBeatAnalysisBackend, queryClient]);

  return { beatBackendForAction, beatBackendsQuery };
}
