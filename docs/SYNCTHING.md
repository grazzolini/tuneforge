# Syncthing Sync Bundle

Use this only for manual or power-user testing with an existing external Syncthing install. TuneForge does not bundle, launch, or supervise Syncthing.

Syncthing is a control/reference path for comparing a TuneForge sync bundle against native
transports. It is not a dependency, product requirement, or source of library truth.

## Safety Boundary

- Sync only the bundle directory passed to `--bundle-root`.
- Do not point Syncthing at `TUNEFORGE_DATA_DIR`, `app.sqlite`, `projects/`, `cache/`, logs, settings, model caches, or the desktop app data directory.
- The bundle contains sync-safe manifests, tombstones, entity revisions, and content-addressed blobs. TuneForge still imports through backend services and verifies SHA-256 before projects become local.
- Export copies artifact blobs into the bundle. Large one-time syncs can temporarily need roughly 2x storage: existing TuneForge project storage plus the exported bundle.
- Deleting the Syncthing bundle after import does not delete imported projects. Imported artifacts are staged/copied into local TuneForge storage.

## Export

Run from the repository root. Use a provider device id that the receiving install already trusts.

```sh
export TUNEFORGE_DATA_DIR=/tmp/tuneforge-peer-a/data
export TUNEFORGE_SYNC_BUNDLE=/tmp/tuneforge-syncthing/bundle
mkdir -p "$TUNEFORGE_SYNC_BUNDLE"

pnpm sync:bundle -- export \
  --bundle-root "$TUNEFORGE_SYNC_BUNDLE" \
  --provider-device-id peer-a
```

To export selected projects only, repeat `--project-id`:

```sh
pnpm sync:bundle -- export \
  --bundle-root "$TUNEFORGE_SYNC_BUNDLE" \
  --provider-device-id peer-a \
  --project-id proj_sha256_example_a \
  --project-id proj_sha256_example_b
```

Configure Syncthing outside TuneForge to sync only `$TUNEFORGE_SYNC_BUNDLE` to the other peer's bundle folder. Wait until Syncthing reports the folder is up to date before importing.

## Import

On the receiving install, use its own TuneForge data directory and the synced bundle path:

```sh
export TUNEFORGE_DATA_DIR=/tmp/tuneforge-peer-b/data
export TUNEFORGE_SYNC_BUNDLE=/tmp/tuneforge-syncthing/bundle

pnpm sync:bundle -- import \
  --bundle-root "$TUNEFORGE_SYNC_BUNDLE" \
  --provider-device-id peer-a
```

Import stages and verifies content-addressed blobs, rewrites paths for the local install, then applies manifests, revisions, and tombstones through TuneForge services. It does not attach the project to the Syncthing folder.

## Control Benchmark

Use this benchmark only when an existing external Syncthing setup is already available. Compare it
against the same dataset used for the custom LAN or Iroh run, and keep all evidence privacy-safe as
defined in [MULTI_DEVICE_LIBRARY_SYNC_SPIKE.md](./MULTI_DEVICE_LIBRARY_SYNC_SPIKE.md#issue-203-evidence-model).

Record:

- Bundle export duration and byte count.
- Syncthing folder receive duration and receive throughput when available.
- TuneForge import staging throughput, reconciliation apply time, project import cadence, TTFA, and
  transfer counts.
- Scratch/staging peak bytes for the TuneForge import side.
- Safe bundle boundary checks: no raw app data, SQLite files, logs, caches, settings, model files,
  symlinks, absolute paths, filenames, display names, endpoint hints, raw IDs, or pairing payloads.
- Conflict, temporary, partial, stale, and deleted-file observations before TuneForge import.

Passing this benchmark means the external folder sync moved a sync-safe bundle and TuneForge
imported it through services with verification. It does not make Syncthing required for TuneForge
sync, and it does not validate raw folder sync of TuneForge app data.

## Bidirectional Runs

Avoid simultaneous exports into the same bundle. Let one peer export, let Syncthing finish, then import on the other peer.

To send changes back, export from the second peer with its trusted provider id, wait for Syncthing, then import on the first peer:

```sh
export TUNEFORGE_DATA_DIR=/tmp/tuneforge-peer-b/data
export TUNEFORGE_SYNC_BUNDLE=/tmp/tuneforge-syncthing/bundle
pnpm sync:bundle -- export \
  --bundle-root "$TUNEFORGE_SYNC_BUNDLE" \
  --provider-device-id peer-b

export TUNEFORGE_DATA_DIR=/tmp/tuneforge-peer-a/data
export TUNEFORGE_SYNC_BUNDLE=/tmp/tuneforge-syncthing/bundle
pnpm sync:bundle -- import \
  --bundle-root "$TUNEFORGE_SYNC_BUNDLE" \
  --provider-device-id peer-b
```

After every intended peer has imported the bundle, remove the folder from Syncthing first. If you no longer need the
local bundle files, delete only the known TuneForge bundle entries after checking the bundle marker:

```sh
if [ -n "${TUNEFORGE_SYNC_BUNDLE:-}" ] &&
   [ -f "$TUNEFORGE_SYNC_BUNDLE/bundle.json" ] &&
   [ -d "$TUNEFORGE_SYNC_BUNDLE/projects" ] &&
   [ -d "$TUNEFORGE_SYNC_BUNDLE/blobs/sha256" ]; then
  rm -- "$TUNEFORGE_SYNC_BUNDLE/bundle.json"
  rm -r -- "$TUNEFORGE_SYNC_BUNDLE/projects" "$TUNEFORGE_SYNC_BUNDLE/blobs"
  rmdir -- "$TUNEFORGE_SYNC_BUNDLE" 2>/dev/null || true
else
  echo "Refusing cleanup: TUNEFORGE_SYNC_BUNDLE does not look like a TuneForge sync bundle." >&2
fi
```
