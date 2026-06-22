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

## Model loading modes and trusted boundary

Development and default packaged builds use Demucs' default Torch checkpoint cache when
`TUNEFORGE_DEMUCS_MODEL_REPO` is unset:

- `pnpm setup:dev` verifies the expected `htdemucs_6s` and `htdemucs_ft`
  checkpoint files by size and SHA-256, then preloads missing or invalid files
  into the Torch checkpoint cache.
- If the weights are not preloaded, the first stem job may download them through
  Demucs, then later runs reuse the cache.
- Cache path precedence matches Torch: `$TORCH_HOME/hub/checkpoints`,
  `$XDG_CACHE_HOME/torch/hub/checkpoints`, then
  `~/.cache/torch/hub/checkpoints`.
- Availability in this mode only requires the local `demucs` package to be
  installed.
- Packages built with `--model-bundle` seed this same cache from package
  resources on startup, then Demucs still loads from the cache.

Explicit offline/pinned setups can use
`TUNEFORGE_DEMUCS_MODEL_REPO`, which points to a local path containing Demucs
model files and `manifest.json`. Backend behavior:

- If set, backend validates the repo before serving the model:
  - manifest exists and parses.
  - manifest entry exists for requested `stem_model`.
  - manifest mode matches expected model mode.
  - manifest file list has matching names, sizes, and SHA-256 hashes.
  - all declared files exist.
  - Demucs package is installed.
- No HTTP downloads happen at generation time when this repo is configured.
- Trust boundary is the prepared local model repo. Treat the repo directory,
  `manifest.json`, YAML selectors, and checkpoint files as one trusted generated
  artifact.
- Do not point `TUNEFORGE_DEMUCS_MODEL_REPO` at user-supplied, shared, or
  otherwise untrusted writable directories.

## Why manifest + pickle checkpoint warning exists

- Backend marks Demucs checkpoint loads as trusted checkpoint loading in
  `app/engines/demucs_worker.py` to support current Demucs pickle model format.
- This is an explicit local-policy decision for two local sources: Demucs'
  Torch cache in development, and the configured local repo in packaged/offline
  builds.
- Security control for configured repos is trusted local repo preparation plus
  runtime manifest checks, not arbitrary model repo verification. If an attacker
  can modify both `manifest.json` and checkpoint files in the configured repo,
  the manifest cannot protect checkpoint loading.

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
