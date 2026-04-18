import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { save } from "@tauri-apps/plugin-dialog";
import { api, type ArtifactSchema, type JobSchema } from "../../lib/api";
import {
  DEFAULT_KEY,
  MUSICAL_KEYS,
  deserializeKey,
  formatKey,
  parseKey,
  semitoneDelta,
  serializeKey,
  transposeKey,
  type MusicalKey,
} from "../../lib/music";

function useActiveJobPolling(projectId: string, jobs: JobSchema[] | undefined) {
  const queryClient = useQueryClient();

  useEffect(() => {
    const active = jobs?.some((job) => job.project_id === projectId && ["pending", "running"].includes(job.status));
    if (!active) return;

    const interval = window.setInterval(async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["jobs"] }),
        queryClient.invalidateQueries({ queryKey: ["analysis", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["artifacts", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["project", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["projects"] }),
      ]);
    }, 1500);

    return () => window.clearInterval(interval);
  }, [jobs, projectId, queryClient]);
}

function artifactLabel(artifact: ArtifactSchema) {
  if (artifact.type === "source_audio") return "Source";
  if (artifact.type === "preview_mix") return "Preview";
  if (artifact.type === "export_mix") return "Export";
  if (artifact.type === "vocal_stem") return "Vocals";
  if (artifact.type === "instrumental_stem") return "Instrumental";
  if (artifact.type === "analysis_json") return "Analysis JSON";
  return artifact.type;
}

function isPlayableArtifact(artifact: ArtifactSchema) {
  return ["source_audio", "preview_mix", "export_mix", "vocal_stem", "instrumental_stem"].includes(artifact.type);
}

function preferredArtifactSelection(artifacts: ArtifactSchema[]) {
  return artifacts.find((artifact) => artifact.type === "preview_mix") ?? artifacts[0] ?? null;
}

function formatSemitoneShift(semitones: number) {
  return `Shift ${semitones > 0 ? "+" : ""}${semitones} semitone${Math.abs(semitones) === 1 ? "" : "s"}`;
}

function artifactSummary(artifact: ArtifactSchema) {
  if (artifact.type === "source_audio") {
    return "Original source file";
  }
  if (artifact.type === "vocal_stem" || artifact.type === "instrumental_stem") {
    const engine = typeof artifact.metadata?.engine === "string" ? artifact.metadata.engine : null;
    const mode = typeof artifact.metadata?.mode === "string" ? artifact.metadata.mode : null;
    return [artifact.type === "vocal_stem" ? "Vocal stem" : "Instrumental stem", mode, engine].filter(Boolean).join(" · ");
  }

  const metadata = artifact.metadata ?? {};
  const pieces: string[] = [];
  const transpose = metadata.transpose;
  if (
    transpose &&
    typeof transpose === "object" &&
    "semitones" in transpose &&
    typeof transpose.semitones === "number"
  ) {
    const semitones = transpose.semitones;
    pieces.push(formatSemitoneShift(semitones));
  }

  const retune = metadata.retune;
  if (retune && typeof retune === "object") {
    if ("target_reference_hz" in retune && typeof retune.target_reference_hz === "number") {
      pieces.push(`Retuned to ${retune.target_reference_hz.toFixed(1)} Hz`);
    } else if ("target_cents_offset" in retune && typeof retune.target_cents_offset === "number") {
      const cents = retune.target_cents_offset;
      pieces.push(`Retuned ${cents > 0 ? "+" : ""}${cents.toFixed(1)} cents`);
    }
  }

  return pieces.join(" · ");
}

