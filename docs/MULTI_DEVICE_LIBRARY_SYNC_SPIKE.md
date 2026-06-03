# Multi-Device Library Sync Spike

## Summary

This is an exploration report, not an implementation plan. The goal is to decide whether TuneForge should support a local-first sync group across multiple trusted installs: Linux desktop, macOS desktop, mobile, and future platforms where relevant.

The model should not be "mobile paired to one desktop." It should be "N trusted TuneForge installs in one sync group." Any peer can import tracks, edit durable project data after the project's minimum usable set is available and verified locally, generate artifacts, provide verified artifact bytes to other peers, go offline, and later catch up. Some peers are more capable than others, but no peer should be the permanent authority for the library.

This report assumes the mobile backend will converge with the desktop backend model: projects, jobs, artifacts, analysis, lyrics, chords, stems, exports, and sync-facing contracts should eventually have equivalent behavior even if the engines behind them differ by platform.

Remote processing is intentionally out of scope for the sync spike. It may become a separate capability scheduler later, but the sync model should not assume "mobile asks desktop" or any fixed executor relationship.

## Current State Findings

TuneForge is already oriented toward local-first library ownership at the product level. The repo documentation describes a local-first desktop app with no account or cloud requirement, mobile as an active Android-first companion path, and desktop-backed processing as a future direction for heavy work. The current mobile architecture documents a local mobile backend inside Tauri rather than exposing the desktop Python/FastAPI backend to Android.

The current desktop backend has the more complete library model:

- Projects live in SQLite and point at filesystem project roots under the configured data root.
- Project files are organized under `projects/<project_id>/source`, `analysis`, `previews`, `stems`, and `exports`.
- Desktop stores `source_sha256` on projects and `content_sha256` on artifacts in the database.
- Artifact rows include type, format, path, byte size, generated-by metadata, delete/regenerate flags, metadata JSON, and optional cache keys.
- The public API exposes project and artifact records, but it does not currently expose all sync-relevant fields such as `source_sha256`, `content_sha256`, `cache_key`, or job result artifact IDs.
- Project IDs are not normal library identity in the UI. They are implementation details that may appear in routes, APIs, storage paths, and diagnostics.

The current mobile backend is intentionally smaller:

- Mobile uses Tauri commands and an embedded SQLite database at app data root, not the desktop HTTP API.
- Mobile has project, artifact, job, analysis, chord, and lyrics tables, but its tables are not yet desktop-parity.
- Mobile imports Android `content://` and `file://` URIs into app-local storage.
- Mobile can run basic local analysis/chord paths and local Whisper lyrics when a side-loaded model exists.
- Mobile stems, preview, retune, transpose, and export are currently capability-gated or fail closed.
- Mobile currently reports `m4a` as default export/preview format, while desktop defaults to WAV and desktop stems are WAV-only.

The frontend already has a useful boundary for parity work. `TuneForgeClient` hides whether calls go to desktop HTTP or mobile Tauri commands, so sync-facing APIs should also flow through that boundary once they exist.

The UI has no global toast or notification system today. Status appears inline in panels, diagnostics, project job history, and compact sidebar surfaces such as background playback. Sync UX should start with those patterns before adding a broader notification system.

## Product Direction

The primary goal is multi-device library sync: keep durable TuneForge project libraries available across trusted installs in the same sync group.

Useful v1 behavior should be:

- A user imports a track on Linux desktop and sees it appear on macOS desktop after both installs are in the same sync group.
- A user imports a track on macOS desktop and sees the synced project appear on Linux desktop and mobile.
- A group can contain at least three peers, for example macOS desktop, Linux desktop, and Android mobile.
- Any two online peers can continue syncing while a third peer is offline.
- Source audio, generated stems, saved mixes, exports, lyrics, chords, analysis, and sections sync as library data.
- Rebuilding chords, lyrics, stems, mixes, or other generated library outputs on one peer creates new durable library state that syncs to the other peers.
- Deleting a project, stem, mix, export, or other synced library artifact on one peer should delete it from the sync group, not only from that local device.
- Importing the same source track by SHA-256 into a library that already has it should fail hard with an "already imported" message and a pointer to the existing project.
- App preferences, theme, local playback defaults, device settings, local model paths, acceleration preferences, and local debugging state do not sync.
- Mobile joins the same sync group as a normal peer, with constrained runtime capabilities but without a special mobile-to-desktop library model.
- Mobile can play synced desktop WAV artifacts directly when those artifacts are present locally.

Remote processing should not be part of v1 sync. If it is revisited later, it should be a separate capability scheduler that can choose the best available executor, not a hard-coded mobile-to-desktop bridge.

## What "Library" Means

With backend parity assumed, the syncable library should include durable project data:

- Project records: canonical project ID, display name, source key override, duration, sample rate, channels, timestamps, source hash, and project revision metadata.
- Source files: original imported source plus any normalized working source required by the receiving runtime.
- Artifacts: source audio, stems, saved practice mixes, previews, exports, analysis JSON snapshots, and future timing artifacts.
- Analysis: key, tuning, tempo, timing grids, source artifact link, analysis version, and timestamps.
- Chords: generated source segments, edited timeline, backend metadata, source kind, source artifact link, revision metadata, and user-edit flag.
- Lyrics: generated source segments, edited segments, backend/model metadata, source artifact link, revision metadata, and user-edit flag.
- Sections and accepted tab-assisted corrections where they become durable library data.
- Job history as historical status, not as active work to resume on another device.

The library should exclude local app state:

- Settings snapshots and preferences.
- Theme and appearance choices.
- Per-project playback memory stored in local frontend state.
- Device audio configuration, mic/input state, and native audio diagnostics.
- Cached model files and machine-local acceleration settings.
- Local-only capability configuration, such as GPU/CPU preferences, model paths, or mobile storage limits.

In-progress jobs should not be synced as runnable jobs. A receiving device can display that another device is processing something, but only completed outputs should become durable synced library state.

## Identity, Existing Projects, And Migration

The UI does not treat project IDs as user-facing library identity, but project IDs do appear in routes, APIs, paths, diagnostics, foreign keys, and manifests. Keeping a second project identity would make the sync model harder to reason about. V1 sync therefore makes the database/API `project_id` the canonical sync identity.

Canonical project identity is derived from the source track SHA-256:

- `project_id`: deterministic database/API identity derived from the full SHA-256 of the canonical imported source bytes, for example `proj_sha256_<full_sha256_hex>`.
- `project_storage_key`: short storage directory key derived from the same hash, for example `proj_<first_24_sha256_hex>`.
- `source_sha256`: full SHA-256 of the canonical imported source bytes.
- `artifact_id`: stable artifact record identity. It can be deterministic where practical from project ID, artifact type, source artifact relation, generation parameters, and content hash, but replacement/regeneration semantics should be explicit.
- `content_sha256`: full SHA-256 of the artifact bytes for verification and dedupe.
- `entity_revision`: durable revision metadata for editable or regenerable entities such as project metadata, chords, lyrics, and sections.

The full source hash remains in the database/API identity for collision detection and verification. The shorter storage key is only an implementation detail for local project folders and compact relative paths.

Existing libraries may contain random project IDs. The migration is best-effort: TuneForge attempts to compute source hashes, re-key safe projects to canonical IDs, rewrite project foreign keys, and move project folders to the derived storage key. If the original source is missing, duplicate source hashes exist, or a path conflict makes re-keying unsafe, the project can remain on a legacy ID and sync preflight will require cleanup or re-import before sync is enabled.

Expected migration flow before enabling sync:

1. Scan existing projects.
2. Ensure every project has `source_sha256`; compute it from the canonical imported source bytes if missing.
3. Detect duplicate `source_sha256` values in the local library.
4. If duplicates exist, fail migration and require manual cleanup before enabling sync. The user can delete a duplicate project and import it again later if needed.
5. Re-key each safe project to `project_id = proj_sha256_<full_source_sha256>` and move its folder to `proj_<first_24_source_sha256_hex>`.
6. Add a uniqueness constraint or equivalent guard for `source_sha256` in sync-enabled libraries.
7. Only enable sync after the migration has completed without unresolved missing hashes, duplicates, or legacy project IDs.

Import behavior should be strict:

