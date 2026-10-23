import { InfiniteQueryObserver, infiniteQueryOptions, type Query, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { api, getJobRuntimeIdentity, subscribeJobOperations, type JobOperationEvent, type JobSchema, type TuneForgeClient } from "./api";

export type JobScope = { projectId?: string; search?: string };
const activeStatuses = ["running", "pending"];
const terminalStatuses = ["completed", "failed", "cancelled"];
const active = (job: JobSchema) => activeStatuses.includes(job.status);
const terminal = (job: JobSchema) => terminalStatuses.includes(job.status);
const signature = (job: JobSchema) => JSON.stringify([job.status, job.updated_at, job.stage, job.export_result, job.result_artifact_ids]);
export function jobsOptions(scope: JobScope, status: "active" | "terminal", client: TuneForgeClient = api) {
  return infiniteQueryOptions({
    queryKey: scope.projectId
      ? ["jobs", { projectId: scope.projectId, scope: "project", status }]
      : ["jobs", "activity", status, scope.search ?? ""],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => client.listJobs({
      ...(scope.projectId ? { project_id: scope.projectId } : {}),
      ...(scope.search ? { search: scope.search } : {}),
      ...(!scope.projectId ? { sort_by: "activity" as const } : {}),
      status: status === "active" ? activeStatuses : terminalStatuses,
      limit: status === "active" ? 200 : 50,
      offset: pageParam,
    }),
    getNextPageParam: (page) => page.has_more ? page.offset + page.jobs.length : undefined,
  });
}
function observerFor(queryClient: QueryClient, scope: JobScope, client: TuneForgeClient) {
  return new InfiniteQueryObserver(queryClient, { ...jobsOptions(scope, "active", client), enabled: false });
}
type ScopeState = { initial: boolean; scope: JobScope; users: number; next: number; observer: ReturnType<typeof observerFor>; unsubscribe: () => void };
type TerminalRefresh = { key: QueryKey; generation: number; cancelled?: Promise<void>; readGeneration?: number; reads?: Map<Query, Promise<unknown> | undefined>; ownedReads?: Map<Query, Promise<unknown> | undefined> };

export function exportSummaryConsistent(job: JobSchema): boolean {
  const result = job.export_result;
  if (!result) return true;
  if (!Array.isArray(result.items) || result.items.length === 0 || result.total_count !== result.items.length) return false;
  return job.status === "cancelled" ? result.outcome === "cancelled" && result.items.every((item) => !["pending", "running"].includes(item.status))
    : job.status === "completed" ? ["completed", "partial"].includes(result.outcome) && result.items.every((item) => !["pending", "running"].includes(item.status))
      : job.status === "failed" ? result.outcome === "failed" : true;
}

const runtimeOwners = new WeakMap<QueryClient, object>();

export class JobLifecycle {
  private scopes = new Map<string, ScopeState>();
  private intents = new Map<number, JobOperationEvent>();
  private known = new Map<string, JobSchema>();
  private terminalSeen = new Map<string, string>();
  private bootstrapSeen = new Map<string, Map<string, string>>();
  private reconciled = new Map<string, string>();
  private resultKeys = new Map<string, QueryKey>();
  private terminalResults = new Map<string, TerminalRefresh>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private queued = false;
  private disposed = false;
  private failures = 0;
  private historyDue = false;
  private nextResults = Date.now() + 1500;
  private acknowledgments = new Set<() => void>();
  private detach: () => void;
  constructor(private queryClient: QueryClient, private runtime = getJobRuntimeIdentity(), private client: TuneForgeClient = api) {
    const previousRuntime = runtimeOwners.get(queryClient);
    if (previousRuntime && previousRuntime !== runtime) queryClient.removeQueries({ queryKey: ["jobs"] });
    runtimeOwners.set(queryClient, runtime);
    this.detach = subscribeJobOperations((event) => {
      if (this.disposed || event.runtime !== this.runtime) return;
      if (event.kind !== "read" && event.kind !== "cancel") this.intents.set(event.id, event);
      this.observe(event.jobs, event.kind !== "read");
      if (event.settled && event.kind !== "read") {
        event.jobs.forEach((job) => { void this.readKnown(job.id); });
        this.historyDue = true;
        this.scopes.forEach((scope) => { scope.next = 0; });
      }
      this.schedule(event.kind === "read" ? 1500 : 0);
      if (event.settled && event.kind !== "read") return new Promise<void>((resolve) => this.acknowledgments.add(resolve));
    });
  }
  subscribe(scope: JobScope) {
    const key = JSON.stringify(scope);
    let entry = this.scopes.get(key);
    if (!entry) {
      const observer = observerFor(this.queryClient, scope, this.client);
      entry = { initial: true, scope, users: 0, next: observer.getCurrentResult().data ? Date.now() + 1500 : 0, observer, unsubscribe: observer.subscribe(() => {}) };
      this.observe(observer.getCurrentResult().data?.pages.flatMap((page) => page.jobs) ?? []);
      this.scopes.set(key, entry);
    }
    entry.users += 1;
    this.schedule(0);
    return () => {
      if (!entry || --entry.users > 0) return;
      entry.unsubscribe();
      entry.observer.destroy();
      this.scopes.delete(key);
    };
  }
  private resultFilters(queryKey: QueryKey) {
    return { queryKey, ...(queryKey.length === 1 && queryKey[0] === "projects" ? { predicate: (query: Query) => query.queryKey[1] !== "activity" } : {}) };
  }
  private queue(key: QueryKey, completed = false) {
    const id = JSON.stringify(key);
    if (!completed) { if (!this.terminalResults.has(id)) this.resultKeys.set(id, key); return; }
    this.resultKeys.delete(id);
    const pending = this.terminalResults.get(id);
    if (pending) pending.generation += 1;
    else this.terminalResults.set(id, { key, generation: 1, cancelled: this.queryClient.cancelQueries(this.resultFilters(key)) });
  }
  private async refreshTerminalResults() {
    const settled = await Promise.allSettled([...this.terminalResults].map(async ([id, pending]) => {
      const filters = this.resultFilters(pending.key);
      const cancellation = pending.cancelled;
      await cancellation;
      pending.cancelled = undefined;
      if (this.disposed) return;
      const inactive = new Map([...pending.ownedReads ?? []].filter(([query, promise]) => !query.isActive() && query.promise === promise && query.state.fetchStatus !== "idle"));
      if (inactive.size) {
        const generation = pending.generation;
        await this.queryClient.cancelQueries({ predicate: (query) => !query.isActive() && inactive.has(query) && inactive.get(query) === query.promise });
        if (this.disposed) return;
        await this.queryClient.invalidateQueries({ predicate: (query) => inactive.has(query) && inactive.get(query) === query.promise, refetchType: "none" });
        if (this.disposed) return;
        if (pending.readGeneration === generation && pending.generation === generation) {
          for (const [query, promise] of inactive) if (query.promise !== promise) pending.reads!.set(query, query.promise);
        }
      }
      const complete = () => this.queryClient.getQueryCache().findAll(filters).every((query) => !query.isActive() || (
        query.state.status === "success" && query.state.fetchStatus === "idle" && !query.state.isInvalidated && pending.reads?.get(query) === query.promise
      ));
      if (pending.readGeneration === pending.generation && complete()) { this.terminalResults.delete(id); return; }
      const outstanding = [...pending.reads ?? []].filter(([query, promise]) => query.promise === promise && query.state.fetchStatus !== "idle");
      if (outstanding.some(([query]) => query.state.fetchStatus === "paused")) throw new Error("Job results paused");
      if (outstanding.length) {
        await Promise.all(outstanding.map(([, promise]) => promise));
        if (this.disposed) return;
        if (pending.readGeneration === pending.generation && complete()) { this.terminalResults.delete(id); return; }
      }
      // Cancel even initial reads, repeating if completion advances during the barrier.
      let generation: number;
      do {
        generation = pending.generation;
        await this.queryClient.cancelQueries(filters);
        if (this.disposed) return;
      } while (generation !== pending.generation);
      const before = new Map(this.queryClient.getQueryCache().findAll(filters).map((query) => [query, query.promise]));
      const refresh = this.queryClient.invalidateQueries(filters, { cancelRefetch: false, throwOnError: true });
      pending.readGeneration = generation;
      pending.reads = new Map(this.queryClient.getQueryCache().findAll(filters).filter((query) => query.isActive()).map((query) => [query, query.promise]));
      pending.ownedReads = new Map([...pending.reads].filter(([query, promise]) => before.has(query) && before.get(query) !== promise));
      await refresh;
      if (this.disposed) return;
      if (!complete()) throw new Error("Job results unavailable");
      if (pending.generation === generation) this.terminalResults.delete(id);
    }));
    if (settled.some((result) => result.status === "rejected")) throw new Error("Job results unavailable");
  }
  private results(job: JobSchema, capabilities: boolean, includeResults = true) {
    const id = job.project_id;
    const type = job.type;
    const queue = (key: QueryKey) => this.queue(key, terminal(job));
    const families: Record<string, string[]> = {
      analyze: ["analysis", "project"], chords: ["chords"], lyrics: ["lyrics"],
      preview: ["artifacts"], retune: ["artifacts"], transpose: ["artifacts"],
      stems: ["artifacts"], drum_substems: ["artifacts"], convert_audio: ["artifacts", "project"], export: ["artifacts"],
    };
    const unknown = !(type in families);
    if (id && includeResults) {
      for (const family of families[type] ?? (terminal(job) ? ["analysis", "chords", "lyrics", "sections", "artifacts", "project"] : [])) queue([family, id]);
      if (["analyze", "convert_audio"].includes(type) || unknown && terminal(job)) {
        queue(["projects"]);
        queue(["projects", "activity", "detail", id]);
      }
    }
    if (!capabilities || unknown && !terminal(job)) return;
    if (["analyze", "chords", "lyrics"].includes(type) || unknown) queue(["runtime", "mobile-capabilities"]);
    if (type === "analyze" || unknown) queue(["beat-backends"]);
    if (type === "chords" || unknown) queue(["chord-backends"]);
    if (type === "stems" || unknown) queue(["stem-models"]);
    if (["stems", "drum_substems"].includes(type) || unknown) queue(["drum-substems", "capabilities"]);
  }
  private observe(jobs: JobSchema[], allowTerminal = false) {
    for (const job of jobs) {
      const previous = this.known.get(job.id);
      if (active(job)) {
        this.known.set(job.id, job);
        if (!previous || previous.stage !== job.stage) this.results(job, true, Boolean(previous));
        if (!previous) this.scopes.forEach((scope) => { if (!scope.scope.projectId || scope.scope.projectId === job.project_id) scope.next = 0; });
      } else if (terminal(job) && (allowTerminal || previous)) {
        const fingerprint = signature(job);
        if (this.terminalSeen.get(job.id) !== fingerprint) {
          this.results(job, true);
          this.historyDue = true;
          this.scopes.forEach((scope) => { if (!scope.scope.projectId || scope.scope.projectId === job.project_id) scope.next = 0; });
          this.terminalSeen.set(job.id, fingerprint);
          if (this.terminalSeen.size > 200) this.terminalSeen.delete(this.terminalSeen.keys().next().value!);
        }
        this.known.delete(job.id);
        if (job.type === "export" && !exportSummaryConsistent(job) && this.reconciled.get(job.id) !== fingerprint) {
          this.reconciled.set(job.id, fingerprint);
          if (this.reconciled.size > 200) this.reconciled.delete(this.reconciled.keys().next().value!);
          void this.readKnown(job.id);
        }
      }
    }
  }
  private async readKnown(id: string) {
    try {
      const { job } = await this.queryClient.fetchQuery({ queryKey: ["jobs", "detail", id], queryFn: () => this.client.getJob(id), staleTime: 0, retry: false });
      if (!this.disposed) this.observe([job], true);
      return true;
    } catch { return false; /* A missing or unavailable row is not proof of completion. */ }
  }
  private async bootstrap() {
    const groups = new Map<string, JobOperationEvent[]>();
    const all = [...this.intents.values()];
    const global = all.some((intent) => !intent.projectId);
    for (const intent of all) {
      const key = global ? "" : intent.projectId!;
      groups.set(key, [...(groups.get(key) ?? []), intent]);
    }
    for (const [projectId, intents] of groups) {
      const response = await this.queryClient.fetchQuery({
        // A post-settlement read must not reuse a request begun before persistence settled.
        queryKey: ["jobs", "bootstrap", projectId, intents.filter((intent) => intent.settled).map((intent) => intent.id)],
        queryFn: () => this.client.listJobs({ ...(projectId ? { project_id: projectId } : {}), sort_by: "updated_at", sort_order: "desc", limit: 200, offset: 0 }),
        staleTime: 0, retry: false,
      });
      if (this.disposed) return;
      const previous = this.bootstrapSeen.get(projectId);
      this.observe(response.jobs.filter((job) => !previous || previous.get(job.id) !== signature(job)), true);
      this.bootstrapSeen.set(projectId, new Map(response.jobs.map((job) => [job.id, signature(job)])));
      for (const intent of intents) if (intent.settled && this.intents.get(intent.id) === intent) this.intents.delete(intent.id);
    }
    if (!this.intents.size) this.bootstrapSeen.clear();
  }
  private async tick() {
    this.timer = undefined;
    if (this.disposed || this.running) return;
    this.running = true;
    let readFailed = false;
    const acknowledgments = [...this.acknowledgments];
    try {
      if (this.intents.size) await this.bootstrap();
      for (const entry of this.scopes.values()) {
        if (this.disposed) return;
        if (entry.next > Date.now()) continue;
        entry.next = Date.now() + 1500;
        const cached = entry.observer.getCurrentResult();
        const result = entry.initial && cached.data ? cached : await entry.observer.refetch({ cancelRefetch: false });
        entry.initial = false;
        if (this.disposed) return;
        if (result.isError) throw result.error;
        let current = entry.observer.getCurrentResult();
        for (let pages = 0; pages < 2 && current.hasNextPage; pages++) current = await entry.observer.fetchNextPage({ cancelRefetch: false });
        if (this.disposed) return;
        const jobs = current.data?.pages.flatMap((page) => page.jobs) ?? [];
        this.observe(jobs);
        if (!current.isError && !current.hasNextPage) {
          const ids = new Set(jobs.map((job) => job.id));
          for (const job of this.known.values()) if ((!entry.scope.projectId || entry.scope.projectId === job.project_id) && !entry.scope.search && !ids.has(job.id)) readFailed = !(await this.readKnown(job.id)) || readFailed;
        }
        entry.next = Date.now() + 1500;
      }
      for (const job of [...this.known.values()]) {
        if (![...this.scopes.values()].some(({ scope }) => !scope.search && (!scope.projectId || scope.projectId === job.project_id))) readFailed = !(await this.readKnown(job.id)) || readFailed;
      }
      if (Date.now() >= this.nextResults) {
        for (const job of this.known.values()) this.results(job, false);
        this.nextResults = Date.now() + 1500;
      }
      if (this.disposed) return;
      const keys = [...this.resultKeys.values()];
      this.resultKeys.clear();
      await Promise.all(keys.map((queryKey) => this.queryClient.invalidateQueries(this.resultFilters(queryKey), { cancelRefetch: false })));
      if (this.disposed) return;
      if (this.historyDue) {
        this.historyDue = false;
        await this.queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === "jobs" && (query.queryKey[2] === "terminal" || typeof query.queryKey[1] === "object" && (query.queryKey[1] as { status?: string })?.status === "terminal") }, { cancelRefetch: false });
      }
      if (this.disposed) return;
      await this.refreshTerminalResults();
      if (readFailed) throw new Error("Job state unavailable");
      this.failures = 0;
    } catch { this.failures += 1; }
    finally {
      this.running = false;
      acknowledgments.forEach((resolve) => { this.acknowledgments.delete(resolve); resolve(); });
      const pending = [...this.intents.values()];
      if (pending.length || this.known.size || this.resultKeys.size || this.terminalResults.size || this.acknowledgments.size || [...this.scopes.values()].some((scope) => scope.next === 0)) {
        const age = pending.length ? Date.now() - Math.min(...pending.map((intent) => intent.startedAt)) : Infinity;
        this.schedule(this.acknowledgments.size ? 0 : this.failures ? Math.min(15000, 1500 * 2 ** (this.failures - 1)) : this.terminalResults.size ? 1500 : age < 2000 ? 250 : age < 10000 ? 500 : 1500);
      }
    }
  }
  private schedule(delay: number) {
    if (this.disposed || this.running || this.queued) return;
    if (this.timer !== undefined) {
      if (delay !== 0) return;
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (delay === 0) {
      this.queued = true;
      queueMicrotask(() => { this.queued = false; void this.tick(); });
    } else this.timer = setTimeout(() => { void this.tick(); }, delay);
  }

  resume = () => { this.scopes.forEach((scope) => { scope.next = 0; }); this.schedule(0); };
  dispose() {
    this.disposed = true;
    this.detach();
    this.acknowledgments.forEach((resolve) => resolve());
    this.acknowledgments.clear();
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.scopes.forEach((scope) => { scope.unsubscribe(); scope.observer.destroy(); });
    this.scopes.clear();
    const reads = new Map([...this.terminalResults.values()].flatMap((pending) => [...pending.ownedReads ?? []]));
    void this.queryClient.cancelQueries({ predicate: (query) => reads.has(query) && reads.get(query) === query.promise && query.state.fetchStatus !== "idle" });
    this.terminalResults.clear();
    void this.queryClient.cancelQueries({ queryKey: ["jobs"] });
  }
}
