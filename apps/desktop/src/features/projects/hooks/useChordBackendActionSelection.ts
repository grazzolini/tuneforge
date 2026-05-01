import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ChordBackendsResponse } from "../../../lib/api";
import { usePreferences, type DefaultChordBackend } from "../../../lib/preferences";

export type ChordBackendActionSelection = {
  backend: DefaultChordBackend;
  backend_fallback_from?: DefaultChordBackend;
};

export function useChordBackendActionSelection() {
  const queryClient = useQueryClient();
  const { defaultChordBackend } = usePreferences();
  const chordBackendsQuery = useQuery({
    queryKey: ["chord-backends"],
    queryFn: api.listChordBackends,
  });

  const chordBackendForAction = useCallback(async (): Promise<ChordBackendActionSelection> => {
    if (defaultChordBackend === "tuneforge-fast") {
      return { backend: "tuneforge-fast" };
    }

    let backendResponse: ChordBackendsResponse | undefined = chordBackendsQuery.data;
    if (!backendResponse) {
      try {
        backendResponse = await queryClient.fetchQuery({
          queryKey: ["chord-backends"],
          queryFn: api.listChordBackends,
        });
      } catch {
        return { backend: "tuneforge-fast", backend_fallback_from: defaultChordBackend };
      }
    }
    if (!backendResponse) {
      return { backend: "tuneforge-fast", backend_fallback_from: defaultChordBackend };
    }

    const selectedBackend = backendResponse.backends.find((backend) => backend.id === defaultChordBackend);
    if (selectedBackend?.available) {
      return { backend: defaultChordBackend };
    }
    return { backend: "tuneforge-fast", backend_fallback_from: defaultChordBackend };
  }, [chordBackendsQuery.data, defaultChordBackend, queryClient]);

  return { chordBackendForAction, chordBackendsQuery };
}
