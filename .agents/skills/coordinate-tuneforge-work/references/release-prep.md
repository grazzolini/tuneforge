# TuneForge Release Preparation

Use this workflow for a named TuneForge release. Treat the release-preparation
PR and the later tagged-release operations as separate authority scopes.

## Readiness and Release Contract

- Read the release tracker, milestone, merged PRs since the previous tag,
  `CHANGELOG.md`, governed version sources, packaging docs, and package scripts.
- Require a clean worktree based on fresh `origin/main`. Before editing, fetch
  `main` and tags and use the user-approved rebase/update strategy. Never
  overwrite unrelated work.
- Prepare one normal release PR unless the approved plan says otherwise. That
  PR updates the curated changelog, all governed version sources, generated
  lock entries, current version fixtures, and this skill when needed.
- Regenerate lockfiles with their owning tools. Do not hand-edit generated
  dependency or contract outputs.
- Require green release-version, license-inventory, lint, typecheck, test,
  backend, Tauri, and deterministic release-media gates before tagging. Report
  only checks actually run and preserve generated release media as uncommitted
  local output.

From v1.4.0 onward, TuneForge releases require exactly seven payloads:

1. `TuneForge_<version>_aarch64.dmg`
2. `TuneForge_<version>_android_aarch64_publishable.apk`
3. `Tuneforge_<version>_x86_64.flatpak`
4. `Tuneforge_<version>_Torch_Nvidia_Core_x86_64.flatpak`
5. `Tuneforge_<version>_Torch_Nvidia_Runtime_x86_64.flatpak`
6. `Tuneforge_<version>_Torch_LegacyNvidia_Core_x86_64.flatpak`
7. `Tuneforge_<version>_Torch_LegacyNvidia_Runtime_x86_64.flatpak`

Every payload has a detached `.asc` signature. The release `SHA256SUMS` covers
exactly the seven payloads, sorted by basename, and has its own detached
`SHA256SUMS.asc` signature. `release-key.asc` completes the exact 17 uploaded
assets. Never reuse the ignored packaging output
`packaging/flatpak/generated/SHA256SUMS` as the release manifest.

Apply this verification matrix before upload and again to a fresh download:
every checksum entry must match the payload digest, and every detached `.asc`
must verify against the approved `release-key.asc` fingerprint.

| Exact payload filename | Provenance | Size | Checksum and signature | License evidence | Architecture / branch | Package or ref identity |
| --- | --- | --- | --- | --- | --- | --- |
| `TuneForge_<version>_aarch64.dmg` | Frozen tagged SHA | Recorded, nonzero | Sorted manifest entry + matching `.asc` | Release inventory + notices | `aarch64` / n/a | `TuneForge`, embedded version and git ref |
| `TuneForge_<version>_android_aarch64_publishable.apk` | Frozen tagged SHA | Recorded, nonzero | Sorted manifest entry + matching `.asc` | Release inventory + notices | `arm64-v8a` / n/a | `com.tuneforge.desktop`, version, release signer |
| `Tuneforge_<version>_x86_64.flatpak` | Frozen tagged SHA and OSTree commit | Recorded, below 2 GiB | Sorted manifest entry + matching `.asc` | CPU profile inventory + notices | `x86_64` / `stable` | `app/com.tuneforge.desktop/x86_64/stable` |
| `Tuneforge_<version>_Torch_Nvidia_Core_x86_64.flatpak` | Frozen tagged SHA and OSTree commit | Recorded, below 2 GiB | Sorted manifest entry + matching `.asc` | NVIDIA Core inventory + notices | `x86_64` / `stable` | `runtime/com.tuneforge.desktop.Torch.Stack.Nvidia.Core/x86_64/stable` |
| `Tuneforge_<version>_Torch_Nvidia_Runtime_x86_64.flatpak` | Frozen tagged SHA and OSTree commit | Recorded, below 2 GiB | Sorted manifest entry + matching `.asc` | NVIDIA Runtime inventory + notices | `x86_64` / `stable` | `runtime/com.tuneforge.desktop.Torch.Stack.Nvidia.Runtime/x86_64/stable` |
| `Tuneforge_<version>_Torch_LegacyNvidia_Core_x86_64.flatpak` | Frozen tagged SHA and OSTree commit | Recorded, below 2 GiB | Sorted manifest entry + matching `.asc` | LegacyNvidia Core inventory + notices | `x86_64` / `stable` | `runtime/com.tuneforge.desktop.Torch.Stack.LegacyNvidia.Core/x86_64/stable` |
| `Tuneforge_<version>_Torch_LegacyNvidia_Runtime_x86_64.flatpak` | Frozen tagged SHA and OSTree commit | Recorded, below 2 GiB | Sorted manifest entry + matching `.asc` | LegacyNvidia Runtime inventory + notices | `x86_64` / `stable` | `runtime/com.tuneforge.desktop.Torch.Stack.LegacyNvidia.Runtime/x86_64/stable` |