- If the local library already has the same `source_sha256`, import should fail hard with a message such as: `You already have project "<project name>" imported.`
- If the sync group manifest already knows the same canonical project ID, import should fail or redirect to the existing synced project rather than creating a duplicate.
- V1 should not support intentional same-source duplicate projects or variants. If the user wants to reset a project, they can delete it from the library and import it again.
- The project ID must be based on the original source bytes, not a platform-specific normalized WAV proxy, otherwise macOS, Linux, and mobile could derive different sync IDs for the same import.
- Hash prefixes must not be the only stored identity. Prefixes are acceptable for display, logs, or compact filenames only if the implementation retains the full hash for collision detection and verification.

Tradeoffs:

- Byte-identical source imports naturally converge to the same sync project.
- The same song encoded in different containers or bitrates will not dedupe unless a future audio fingerprinting layer is added.
- Existing random project IDs are allowed only as migration leftovers that must be cleaned up before sync is enabled.
- The no-duplicates rule keeps v1 simple, but it rules out multiple independent arrangements from the exact same source until a future explicit variant model exists.

Implementation decision for the first sync milestone:

- Desktop backend imports now use canonical `project_id = proj_sha256_<full_source_sha256>`.
- Project directories use the shorter derived storage key instead of the full project ID.
- `GET /api/v1/sync/preflight` checks existing libraries for missing hashes, invalid hashes, duplicate source hashes, and noncanonical project IDs before sync is enabled.
- Duplicate import rejection is enforced for backend imports because the canonical project ID makes same-source duplicates a primary-key conflict.

## Storage And Portability

Direct database sync is the wrong primitive. Desktop and mobile schemas are not identical today, and even after parity, SQLite files contain local paths, migrations, and runtime-specific state. Sync should operate through manifests and artifact content.

The portable unit should be a sync group manifest plus project manifests and content-addressed files:

- `sync_group_manifest`: sync group ID, schema version, known devices, known projects, group-level feature flags, delete tombstone summary, and high-water marks.
- `device_manifest`: device ID, display name, platform, public identity, protocol versions, advertised capabilities, last-seen metadata, and trust state.
- `library_manifest`: local device ID, schema version, known sync projects, available artifacts, group delete tombstones, and high-water marks.
- `project_manifest`: canonical project ID, local display/project metadata, analysis/chords/lyrics/sections records, artifact list, revision records, and dependency links.
- `artifact_manifest`: artifact ID, canonical project ID, type, format, relative project path, byte size, SHA-256, generated-by metadata, can-delete/can-regenerate flags, metadata, cache key when meaningful, source artifact relation, and replacement/supersession state.
- `peer_inventory`: per-device advertisement of which content hashes and artifact bytes are currently available, transferring, or missing.
- `entity_revision`: durable entity type, entity ID, revision ID, base revision ID, author device ID, logical counter or monotonic sequence, updated timestamp, generation metadata when relevant, and content hash.
- `delete_tombstone`: durable record for group-level deletion of a project, artifact, or entity revision.
- `transfer_manifest`: chunk/block hashes for large files, transfer state, provider device, receiver device, and verification results.

Receivers should rewrite all file paths to their own app data root. Paths in sync manifests should be relative to the project root. Absolute source paths can remain as display/provenance metadata, but they must not be required for playback or regeneration on another device.

The current hash fields are valuable but need to move into the sync contract. Desktop already stores source and artifact hashes in the database; public schemas should expose sync-safe hash fields, and mobile parity should store the same information.

Content identity and semantic identity should remain separate:

- Sync project identity comes from source SHA-256.
- Artifact record identity comes from sync project context, artifact role, generation parameters, and content identity.
- `content_sha256` remains the content identity for byte-for-byte dedupe and verification.
- Optional transport-specific content IDs, such as BLAKE3 blob IDs, may be used internally by the transfer layer but should not replace the sync contract's stable SHA-256 fields.
- Provider inventory should be treated as an advertised availability snapshot, not as artifact truth. It can be stale, and receivers must still verify received bytes by SHA-256 before import.

Conflict handling should be conservative:

- If two devices have the same sync project/artifact ID and same SHA-256, treat it as identical.
- If the same content arrives under different artifact IDs, dedupe by SHA-256 where metadata allows it.
- If lyrics, chords, or sections diverge from the same base revision, keep both and mark a conflict instead of overwriting user edits.
- If generated artifacts diverge because two peers rebuilt them concurrently or with different engines/models, keep both or mark a replacement conflict instead of assuming determinism.
- Entity-level conflicts should use revision ancestry, not only wall-clock timestamps.

Delete behavior should be group-oriented for v1:

- Deleting a project means deleting it from the sync group.
- Deleting a stem, saved mix, export, or generated artifact means deleting that artifact from the sync group.
- Delete operations should create durable tombstones so offline peers do not resurrect deleted records when they reconnect.
- Tombstones should include author device, timestamp, target ID, target type, and enough prior metadata to make UI diagnostics possible.
- Local-only artifact eviction can be deferred. For v1, a visible delete action should mean group delete, not "free local space only."

## Sync Completeness And Edit Locking

Avoid making partially synced projects editable. Metadata can arrive first so the project appears in the remote library, but the receiving app should treat that project as `syncing` and read-only until the minimum usable project set has been verified locally.

Minimum usable set for v1:

- Project manifest.
- Source artifact manifest.
- Source bytes or a verified playable/analysis-compatible source proxy.
- Editable entities with their base revisions, such as lyrics/chords/sections when present.
- Current conflict state.
- Relevant delete tombstones known to the receiving peer.

For the first user-focused version, TuneForge can prioritize full-library sync over selective mobile storage. Large generated artifacts can still have transfer states, but the default product expectation is that synced library artifacts eventually arrive on all trusted peers unless deleted from the group.

Suggested availability states:

- `syncing`: metadata or required bytes are still arriving; project is visible but not editable.
- `local`: required project data and the artifact bytes are present and verified locally.
- `remote_available`: artifact bytes are available from at least one trusted peer but not local yet.
- `downloading`: transfer is in progress.
- `missing`: metadata references bytes that no trusted peer currently advertises.
- `deleted`: the project, artifact, or entity has a group tombstone.
- `conflicted`: semantic metadata requires user review.

The important UX rule is that "metadata-only" should not become "editable project." It should appear as a syncing or unavailable project row until the app can safely open it.

## Regeneration And Delete Semantics

TuneForge should not assume generated data is deterministic across devices, hardware, model versions, or future engine changes. Even if some generation paths happen to be deterministic today, sync should record what actually happened.

Regeneration rules:

- Rebuilding chords creates a new chord entity revision with generation metadata, source artifact relation, author device, and content hash.
- Rebuilding lyrics creates a new lyrics entity revision with backend/model metadata, source artifact relation, author device, and content hash.
- Rebuilding stems, mixes, previews, or exports creates new artifact state with generation metadata, source artifact relation, author device, byte size, and `content_sha256`.
- If regenerated output has the same SHA-256 as the existing output, it can dedupe and remain semantically identical.
- If regenerated output differs, the new output should sync as the current replacement when the user explicitly ran a rebuild/replace operation.
- If two peers rebuild the same entity or artifact concurrently from the same base, the receiver should mark a conflict or keep both branches rather than guessing which is correct.
- Receiving peers should import regenerated lyrics/chords/artifacts as synced library state. They should not be required to rerun the local engine just because the output is cheap to regenerate.

Delete rules:

- Project delete removes the project, source, generated artifacts, and durable metadata from the sync group through a group tombstone.
- Artifact delete removes the artifact from the sync group through an artifact tombstone.
- Rebuild-and-replace should supersede old generated outputs and may tombstone replaced artifact/entity revisions if the product does not want to keep history.
- Rebuild-and-keep-both can be a future explicit feature, but v1 should prefer simple replacement semantics unless there is a conflict.
- Delete tombstones must be reconciled before accepting older manifests, otherwise offline devices may resurrect removed projects or artifacts.

## Format Policy And Mobile WAV Impact

Mobile should support desktop WAV artifacts because desktop stems are already WAV-only and WAV is the safest interchange format for generated stems and analysis-ready audio. Not supporting WAV would make mobile unable to consume the most important desktop-generated artifacts.

