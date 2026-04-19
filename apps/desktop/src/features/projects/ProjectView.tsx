import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
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
  if (artifact.type === "source_audio") return "Source Track";
  if (artifact.type === "preview_mix") return "Practice Mix";
  if (artifact.type === "export_mix") return "Export File";
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

function formatArtifactTimestamp(createdAt: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(createdAt));
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

function sourceArtifactIdForStems(artifact: ArtifactSchema | null) {
  if (!artifact) return null;
  if (artifact.type === "vocal_stem" || artifact.type === "instrumental_stem") {
    const sourceArtifactId = artifact.metadata?.source_artifact_id;
    return typeof sourceArtifactId === "string" ? sourceArtifactId : null;
  }
  if (artifact.type === "source_audio" || artifact.type === "preview_mix") {
    return artifact.id;
  }
  return null;
}

function buildRequestedRetune(
  retuneMode: "off" | "reference" | "cents",
  referenceHz: string,
  centsOffset: string,
) {
  if (retuneMode === "reference") {
    const parsed = Number(referenceHz);
    return Number.isFinite(parsed) ? { target_reference_hz: parsed } : null;
  }
  if (retuneMode === "cents") {
    const parsed = Number(centsOffset);
    return Number.isFinite(parsed) ? { target_cents_offset: parsed } : null;
  }
  return null;
}

function matchesPreviewSettings(
  artifact: ArtifactSchema | null,
  requestedRetune: { target_reference_hz: number } | { target_cents_offset: number } | null,
  transposeSemitones: number,
) {
  if (!artifact || artifact.type !== "preview_mix") {
    return false;
  }

  const metadata = artifact.metadata ?? {};
  const retune = typeof metadata.retune === "object" && metadata.retune !== null ? metadata.retune : {};
  const transpose =
    typeof metadata.transpose === "object" && metadata.transpose !== null ? metadata.transpose : {};

  const requestedReferenceHz =
    requestedRetune && "target_reference_hz" in requestedRetune ? requestedRetune.target_reference_hz : null;
  const requestedCents =
    requestedRetune && "target_cents_offset" in requestedRetune ? requestedRetune.target_cents_offset : null;
  const artifactReferenceHz =
    "target_reference_hz" in retune && typeof retune.target_reference_hz === "number" ? retune.target_reference_hz : null;
  const artifactCents =
    "target_cents_offset" in retune && typeof retune.target_cents_offset === "number" ? retune.target_cents_offset : null;
  const artifactSemitones =
    "semitones" in transpose && typeof transpose.semitones === "number" ? transpose.semitones : 0;

  return (
    artifactSemitones === transposeSemitones &&
    artifactReferenceHz === requestedReferenceHz &&
    artifactCents === requestedCents
  );
}

function formatRetuneSummary(
  retuneMode: "off" | "reference" | "cents",
  referenceHz: string,
  centsOffset: string,
) {
  if (retuneMode === "off") {
    return "No fine retune applied";
  }
  if (retuneMode === "reference") {
    return `Retuned to ${referenceHz} Hz`;
  }
  return `Retuned ${Number(centsOffset) > 0 ? "+" : ""}${centsOffset} cents`;
}