The DMG, publishable APK, CPU Flatpak, and both Core/Runtime accelerator pairs
are mandatory. Treat all five Flatpak payloads as release-gated: missing or
malformed identity/ref, hash, signature, size, license, or provenance evidence
fails closed. Preserve CPU fallback even when optional accelerator-device
detection and inference evidence is unavailable.

Create a named temporary staging directory and print its absolute path. Retain
it through final publication and remote verification. Show its explicit
cleanup command, but never run cleanup automatically.

## Manual Steps and Automation Boundary

Never run artifact-signing commands, `pnpm package:android:release`, or final
release publication. The Linux Flatpak build and every packaged-app launch are
manual handoffs; the user owns launches and app data. Never access or automate KeePassXC, inspect private keys
or passwords, request secrets in chat, or rely on a cached artifact-signing
identity. An approved signed-tag command may use the repository-configured Git
signing identity without accessing KeePassXC or inspecting or exporting key
material.
Manual steps export any temporary PKCS12 file, enter signing environment values,
run the Android release build, create signatures, export the public key, and
publish the verified draft.

Codex may prepare exact commands; create a signed annotated tag only after its
checkpoint stop and fresh explicit approval; and verify public artifacts,
checksums, signatures, certificate fingerprints, tags, commits, package
identities, and GitHub state. Each checkpoint needs fresh explicit authority
for the actions after that stop. Merge authority is always separate.

## Checkpoint 1: Before Signed Tag

1. Require the release-preparation PR merged with green CI. Refresh the local
   checkout, require a clean worktree, and prove `HEAD == origin/main`.
2. Freeze the release commit SHA. Verify version sources, dated changelog, tag
   absence, the seven-payload/17-asset contract, and release readiness from
   that exact commit.
3. Stop. Show the exact signed annotated-tag command and await fresh explicit
   approval.
4. After approval, create the signed annotated tag, then verify its signature,
   annotation, target, release SHA, `main` equality, and clean state.
5. Push the verified tag only after separate explicit approval. Never move or
   delete a pushed release tag. Any code correction requires a roll-forward
   version and a new plan.

## Checkpoint 2: Before Draft Release

1. Create the staging directory, `release-notes.md`, and an expected-asset
   manifest containing exactly the seven payload names above, their seven
   exact `.asc` names, `SHA256SUMS`, `SHA256SUMS.asc`, and `release-key.asc`.
2. Cover user-visible changes, downloads, installation, checksum/signature
   verification, Android update identity, unsigned/not-notarized macOS status,
   the CPU-only Flatpak runtime gate, optional accelerator evidence, and known
   limitations. Tell Linux users that Flatpak support is x86_64 only, the CPU
   app installs first, and accelerator extensions install only as a complete
   matching Core/Runtime pair. State that FFmpeg remains host-provided and must
   be available through the Flatpak runtime/extension paths. Keep operational
   details out of `CHANGELOG.md`.
