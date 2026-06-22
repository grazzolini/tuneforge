# TuneForge References

## Purpose

This document records product and workflow references that can inform TuneForge design. These references are inspiration, not requirements, commitments, or parity targets.

TuneForge should remain focused on its own local-first scope, architecture, licensing constraints, and contributor capacity.

## How to Use This Document

- Use references to understand common musician workflows and user expectations.
- Prefer TuneForge-specific product principles over copying another tool's feature set.
- Treat all references as non-prescriptive.
- Avoid adding network, account, telemetry, or cloud assumptions just because a reference product has them.

## Workflow Category

TuneForge sits near tools for:

- music practice
- stem separation
- key, tempo, and chord detection
- pitch and tuning adjustment
- lyrics transcription and correction
- capo-oriented practice support
- local export of practice-ready audio

## Reference Tools

### Moises-style practice workflows

Relevant ideas:

- import a song and process it into practice aids
- separate vocals and backing instruments
- adjust key and tempo for practice
- show chords and lyrics during playback
- export or reuse prepared practice material

TuneForge differences:

- local-first architecture
- no account or cloud processing requirement
- desktop-first complete workflow
- Android/mobile as a local companion direction
- host-installed FFmpeg policy on desktop

### Transcription-oriented tools

Relevant ideas:

- timestamped lyric segments
- editable transcript output
- word-level timing where available
- follow-along playback

TuneForge should treat transcription as editable draft output and prioritize correction workflows over claiming perfect accuracy.

### Stem-focused tools

Relevant ideas:

- vocal/instrumental isolation
- practice against selected stems
- cached/generated artifacts
- clear progress and failure states for heavy jobs

TuneForge should keep stems local and avoid making stems a prerequisite for source-track analysis.

### Chord-focused tools

Relevant ideas:

- timed chord timelines
- bar-based chord grids
- current chord highlighting
- manual correction
- capo-relative display

TuneForge should keep chord data editable and should separate harmonic display changes from audio transforms.

### Lyrics-focused tools

Relevant ideas:

- large follow-along lyric display
- editable lines
- lyric/chord combined lead sheet
- tab or text import for correction

TuneForge should keep lyrics local and project-owned.

## Project-Specific Takeaways

- The most important workflow is preparing a song for practice, then staying in a focused playback/practice view.
- Chords, lyrics, stems, and transforms should support practice, not turn TuneForge into a general DAW.
- Local-first behavior is a product direction and architectural constraint.
- References should inform UX expectations, but TuneForge should not chase feature parity for its own sake.

## Future Research Areas

- Better local beat/downbeat detection for practice sync.
- Local mobile-friendly lyrics runtimes.
- Bar-based chord and lyric correction workflows.
- Project portability and optional device handoff.
- Lightweight local import of tab/chord text for correction.

## Beat/Downbeat Model Evaluation

This evaluation checked whether TuneForge should integrate a local ML beat/downbeat/meter model for source-track timing
analysis. The current direction is to keep the built-in heuristic as the source-track baseline, and use CPJKU Beat This
`small0` as the optional Advanced Beat Analysis model after local-track bake-off evidence and explicit model-weight
redistribution confirmation.

Local-track baseline evidence from a read-only sample of 8 converted source WAVs in local app data: 8/8 completed,
8/8 produced timing grids, median heuristic runtime was 12.686 seconds, median runtime ratio was 0.0531x track length,
and 5/8 tracks had at least one large beat-gap flag.

Follow-up benchmark evidence compared the built-in analyzer, Beat This `small0`, and Beat This `final0` on the same
kind of 8 local, non-committed tracks, including known timing failures and stable baselines. All 8 tracks completed for
all 3 backends without source paths in the benchmark output. Median warm runtime ratios were 0.047267x for the
built-in analyzer, 0.006145x for `small0`, and 0.007968x for `final0`; `final0` was about 1.30x slower than `small0`
and about 9.6x larger.

Quality evidence does not justify switching the default or exposing a model-size setting yet. `final0` reduced large
gap flags on some tracks, but it still showed tempo and meter risks on known benchmark cases. The benchmark now records
single-anchor drift and Beat This alignment against the built-in grid for future bake-offs, but the current
recommendation is to keep `small0` as the default optional model until listening checks show `final0` improves practice
sync without tempo or meter regressions.

Several candidates were kept as research-only or excluded because their upstream project activity, release freshness,
or supported Python/ML stack did not fit a new desktop runtime dependency.

| Candidate | Fit | License / weights | Integration notes |
| --- | --- | --- | --- |
| [CPJKU Beat This](https://pypi.org/project/beat-this/) | Best spike candidate | PyPI/package metadata uses MIT; pretrained checkpoints need explicit redistribution confirmation before bundling. | Python package released for Python 3, uses PyTorch plus small inference deps, has `small*` checkpoints around 8.1 MB and `final*` around 78 MB, and can download models automatically when not preloaded. |
| [madmom downbeat processors](https://madmom.readthedocs.io/en/v0.16/modules/features/downbeats.html) | Exclude for bundled runtime | Code is BSD-style, but pretrained models are documented as CC BY-NC-SA 4.0. | Strong prior art for RNN/DBN downbeat tracking, but the non-commercial/share-alike model terms conflict with TuneForge runtime dependency policy. |
| [BeatNet](https://github.com/mjhydri/BeatNet) | Research only | Repository license file is CC BY 4.0, including packaged pretrained models. | Ships pretrained models and online/offline beat/downbeat/meter tracking, but license shape is not a normal permissive software dependency and docs warn about madmom compatibility with modern Python/NumPy. |
| [All-In-One](https://pypi.org/project/allin1/) | Research only | Code/package is permissive, but model/dependency packaging remains too heavy for default TuneForge. | Predicts tempo, beats, downbeats, and sections, but requires PyTorch, NATTEN, a madmom install path, Demucs/FFmpeg-style preprocessing, and model preloading from Hugging Face. |
| [Beat-Transformer](https://github.com/zhaojw1998/Beat-Transformer) | Research only | Code is MIT; checkpoint licensing and packaging path are not clear enough for default bundling. | Demixed-beat approach may align with TuneForge stems, but it appears research-code oriented, upstream activity appears stale, and it would add PyTorch/model packaging work without a clean package path. |
| [Omnizart](https://github.com/Music-and-Culture-Technology-Lab/omnizart) | Exclude | License is permissive, but the stack is too old/heavy for TuneForge packaging. | Beat/downbeat support exists, but it depends on old TensorFlow-era tooling and does not fit Python 3.11 desktop packaging. Upstream release freshness also makes it a poor fit for a new dependency. |
| [WaveBeat](https://github.com/csteinmetz1/wavebeat) | Exclude | GPL-3.0. | GPL runtime dependency conflicts with repository dependency rules. |

Runtime and quality evaluation should use local tracks that are not committed to the repository:

```sh
bash scripts/run-backend-module.sh app.benchmarks.timing --audio-dir /path/to/local/tracks --json-only
```

For each candidate spike, compare model output against the timing benchmark by `track_###`: runtime ratio, beat count,
downbeat count, meter, first beat numbers, source-grid drift, model size, and whether model weights were preloaded or
downloaded during analysis.
