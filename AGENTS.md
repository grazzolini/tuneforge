# AGENTS.md

Guidance for AI coding agents (Claude Code, Cursor, Copilot, Aider, Codex, etc.) working in this repository.

This file is the agent-facing companion to [CONTRIBUTING.md](./CONTRIBUTING.md). Humans should read CONTRIBUTING.md; agents should read both, but this file takes precedence on conventions specific to automated work.

## Project Snapshot

Tuneforge is a local-first desktop app for musicians learning songs: stem separation, chord/key/tempo detection, pitch shift, retune, export. No cloud, no account.

- **Monorepo**: pnpm workspace.
- **Backend**: `apps/backend` — FastAPI + SQLAlchemy 2 + Pydantic v2, Python 3.11, managed with `uv`. SQLite persistence, single-process job runner, audio engines (Demucs, FFmpeg, librosa-style analysis).
- **Desktop**: `apps/desktop` — Tauri 2 (Rust) shell + React/Vite/TypeScript frontend, Vitest + Testing Library.
- **Shared types**: `packages/shared-types` — TypeScript types generated from the backend OpenAPI schema. **Always regenerate after backend route/schema changes.**

## Hard Rules

These are non-negotiable. If a task seems to require breaking one, stop and ask.

1. **Local-only stays local.** The backend binds `127.0.0.1`. Do not introduce network exposure, public binds, reverse-proxy assumptions, multi-user concepts, auth/session systems, telemetry, analytics, or external API calls (other than the Demucs model download that already exists).
2. **No cloud, no accounts.** The app must keep working with no internet after first run.
3. **Don't bundle FFmpeg.** It is a host-installed dependency by design. See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) for the licensing reason.
4. **Respect the layering.** `routes/` → `services/` → `engines/`. Routes are thin; business logic lives in services; raw audio/ML work lives in engines. Don't bypass layers.
5. **Don't commit generated files by hand.** Run the generator (see "Generated artifacts" below).
6. **Don't disable lint/type/test rules to make CI pass.** Fix the underlying issue.
7. **Don't bypass safety flags.** No `--no-verify`, no `git push --force` on shared branches, no destructive shell shortcuts.
8. **MIT-compatible deps only.** Avoid GPL/AGPL/SSPL runtime dependencies. Note any new dep's license in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

## Repository Layout

```
apps/
  backend/                FastAPI service
    app/
      api/routes/         HTTP handlers (thin)
      services/           orchestration, persistence, caching
      engines/            pure compute: analysis, chords, stems, transform
      models.py           SQLAlchemy ORM
      schemas.py          Pydantic request/response
      errors.py           AppError + handlers
      config.py           env-driven Settings
    alembic/versions/     migrations (auto-run on startup)
    tests/                pytest suite
  desktop/
    src/                  React frontend (Vitest)
    src-tauri/            Rust shell (cargo)
packages/
  shared-types/           generated TS contracts
scripts/                  packaging helpers
```

## Workflow Expectations

When asked to implement a change:

1. **Read before writing.** Inspect the surrounding files in the relevant layer. Match existing patterns.
2. **Plan briefly.** For multi-step work, write a short plan or todo list before editing.
3. **Edit narrowly.** Don't reformat unrelated code, don't add docstrings/comments to code you didn't touch, don't introduce new abstractions for one-time operations.
4. **Run the gates locally.** From the workspace root:
   ```sh
   pnpm lint
   pnpm typecheck
   pnpm test
   ```
   And for the backend:
   ```sh
   cd apps/backend && uv run --python 3.11 pytest
   ```
5. **Regenerate contracts if backend HTTP surface changed:**
   ```sh
   pnpm contracts:generate
   ```
   Commit the resulting `packages/shared-types/src/generated/openapi.ts`. CI fails on drift.
6. **Verify Tauri compiles** if you touched anything in `apps/desktop/src-tauri/`:
   ```sh
   cd apps/desktop/src-tauri && cargo check
   ```
7. **Update docs only when behavior changes.** Don't create new markdown files to describe what you did. The PR description is the right place for that.

## Code Conventions

### Python (backend)

