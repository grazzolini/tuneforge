import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { JobSchema } from "../../../lib/api";

export function useActiveJobPolling(projectId: string, jobs: JobSchema[] | undefined) {
  const queryClient = useQueryClient();

  useEffect(() => {
    const active = jobs?.some(
      (job) => job.project_id === projectId && ["pending", "running"].includes(job.status),
    );
    if (!active) return;

    const interval = window.setInterval(async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["jobs"] }),
        queryClient.invalidateQueries({ queryKey: ["analysis", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["chords", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["lyrics", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["artifacts", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["project", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["projects"] }),
      ]);
    }, 1500);

    return () => window.clearInterval(interval);
  }, [jobs, projectId, queryClient]);
}

