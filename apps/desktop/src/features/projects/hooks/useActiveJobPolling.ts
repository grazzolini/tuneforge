import { createContext, createElement, useContext, useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getJobRuntimeIdentity } from "../../../lib/api";
import { JobLifecycle } from "../../../lib/jobLifecycle";

const LifecycleContext = createContext<JobLifecycle | null>(null);
export function JobLifecycleProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const runtime = getJobRuntimeIdentity();
  const [owner, setOwner] = useState<JobLifecycle | null>(null);
  useEffect(() => {
    const lifecycle = new JobLifecycle(queryClient, runtime);
    setOwner(lifecycle);
    const resume = () => { if (document.visibilityState !== "hidden") lifecycle.resume(); };
    window.addEventListener("pageshow", resume);
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      lifecycle.dispose();
      window.removeEventListener("pageshow", resume);
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [queryClient, runtime]);
  return createElement(LifecycleContext.Provider, { value: owner }, children);
}
export function useJobLifecycleScope(projectId?: string, search?: string, enabled = true) {
  const owner = useContext(LifecycleContext);
  useEffect(() => {
    if (!owner || !enabled) return;
    return owner.subscribe({ ...(projectId ? { projectId } : {}), ...(search ? { search } : {}) });
  }, [owner, projectId, search, enabled]);
}
