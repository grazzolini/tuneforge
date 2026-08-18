import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { JobSchema } from "../../../lib/api";

type ActiveJobPollingOptions = {
  forceActive?: boolean;
  intervalMs?: number;
};

export function useActiveJobPolling(
  projectId: string,
  jobs: JobSchema[] | undefined,
  { forceActive = false, intervalMs = 1500 }: ActiveJobPollingOptions = {},
) {
  const queryClient = useQueryClient();

  useEffect(() => {
    const active = forceActive || jobs?.some(
      (job) => job.project_id === projectId && ["pending", "running"].includes(job.status),
    );
    if (!active) return;

    const refresh = () => {
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ["jobs"] }),
        queryClient.invalidateQueries({ queryKey: ["analysis", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["chords", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["lyrics", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["artifacts", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["project", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["projects"] }),
      ]);
    };
    refresh();
    const interval = window.setInterval(refresh, intervalMs);

    return () => window.clearInterval(interval);
  }, [forceActive, intervalMs, jobs, projectId, queryClient]);
}