Using WAV has tradeoffs beyond file size:

- Android platform media support includes PCM/WAVE decode for common linear PCM WAV files, but TuneForge should validate the exact desktop stem format.
- If desktop-generated stems use 24-bit PCM, 32-bit float WAV, unusual channel layouts, or RF64/BWF variants, mobile playback may need the app's native decoder path rather than relying only on platform media APIs.
- PCM/WAV generally avoids compressed-codec decode work, but it reads and transfers far more bytes than AAC/M4A or MP3.
- Larger reads can increase storage I/O, cache pressure, sync time, and network/battery cost during transfer.
- Compressed formats may use hardware decode or offloaded playback on some devices, so WAV is not automatically better for battery life during playback.
- For practice features that need sample-accurate stems, analysis, or low-latency PCM buffers, WAV/PCM can still be the simpler and more reliable working format.
- Actual battery impact needs measurement on target Android hardware because it depends on storage, output path, codec/offload support, sample rate, and whether playback is through MediaCodec, AudioTrack, or the app's native audio path.

Recommended policy:

- Preserve the original imported source when possible.
- Store generated stems and desktop-produced practice artifacts as WAV when that is the canonical artifact format.
- Generate derived WAV/PCM proxies only when needed for playback, analysis, waveform, or ML paths.
- Keep source artifact metadata explicit about original format, canonical playback path, analysis path, and generated proxy path.
- Treat AAC/M4A as mobile export-oriented formats, not as the only internal mobile format.
- For the first user-focused sync version, prioritize correctness and full-library availability over mobile storage optimization.
- Let mobile avoid opening or editing a project until the required base data is synced, but do not make selective mobile storage a first-order v1 requirement.

Desktop can later adopt the same storage model: original source as canonical import, normalized WAV as a disposable derived cache where possible, and durable generated artifacts when they are user-visible library outputs.

## Architecture Options

### TuneForge Semantic Sync Layer

TuneForge owns project manifests, artifact manifests, revision records, pairing/trust semantics, conflict rules, tombstones, staged import/export, status UX, and future remote-processing integration. The transport underneath can be custom or library-backed.

Benefits:

- Best fit for project/artifact semantics.
- Can exclude preferences and local app state by construction.
- Can model generated artifacts, user edits, conflict branches, canonical project IDs, and group delete tombstones explicitly.
- Works across Linux, macOS, mobile, and future platforms without syncing raw database files.
- Allows transport choices to change without changing the library contract.

Costs:

- More engineering work than wrapping an existing file sync tool.
- Must get identity, encryption, resumability, conflict safety, staged imports, edit locking, and delete propagation right.
- Needs careful test coverage for partial transfer, corruption, replay, path rewriting, multi-peer conflicts, and offline tombstone reconciliation.

This is the recommended product direction. Syncthing should be used as a design reference, not as the product boundary.

### Custom LAN Transport Baseline

TuneForge implements a simple native transport for the first spike: pinned device identity, local discovery, encrypted streams, manifest exchange, chunked blob transfer, resume, hash verification, and status events.

Benefits:

- Smallest conceptual surface for proving the semantic sync model.
- Keeps implementation close to TuneForge's actual requirements.
- Good benchmark for evaluating external transport libraries.
- Can start with same-LAN desktop-to-desktop sync before mobile complexity.

Costs:

- NAT traversal, relay fallback, and broader connectivity are non-trivial if needed later.
- Requires implementation and testing of resumability and transfer scheduling.
- Could duplicate functionality already available in mature peer-to-peer libraries.

This is a good control implementation for the first spike, even if it is replaced later.

### Iroh-Based Transport And Blob Layer

TuneForge uses Iroh for peer connectivity and/or content-addressed blob transfer while keeping TuneForge manifests as the semantic source of truth.

Benefits:

- Rust-native peer-to-peer transport model.
- QUIC streams can carry TuneForge-specific protocols.
- Content-addressed blob transfer maps well to source files, WAV stems, exports, previews, and analysis snapshots.
- Blob integrity verification and range/streaming transfer are directly relevant to large audio artifacts.
- Avoids adopting a generic folder-sync model as the product semantics.

Costs:

- Requires spike work for Tauri desktop and Android integration.
- Transport-specific hashes, such as BLAKE3 blob IDs, must coexist cleanly with TuneForge's SHA-256 sync contract.
- Relay policy, dependency maturity, lifecycle handling, and offline behavior need evaluation.

This is the strongest candidate for a TuneForge-owned multi-device sync transport.

### Ouisync-Based Managed Sync Substrate

TuneForge evaluates Ouisync as a managed peer-to-peer sync substrate for a TuneForge-owned sync repository containing manifests and content-addressed blobs, not raw app data.

Benefits:

- Designed as a secure peer-to-peer file sync app/library.
- Has Rust implementation and mobile-relevant bindings.
- Already targets multi-device peer-to-peer file synchronization across desktop and mobile platforms.
- Could reduce the amount of custom networking and repository synchronization code.

Costs:

- Ouisync is still file/repository oriented, not TuneForge project semantics.
- Its own repository/conflict model may or may not fit TuneForge's staged import/export model.
- Packaging, lifecycle, permissions, storage behavior, and dependency license policy need explicit evaluation.
- TuneForge would still need semantic manifests, path rewriting, revisions, edit locking, delete tombstones, and artifact import rules.
- The spike rejected Ouisync for this path because it requires external repository setup, duplicates artifact storage, and does not yet provide embedded lifecycle control.

See "Ouisync Rejection Finding" for evidence. Ouisync may remain a reference for managed repository behavior, but it is not a current transport candidate.

### Managed Syncthing Sync Bundle

TuneForge manages or guides a Syncthing-style folder containing only sync-safe data: group manifests, project manifests, revision records, tombstones, and content-addressed blobs. It must never sync the raw app data directory, SQLite database, absolute local source paths, settings, caches, logs, model files, or other machine-local state.

Benefits:

- Syncthing has proven concepts for device identity, TLS, block exchange, local discovery, resumable file sync, and multi-device folder clusters.
- Strong mental model for desktop users who already trust Syncthing.
- Existing external Syncthing setups can provide reference evidence without making Syncthing the product boundary.
- Existing REST and status concepts are useful for UX inspiration.
- Folder sync between trusted desktop installs is close to Syncthing's core strength.

Costs:

- Syncthing is file/folder sync, not TuneForge project semantics.
- Raw folder sync does not solve SQLite path rewriting, edit locking, user-edit conflicts, rebuild semantics, or group delete tombstone interpretation.
- The sync bundle would still need TuneForge manifests and staged imports.
- Runtime distribution, daemon supervision, source-compliance, licensing, packaging, upgrades, and lifecycle management need explicit review before any bundled-runtime decision.
- Mobile packaging and lifecycle management may be harder than desktop packaging, especially because the official Syncthing Android wrapper has been discontinued. This is a real product risk, but it should not block desktop reference measurement.

This option is worth evaluating as a desktop-focused comparison and power-user reference, but it should not become "sync the TuneForge data directory with Syncthing." A fast Syncthing run is useful evidence only if TuneForge still owns manifests, tombstones, conflict policy, SHA-256 verification, path rewriting, and service-level import.

### External Syncthing Integration

TuneForge detects or documents an existing Syncthing setup and exposes import/status affordances around a user-managed sync bundle. For this spike, using an existing external setup is acceptable evidence and a useful reference path. It is not a product dependency, not a required user setup, and not a reason to loosen TuneForge's sync-safe bundle boundary.

Benefits:

- Minimal protocol work.
- Useful for advanced users who already sync folders between trusted devices.
- Can provide a bridge while native sync matures.
- Provides a practical reference for block reuse, temp/conflict files, stale files, and arrival timing without building a daemon supervisor first.

Costs:

- Weak product UX for mobile and non-technical users.
- Hard to guarantee that only library data syncs unless TuneForge owns the bundle contents and rejects unsafe paths.
- Still does not solve database portability, path rewriting, edit locking, delete semantics, or semantic conflicts unless the synced folder is a TuneForge sync bundle.
- External setup varies across platforms.

This is better as an advanced compatibility/reference path than the primary product strategy. If exposed later, it must only point at a TuneForge sync bundle, never at the app data directory.