- Python 3.11. Use `uv run --python 3.11 ...` for everything; do not invoke a globally installed Python.
- Type hints on all new function signatures. `mypy app` must pass.
- `ruff check .` must pass. Fix lints, do not silence them.
- Pydantic v2 syntax (`model_config`, `Field(...)`, `model_validate`).
- SQLAlchemy 2 declarative + `Mapped[...]` style.
- Raise `AppError` (see `app/errors.py`) for user-facing failures, not bare `HTTPException`.
- Never call into engines from routes — go through a service.
- New env-driven settings go in `app/config.py` and must be documented in [apps/backend/README.md](apps/backend/README.md#configuration).
- Database schema changes require an Alembic revision in `apps/backend/alembic/versions/` (next sequential prefix, e.g. `0003_*.py`).

### TypeScript / React (desktop)

- Strict TypeScript. No `any` unless justified in a comment, and only at boundaries.
- Use the generated types from `@tuneforge/shared-types` — never hand-write a type that mirrors a backend schema.
- Functional components + hooks. No class components.
- Co-locate component-specific state and effects; lift only when shared.
- Existing React Hook exhaustive-deps warnings in `apps/desktop/src/features/projects/playback.tsx` are intentional and pre-existing — don't "fix" them as a drive-by.

### Rust (Tauri shell)

- Keep `apps/desktop/src-tauri/src/main.rs` minimal. The shell exists to launch the bundled backend and host the WebView; business logic stays in the Python backend.
- Don't add Tauri capabilities without a concrete need. Current capabilities live in `apps/desktop/src-tauri/capabilities/default.json`.

### Tests

- Add tests for new behavior. Backend uses pytest with synthetic audio fixtures (sine waves, chord progressions) — prefer those over committing real audio files.
- Frontend uses Vitest + Testing Library. Test user-visible behavior, not implementation details.
- Don't commit copyrighted audio under any circumstances.

## Generated Artifacts

The following files are generated. **Do not edit by hand.**

| File | Generator |
| --- | --- |
| `packages/shared-types/openapi.json` | `pnpm contracts:generate` (writes from backend OpenAPI export) |
| `packages/shared-types/src/generated/openapi.ts` | `pnpm contracts:generate` |
| `apps/desktop/src-tauri/gen/schemas/*` | Tauri build |
| `apps/desktop/src-tauri/Cargo.lock` | cargo |
| `pnpm-lock.yaml` | pnpm |

## Security and Privacy

- Treat the loopback bind as the only trust boundary. See [SECURITY.md](./SECURITY.md).
- Never log file contents, audio data, or anything that could include user material.
- Never add a feature that opens an outbound connection to a service the user hasn't explicitly configured.
- Never ask the user to paste secrets into chat or commit them. The `.gitignore` already blocks the obvious patterns; if you need a new secret-bearing file pattern, extend `.gitignore` first.

## Commit and PR Hygiene

- **Conventional Commits required.** Format: `<type>(<optional scope>): <subject>`. Allowed types: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `revert`. Subject is imperative (`add ...`, not `Added`/`Adds`). Header ≤ 100 chars. The `commit-msg` Husky hook and a CI job (`commitlint`) enforce this on every commit and on the PR title.
- Reference issues with `Fixes #123` / `Refs #123` in the body or footer.
- One concern per commit and per PR. If a refactor and a feature are tangled, split them into separate PRs.
- **Prefer one commit per PR.** A repository ruleset enforces squash merges and linear history on `main`, so any extra commits in a PR get folded into one at merge time anyway. The PR title becomes the squash commit message, so it must also pass commitlint. Recommended workflow: amend the existing commit and push with `git push --force-with-lease` rather than stacking fix-up commits.
- Fill in the PR template. Be honest in the test plan — list the commands you actually ran.
- Mark a PR as draft if any required gate fails locally.
- Never use `--no-verify` and never `force-push` to `main` or to someone else's branch.

## When to Stop and Ask

Pause and surface the question to the human instead of guessing when:

- A task implies network exposure, multi-user behavior, auth, telemetry, or cloud features.
- A change requires adding a non-MIT-compatible dependency.
- A migration would be destructive (drop column, drop table, irreversible data shape change).
- Existing tests would need to be deleted or weakened to make the change pass.
- The user's request conflicts with anything in this file.

## Quick Reference

```sh
# Install
pnpm setup:dev

# Develop
pnpm dev                  # backend + desktop together
pnpm dev:backend
pnpm dev:desktop

# Gate before opening a PR
pnpm lint
pnpm typecheck
pnpm test
cd apps/backend && uv run --python 3.11 pytest
cd apps/desktop/src-tauri && cargo check

# After backend HTTP changes
pnpm contracts:generate
```
