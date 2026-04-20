# Contributing to Tuneforge

Thanks for the interest. Tuneforge is a local-first toolkit for musicians learning and rehearsing songs at home, so feature scope is opinionated, but bug fixes, polish, and well-scoped feature contributions are welcome.

By participating, you agree to the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Scope and Philosophy

- **Local-only, single-user.** The backend binds to `127.0.0.1` and has no authentication. Features that assume network exposure or multi-user state are out of scope.
- **Built for players.** Features should help someone learn, rehearse, or play along with a song (stem isolation, key/tempo/chord detection, transpose, retune, looped playback, export). Generic DAW / production / mixing features are out of scope.
- **No telemetry, no accounts, no cloud.** The app must keep working with no internet access after the initial Demucs model download.

If unsure whether a feature fits, open a discussion or feature-request issue first before writing code.

## Prerequisites

- `pnpm` (version pinned in [package.json](./package.json))
- `uv`
- Python 3.11
- `ffmpeg` and `ffprobe` on your `PATH`
- Rust toolchain (for the Tauri shell)

## Setup

```sh
pnpm install
cd apps/backend && uv sync --python 3.11 --all-groups
cd ../..
pnpm contracts:generate
```

## Development Loop

Two terminals:

```sh
pnpm dev:backend
pnpm dev:desktop
```

Or both at once:

```sh
pnpm dev
```

The backend serves on `http://127.0.0.1:8765/api/v1`. The Tauri dev shell connects to it.

## Before You Open a PR

Run all of these locally and make sure they pass:

```sh
pnpm lint
pnpm typecheck
pnpm test
```

If you changed any FastAPI route, request schema, or response schema, regenerate the shared contracts and commit the result:

```sh
pnpm contracts:generate
```

CI will fail if `packages/shared-types/src/generated/openapi.ts` is out of sync.

## Commit Messages

Tuneforge enforces [Conventional Commits](https://www.conventionalcommits.org/) via `commitlint`. The `commit-msg` Husky hook is installed automatically by `pnpm install`, and CI re-checks every commit on a PR plus the PR title (because the PR title becomes the squash commit message on `main`).

Format:

```
<type>(<optional scope>): <subject>
```

Allowed types: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `revert`.

Examples:

```
feat(backend): add chord smoothing window
fix(desktop): keep playback position on tab switch
ci: pin commitlint action to v6.2.1
docs: clarify ffmpeg prerequisite
```

Rules:

- Use a concise, imperative subject (`add ...`, not `added ...` / `adds ...`).
- Subject must not start with a capitalised word, PascalCase, or all-caps.
- Header (full first line) must be ≤ 100 characters.
- Reference issues in the body or footer with `Fixes #123` / `Refs #123`.
- Keep unrelated changes in separate PRs.

## Pull Requests

- Open against `main`.
- Fill in the PR template (summary, motivation, test plan).
- Mark the PR as draft if it is not ready for review.
- Keep PRs focused. Large refactors should be split or discussed first.

### One Commit Per PR (Recommended)

`main` is protected by a ruleset that enforces **squash merges** and **linear history**, so every PR ends up as a single commit on `main` regardless of how many commits were in the PR branch.

To keep the PR diff and the eventual squash commit message clean, the recommended workflow is:

1. Make your change in a branch.
2. Commit it (one commit).
3. If review feedback or your own follow-ups require changes, **amend** the existing commit instead of adding new ones:
   ```sh
   git add -A
   git commit --amend --no-edit       # or omit --no-edit to also rewrite the message
   git push --force-with-lease
   ```
4. Use `--force-with-lease` (not `--force`) so you don't clobber someone else's push.

Multiple commits are still allowed — they will simply be squashed at merge time — but a single, well-described commit avoids any surprise about what the squash commit message becomes.

## Reporting Bugs

Use the bug report template. Include:

- OS and version
- Tuneforge commit SHA
- Steps to reproduce
- Expected vs. actual behavior
- A minimal sample audio file when relevant (do not commit copyrighted material)

## Security Issues

Do **not** open a public issue. See [SECURITY.md](./SECURITY.md) for the private disclosure process.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](./LICENSE).