export function ProjectView() {
  const { projectId = "" } = useParams();
  const navigate = useNavigate();
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
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["jobs"] }),
        queryClient.invalidateQueries({ queryKey: ["artifacts", projectId] }),
      ]);
    },
  });

  const stemMutation = useMutation({
    mutationFn: async () => {
      const sourceArtifactId = sourceArtifactIdForStems(selectedArtifact);
      if (!sourceArtifactId) {
        throw new Error("Select source audio or practice mix first.");
      }
      setFollowLatestPreview(false);
      return api.createStems(projectId, {
        mode: "two_stem",
        output_format: "wav",
        force: hasVisibleStems,
        source_artifact_id: sourceArtifactId,
      });
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["jobs"] }),
        queryClient.invalidateQueries({ queryKey: ["artifacts", projectId] }),
      ]);
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
      navigate("/");
    },
  });

  const projectJobs = useMemo(
    () => jobsQuery.data?.filter((job) => job.project_id === projectId) ?? [],
    [jobsQuery.data, projectId],
  );
  const analyzeJob = projectJobs.find((job) => job.type === "analyze");
  const stemJob = projectJobs.find((job) => job.type === "stems");
  const displayArtifacts = useMemo(() => {
    const artifacts = artifactsQuery.data ?? [];
    const source = artifacts.find((artifact) => artifact.type === "source_audio");
    const previews = artifacts.filter((artifact) => artifact.type === "preview_mix");
    const stems = artifacts.filter((artifact) => artifact.type === "vocal_stem" || artifact.type === "instrumental_stem");
    const analysisJson = artifacts.find((artifact) => artifact.type === "analysis_json");
    const exports = artifacts.filter((artifact) => artifact.type === "export_mix");
    return [...previews, ...stems, ...exports, analysisJson, source].filter(Boolean) as ArtifactSchema[];
  }, [artifactsQuery.data]);
  const mixArtifacts = useMemo(
    () => displayArtifacts.filter((artifact) => artifact.type === "preview_mix" || artifact.type === "source_audio"),
    [displayArtifacts],
  );
  const stemArtifacts = useMemo(
    () => displayArtifacts.filter((artifact) => artifact.type === "vocal_stem" || artifact.type === "instrumental_stem"),
    [displayArtifacts],
  );
  const selectableArtifacts = useMemo(
    () => [...mixArtifacts, ...stemArtifacts].filter((artifact) => isPlayableArtifact(artifact)),
    [mixArtifacts, stemArtifacts],
  );
  const selectedArtifact = selectableArtifacts.find((artifact) => artifact.id === selectedArtifactId) ?? null;
  const selectedStemSourceArtifactId = sourceArtifactIdForStems(selectedArtifact);
  const visibleStemArtifacts = useMemo(
    () =>
      stemArtifacts.filter((artifact) => {
        const sourceArtifactId = artifact.metadata?.source_artifact_id;
        return typeof sourceArtifactId === "string" && sourceArtifactId === selectedStemSourceArtifactId;
      }),
    [selectedStemSourceArtifactId, stemArtifacts],
  );
  const detectedKey = parseKey(analysisQuery.data?.estimated_key);
  const sourceKey = manualSourceKey ?? detectedKey ?? DEFAULT_KEY;
  const targetKey = targetDirty ? targetKeyState ?? sourceKey : sourceKey;
  const transposeSemitones = semitoneDelta(sourceKey, targetKey);
  const targetKeyOptions = MUSICAL_KEYS.filter((key) => key.mode === sourceKey.mode);
  const requestedRetune = buildRequestedRetune(retuneMode, referenceHz, centsOffset);
  const hasTransformChange = retuneMode !== "off" || transposeSemitones !== 0;
  const isAnalysisRunning = Boolean(analyzeJob && ["pending", "running"].includes(analyzeJob.status));
  const isStemRunning = Boolean(stemJob && ["pending", "running"].includes(stemJob.status));
  const currentKeyValue = manualSourceKey
    ? serializeKey(manualSourceKey)
    : detectedKey
      ? "auto"
      : serializeKey(sourceKey);
  const selectedArtifactSummary = selectedArtifact ? artifactSummary(selectedArtifact) : "";
  const latestPreviewArtifact = displayArtifacts.find((artifact) => artifact.type === "preview_mix") ?? null;
  const previewMatchesCurrentSettings = matchesPreviewSettings(latestPreviewArtifact, requestedRetune, transposeSemitones);
  const isStemSelected = selectedArtifact ? ["vocal_stem", "instrumental_stem"].includes(selectedArtifact.type) : false;
  const canGenerateStems = Boolean(selectedStemSourceArtifactId);
  const hasVisibleStems = visibleStemArtifacts.length > 0;
  const selectedArtifactMatchesCurrentSettings =
    (selectedArtifact?.type === "source_audio" && !hasTransformChange) ||
    matchesPreviewSettings(selectedArtifact, requestedRetune, transposeSemitones);
  const visibleJobs = useMemo(() => projectJobs.filter((job) => job.type !== "stems"), [projectJobs]);
  const recentJobs = visibleJobs.slice(0, 3);
  const selectedMixTitle = selectedArtifact ? artifactLabel(selectedArtifact) : "None selected";
  const selectedMixSummary = selectedArtifact
    ? selectedArtifactSummary || (selectedArtifact.type === "source_audio" ? "Original source file" : "Saved practice mix")
    : "Choose a saved mix to play.";
  const controlSummary = hasTransformChange ? formatKey(targetKey) : "Original key";
  const tuningSummary = formatRetuneSummary(retuneMode, referenceHz, centsOffset);
  const mixStatus = !hasTransformChange
    ? latestPreviewArtifact
      ? "Using source settings"
      : "Source only"
    : !latestPreviewArtifact
      ? "No preview yet"
      : previewMatchesCurrentSettings
        ? "Up to date"
        : "Needs update";
  const mixStatusCopy = isStemSelected
    ? "Stem tracks are independent from mix controls."
    : selectedArtifact
    ? selectedArtifactMatchesCurrentSettings
      ? "Selected mix matches current controls."
      : !hasTransformChange
        ? "Selected mix differs from current source controls."
        : "Controls differ from selected mix. Create new mix if you want to save them."
    : "Select a mix to compare it with current controls.";

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
    if (!selectableArtifacts.length) {
      setSelectedArtifactId(null);
      return;
    }

    const currentArtifact = selectableArtifacts.find((artifact) => artifact.id === selectedArtifactId) ?? null;
    if (!currentArtifact) {
      setSelectedArtifactId(preferredArtifactSelection(selectableArtifacts)?.id ?? null);
      return;
    }

    if (followLatestPreview) {
      const latestPreview = selectableArtifacts.find((artifact) => artifact.type === "preview_mix");
      if (latestPreview && latestPreview.id !== currentArtifact.id) {
        setSelectedArtifactId(latestPreview.id);
      }
    }
  }, [followLatestPreview, selectableArtifacts, selectedArtifactId]);

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
            Keep alternate practice mixes ready to play, compare, and revisit inside the project.
          </p>
        </div>

        <div className="button-row">
          <button
            className="button button--primary"
            onClick={() => previewMutation.mutate()}
            disabled={previewMutation.isPending || !hasTransformChange}
          >
            {previewMutation.isPending ? "Queueing…" : "Create Mix"}
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
            <h2>Saved Mixes</h2>
            {selectedArtifact ? (
              <>
                <div className="playback-focus">
                  <div>
                    <p className="metric-label">Now Playing</p>
                    <h3>{artifactLabel(selectedArtifact)}</h3>
                  </div>
                  <div className="playback-focus__meta">
                    <span>{selectedArtifact.format.toUpperCase()}</span>
                    <span>{formatArtifactTimestamp(selectedArtifact.created_at)}</span>
                  </div>
                </div>
                {selectedArtifactSummary ? <p className="artifact-meta">{selectedArtifactSummary}</p> : null}
                <div className="artifact-selector artifact-selector--stacked" role="group" aria-label="Saved mix list">
                  {mixArtifacts.map((artifact) => (
                    <button
                      key={artifact.id}
                      className={`artifact-pill${selectedArtifactId === artifact.id ? " artifact-pill--active" : ""}`}
                      onClick={() => {
                        setSelectedArtifactId(artifact.id);
                        setFollowLatestPreview(false);
                      }}
                      type="button"
                    >
                      <span className="artifact-pill__title">{artifactLabel(artifact)}</span>
                      <span className="artifact-pill__meta">
                        {artifactSummary(artifact) || formatArtifactTimestamp(artifact.created_at)}
                      </span>
                    </button>
                  ))}
                </div>
                <div className="subpanel subpanel--compact">
                  <div className="subpanel__header">
                    <h3>Stem Tracks</h3>
                    <p className="subpanel__copy">Generate vocal and instrumental tracks for focused practice.</p>
                  </div>
                  <div className="button-row">
                    <button
                      className="button"
                      onClick={() => stemMutation.mutate()}
                      disabled={stemMutation.isPending || isStemRunning || !canGenerateStems}
                    >
                      {stemMutation.isPending || isStemRunning ? "Generating…" : hasVisibleStems ? "Refresh Stems" : "Generate Stems"}
                    </button>
                  </div>
                  {visibleStemArtifacts.length ? (
                    <div className="artifact-selector artifact-selector--stacked" role="group" aria-label="Stem track list">
                      {visibleStemArtifacts.map((artifact) => (
                        <button
                          key={artifact.id}
                          className={`artifact-pill${selectedArtifactId === artifact.id ? " artifact-pill--active" : ""}`}
                          onClick={() => {
                            setSelectedArtifactId(artifact.id);
                            setFollowLatestPreview(false);
                          }}
                          type="button"
                        >
                          <span className="artifact-pill__title">{artifactLabel(artifact)}</span>
                          <span className="artifact-pill__meta">
                            {artifactSummary(artifact) || formatArtifactTimestamp(artifact.created_at)}
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="artifact-meta">
                      {canGenerateStems ? "No stems yet for selected audio." : "Select source audio or practice mix first."}
                    </p>
                  )}
                </div>
                <audio controls src={api.streamArtifactUrl(selectedArtifact.id)} className="player" />
              </>
            ) : (
              <p>No practice mix yet. Set a tuning or target key, then create one.</p>
            )}
          </div>

          <div className="panel">
            <h2>Current Selection</h2>
            <div className="session-block">
              <div role="group" aria-label="Selected mix summary">
                <p className="metric-label">Selected Audio</p>
                <strong>{selectedMixTitle}</strong>
                <p className="artifact-meta">{selectedMixSummary}</p>
              </div>
              <div role="group" aria-label="Current control summary">
                <p className="metric-label">Current Mix Controls</p>
                <strong>{controlSummary}</strong>
                <p className="artifact-meta">{tuningSummary}</p>
              </div>
              <div role="group" aria-label="Mix status summary">
                <p className="metric-label">Selection Status</p>
                <strong>{mixStatus}</strong>
                <p className="artifact-meta">{mixStatusCopy}</p>
              </div>
              <div role="group" aria-label="Recent processing summary">
                <p className="metric-label">Recent Processing</p>
                {recentJobs.length ? (
                  <ul className="session-jobs">
                    {recentJobs.map((job) => (
                      <li key={job.id}>
                        <span>{job.type}</span>
                        <small>{job.status}</small>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="artifact-meta">No processing jobs yet.</p>
                )}
              </div>
            </div>

            <details className="details-block">
              <summary>Export and file details</summary>
              <div className="details-stack">
                <div className="subpanel subpanel--compact">
                  <div className="subpanel__header">
                    <h3>Export</h3>
                    <p className="subpanel__copy">Use this only when you need a file outside the app.</p>
                  </div>
                  <button className="button" onClick={() => exportMutation.mutate()} disabled={exportMutation.isPending}>
                    {exportMutation.isPending ? "Queueing…" : "Export Selected Audio"}
                  </button>
                </div>
              </div>
            </details>

            <details className="details-block">
              <summary>Show raw artifacts and processing history</summary>
              <div className="details-stack">
                <ul className="artifact-list">
                  {displayArtifacts.length ? (
                    displayArtifacts.map((artifact) => (
                      <li key={artifact.id}>
                        <span>{artifactLabel(artifact)}</span>
                        <small>{artifact.format.toUpperCase()}</small>
                        <small>{formatArtifactTimestamp(artifact.created_at)}</small>
                        {artifactSummary(artifact) ? <small>{artifactSummary(artifact)}</small> : null}
                      </li>
                    ))
                  ) : (
                    <li>No artifacts yet.</li>
                  )}
                </ul>

                <ul className="job-list">
                  {visibleJobs.length ? (
                    visibleJobs.map((job) => (
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
            </details>
          </div>
        </div>
      </div>
    </section>
  );
}
