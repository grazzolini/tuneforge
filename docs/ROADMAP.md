# TuneForge Roadmap

## Purpose

This roadmap records TuneForge's undated release train from v1.0.1 through
v2.0.0. GitHub milestones define release scope, and each milestone has one
`release-plan` tracker whose `## Ordered work` section is the canonical work
order. The first open linked issue is next. When no linked issue remains open,
the milestone is ready for refinement or release handoff; that state does not
publish a release or create a tag.

Release issues describe intended product work. Research issues collect evidence
before TuneForge commits to implementation. Research may conclude that a path is
not viable, and completing a research issue never promises a shipped feature.

## Release Train

| Milestone | Direction | Canonical tracker |
| --- | --- | --- |
| [v1.0.1 — Mobile and E2E hardening](https://github.com/grazzolini/tuneforge/milestone/13) | Consolidate completed mobile, E2E, test-performance, and Android packaging work. | [#391](https://github.com/grazzolini/tuneforge/issues/391) |
| [v1.1.0 — Export workflows](https://github.com/grazzolini/tuneforge/milestone/14) | Make audio and stem export selective, explicit, and platform-truthful. | [#392](https://github.com/grazzolini/tuneforge/issues/392) |
| [v1.2.0 — Storage format choice](https://github.com/grazzolini/tuneforge/milestone/15) | Choose WAV, FLAC, MP3, or M4A for newly created durable audio and convert existing audio on demand. | [#393](https://github.com/grazzolini/tuneforge/issues/393) |
| [v1.3.0 — Footprint and engine defaults](https://github.com/grazzolini/tuneforge/milestone/16) | Improve the lightweight chord engine and reduce the default package footprint. | [#394](https://github.com/grazzolini/tuneforge/issues/394) |
| [v1.4.0 — Mobile runtime experiments](https://github.com/grazzolini/tuneforge/milestone/17) | Measure iOS simulator and Android model feasibility without shipment promises. | [#395](https://github.com/grazzolini/tuneforge/issues/395) |
| [v2.0.0 — Android-first 2.0](https://github.com/grazzolini/tuneforge/milestone/18) | Deliver the complete Android-first workflow and truthful capability states. | [#396](https://github.com/grazzolini/tuneforge/issues/396) |

Milestones are intentionally undated. Scope and order may be refined through
their trackers as implementation evidence changes.

## v1.0.1 — Mobile and E2E Hardening

v1.0.1 gathers work merged since v1.0.0: mobile storage, playback and sync;
native Android audio, tuner and wake handling; E2E coverage; test performance;
and Android packaging. The closed
[E2E and Test Performance](https://github.com/grazzolini/tuneforge/milestone/11)
and [Mobile First-Class App](https://github.com/grazzolini/tuneforge/milestone/12)
milestones remain the historical record. Their issues are not reassigned.

The milestone stays open until release refinement and preparation are requested.
No tag or release is implied by completing its tracker.

## v1.1.0 — Export Workflows

The export foundation in [#397](https://github.com/grazzolini/tuneforge/issues/397)
precedes the contributor request in
[#388](https://github.com/grazzolini/tuneforge/issues/388). The intended workflow
selects one, several, or all stems and other exportable audio artifacts; targets
a file, folder, or ZIP as appropriate; and supports WAV, FLAC, MP3, and M4A/AAC.

Desktop and Android must expose their real encoder and destination capabilities.
An unavailable combination is disabled or explained, never presented as a
working action. TuneForge remains local-only and continues to rely on
host-installed FFmpeg on desktop rather than bundling it.

Desktop lyrics and lyrics-with-chords TXT export from
[#387](https://github.com/grazzolini/tuneforge/issues/387) and
[#439](https://github.com/grazzolini/tuneforge/issues/439) now extends this workspace. Generated
documents can ship alone or alongside audio without becoming synced or app-owned project artifacts.
Chords-only and additional document formats remain outside this milestone.

## v1.2.0 — Storage Format Choice

[#398](https://github.com/grazzolini/tuneforge/issues/398) adds a
`wav | flac | mp3 | m4a` preference for new durable audio, with WAV as the default.
MP3 and M4A use 192 kbps lossy encoding and require an irreversible-quality warning. The value is captured
when an import, generation job, or save action starts and applies to new sources,
stems, saved mixes, and other durable audio created by that action.

Changing the preference affects future artifacts only. Existing files stay
unchanged, and mixed-format libraries and projects remain valid. TuneForge does
not retain the original import as a separate canonical file under this plan.

Sync preserves each received artifact's format regardless of the receiving
peer's preference. Backend and Android source validation must accept matching
WAV, FLAC, MP3, and AAC-LC M4A media formats and suffixes. All peers are assumed to run the latest
TuneForge; version negotiation, compatibility transcoding, and protocol redesign
are out of scope. Any HTTP schema change must regenerate the committed OpenAPI
TypeScript contract.

[#399](https://github.com/grazzolini/tuneforge/issues/399) adds an explicit
background job to transcode existing durable audio to the current four-format
preference. It reuses progress and cancellation patterns, verifies each new
file, and atomically updates the artifact path, format, size, and content hash.
It does not rerun analysis, stems, lyrics, chords, beats, or other models.

## v1.3.0 — Footprint and Engine Defaults

[#400](https://github.com/grazzolini/tuneforge/issues/400) improves the
lightweight chord engine and makes it the default. CREMA remains supported as an
optional engine, while TensorFlow leaves the default package scope. Chord
quality, runtime, memory, and package-size evidence are part of completion.

## v1.4.0 — Mobile Runtime Experiments

This milestone contains evidence work rather than release promises:

1. [#401 — iOS simulator build and core runtime feasibility](https://github.com/grazzolini/tuneforge/issues/401)
2. [#402 — Whisper, Demucs, and beat-this Android benchmarks](https://github.com/grazzolini/tuneforge/issues/402)
3. [#403 — Drum sub-stem quality and mobile viability](https://github.com/grazzolini/tuneforge/issues/403)

The iOS work is simulator-only and must not imply physical-device support.
Android benchmarks record model size, runtime, memory, output quality, runtime
dependencies, and capability recommendations. The drum spike references the
feature request in [#389](https://github.com/grazzolini/tuneforge/issues/389) and
evaluates candidates including
[MIT DrumSep](https://github.com/inagoy/drumsep) and its registered
[demucs-infer](https://github.com/openmirlab/demucs-infer) path. #389 remains
unmilestoned until evidence justifies implementation.

## v2.0.0 — Android-First 2.0

Android is the primary mobile target. The 2.0 gate is a functional Android flow
for import, library, playback, editing, sync, export, four-format durable storage, and
truthful model capability states.

Heavy on-device models ship only when v1.4 evidence justifies them. A negative
Whisper, Demucs, beat-this, or drum-separation result does not block 2.0. iOS
remains simulator-only experimental work.

Play Store, App Store, notarization, and distribution signing are not release
gates. Attaching an APK to a GitHub release may be useful, but remains optional.

## Continuing Product Boundaries

- Keep TuneForge local-only: no account, cloud backend, telemetry, or remote
  processing requirement.
- Keep desktop as the most complete workflow while Android reaches functional
  parity for the 2.0 gate.
- Keep generated audio, analysis, chord, lyric, and job state tied to explicit
  project artifacts.
- Preserve user edits when regeneration jobs run, with explicit confirmation
  for destructive refreshes.
- Keep backend, desktop, contract, packaging, and privacy validation proportional
  to the surfaces changed by each issue.
- Keep release copy explicit about what ships, what remains experimental, which
  models download or cache after use, and which host tools are required.