export function ProjectView() {
  const { projectId = "" } = useParams();
  const queryClient = useQueryClient();
  const [retuneMode, setRetuneMode] = useState<"off" | "reference" | "cents">("off");
  const [referenceHz, setReferenceHz] = useState("440");
  const [centsOffset, setCentsOffset] = useState("0");
  const [manualSourceKey, setManualSourceKey] = useState<MusicalKey | null>(null);
  const [targetKeyState, setTargetKeyState] = useState<MusicalKey | null>(null);
  const [targetDirty, setTargetDirty] = useState(false);
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const [followLatestPreview, setFollowLatestPreview] = useState(true);
  const [isRenaming, setIsRenaming] = useState(false);
  const [draftName, setDraftName] = useState("");

  const projectQuery = useQuery({
    queryKey: ["project", projectId],
    queryFn: async () => (await api.getProject(projectId)).project,
    enabled: Boolean(projectId),
  });
  const analysisQuery = useQuery({
    queryKey: ["analysis", projectId],
    queryFn: async () => (await api.getAnalysis(projectId)).analysis,
    enabled: Boolean(projectId),
  });
  const artifactsQuery = useQuery({
    queryKey: ["artifacts", projectId],
    queryFn: async () => (await api.listArtifacts(projectId)).artifacts,
    enabled: Boolean(projectId),
  });
  const jobsQuery = useQuery({
    queryKey: ["jobs"],
    queryFn: async () => (await api.listJobs()).jobs,
  });

  useActiveJobPolling(projectId, jobsQuery.data);

  const analyzeMutation = useMutation({
    mutationFn: () => api.analyzeProject(projectId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
  });

  const renameMutation = useMutation({
    mutationFn: async () => api.updateProject(projectId, { display_name: draftName }),
    onSuccess: async () => {
      setIsRenaming(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["project", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["projects"] }),
      ]);
    },
  });

  const previewMutation = useMutation({
    mutationFn: async () => {
      if (retuneMode === "off" && transposeSemitones === 0) {
        throw new Error("Choose a tuning or key change first.");
      }

      setFollowLatestPreview(true);

      return api.createPreview(projectId, {
        output_format: "wav",
        retune:
          retuneMode === "reference"
            ? { target_reference_hz: Number(referenceHz) }
            : retuneMode === "cents"
              ? { target_cents_offset: Number(centsOffset) }
              : undefined,
        transpose: transposeSemitones !== 0 ? { semitones: transposeSemitones } : undefined,
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
  });

  const stemMutation = useMutation({
    mutationFn: async () => {
      setFollowLatestPreview(false);
      return api.createStems(projectId, {
        mode: "two_stem",
        output_format: "wav",
        force: false,
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
  });

  const exportMutation = useMutation({
    mutationFn: async () => {
      const exportArtifact =
        selectedArtifact ??
        artifactsQuery.data?.find((artifact) => artifact.type === "preview_mix") ??
        artifactsQuery.data?.find((artifact) => artifact.type === "source_audio");
      if (!exportArtifact) {
        throw new Error("Nothing available to export yet.");
      }
      const suggestedFormat = exportArtifact.format;
      const exportTarget = await save({
        defaultPath: `${projectQuery.data?.display_name ?? artifactLabel(exportArtifact)}.${suggestedFormat}`,
      });
      const destinationPath = exportTarget ? exportTarget.slice(0, exportTarget.lastIndexOf("/")) : undefined;
      const extension = exportTarget?.split(".").pop()?.toLowerCase();
      return api.createExport(projectId, {
        artifact_ids: [exportArtifact.id],
        mixdown_mode: "copy",
        output_format: extension === "mp3" || extension === "flac" ? extension : "wav",
        destination_path: destinationPath,
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteProject(projectId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      window.location.hash = "#/";
    },
  });

  const projectJobs = useMemo(
    () => jobsQuery.data?.filter((job) => job.project_id === projectId) ?? [],
    [jobsQuery.data, projectId],
  );
  const analyzeJob = projectJobs.find((job) => job.type === "analyze");
  const stemJob = projectJobs.find((job) => job.type === "stems");
  const visibleArtifacts = useMemo(() => {
    const artifacts = artifactsQuery.data ?? [];
    const source = artifacts.find((artifact) => artifact.type === "source_audio");
    const preview = artifacts.find((artifact) => artifact.type === "preview_mix");
    const vocalStem = artifacts.find((artifact) => artifact.type === "vocal_stem");
    const instrumentalStem = artifacts.find((artifact) => artifact.type === "instrumental_stem");
    const analysisJson = artifacts.find((artifact) => artifact.type === "analysis_json");
    const exports = artifacts.filter((artifact) => artifact.type === "export_mix");
    return [preview, vocalStem, instrumentalStem, ...exports, analysisJson, source].filter(Boolean) as ArtifactSchema[];
  }, [artifactsQuery.data]);
  const playableArtifacts = useMemo(
    () => visibleArtifacts.filter((artifact) => isPlayableArtifact(artifact)),
    [visibleArtifacts],
  );
  const selectedArtifact = playableArtifacts.find((artifact) => artifact.id === selectedArtifactId) ?? null;
  const detectedKey = parseKey(analysisQuery.data?.estimated_key);
  const sourceKey = manualSourceKey ?? detectedKey ?? DEFAULT_KEY;
  const targetKey = targetDirty ? targetKeyState ?? sourceKey : sourceKey;
  const transposeSemitones = semitoneDelta(sourceKey, targetKey);
  const targetKeyOptions = MUSICAL_KEYS.filter((key) => key.mode === sourceKey.mode);
  const hasTransformChange = retuneMode !== "off" || transposeSemitones !== 0;
  const isAnalysisRunning = Boolean(analyzeJob && ["pending", "running"].includes(analyzeJob.status));
  const isStemRunning = Boolean(stemJob && ["pending", "running"].includes(stemJob.status));
  const currentKeyValue = manualSourceKey
    ? serializeKey(manualSourceKey)
    : detectedKey
      ? "auto"
      : serializeKey(sourceKey);
  const selectedArtifactSummary = selectedArtifact ? artifactSummary(selectedArtifact) : "";

  useEffect(() => {
    if (!projectQuery.data || analysisQuery.isLoading || analysisQuery.data || analyzeMutation.isPending) {
      return;
    }
    const hasAttemptedAnalysis = projectJobs.some((job) => job.type === "analyze");
    if (hasAttemptedAnalysis) {
      return;
    }
    analyzeMutation.mutate();
  }, [
    analyzeMutation,
    analysisQuery.data,
    analysisQuery.isLoading,
    projectJobs,
    projectQuery.data,
  ]);

  useEffect(() => {
    if (!isRenaming) {
      setDraftName(projectQuery.data?.display_name ?? "");
    }
  }, [isRenaming, projectQuery.data?.display_name]);

  useEffect(() => {
    if (!playableArtifacts.length) {
      setSelectedArtifactId(null);
      return;
    }

    const currentArtifact = playableArtifacts.find((artifact) => artifact.id === selectedArtifactId) ?? null;
    if (!currentArtifact) {
      setSelectedArtifactId(preferredArtifactSelection(playableArtifacts)?.id ?? null);
      return;
    }

    if (followLatestPreview) {
      const latestPreview = playableArtifacts.find((artifact) => artifact.type === "preview_mix");
      if (latestPreview && latestPreview.id !== currentArtifact.id) {
        setSelectedArtifactId(latestPreview.id);
      }
    }
  }, [followLatestPreview, playableArtifacts, selectedArtifactId]);

  return (
    <section className="screen">
      <div className="screen__header">
        <div className="screen__title-block">
          <p className="eyebrow">
            <Link to="/">Library</Link> / Project
          </p>
          {isRenaming ? (
            <div className="title-edit">
              <input
                aria-label="Project name"
                className="title-input"
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
              />
              <div className="button-row">
                <button
                  className="button button--primary button--small"
                  type="button"
                  onClick={() => renameMutation.mutate()}
                  disabled={renameMutation.isPending || !draftName.trim()}
                >
                  {renameMutation.isPending ? "Saving…" : "Save"}
                </button>
                <button
                  className="button button--ghost button--small"
                  type="button"
                  onClick={() => {
                    setIsRenaming(false);
                    setDraftName(projectQuery.data?.display_name ?? "");
                  }}
                  disabled={renameMutation.isPending}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="title-row">
              <h1>{projectQuery.data?.display_name ?? "Project"}</h1>
              <button className="button button--ghost button--small" type="button" onClick={() => setIsRenaming(true)}>
                Rename
              </button>
            </div>
          )}
          <p className="screen__subtitle">
            Build a practice mix by setting tuning and target key, then export the current preview.
          </p>
        </div>

        <div className="button-row">
          <button
            className="button button--primary"
            onClick={() => previewMutation.mutate()}
            disabled={previewMutation.isPending || !hasTransformChange}
          >
            {previewMutation.isPending ? "Queueing…" : "Update Preview"}
          </button>
          <button className="button" onClick={() => stemMutation.mutate()} disabled={stemMutation.isPending || isStemRunning}>
            {stemMutation.isPending || isStemRunning ? "Generating…" : "Generate Stems"}
          </button>
          <button className="button" onClick={() => exportMutation.mutate()} disabled={exportMutation.isPending}>
            {exportMutation.isPending ? "Queueing…" : "Export"}
          </button>
          <button className="button button--ghost" onClick={() => deleteMutation.mutate()} disabled={deleteMutation.isPending}>
            Delete Project
          </button>
        </div>
      </div>

      <div className="layout-grid">
        <div className="stack">
          <div className="panel">
            <h2>Track Metadata</h2>
            <dl className="meta-grid">
              <div>
                <dt>Duration</dt>
                <dd>{projectQuery.data?.duration_seconds?.toFixed(2) ?? "Unknown"} s</dd>
              </div>
              <div>
                <dt>Sample Rate</dt>
                <dd>{projectQuery.data?.sample_rate ?? "Unknown"} Hz</dd>
              </div>
              <div>
                <dt>Channels</dt>
                <dd>{projectQuery.data?.channels ?? "Unknown"}</dd>
              </div>
            </dl>

            <details className="details-block">
              <summary>Show file details</summary>
              <dl className="details-grid">
                <div>
                  <dt>Imported Path</dt>
                  <dd className="path">{projectQuery.data?.imported_path ?? "Unknown"}</dd>
                </div>
                <div>
                  <dt>Original Source</dt>
                  <dd className="path">{projectQuery.data?.source_path ?? "Unknown"}</dd>
                </div>
              </dl>
            </details>
          </div>

          <div className="panel">
            <h2>Analysis</h2>
            {isAnalysisRunning ? <p className="setting-copy">Analyzing source track…</p> : null}
            <div className="analysis-grid">
              <div>
                <span className="metric-label">Detected Tuning</span>
                <strong>{analysisQuery.data?.estimated_reference_hz?.toFixed(2) ?? "Pending"} Hz</strong>
              </div>
              <div>
                <span className="metric-label">Offset from A440</span>
                <strong>{analysisQuery.data?.tuning_offset_cents?.toFixed(2) ?? "—"} cents</strong>
              </div>
              <div>
                <span className="metric-label">Estimated Key</span>
                <strong>{detectedKey ? formatKey(detectedKey) : isAnalysisRunning ? "Analyzing…" : "Unknown"}</strong>
              </div>
              <div>
                <span className="metric-label">Confidence</span>
                <strong>{analysisQuery.data?.key_confidence?.toFixed(2) ?? "—"}</strong>
              </div>
            </div>
          </div>

          <div className="panel">
            <h2>Transform Controls</h2>
            <div className="section-stack">
              <div className="subpanel">
                <div className="subpanel__header">
                  <h3>Tuning</h3>
                  <p className="subpanel__copy">Optional fine-tuning independent from key changes.</p>
                </div>
                <div className="controls">
                  <label>
                    Retune
                    <select
                      aria-label="Retune"
                      value={retuneMode}
                      onChange={(event) => setRetuneMode(event.target.value as "off" | "reference" | "cents")}
                    >
                      <option value="off">Off</option>
                      <option value="reference">Target Reference Hz</option>
                      <option value="cents">Direct Cents Offset</option>
                    </select>
                  </label>

                  {retuneMode === "reference" ? (
                    <label>
                      Target Reference Hz
                      <input
                        aria-label="Target Reference Hz"
                        value={referenceHz}
                        onChange={(event) => setReferenceHz(event.target.value)}
                        type="number"
                        step="0.1"
                      />
                    </label>
                  ) : null}

                  {retuneMode === "cents" ? (
                    <label>
                      Cents Offset
                      <input
                        aria-label="Cents Offset"
                        value={centsOffset}
                        onChange={(event) => setCentsOffset(event.target.value)}
                        type="number"
                        step="0.1"
                      />
                    </label>
                  ) : null}
                </div>
              </div>

              <div className="subpanel">
                <div className="subpanel__header">
                  <h3>Key Change</h3>
                  <p className="subpanel__copy">Shift the song by musical key instead of raw semitones.</p>
                </div>

                <div className="key-shift key-shift--compact">
                  <div className="key-shift__header">
                    <div>
                      <span className="metric-label">Source Key</span>
                      <strong>{formatKey(sourceKey)}</strong>
                      <small className="artifact-meta">
                        {manualSourceKey
                          ? "Using manual source key"
                          : detectedKey
                            ? "Detected automatically"
                            : "Set manually if the analysis is wrong"}
                      </small>
                    </div>
                    <div>
                      <span className="metric-label">Target Key</span>
                      <strong>{formatKey(targetKey)}</strong>
                    </div>
                    <span className="key-shift__meta">{formatSemitoneShift(transposeSemitones)}</span>
                  </div>

                  <div className="key-stepper">
                    <button
                      className="button"
                      aria-label="Lower target key"
                      onClick={() => {
                        setTargetDirty(true);
                        setTargetKeyState((current) => transposeKey(current ?? sourceKey, -1));
                      }}
                      type="button"
                    >
                      -
                    </button>
                    <label className="key-stepper__value">
                      <span className="key-stepper__label">Target Key</span>
                      <select
                        aria-label="Target Key"
                        value={serializeKey(targetKey)}
                        onChange={(event) => {
                          setTargetDirty(true);
                          setTargetKeyState(deserializeKey(event.target.value));
                        }}
                      >
                        {targetKeyOptions.map((key) => (
                          <option key={key.value} value={key.value}>
                            {key.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      className="button"
                      aria-label="Raise target key"
                      onClick={() => {
                        setTargetDirty(true);
                        setTargetKeyState((current) => transposeKey(current ?? sourceKey, 1));
                      }}
                      type="button"
                    >
                      +
                    </button>
                  </div>

                  <details className="details-block details-block--inset">
                    <summary>Correct source key if detection is wrong</summary>
                    <div className="controls controls--tight">
                      <label>
                        Source Key
                        <select
                          aria-label="Current Key"
                          value={currentKeyValue}
                          onChange={(event) =>
                            setManualSourceKey(event.target.value === "auto" ? null : deserializeKey(event.target.value))
                          }
                        >
                          {detectedKey ? <option value="auto">Use detected key ({formatKey(detectedKey)})</option> : null}
                          {MUSICAL_KEYS.map((key) => (
                            <option key={key.value} value={key.value}>
                              {key.label}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <p className="setting-copy">
                      This does not change the audio by itself. It only changes how the target key is calculated.
                    </p>
                  </details>
                </div>
              </div>
            </div>

            {previewMutation.isError ? (
              <p className="inline-error">
                {previewMutation.error instanceof Error ? previewMutation.error.message : "Could not create preview."}
              </p>
            ) : null}
          </div>
        </div>

        <div className="stack">
          <div className="panel">
            <h2>Playback</h2>
            {selectedArtifact ? (
              <>
                <div className="artifact-selector">
                  {playableArtifacts.map((artifact) => (
                    <button
                      key={artifact.id}
                      className={`chip${selectedArtifactId === artifact.id ? " chip--active" : ""}`}
                      onClick={() => {
                        setSelectedArtifactId(artifact.id);
                        setFollowLatestPreview(artifact.type === "preview_mix");
                      }}
                      type="button"
                    >
                      {artifactLabel(artifact)}
                    </button>
                  ))}
                </div>
                <audio controls src={api.streamArtifactUrl(selectedArtifact.id)} className="player" />
                <p className="artifact-meta">
                  {artifactLabel(selectedArtifact)} · {selectedArtifact.format.toUpperCase()}
                </p>
                {selectedArtifactSummary ? <p className="artifact-meta">{selectedArtifactSummary}</p> : null}
              </>
            ) : (
              <p>No preview yet. Set a tuning or target key, then update the preview.</p>
            )}
            {isStemRunning ? <p className="setting-copy">Generating vocal and instrumental stems…</p> : null}
          </div>

          <div className="panel">
            <h2>Artifacts</h2>
            <ul className="artifact-list">
              {visibleArtifacts.length ? (
                visibleArtifacts.map((artifact) => (
                  <li key={artifact.id}>
                    <span>{artifactLabel(artifact)}</span>
                    <small>{artifact.format.toUpperCase()}</small>
                    {artifactSummary(artifact) ? <small>{artifactSummary(artifact)}</small> : null}
                  </li>
                ))
              ) : (
                <li>No artifacts yet.</li>
              )}
            </ul>
          </div>

          <div className="panel">
            <h2>Jobs</h2>
            <ul className="job-list">
              {projectJobs.length ? (
                projectJobs.map((job) => (
                  <li key={job.id}>
                    <div>
                      <strong>{job.type}</strong>
                      <span>{job.status}</span>
                    </div>
                    <progress max={100} value={job.progress} />
                    {["pending", "running"].includes(job.status) ? (
                      <button className="button button--ghost button--small" onClick={() => api.cancelJob(job.id)} type="button">
                        Cancel
                      </button>
                    ) : null}
                    {job.error_message ? <small className="inline-error">{job.error_message}</small> : null}
                  </li>
                ))
              ) : (
                <li>No jobs yet.</li>
              )}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}
