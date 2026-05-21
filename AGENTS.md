# AGENTS.md

Guidance for AI coding agents (Claude Code, Cursor, Copilot, Aider, Codex, etc.) working in this repository.

This file is the agent-facing companion to [CONTRIBUTING.md](./CONTRIBUTING.md). Humans should read CONTRIBUTING.md; agents should read both, but this file takes precedence on conventions specific to automated work.

## Project Snapshot

Tuneforge is a local-first desktop app for musicians learning songs: stem separation, chord/key/tempo detection, pitch shift, retune, export. No cloud, no account.

- **Monorepo**: pnpm workspace.
- **Backend**: `apps/backend` — FastAPI + SQLAlchemy 2 + Pydantic v2, Python 3.11, managed with `uv`. SQLite persistence, single-process job runner, audio engines (Demucs, FFmpeg, librosa-style analysis).
- **Desktop**: `apps/desktop` — Tauri 2 (Rust) shell + React/Vite/TypeScript frontend, Vitest + Testing Library.
- **Shared types**: `packages/shared-types` — TypeScript types generated from the backend OpenAPI schema. **Always regenerate after backend route/schema changes.**
- **Documentation**: `docs/` — source of truth for architecture, API, mobile strategy, and references.

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
  desktop/                Tauri shell + React frontend
packages/
  shared-types/           generated TS contracts
docs/                     architecture/spec/API docs
scripts/                  packaging helpers
```

## Folder-Scoped Agent Guidance

More specific AGENTS.md files exist in:

- `apps/backend/AGENTS.md`
- `apps/desktop/AGENTS.md`
- `packages/shared-types/AGENTS.md`
- `docs/AGENTS.md`

When editing inside those directories, follow the nested file first.

## Workflow Expectations

When asked to implement a change:

1. **Read before writing.** Inspect the surrounding files in the relevant layer. Match existing patterns.
2. **Plan briefly.** For multi-step work, write a short plan or todo list before editing.
3. **Edit narrowly.** Don't reformat unrelated code, don't add docstrings/comments to code you didn't touch, don't introduce new abstractions for one-time operations.
4. **Run the relevant gates locally** for the files you touched. Prefer targeted checks first, then broader gates when cross-cutting changes are made.
5. **Regenerate contracts if backend HTTP surface changed:**
   ```sh
   pnpm contracts:generate
   ```
   Commit the resulting generated files. CI fails on drift.
6. **Update docs when behavior or workflow changes.** Keep docs in `docs/` aligned with implementation and avoid adding one-off markdown status notes.

## Cross-Workspace Gates (run from repo root)

```sh
pnpm lint
pnpm typecheck
pnpm test
```

## Code Conventions (Global)

- Use existing formatters/linters; do not introduce ad hoc style changes.
- Prefer small, reviewable diffs over broad rewrites.
- Add tests for new behavior; update existing tests when behavior intentionally changes.

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

- **Conventional Commits required.** Format: `<type>(<optional scope>): <subject>`. Allowed types: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `revert`. Subject is imperative (`add ...`, not `Added`/`Adds`). Header ≤ 100 chars.
- Reference issues with `Fixes #123` / `Refs #123` in the body or footer.
- One concern per commit and per PR.
- **Prefer one commit per PR.**
- Fill in the PR template. Be honest in the test plan — list the commands you actually ran.

## When to Stop and Ask

Pause and surface the question to the human instead of guessing when:

- A task implies network exposure, multi-user behavior, auth, telemetry, or cloud features.
- A change requires adding a non-MIT-compatible dependency.
- A migration would be destructive (drop column, drop table, irreversible data shape change).
- Existing tests would need to be deleted or weakened to make the change pass.
- The user's request conflicts with anything in this file.