### Platform Discovery And Pairing Helpers

Android Network Service Discovery, Tauri barcode scanning, mDNS/DNS-SD, and platform-specific mechanisms can help with pairing and discovery.

Benefits:

- Useful for QR pairing, local discovery, and nearby-device flows.
- Android-specific discovery APIs may simplify some mobile cases.
- Can improve UX without defining the core sync semantics.

Costs:

- Platform-specific APIs do not solve cross-platform Linux/macOS/mobile sync by themselves.
- Discovery APIs are not a full TuneForge semantic sync system.
- Pairing/discovery must not be treated as authentication.

These mechanisms should be evaluated as discovery and pairing aids, not as the core product protocol.

## Transport Bake-Off

The transport bake-off should compare candidate transport and blob layers without moving library truth out of TuneForge's semantic manifests. The transport can discover peers, authenticate sessions, move bytes, expose progress, resume work, and report evidence. It must not become the owner of projects, revisions, conflicts, tombstones, or app state. `project_manifest`, `artifact_manifest`, `entity_revision`, `delete_tombstone`, and SHA-256 verification remain the source of truth across all options.

Manual Iroh prototype bake-off numbers are now captured below for the Mac/Linux dataset and one Mac VM fallback run. Keep adding only observed values from real runs; leave unknown fields blank or `TBD`.

The default recommendation is to keep the custom LAN baseline as the control, keep Iroh active as the strongest TuneForge-owned transport candidate, and use Syncthing only as a managed-folder reference. Current research did not show a prototype blocker for Iroh: it is Rust-native, dual MIT/Apache-2.0 licensed, provides encrypted QUIC peer connections with direct and relay paths, and `iroh-blobs` provides content-addressed verified streaming, range requests, and resumable blob downloads. The main Iroh risks are integration work, Tauri desktop and Android lifecycle, storage, relay policy, package size, and dependency maturity. The current latest `iroh-blobs` line is suitable for prototype evidence only because docs.rs marks it as not production quality.

Research notes as of 2026-05-20:

- [Iroh documentation](https://docs.iroh.computer/what-is-iroh) describes Rust-native encrypted QUIC connections, peer discovery, NAT traversal, relay fallback, and composable protocols such as `iroh-blobs`; the [Iroh repository](https://github.com/n0-computer/iroh) is dual licensed MIT/Apache-2.0.
- [`iroh-blobs`](https://docs.iroh.computer/protocols/blobs) is content-addressed with BLAKE3 and supports verified streaming, range requests, and resumable downloads. TuneForge can use those as transport internals only; SHA-256 remains the manifest contract.
- The [latest `iroh-blobs` docs.rs page](https://docs.rs/iroh-blobs/latest/iroh_blobs/) was `0.101.0` on 2026-05-20, listed MIT OR Apache-2.0 licensing, and explicitly warned that the current line is not yet production quality. Treat it as prototype-suitable, not production-ready, until a later dependency review proves otherwise.
- [Ouisync developer docs](https://ouisync.net/developers/) describe a Rust peer-to-peer sync library with Kotlin and Dart/Flutter bindings and MPL-2.0 licensing. It is mobile-relevant, but it is a managed repository/file sync substrate rather than TuneForge semantics.
- [Syncthing docs](https://docs.syncthing.net/v2.0.0/users/syncing.html) describe block exchange and file-conflict behavior, and its [specs](https://docs.syncthing.net/v2.0.0/specs/index.html) cover local/global discovery and relay protocols, but it is MPL-2.0, Go-based, folder-oriented, and the [official Syncthing Android app has been discontinued](https://forum.syncthing.net/t/discontinuing-syncthing-android/23002). A Syncthing-managed bundle is therefore a desktop comparison/reference, not the primary product boundary. Bundling or supervising the daemon would require packaging, notice, and source-compliance review first.

### Phase 2 Iroh Prototype

The Iroh transport-adapter prototype should prove whether Iroh can become the preferred TuneForge transport without moving library truth out of TuneForge's semantic sync layer. The existing custom TCP/Noise transport remains the fallback and control implementation for comparable runs.

Semantic boundaries for the prototype:

- `sync_group_manifest`, `device_manifest`, `project_manifest`, `artifact_manifest`, `entity_revision`, `delete_tombstone`, and TuneForge SHA-256 fields remain the source of truth.
- Iroh endpoint IDs, BLAKE3 blob IDs, blob tickets, relay metadata, provider/requester state, connection state, and endpoint lifecycle state are transport-local. They may appear in adapter diagnostics and Activity evidence, but they must not become project identity, artifact identity, trust identity, or manifest truth.
- TuneForge trusted peer identity remains the paired device public key. An Iroh endpoint ID can help reach a peer, but it must not establish trust by itself.
- Received artifact bytes must still be verified by TuneForge `content_sha256` before staging or import, even when `iroh-blobs` has already verified BLAKE3 streams internally.
- The default relay policy is relay-disabled/local-direct. A public or hosted relay path must stay disabled unless a future explicit user-configured relay policy is introduced.
- Fallback to the custom TCP transport is allowed only when Iroh is unsupported or unavailable for both trusted peers. Do not fall back silently after authentication, trusted-peer, manifest verification, artifact hash, or staging failures.
- The FastAPI backend remains loopback-only; the Iroh adapter lives in the native sync transport layer and never syncs raw app data directories or SQLite databases.

Evidence captured for the Iroh prototype must come from real runs. Leave fields blank or `TBD` until the prototype records actual values:

| Evidence area | Fields to record | Why it matters |
| --- | --- | --- |
| Transport selection | `selectedTransport`, `candidateTransports`, `localTransportCapabilities`, `remoteTransportCapabilities`, `fallbackReason`, `fallbackAllowed`, `fallbackUsed` | Proves Iroh was selected intentionally or explains why the control transport ran instead. |
| Iroh endpoint state | `localIrohEndpointId`, `remoteIrohEndpointId`, `endpointState`, `directPathState`, `relayPolicy`, `relayUsed`, `connectionError` | Shows whether the run stayed local-direct and whether endpoint lifecycle is stable. |
| Manifest exchange | `runId`, `syncGroupId`, `peerDeviceId`, `remoteDeviceId`, `localManifestCount`, `remoteManifestCount`, `manifestErrors` | Confirms the Iroh adapter exercised the same semantic manifest flow as the control. |
| Blob transfer identity | `artifactId`, `contentSha256`, `sizeBytes`, `irohBlobId`, `blobFormat`, `rangeRequested`, `rangeReceived`, `providerCount` | Keeps Iroh BLAKE3/blob identifiers visible as transport evidence while preserving SHA-256 as the import gate. |
| Cold transfer result | `startedAt`, `completedAt`, `durationMs`, `receivedBytes`, `timeToFirstArtifactMs`, `throughputBytesPerSecond`, `projectResults`, `failedArtifactIds` | Captures comparable first-run evidence without inventing benchmark numbers. |
| Repeated Sync Now result | `alreadyStaged`, `alreadyStagedBytes`, `alreadyLocalBytes`, `reFetchedBytes`, `skippedArtifactIds`, `durationMs` | Proves reruns avoid unnecessary transfer of already verified local content. |
| Interrupted transfer result | `interruptionPoint`, `resumeAttempted`, `rangeResumeUsed`, `bytesBeforeInterrupt`, `bytesAfterResume`, `finalContentSha256`, `status` | Shows whether Iroh range/resume behavior works for large WAV artifacts under TuneForge verification. |
| Packaging and lifecycle | `desktopBundleSizeDeltaBytes`, `rustCrateCountDelta`, `androidBuildStatus`, `tauriLifecycleNotes`, `storageBackend`, `licenseNoticeStatus` | Records production-readiness risks separately from transfer correctness. |

#### Manual Iroh Prototype Evidence As Of 2026-05-20

- Mac VM peer: Iroh was attempted, then fell back to TCP with fallback reason `Could not read sync transport frame length: connection lost`. TCP fallback completed 1050 MB in 2:58 at 5.9 MB/s with TTFA 32 s.
- Mac/Linux Iroh cold sync completed 1050 MB in 6:25 at 2.7 MB/s with TTFA 1.4 s, importing 4 projects and receiving 32 artifacts.
- Repeated Mac/Linux Iroh sync completed in 11 s, transferred 0 B, and skipped 4 projects.
- Mac/Linux TCP baseline on latest main `f74b65e` completed 1050 MB in 6:40-6:41 at 2.6 MB/s with TTFA about 1.4-1.5 s.
- Interrupted Iroh run failed cleanly on the serving Mac with `Could not write sync transport frame: connection lost`. Retry stayed on Iroh and completed 305 MB in 1:57 at 2.6 MB/s, imported 1 project, skipped 4, received 6 artifacts, reused 2 staged artifacts, and had 0 failed transfers.
- Linux-to-Mac sync after a Linux listener restart fell back to TCP with fallback reason `Timed out connecting to Iroh sync peer`. The stored Linux Iroh endpoint hint still pointed at the previous UDP port, while TCP continued to work on its stable port.

The Iroh prototype evidence supports using Iroh for end-to-end transport on this dataset: Iroh works end-to-end and is comparable to TCP on Mac/Linux. Completed verified staged content is reused after interruption. True mid-artifact `iroh-blobs` byte-range resume is not implemented or proven by these runs, so do not claim byte-range resume support yet. Direct Iroh now binds to a stable UDP port adjacent to the TCP sync port so endpoint hints survive listener restarts; stale endpoint hints should still be refreshed on pairing or successful fallback sync.

### Ouisync Rejection Finding

The Ouisync spike is closed as rejected for the current TuneForge sync path. TuneForge can write a sync-safe bundle and import it through existing services, but Ouisync did not become a usable TuneForge transport in this spike.

- Direct embedded-library adoption is blocked for this milestone. No crates.io package was found, the upstream source dependency path conflicted with the existing SQLite dependency graph during prototype work, upstream currently requires a newer Rust toolchain than the Tauri shell baseline, and MPL-2.0 requires explicit policy/notice review before runtime adoption.
- The external synced-folder harness is not acceptable product behavior. It requires users to install/configure Ouisync, create/share/import a repository, manage Ouisync access tokens, and provide a mounted repository path before TuneForge can sync.
- The first bundle design duplicated artifact bytes permanently. Run-scoped bundles with signed ack and sender-owned GC could bound storage, but still depend on external Ouisync setup and were not proven with real propagation.
- The only successful cross-device import used manual folder copying, so it proves import-through-services after files arrive, not Ouisync propagation speed, retry behavior, conflict behavior, or lifecycle.

Semantic boundaries remain useful if Ouisync is ever reconsidered:

- TuneForge pairing and trusted device keys must remain authoritative. Ouisync share tokens, repository IDs, conflict files, internal hashes, peer state, and repository status may only be diagnostics.
- Received files must still be staged and imported through TuneForge services with SHA-256 verification, path rewriting, revision checks, and tombstone reconciliation before a project becomes editable.
- Ouisync must never sync raw app data directories, SQLite databases, preferences, logs, model caches, or local settings.

Current decision: do not merge Ouisync code, do not add an Ouisync feature flag, and do not ask users to configure external Ouisync for TuneForge sync. Keep Iroh and TCP active; use Syncthing only as a sync-safe bundle reference and power-user comparison.

### Manual Syncthing Bundle Evidence

External Syncthing can be used as sync-safe bundle evidence if an existing setup is available. It should only move TuneForge sync bundles: manifests, tombstones, entity revisions, and content-addressed blobs. Do not place raw app data directories, SQLite files, absolute local paths, settings, caches, logs, model files, or generated runtime state in the Syncthing folder.

Operational manual commands belong in [SYNCTHING.md](./SYNCTHING.md), not in this spike report.

Expected Syncthing speed is not the key question. The bake-off should emphasize whether a folder-sync tool preserves TuneForge's product semantics: safe bundle boundaries, no raw database sync, no path leaks, service-level import, conflict visibility, stale file handling, and delete/tombstone behavior.

| Product question | Acceptable evidence |
| --- | --- |
| Bundle boundary | Synced contents stay limited to sync-safe manifests, tombstones, entity revisions, and content-addressed blobs. Unsafe app data, SQLite, settings, caches, logs, model files, absolute paths, and symlinks are rejected before import. |
| Semantic ownership | TuneForge imports through services with SHA-256 verification, staging, path rewriting, revision reconciliation, and tombstone handling. |
| Folder-sync behavior | Conflict, temporary, partial, and stale files are visible to TuneForge and ignored or rejected before they affect local library state. |
| Reuse behavior | Unchanged synced content can be reused without changing project semantics or bypassing TuneForge verification. |
| Delete behavior | Tombstones remain authoritative, and stale folder contents do not resurrect deleted library state. |

### Sync Validation Evidence Model

Sync validation evidence should be privacy-safe before any persistent sync logs exist. Manual notes, screenshots, copied Activity output, and future logs must record only redacted identifiers and aggregate transfer facts.

Do not record:

- Audio content or file contents.
- Filenames, original import names, absolute paths, or user-chosen display names.
- Raw device IDs, project IDs, artifact IDs, endpoint hints, pairing payloads, QR payloads, public keys, or secrets.
- LAN IP addresses, relay addresses, hostnames, or other endpoint material unless a future debug export adds explicit redaction.

Acceptable evidence:

- Redacted run labels such as `run-a`, `peer-a`, `project-1`, and `artifact-1`.
- Relative sync phases, counts, byte totals, durations, status values, and redacted error codes.
- Transport choice and fallback code when it does not expose endpoint hints or peer identity material.
- Scratch and staging peak byte usage without local path disclosure.
- Playback result summaries such as source/stem playable, duration matched, seek worked, or decoder failed with a redacted code.

Required metrics for every sync validation run:

| Metric | Evidence to capture |
| --- | --- |
| Network receive throughput | Received bytes divided by receive duration for the selected transport. |
| Backend staging throughput | Staged bytes divided by staging duration before apply. |
| Reconciliation apply time | Total backend/mobile service apply duration after staged content is verified. |
| Project import cadence | Imported projects per minute and time between successive project availability events. |
| TTFA | Time from sync start to first verified artifact becoming locally available. |
| Transfer counts | Requested, received, skipped/already-local, already-staged, failed, and retried artifacts. |
| Transport choice | Selected transport, candidate transports, and whether fallback was allowed or used. |
| Fallback reason/code | Redacted fallback reason/code, without endpoint hints or raw peer IDs. |
| Scratch/staging peaks | Peak scratch bytes and staging bytes during the run. |

For `pnpm sync:validate -- storage-peaks`, use `--samples` and `--interval-ms` during an active
run when possible. Output `peakBytes` is the max observed across samples; `sampleCount: 1` is only
the current snapshot and is not proof of the run peak.

### Baseline Evidence Fields

The current custom desktop transport records run-level and phase-level evidence that should be copied into bake-off notes before testing another candidate against the same dataset:

| Evidence area | Recorded fields | How to use it |
| --- | --- | --- |
| Run identity and before/after timing | `runId`, `peerDeviceId`, `remoteDeviceId`, `startedAt`, `completedAt`, `durationMs`, `status`, `message` | Tie every manual measurement to one sync run and compare start/end wall-clock duration across candidates. |
| Manifest exchange | `localManifestCount`, `remoteManifestCount`, `manifestErrors` | Confirm each candidate compared the same manifest set and did not hide export/import errors. |
| Project import outcome | `importedProjectCount`, `skippedProjectCount`, `failedProjectCount`, `projectResults`, `importedProjects` | Compare semantic results, not only transfer speed. A faster transport that imports fewer projects failed the bake-off. |
| Artifact transfer outcome | `receivedArtifacts[]`, `transferCounts.requested`, `transferCounts.received`, `transferCounts.alreadyStaged`, `transferCounts.failed`, `transferCounts.receivedBytes`, `transferCounts.alreadyStagedBytes` | Separate cold transfers from reused staged content and quantify bytes moved versus bytes already present. |
| Artifact-level verification | `receivedArtifacts[].artifactId`, `contentSha256`, `sizeBytes`, `status`, `message` | Prove received bytes match the semantic artifact SHA-256 before import. |
| Transport phase timing evidence | `phaseTimings[]` / `phase_timings[]` entries with `phase`, `projectId`, `artifactId`, `startedAt`, `completedAt`, and `durationMs` | Compare discovery/handshake, manifest exchange, staging checks, transfers, staging, reconciliation, cleanup, and serving phases. |
| Backend reconciliation timing | `include_timing_evidence=true` on apply requests; response `timing_evidence[]` with `phase`, `duration_ms`, `action_type`, `item_type`, `item_id`, `project_id`, `status`, and `details` | Separate transport time from backend plan/apply/action/staging-cleanup time. |
| Resumability evidence | `alreadyStaged`, `alreadyStagedBytes`, artifact statuses `already_staged`, `received`, or `failed` | The custom baseline currently proves full verified staged-content reuse on rerun; it does not prove mid-artifact byte-range resume. |

When copying these fields into validation notes, redact raw IDs and endpoint material according to "Sync Validation Evidence Model". Schema/API examples can name existing fields, but persistent evidence should not preserve raw values.

### Candidate Comparison

| Candidate | Performance | Resumability | Lifecycle | Packaging | Licensing | Mobile feasibility | Semantic-manifest fit | Recommendation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Custom LAN baseline | Mac/Linux TCP on latest main `f74b65e` completed 1050 MB in 6:40-6:41 at 2.6 MB/s with TTFA about 1.4-1.5 s. The Mac VM fallback run completed 1050 MB in 2:58 at 5.9 MB/s with TTFA 32 s. | Reuses fully verified content-addressed staging via `already_staged`; no proven mid-artifact byte-range resume. | Simple Tauri-owned listener/session lifecycle; easy to pause, stop, and surface in existing Activity UI. | Already in the Tauri/Rust desktop shell with limited dependency surface; desktop-only today. | Current Rust crates are already tracked in notices; no new managed sync runtime. | Android stubs exist, but mobile lifecycle, background networking, and permissions are not solved. | Excellent because it already exchanges TuneForge manifests, inventories, tombstones, and staged artifacts. | Keep as the control implementation for every bake-off run. |
| Iroh | Mac/Linux cold sync completed 1050 MB in 6:25 at 2.7 MB/s with TTFA 1.4 s, importing 4 projects and receiving 32 artifacts. Repeated sync completed in 11 s with 0 B transferred and 4 skipped projects. | Interrupted retry reused completed staged content: 305 MB in 1:57 at 2.6 MB/s, 1 imported, 4 skipped, 6 received artifacts, 2 reused staged artifacts, 0 failed transfers. True mid-artifact `iroh-blobs` byte-range resume is not implemented or proven. | Requires endpoint/router lifecycle, relay-disabled local-direct default behavior, stable UDP port binding, stale endpoint-hint refresh, offline behavior, and status integration inside Tauri. | Rust crates fit the shell; Android build, storage backend, and binary size need proof. | Dual MIT/Apache-2.0 is the cleanest candidate against project policy. | Iroh targets mobile, but TuneForge should integrate from Rust/Tauri rather than relying on immature non-Rust bindings. | Strong if Iroh endpoint IDs, BLAKE3 blob IDs, relay metadata, and endpoint state remain transport-local while TuneForge SHA-256 manifests stay authoritative. | The prototype proves Iroh works end-to-end and is comparable to TCP on Mac/Linux for this dataset; keep it prototype-gated until production-readiness risks are closed. |
| Ouisync | Rejected. The only completed import used `rsync`, not Ouisync propagation. | Repeated service import skipped existing projects after manual copy; repository retry behavior was not proven. | Rejected: external repository/share-token/mount lifecycle would leak into TuneForge UX, and permanent duplicate artifacts are unacceptable. | No crates.io package; source integration conflicted with the current dependency graph; upstream toolchain requirement is higher than the current shell baseline. | MPL-2.0 needs explicit notice/policy review before runtime adoption. | Not pursued. | Medium technically after files arrive, but TuneForge still owns manifests, trust, staging, SHA-256, revisions, and tombstones. | Do not merge Ouisync code or expose a prototype flag. |
| Syncthing-managed sync bundle | Can move a sync-safe bundle through user-managed folder sync. Speed is secondary to preserving the bundle boundary. | May reuse unchanged files at the folder layer, but conflict, temporary, and stale-file behavior still need product-level handling. Syncthing conflicts are file conflicts, not TuneForge conflicts. | External setup can serve as reference evidence; bundled daemon lifecycle, REST/admin surface, supervision, upgrades, and user configuration remain product risks. | Go binary/service packaging is heavier than Rust crates and may vary by desktop platform. | MPL-2.0 requires explicit policy, notice, and source-compliance review before bundling. | Deferred for this comparison. Official Android app discontinuation is a risk, but it should not block desktop reference measurement. | Medium: acceptable only if it transports manifests/blobs and TuneForge still imports through services. Moving bundle files does not make Syncthing the semantic layer. | Use as desktop-focused comparison and power-user/reference path, not the default implementation or required user setup. |

### Manual Measurement Template

Fill this table with real evidence from the fields above. Do not enter estimated throughput or invented durations.

| Date | Candidate | Scenario | Devices and network | Dataset | Before/control evidence | After/result evidence | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-05-20 | Custom LAN baseline | Cold import | Mac/Linux, latest main `f74b65e` | 1050 MB | TCP control run | Completed in 6:40-6:41 at 2.6 MB/s with TTFA about 1.4-1.5 s | Control row for comparison. |
| 2026-05-20 | Custom LAN fallback | Iroh attempted, TCP fallback | Mac VM peer | 1050 MB | Iroh attempted first | TCP fallback completed in 2:58 at 5.9 MB/s with TTFA 32 s | Fallback reason: `Could not read sync transport frame length: connection lost`. |
| 2026-05-20 | Iroh | Cold import | Mac/Linux | 1050 MB, 4 projects, 32 artifacts | Iroh selected | Completed in 6:25 at 2.7 MB/s with TTFA 1.4 s; imported 4 projects and received 32 artifacts | Comparable to TCP on this dataset. |
| 2026-05-20 | Iroh | Repeated Sync Now | Mac/Linux | Same staged dataset | Previous Iroh cold sync completed | Completed in 11 s, transferred 0 B, skipped 4 projects | Proves completed verified content is reused. |
| 2026-05-20 | Iroh | Interrupted run and retry | Mac/Linux | 305 MB retry subset | Serving Mac failed cleanly with `Could not write sync transport frame: connection lost` | Retry stayed on Iroh and completed in 1:57 at 2.6 MB/s; imported 1 project, skipped 4, received 6 artifacts, reused 2 staged artifacts, 0 failed transfers | Proves verified staged-content reuse after interruption; true mid-artifact byte-range resume is not implemented or proven. |
| 2026-05-20 | Iroh | Stale endpoint hint fallback | Linux-to-Mac after Linux listener restart | 227 MB, 1 project, 8 artifacts | Stored Linux Iroh hint pointed at a previous UDP port | Fallback to TCP completed in 1:37 at 2.3 MB/s with TTFA 19 s; imported 1 project and skipped 5 | Follow-up: stable Iroh UDP port and endpoint-hint refresh. |

The interrupted lyrics-job convergence edge case is a sync v2 follow-up and does not block the transport bake-off. Completed lyrics revisions and artifacts should still sync as durable library state, but interrupted runnable jobs are not part of the v1 sync truth and should not determine the transport bake-off outcome.

### Sync Validation Checklist

Use this checklist for manual sync validation evidence. Keep every row tied to redacted run labels from "Sync Validation Evidence Model" and compare candidates against the same dataset where possible.

| Scenario | Pass evidence |
| --- | --- |
| Desktop to desktop | A desktop import on peer A becomes available on peer B after manifest exchange, transfer, staging, SHA-256 verification, and service-level import. Record required metrics, transfer counts, and TTFA. |
| Desktop to Android | A desktop import becomes available on Android as normal library state. Android records selected transport, fallback reason/code if used, staging/apply timing, storage peaks, and playback results for synced source and stem artifacts. |
| Android to desktop | An Android import or Android-origin durable project change becomes available on a desktop peer through the same sync group model. Record import cadence, transfer counts, staging/apply timing, selected transport, and fallback reason/code if any. |
| Three-device join and catch-up | A third peer joins an existing group, catches up from trusted online peers, and reaches the same project/artifact/revision/tombstone state. Record which peers were online, project import cadence, TTFA, and missing-provider behavior without raw IDs. |
| Retry and resume | Interrupt a run, restart sync, and prove completed verified staging is reused. Record retried counts, already-staged counts/bytes, failed counts, final verification status, and whether byte-range resume was actually proven. |
| Listener lifecycle | Start, stop, restart, pause, and resume listeners on desktop and Android where supported. Record selected transport, fallback reason/code, stale-hint handling, and whether peers recover without duplicating imports. |
| Playback validation | Open synced projects only after the minimum usable set is verified. Play synced source and desktop WAV stem artifacts on desktop and Android, then record playable/seek/duration-match outcomes and redacted decoder failures. |
| Syncthing control benchmark | Use only an external user-managed Syncthing setup moving a TuneForge sync bundle. Record control timing, transfer counts if available, safe bundle boundary checks, and service-level import results. Do not treat Syncthing as a product dependency or implementation requirement. |

Accepted sync validation evidence must not claim mid-artifact byte-range resume, Android transport parity, background sync lifecycle, or Syncthing product readiness unless the specific run proves it.

## Recommended Direction

Build a TuneForge-owned semantic sync layer with a swappable transport/blob layer. The sync layer should operate above backend persistence and below UI workflows. It should treat Linux desktop, macOS desktop, and mobile as peers in the same trusted sync group.

```mermaid
flowchart TD
  UI["React UI"] --> Client["TuneForgeClient"]
  Client --> Desktop["Desktop HTTP backend"]
  Client --> Mobile["Mobile Tauri backend"]
  Desktop --> SyncService["Semantic sync service"]
  Mobile --> SyncService
  SyncService --> Manifests["Group/project/artifact manifests"]
  SyncService --> Revisions["Entity revisions, rebuilds, and conflicts"]
  SyncService --> Tombstones["Delete tombstones"]
  SyncService --> Staging["Content-addressed artifact staging"]
  SyncService --> Transport["Swappable encrypted transport"]
  Transport --> PeerA["Linux TuneForge peer"]
  Transport --> PeerB["macOS TuneForge peer"]
  Transport --> PeerC["Mobile TuneForge peer"]
```

The first real implementation milestone should be library sync between two desktop installs, ideally Linux and macOS. The next milestone should add a third peer and prove that any two online peers can continue syncing while the third is offline. Mobile should join after the desktop-to-desktop semantic model is proven, with the same library model and measured WAV playback behavior. Remote processing should remain decoupled from the sync spike.

Recommended spike sequence:

1. Existing-library migration preflight: compute missing source hashes, detect duplicate source hashes, re-key safe projects to canonical IDs, and fail hard if manual cleanup is required.
2. Manifest-only desktop project export/import with path rewriting and hash verification.
3. Strict duplicate import behavior based on source SHA-256.
4. Content-addressed artifact staging and idempotent import.
5. Entity revision records for project metadata, chords, lyrics, sections, and regeneration events.
6. Group delete tombstones for project/artifact/entity deletion.
7. Edit-locking for syncing projects until minimum usable data is verified.
8. Linux-to-macOS desktop sync on the same LAN.
9. Three-peer desktop sync behavior.
10. Transport bake-off: keep the custom LAN baseline as the control, keep Iroh active, and use an external Syncthing setup only as a sync-safe bundle reference. Ouisync is rejected for the current transport path.
11. Mobile library sync and WAV playback/battery validation.

## Security Model

The security bar should be "local-first, explicit trust, encrypted by default."

Sync group identity:

- A sync group has a stable `sync_group_id`.
- Devices join a sync group through explicit trust establishment.
- V1 can support a single sync group per install even if the data model leaves room for multiple groups later.

Device identity:

- Each install generates a long-lived local keypair.
- The public identity derives a stable device ID.
- Pairing stores the peer's device ID and public identity.
- Trust is explicit and revocable.
- Device display names are convenience labels, not identity.
- Trust should be pairwise in v1. Joining the same sync group should not automatically grant transitive trust. A device may announce that it knows another peer, but each receiving install should explicitly trust that peer before accepting manifests, revisions, tombstones, or artifact bytes from it.

Pairing:

- QR code should be the primary mobile pairing flow.
- Desktop-to-desktop can use local discovery to find candidates, but still requires explicit confirmation.
- Desktop-to-desktop should also support a manual code or copy/paste pairing path for networks where discovery is unavailable.
- Pairing payload should include sync group ID, device ID, display name, endpoint hints, protocol version, and a short-lived pairing secret or confirmation code.

Transport and manifest authenticity:

- Use encrypted peer-to-peer transport with pinned peer identity.
- Discovery announces candidates, not trust.
- Verify every received artifact by SHA-256 before importing it.
- Use chunk/block hashes or transport-level verified streaming for large artifacts and resumable transfers.
- Include nonces/session IDs to avoid replaying stale transfer messages.
- Manifests, entity revisions, and delete tombstones should carry author device metadata and should be signed by the author device or otherwise authenticated with a group/pairing key, especially if TuneForge ever supports a Syncthing-managed or externally synced bundle.
- Keep the existing FastAPI backend loopback-only; LAN exposure belongs in a separate native sync layer.

LAN discovery:

- Syncthing local discovery is a useful reference for announcing device IDs and addresses over a LAN.
- Android NSD provides local service discovery APIs and should be evaluated for mobile-friendly discovery.
- QR/manual pairing must work even when LAN discovery is unavailable.

Risks:

- Local discovery spoofing is possible if discovery is treated as authentication. It must not be.
- A compromised paired device can send bad metadata unless manifests are validated strictly.
- Automatic group delete propagation can cause data loss if tombstones are accepted too broadly or without user intent.
- Sync group membership revocation needs careful behavior for devices that were offline during revocation.
- Public backend binding would violate the current trust boundary. Keep FastAPI loopback-only and put LAN exposure in the native sync layer.

## Data Sync Model

Sync should be content-aware, project-aware, and group-aware:

1. Create or join a sync group.
2. Run migration preflight before enabling sync on an existing library.
3. Pair devices and exchange identities, protocol versions, and basic platform capabilities.
4. Exchange library manifests and peer inventory.
5. Compare project revisions, entity revisions, artifact manifests, artifact hashes, and delete tombstones.
6. Create read-only syncing project placeholders where metadata has arrived but required base data is incomplete.
7. Queue missing metadata and files.
8. Choose a provider for each missing content hash from the set of trusted online peers.
9. Transfer files in chunks or verified streams with hash verification.
10. Stage incoming project data under a temporary path.
11. Import staged data through backend/mobile services so database rows and filesystem paths stay consistent.
12. Mark the project editable only after the minimum usable set is local and verified.
13. Apply regeneration revisions and delete tombstones through backend services, not raw database writes.
14. Update availability state and provider inventory.
15. Emit sync status events for UI.

Multi-peer behavior:

- No device should be treated as the permanent master.
- Any peer can introduce new project metadata, artifacts, user edits, rebuilds, or group delete tombstones when the relevant project is fully available locally.
- Any peer that has verified bytes can serve those bytes to another trusted peer.
- A device can be offline without making the sync group failed.
- A new peer should be able to catch up from whichever trusted peers are online and have the required data.

Conflict policy:

- Generated output conflicts can usually keep both artifacts or surface a replacement conflict.
- User-edited lyrics/chords/sections require explicit conflict UI.
- Project rename conflicts can use newest update while preserving alternate names in conflict metadata.
- Job history conflicts should not block sync because historical jobs are not authoritative library state.
- Entity-level conflicts should use revision ancestry, not only wall-clock timestamps.
- Delete tombstones should usually win over older manifests, but only after validating author identity, target identity, and sync group membership.

Offline and reconnect behavior:

- Devices keep a durable outbound/inbound sync queue.
- Completed transfers are idempotent by SHA-256.
- Partial transfers resume by chunk hash or verified range request where supported.
- A device can mark another as offline without marking sync failed.
- Manual "Sync now" should force manifest exchange and retry failed transfers.
- If a device misses multiple rounds of changes, it should reconcile from manifests, revisions, and tombstones rather than replaying fragile event logs.

## Remote Processing Boundary

Remote processing is not part of v1 sync.

If revisited later, it should be capability-based and scheduler-driven, not hard-coded as "mobile asks desktop." Different devices can have very different practical performance profiles: a fast Apple Silicon laptop may be a better executor than an older Linux GPU box even if both advertise stem capability. A later scheduler would need to account for capability, expected speed, current load, power state, user preference, and availability.

Future remote job research should answer:

- Whether remote processing is needed after library sync exists.
- Whether the user picks an executor or TuneForge chooses automatically.
- How devices advertise expected performance without creating confusing promises.
- Whether remote jobs can be canceled, retried, or reassigned.
- How returned outputs become normal artifacts through the sync layer.

For this spike, keep mobile "sync only" once backend parity exists.

## Frontend UX

Use existing TuneForge UI patterns first.

Settings:

- Add a "Sync Group" or "Connected Devices" section near Local Data.
- Show this device name, device ID, and sync group ID.
- Do not expose local `project_id` as a normal user-facing concept.
- Actions: create sync group, join sync group, show QR code, scan QR code on mobile, discover nearby devices, copy pairing code, unpair device, pause sync, sync now.
- Show migration/preflight status before sync is enabled on an existing library.
- Show per-device status: online, last seen, last sync, pending transfers, paused, conflict count.
- Show group-level state: all synced, syncing, partial availability, conflicts, offline peers.

Library:

- Add a compact sync summary near the library toolbar.
- Show global state such as "All synced", "2 peers online", "3 transfers pending", "Waiting for MacBook", "Artifacts available remotely", or "2 conflicts".
- Avoid turning the library into a sync dashboard.
- Allow syncing projects to appear, but keep them visually distinct and non-editable until required data is verified.
- When importing a track whose source SHA-256 already exists, show a hard failure such as: `You already have project "<project name>" imported.` The UI should offer to open the existing project, not create a duplicate.

Project:

- Add project-level sync state near existing job/status surfaces.
- Show artifact-level availability for large files: local, remote, downloading, missing, deleted.
- Show artifact-level progress for large transfers only when relevant.
- Disable edits while the project is still syncing its minimum usable set.
- Link conflicts to the affected lyrics/chords/sections/artifacts.
- Rebuild actions for chords, lyrics, stems, mixes, previews, and exports should make clear that rebuilt outputs become synced library state.
- Delete actions should make clear that deleting a synced project or artifact deletes it from the sync group, not just from the current device.

Notifications:

- Start with inline `role="status"` regions and compact app chrome indicators.
- Add a small in-app notice system only if background sync needs global completion/failure feedback while the user is outside the relevant project.
- System notifications should not be part of the first sync spike.

## Validation Plan

For the eventual implementation spike, validate in this order:

1. Existing-library migration tests for projects with random IDs, missing source hashes, duplicate source hashes, and successful canonical project ID assignment.
2. Manifest tests for desktop project export/import, path rewriting, hashes, and dedupe.
3. Deterministic canonical project ID tests from full source SHA-256.
4. Duplicate import tests proving same-source imports fail hard and point to the existing project.
5. Staged import tests proving that synced data is imported through backend services rather than raw database writes.
6. Entity revision tests for chords, lyrics, sections, project renames, base revision tracking, rebuild events, and conflict branches.
7. Delete tombstone tests for project deletes, artifact deletes, offline-peer delete reconciliation, and resurrection prevention.
8. Edit-lock tests proving syncing projects are visible but not editable until required base data is present.
9. Pairing tests for QR/manual payload validation, trust storage, unpairing, invalid peer rejection, pairwise trust, and sync group ID handling.
10. Transfer tests for chunk verification, partial resume, corruption rejection, provider switching, and idempotent replays.
11. Conflict tests for edited lyrics/chords/sections, project rename conflicts, concurrent rebuilds, delete-vs-update races, and divergent generated artifacts.
12. Artifact availability tests for local artifacts, remote artifacts, missing providers, deleted artifacts, and transfer state.
13. Frontend tests for Settings pairing UI, migration/preflight status, duplicate import failure, library status, project sync status, artifact availability, conflict surfacing, edit disabling, group delete warnings, and accessible status updates.
14. Transport bake-off tests comparing custom LAN baseline, Iroh, and a Syncthing-managed sync bundle reference if an existing external setup is available. Ouisync has been rejected for this path.
15. Mobile WAV validation:
    - Validation notes identify the transport path used, selected fallback, and any Android
      transport gaps.
    - WAV source/stem playback works from synced desktop artifacts.
    - Battery and CPU usage are measured against AAC/M4A or another compressed baseline.
    - Storage and transfer costs are visible in the sync UI.
    - Playback does not require special mobile-to-desktop sync semantics.
16. Manual multi-device tests:
    - Linux desktop to macOS desktop on the same LAN.
    - macOS desktop to Linux desktop on the same LAN.
    - Three peers in one group, such as Linux desktop, macOS desktop, and mobile.
    - One peer offline while the other two continue syncing.
    - Offline import then reconnect.
    - Same source imported independently on two devices and merged or rejected by source hash according to manifest state.
    - Duplicate local imports fail hard with the existing project name.
    - WAV stem sync to mobile playback.
    - Rebuilt chords/lyrics on one peer sync to the other peers.
    - Deleted projects/artifacts on one peer are deleted from all peers after reconnect.
    - Conflicting lyric/chord edits on two fully synced devices.

## Open Questions

- Should v1 sync job history at all, or only current durable outputs and metadata?
- How long should delete tombstones be retained?
- Should TuneForge support undo for group deletes, and if so, how does that interact with offline peers?
- Should source imports always copy into the project for syncable projects?
- How should future intentional same-source variants be represented if the v1 policy forbids duplicates?
- Which transfer implementation is best for Tauri desktop and Android: custom LAN QUIC/TLS, Iroh, Syncthing-managed sync bundle, WebRTC data channels, or managed local HTTP over a pinned encrypted tunnel?
- If a transport uses BLAKE3 or another internal content hash, how should that coexist with TuneForge's SHA-256 artifact hashes?
- Does embedding or managing any Syncthing-like component satisfy dependency/license policy?
- Should mobile storage pruning or local-only eviction exist later, or is full-library sync good enough for the expected personal library size?
- Should a sync group support multiple libraries in the future, or is one library per app install enough?
- Is relay/NAT traversal required for v1, or should v1 be same-LAN only?
- How should sync group membership revocation work when a revoked device was offline?

## Primary Sources

Repo docs:

- [SPEC.md](./SPEC.md)
- [MOBILE.md](./MOBILE.md)
- [API.md](./API.md)
- [ROADMAP.md](./ROADMAP.md)

Repo implementation:

- `apps/backend/app/models.py`
- `apps/backend/app/services/projects.py`
- `apps/backend/app/services/artifacts.py`
- `apps/backend/app/services/paths.py`
- `apps/desktop/src/lib/api.ts`
- `apps/desktop/src-tauri/src/mobile_backend.rs`
- `apps/desktop/src-tauri/src/native_audio/decode.rs`

External references:

- Syncthing Block Exchange Protocol: <https://docs.syncthing.net/specs/bep-v1.html>
- Syncthing Device IDs: <https://docs.syncthing.net/dev/device-ids.html>
- Syncthing Local Discovery: <https://docs.syncthing.net/specs/localdisco-v4.html>
- Syncthing REST API: <https://docs.syncthing.net/dev/rest.html>
- Iroh protocol docs: <https://docs.iroh.computer/concepts/protocols>
- Iroh blobs protocol: <https://docs.iroh.computer/protocols/blobs>
- Ouisync project: <https://github.com/equalitie/ouisync>
- Ouisync developer docs: <https://ouisync.net/developers/>
- Tauri Barcode Scanner plugin: <https://v2.tauri.app/plugin/barcode-scanner/>
- Android supported media formats: <https://developer.android.com/media/platform/supported-formats>
- Android `AudioTrack`: <https://developer.android.com/reference/android/media/AudioTrack>
- Android Network Service Discovery: <https://developer.android.com/develop/connectivity/wifi/use-nsd>
