# Deferred work context

These notes preserve context for later planning. GitHub owns status, priorities,
scheduling, and release ordering; this is not a second issue tracker. Update or
remove a note when its context is resolved. Notes do not authorize extra work.

## Cross-runtime integration CI

[GitHub issue](https://github.com/grazzolini/tuneforge/issues/601)

The Rust integration test exercises real Python result producers, native apply
and replay, then native edits verified by Python. Inference is mocked; persistence
and reconciliation remain real. Static shared fixtures do not provide equivalent proof.

The test is compiled but ignored by default because `desktop_tauri` has no prepared
Python backend environment. Adding backend setup there would increase runtime and
cache costs. Keep the test and Python fixture available for explicit manual execution.

Revisit when a dedicated cross-runtime lane can preserve this proof while maintaining
the current pipeline runtime and avoiding substantial cache growth. Validate image
dependency size, provenance, job scope, runtime, and cache impact before enabling it.

Source pointers:

- [Rust test and fixture launcher](apps/desktop/src-tauri/src/mobile_backend/reconciliation.rs)
- [Python fixture](apps/backend/tests/result_sync_fixture.py)
- [CI jobs and scope](.github/workflows/ci.yml)
- [CI image producer and consumer policy](.github/ci/README.md)

For manual execution, use the prepared Python backend, repository-owned SoXR, and
fresh synthetic data, transport, cache, and temporary roots:

```sh
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib \
  mobile_backend::reconciliation::tests::python_producers_native_apply_result_matrix_and_bidirectional_replay \
  -- --exact --ignored
```

## Section playback and editing

Consolidate the section UI before defining detailed follow-up issues. Future work
can use timed sections for playback navigation and practice, and provide an editor
for the working sections. This is expected to be considered after 2.0.0, without a
committed milestone or release date. Detection alone does not implement a section
editor or display.

The local per-project result separates three roles:

- `raw_sections_json`: model output.
- `refined_sections_json`: automatic refinement using musical cues.
- `sections_json`: working copy, initially copied from the refined result and
  intended to hold future user edits.

A successful explicit reprocess from Studio or bulk processing replaces the
working copy, so warn before overwriting edits. Failed or cancelled reruns preserve
the last result. Plan editing and reprocessing together so that behavior remains
clear to users.

## Tab import and section reconciliation

Rework tab import with its lyric and chord context in mind. Untimed tab section
labels need reconciliation with timed detected or edited sections, but the
alignment method and resulting storage design remain open. Do not merge the stores
prematurely.

Revisit the meaning, name, and storage responsibility of the existing tab-derived
`song_sections` table during that rework. Its labels are separate from chord and
lyric overrides, which have their own tables. Keep new detection results in
`section_analysis_results` separate until the design is ready.

## Section sync and revision storage

Plan sync for editable section results with last-writer-wins semantics once the
editable representation, storage, and corresponding runtime support are settled.
New section detection results remain local for now: generation must not create
entity revisions or sync tombstones. Existing tab section and revision flows stay
unchanged.

Separately, evaluate duplication between result-table JSON and
`sync_entity_revisions` payloads. Define authoritative state, derived data, and
necessary history before reducing copies or hydration. Future planning must address
migration, provenance, and last-writer-wins consequences. The existing
[manifest precomputation issue](https://github.com/grazzolini/tuneforge/issues/617)
is related, but does not encompass a general storage or JSON redesign.

Source pointers: [models](apps/backend/app/models.py),
[section detection](apps/backend/app/services/section_detection.py),
[tab import](apps/backend/app/services/tabs.py), and
[sync revisions](apps/backend/app/services/sync_revisions.py).

## Processing concurrency

Evaluate bounded parallel execution of independent processing work while projects
remain queued and required per-project processing order and dependencies are
preserved. Before changing the single-worker scheduler, define CPU, GPU, and memory
budgets and contention, plus cancellation and failure behavior. The scheduler
implementation remains a separate future decision.

Source pointer: [job service](apps/backend/app/services/jobs.py).

## Android stem acceleration and alternate runtimes

Defer GPU and alternate-runtime work. The pinned Termux Torch recipe sets
`USE_VULKAN=ON`. PyTorch's eager Vulkan backend is unmaintained, and the complex
FFT operators HTDemucs uses lack Vulkan dispatch in the pinned Torch version.
[PyTorch Vulkan maintenance note](https://docs.pytorch.org/tutorials/unstable/vulkan_workflow.html)
and [Torch 2.15 FFT dispatch](https://github.com/pytorch/pytorch/blob/v2.15.0/aten/src/ATen/native/native_functions.yaml).

If a concrete need warrants revisiting acceleration, consider ExecuTorch's Vulkan
delegate or ONNX Runtime. Verify actual operator placement, CPU/GPU partitioning,
and transfer costs. Establish output parity against CPU with the same checkpoint
and fixtures before comparing end-to-end timings. Keep new exports and their
provenance in the `tuneforge-models` repository. Revisit adaptive CPU thread
settings beyond the fixed profile only when matched-fixture results identify a
concrete need.

Use the existing pinned `htdemucs_6s` weights directly for the CPU production path.
CPU correctness, model acquisition and caching, mixed formats, metadata and
last-writer-wins behavior, licensing and native audits, and shipping validation
remain part of that work. Additional stem families remain separate under #590.

Add Android support for two-stem separation (vocals and instrumental) in a future
change, reusing the existing stem runtime and job pipeline.

Compare source decoding, channel conversion, resampling, and working WAV
precision on matched desktop and Android fixtures. Measure whether differences
affect stem output before changing either input path.

Android's built-in and Advanced Chords paths analyze the imported track.
Evaluate adding the desktop source-plus-stem chord mix and timeline augmentation
on Android. Android Whisper also prepares the imported track. Evaluate choosing
an eligible vocal stem with the imported track as fallback.

After 2.0.0, revisit sharing the desktop and Android backends. Compare running
the desktop Python backend on Android with the Termux-built runtime against a
shared Rust backend that retains Python where inference requires it. Reassess
the earlier preference for Rust using the new runtime evidence. Verify full
backend compatibility separately from the embedded stem worker.

See the [runtime lock](packaging/demucs-android/runtime-lock.json),
[CPU worker](packaging/demucs-android/runner.py), and
[Android stem packaging](docs/PACKAGING.md#android-cpu-stem-runtime).
