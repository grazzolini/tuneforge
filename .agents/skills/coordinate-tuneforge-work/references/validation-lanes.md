# Validation Lanes

Apply only lanes justified by affected surfaces. Preserve user-owned desktop
app lifecycle and installed state in every lane.

## UI and User-Facing Behavior

Use Product Design on Sol High for a pre-implementation brief and final QA.
Check screens/states, interaction model, truthfulness, brief consistency, and
absence of fake or misleading data. Capture screenshots when they are useful
evidence. Do not use this lane for code, backend contract, or music-theory
correctness.

## Contracts

Use `tuneforge_contract_guard` on Terra High only if schemas, API routes,
OpenAPI, generated types, or their callers could drift. Validate actual
producer/consumer compatibility. Do not run this lane for unrelated internal
refactors.

## Android Runtime

Use Android emulator and CLI only when the issue needs mobile runtime evidence.
Do not touch installed app data, identity, trusted peers, or transport state.
Do not control a user-owned desktop app. Before any import, pairing, or sync,
prove all of: a fresh `TUNEFORGE_DATA_DIR`, a fresh
`TUNEFORGE_SYNC_TRANSPORT_DATA_DIR`, isolated app/WebView identity storage, and
an isolated backend port. If any isolation boundary cannot be proven, stop and
request a safe handoff.

## Sync and Transport

Run existing validator and privacy checks relevant to changed evidence. Report
local state validation separately from proven live transport. A successful
validator, mocked transport, pairing UI, or emulator-only flow does not prove
cross-device delivery, import, persistence on a peer, or release behavior.

## Research and Benchmark Evidence

Define question, method, datasets or fixtures, environment or hardware
baseline, licensing constraints, timebox, and recommendation criteria. Preserve
only sanitized measurements and reproducible command templates; exclude
secrets, private paths, raw IDs, endpoints, and pairing payloads, following
surface-specific privacy and data rules. Report benchmark comparability limits;
do not generalize beyond evidence or treat a local spike as production proof. A
supported negative or defer recommendation is valid.

## Manual or Hardware Steps

Pause before actions requiring user-owned devices, credentials, pairing,
physical hardware, or human-visible desktop lifecycle control. Provide exact
safe handoff steps and expected evidence. Resume only from evidence supplied by
the user; label unperformed steps as unverified.

## Evidence Format

For every lane, report:

- command or manual procedure;
- observed result;
- behavior that result proves;
- behavior it does not prove;
- remaining user handoff, if any.