3. Stop with the notes preview and exact
   `gh release create v<version> --draft --verify-tag --notes-file ...`
   command; do not run it.
4. Create the draft only after separate explicit approval. Keep final
   publication manual-only.

## Checkpoint 3: Before Android Release APK

1. Require a clean checkout with `HEAD == v<version>^{commit}` and no
   `TUNEFORGE_GIT_REF` override.
2. Build and stage the unsigned Apple Silicon DMG. Verify filename, embedded
   package version, and git ref `v<version>-0-g<release-sha8>`.
3. Record manual launch-smoke evidence for the packaged DMG: OS, command,
   artifact hash, launch without dev server, loopback backend, UI/navigation,
   and visible release identity.
4. Hand off the Linux build to a clean x86_64 tagged checkout with no
   `TUNEFORGE_GIT_REF`, `--model-bundle`, or profile selectors. The manual
   command is `pnpm package:linux:flatpak`; it must return the five exact
   Flatpak payloads named above plus sanitized OS, tool versions, command, tag,
   commit SHA, refs, sizes, hashes, state, checksum, and CPU smoke evidence.
5. The Flatpak runtime gate installs the CPU app bundle alone in an isolated
   environment with no accelerator refs, launches without a dev server, and
   verifies the loopback backend, UI/navigation, and visible `v<version>`
   identity. Accelerator-device detection and inference evidence is optional
   and non-blocking; mark it unverified unless tested. Preserve CPU fallback.
6. Keep all five Flatpak payloads gated so missing or malformed identity/ref,
   hash, signature, size, license, or provenance evidence fails verification
   closed. Stop before Android signing/build work only after the DMG, Linux
   handoff, and CPU smoke evidence pass. Show the five documented release
   environment variables, `pnpm package:android:release`, unset commands, and
   temporary-key cleanup reminder. Do not execute them.
7. After the manual Android release build supplies the APK, verify version, ARM64 ABI,
   non-debuggable/release state, exactly one signer, certificate continuity
   with the prior release, clean-tag provenance, and isolated emulator/device
   smoke evidence.

## Checkpoint 4: Before Signing and Upload

1. Stage the seven verified payloads. Generate a new release `SHA256SUMS` over
   exactly those seven payloads, sorted by basename. Confirm these are exactly
   the eight pre-signing files and the expected-asset manifest names all 17
   final assets. Never copy the ignored Flatpak packaging checksum file.
2. Stop with exact expected filenames and explicit-fingerprint GPG commands.
   The manual step creates eight detached signatures—one for each payload and
   one for `SHA256SUMS`—then exports `release-key.asc`.
3. In an isolated temporary GPG home, verify the imported public-key
   fingerprint, all eight detached signatures, checksums, APK certificate,
   exact 17-asset set, and every applicable field in the seven-payload matrix.
   Fail closed on any mismatch or missing evidence.
4. Upload exactly 17 files to the draft only after separate explicit
   approval. Do not publish it.
5. Download all draft assets into a separate verification directory and repeat
   every applicable matrix field, the exact 17-asset-set check, and release-note
   checks against the frozen release SHA.

## Failure Recovery and Closure

- Fail closed for a missing payload, unexpected asset, dirty or mismatched tag
  provenance, wrong Android signer, incomplete package/device smoke evidence,
  bad or missing signature, checksum mismatch, or failed fresh download.
- Preserve the draft and staging directory while investigating. Replace an
  invalid draft asset only with explicit upload authority, then repeat the
  complete fresh-download verification. Never repair a published tag in place.
- A manual step publishes the verified draft. After publication, require separate
  GitHub-write authority before posting release evidence, closing the release
  tracker, or closing the milestone.
- Final closure verifies published tag, release commit, `main`, 17 remote
  assets, checksums, signatures, Android certificate, notes, tracker, and
  milestone. Report any intentionally unverified platform behavior.
