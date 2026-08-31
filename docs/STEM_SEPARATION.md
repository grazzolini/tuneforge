# Stem separation behavior

TuneForge runs stem separation through local Demucs. This document captures current
runtime behavior and security boundaries for model loading.

## Demucs usage path

- Backend service exposes two APIs for stems:
  - `GET /api/v1/stem-models` lists supported models + availability.
  - `POST /api/v1/projects/{project_id}/stems` starts stem generation.
- Backend services route to `app/services/stems.py` and execute Demucs through
  `app/engines/stems.py`.
- Demucs execution runs as a spawned Python module:
  - `app/engines/demucs_worker.py` for both 6-stem and 2-stem modes.
  - 6-stem path writes each requested source file with `--stem source=path`.
  - 2-stem path writes `vocals` and `instrumental` from summed accompaniment.
- Stem artifacts are stored with metadata `source_artifact_id`, `stem_model`,
  `stem_model_label`, and `stem_source` for each generated file.

## Model loading modes and integrity boundary

TuneForge supports three ordered Demucs sources. All use the same immutable repository
commits and exact YAML+safetensors file metadata from `packaging/demucs/models.json`:

1. `TUNEFORGE_DEMUCS_MODEL_REPO`, when configured.
2. A validated `TUNEFORGE_MODEL_BUNDLE_DIR/demucs` directory.
3. The standard Hugging Face Hub cache/download path: `HF_HUB_CACHE`, legacy
   `HUGGINGFACE_HUB_CACHE`, `HF_HOME/hub`, `XDG_CACHE_HOME/huggingface/hub`, then
   `~/.cache/huggingface/hub`.

`pnpm setup:dev` verifies both supported model bags by size and SHA-256 and downloads only
missing or individually corrupt files. A verified warm cache performs no network download.
If setup prewarm is skipped, the first stem job performs the same pinned download and later
runs reuse it. Public repositories do not require `HF_TOKEN`. `TUNEFORGE_DATA_DIR` does not
control the upstream Demucs, Whisper, or beat-this caches.

Explicit local repositories use this layout:

```text
<repo>/<model-id>/<pinned-revision>/<yaml-and-safetensors>
```

Create one with `pnpm models:demucs:prepare`. Runtime validates every required file against
the canonical manifest before loading, and never falls back to the network when an explicit
repo is invalid. Existing `.th` caches are left untouched but ignored; legacy `.th` repos and
model bundles fail with guidance to recreate them using current TuneForge.

An explicit `--model-bundle` packages Demucs as
`demucs/<model-id>/<revision>/<yaml-and-safetensors>`. Startup validates its v2 manifest and
files, and inference loads those resources directly without copying or synthesizing a Hugging
Face cache. Version 1 bundles remain compatible only when their Torch checkpoint list contains
no legacy Demucs entries. Default release package commands still exclude external Demucs model
weights unless `--model-bundle` is explicitly selected.

The worker constructs each bag with `demucs.hf.load_safetensors_model` and `BagOfModels` in
the manifest's pinned order. No trusted pickle checkpoint loader or FBAI fallback is used.
Treat writable local repos and bundles as integrity-sensitive generated artifacts even though
safetensors removes the legacy pickle execution path.

## 2-stem vs 6-stem model behavior

Model ID and label mapping:

- `Default (6 stems model)` → `htdemucs_6s`
- `2 stems model` → `htdemucs_ft`

Artifact output mapping:

- `htdemucs_6s` creates:
  - `vocal_stem` (`vocals.wav`)
  - `drums_stem` (`drums.wav`)
  - `bass_stem` (`bass.wav`)
  - `guitar_stem` (`guitar.wav`)
  - `piano_stem` (`piano.wav`)
  - `other_stem` (`other.wav`)
- `htdemucs_ft` creates:
  - `vocal_stem` (`vocals.wav`)
  - `instrumental_stem` (`instrumental.wav`)

Artifacts are generated per source + selected model. Regenerating the same model
replaces current files and removes stale paths. Switching models and rebuilding
prunes stale stems for the same source so the UI does not keep mixed model output
sets.

## Chord refresh hidden non-vocal mix

- Some chord backends request a source accompaniment stem for augmentation.
- Backend tries `instrumental_stem` first.
- If no full instrumental exists, backend falls back to a temporary mix from:
  `drums`, `bass`, `guitar`, `piano`, `other` stems.
- That mixed stem is a temporary file used only for chord detection
  (not saved as a new visible artifact).

## Backend hash storage

Migration `0012_backend_hash_storage` adds file hash columns:

- `projects.source_sha256`
- `artifacts.content_sha256`

These hashes are persisted during registration/ingest and artifact refresh.
They support reproducibility checks and auditability of source/project files and
generated artifacts.

Stem-specific uniqueness includes `source_artifact_id` and `stem_model` as part of
the artifact identity, so separate 2-stem and 6-stem outputs do not collide for
the same source artifact.

## Frontend model setting and delete behavior

- Model choice lives in UI preferences (`defaultStemModel`) with values
  `htdemucs_6s` or `htdemucs_ft`.
- Defaults and user changes persist in localStorage key `tuneforge.ui-preferences`.
- `stemMutation` uses the selected `defaultStemModel` when creating stems unless
  another model is explicitly chosen for the request path.
- Deleting stems/mixes in UI:
  - Source audio is not deletable.
  - Saved practice mixes and stem tracks are deletable.
  - Deleting a practice mix deletes its stem tracks too.
  - Deleting all stems, source stems, or practice stems leaves source/mixes
    according to action.
  - Delete actions are disabled while related jobs are playing/queued/running
    and while playback is active.
- Backend enforces the same constraint: stem and preview mix delete requests are
  rejected while chord, stem, or export jobs are pending/running.
