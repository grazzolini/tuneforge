# TuneForge Roadmap

## Purpose

This roadmap summarizes TuneForge's released versions and future release goals.
GitHub milestones and their release-plan trackers own exact issue scope,
sequencing, dependencies and acceptance criteria.

Future plans are undated and may change as implementation and research provide
evidence. See [CHANGELOG.md](../CHANGELOG.md) for full release notes.

## Released Versions

| Version | Released | Outcome | Milestone | Release plan |
| --- | --- | --- | --- | --- |
| [v1.0.0](https://github.com/grazzolini/tuneforge/releases/tag/v1.0.0) | 2026-07-03 | Initial local desktop workflow for analysis, stems and practice. | — | — |
| v1.0.1 | 2026-08-13 | Mobile storage, playback and sync hardening; Android packaging. | [#13](https://github.com/grazzolini/tuneforge/milestone/13) | [#391](https://github.com/grazzolini/tuneforge/issues/391) |
| v1.1.0 | 2026-08-18 | Audio and lyrics/chord document export workflows. | [#14](https://github.com/grazzolini/tuneforge/milestone/14) | [#392](https://github.com/grazzolini/tuneforge/issues/392) |
| v1.2.0 | 2026-08-24 | Durable audio format choice and reprocessing. | [#15](https://github.com/grazzolini/tuneforge/milestone/15) | [#393](https://github.com/grazzolini/tuneforge/issues/393) |
| v1.3.0 | 2026-08-28 | Chord and beat-analysis engine improvements. | [#16](https://github.com/grazzolini/tuneforge/milestone/16) | [#394](https://github.com/grazzolini/tuneforge/issues/394) |
| v1.4.0 | 2026-09-01 | Dependency refresh, ONNX chords and safer model loading. | [#19](https://github.com/grazzolini/tuneforge/milestone/19) | [#482](https://github.com/grazzolini/tuneforge/issues/482) |
| v1.5.0 | 2026-09-08 | Native audio consistency and playback/sync fixes. | [#20](https://github.com/grazzolini/tuneforge/milestone/20) | [#514](https://github.com/grazzolini/tuneforge/issues/514) |
| v1.6.0 | 2026-09-21 | Android processing, owned audio conversion and experimental iOS workflows. | [#17](https://github.com/grazzolini/tuneforge/milestone/17) | [#395](https://github.com/grazzolini/tuneforge/issues/395) |
| v1.7.0 | 2026-10-02 | Output routing, volume controls and desktop drum refinement. | [#21](https://github.com/grazzolini/tuneforge/milestone/21) | [#564](https://github.com/grazzolini/tuneforge/issues/564) |

## v1.8.0 — Test Packages and Security

[Milestone](https://github.com/grazzolini/tuneforge/milestone/22) ·
[Release plan #582](https://github.com/grazzolini/tuneforge/issues/582)

Start with clearly distinguishable, isolated test packages for Android, macOS
and Flatpak. Testing should coexist safely with installed production TuneForge
and its saved data.

Validate and remediate GitHub security findings and findings from the forthcoming
Codex audit. Improve Android packaging from Linux hosts and Web Audio output
device discovery. Security readiness depends on verified outcomes; sensitive
details remain private.

Finish with canonical analysis, chord and lyric result revisions
([#470](https://github.com/grazzolini/tuneforge/issues/470)), after
[Android packaging #585](https://github.com/grazzolini/tuneforge/issues/585).
This storage foundation precedes the cross-platform workflow work in 2.0.

## v1.9.0 — Musical Consistency and Processing

[Milestone](https://github.com/grazzolini/tuneforge/milestone/23) ·
[Release plan #583](https://github.com/grazzolini/tuneforge/issues/583)

Make musical notation and lyrics/chord documents consistent across runtimes.
Improve job handling and Android processing responsiveness while preserving
result quality.

Evaluate future capabilities: sustainable stem and lyrics runtimes, reusable
music-theory tools, automatic song sections and additional stem families.
Research establishes decisions; completing it does not promise a shipped
feature. Android stems, a replacement lyrics engine, automatic sections and
additional stem families are not committed 1.9 features.

Android stems remain a goal before 2.0. Another 1.x release remains possible
as evidence and implementation needs become clearer.

<a id="v200--android-first-20"></a>

## v2.0.0 — Cross-platform Workflow Maturity

[Milestone](https://github.com/grazzolini/tuneforge/milestone/18) ·
[Release plan #396](https://github.com/grazzolini/tuneforge/issues/396)

Make everyday workflows reliable across supported desktop platforms and Android,
with capabilities and interactions appropriate to each platform.

Build on the result revision foundation scheduled for 1.8. The remaining work covers
cross-platform workflows ([#448](https://github.com/grazzolini/tuneforge/issues/448)),
durable mixes at selected tempos ([#529](https://github.com/grazzolini/tuneforge/issues/529)),
and playback timing qualified through measurement for supported output combinations
([#580](https://github.com/grazzolini/tuneforge/issues/580)).

## Continuing Product Boundaries

TuneForge remains local-first and works offline after initial setup, without
accounts, cloud processing or telemetry. Preserve saved work and user edits.

Android is the supported mobile target. iOS remains simulator-only experimental.
