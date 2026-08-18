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

Standard TuneForge releases upload exactly seven assets, using the release
version in both binaries:

1. `TuneForge_<version>_aarch64.dmg`
2. `TuneForge_<version>_aarch64.dmg.asc`
3. `TuneForge_<version>_android_aarch64_publishable.apk`
4. `TuneForge_<version>_android_aarch64_publishable.apk.asc`
5. `SHA256SUMS`
6. `SHA256SUMS.asc`
7. `release-key.asc`

The ARM64 publishable APK is mandatory for every release. `SHA256SUMS` lists
only the DMG and APK. For v1.1.0, do not build or upload a Flatpak.

Create a named temporary staging directory and print its absolute path. Retain
it through final publication and remote verification. Show its explicit
cleanup command, but never run cleanup automatically.

## Manual Steps and Automation Boundary

Never run artifact-signing commands, `pnpm package:android:release`, or final
release publication. Never access or automate KeePassXC, inspect private keys
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
   absence, and release readiness from that exact commit.
3. Stop. Show the exact signed annotated-tag command and await fresh explicit
   approval.
4. After approval, create the signed annotated tag, then verify its signature,
   annotation, target, release SHA, `main` equality, and clean state.
5. Push the verified tag only after separate explicit approval. Never move or
   delete a pushed release tag. Any code correction requires a roll-forward
   version and a new plan.

## Checkpoint 2: Before Draft Release

1. Create the staging directory, `release-notes.md`, and an expected-asset
   manifest containing the exact seven filenames.
2. Cover user-visible changes, downloads, installation, checksum/signature
   verification, Android update identity, unsigned/not-notarized macOS status,
   and known limitations. Keep operational details out of `CHANGELOG.md`.
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
4. Stop before Android signing/build work. Show the five documented release
   environment variables, `pnpm package:android:release`, unset commands, and
   temporary-key cleanup reminder. Do not execute them.
5. After the manual Android release build supplies the APK, verify version, ARM64 ABI,
   non-debuggable/release state, exactly one signer, certificate continuity
   with the prior release, clean-tag provenance, and isolated emulator/device
   smoke evidence.

## Checkpoint 4: Before Signing and Upload

1. Stage the verified DMG and APK. Generate `SHA256SUMS` over exactly those two
   files. Confirm these are the only three pre-signing assets and the manifest
   names the four manual-step signing assets still required.
2. Stop with exact expected filenames and explicit-fingerprint GPG commands.
   The manual step signs DMG, APK, and `SHA256SUMS`, then exports
   `release-key.asc`.
3. In an isolated temporary GPG home, verify the imported public-key
   fingerprint, three detached signatures, checksums, APK certificate,
   filenames, and exact asset set. Fail closed on any mismatch or missing
   evidence.
4. Upload exactly seven files to the draft only after separate explicit
   approval. Do not publish it.
5. Download all draft assets into a separate verification directory and repeat
   checksum, signature, APK identity, DMG identity, tag provenance, asset-set,
   and release-note checks against the frozen release SHA.

## Failure Recovery and Closure

- Fail closed for a missing DMG/APK, unexpected asset, dirty or mismatched tag
  provenance, wrong Android signer, incomplete package/device smoke evidence,
  bad or missing signature, checksum mismatch, or failed fresh download.
- Preserve the draft and staging directory while investigating. Replace an
  invalid draft asset only with explicit upload authority, then repeat the
  complete fresh-download verification. Never repair a published tag in place.
- A manual step publishes the verified draft. After publication, require separate
  GitHub-write authority before posting release evidence, closing the release
  tracker, or closing the milestone.
- Final closure verifies published tag, release commit, `main`, seven remote
  assets, checksums, signatures, Android certificate, notes, tracker, and
  milestone. Report any intentionally unverified platform behavior.
