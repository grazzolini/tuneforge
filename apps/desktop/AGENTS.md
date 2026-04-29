# AGENTS.md (Desktop)

Scope: applies to `apps/desktop/**`.

Use the root `AGENTS.md` for global rules. This file adds desktop-specific guidance only.

## Frontend conventions

- Keep TypeScript strict; avoid `any` except narrow boundary cases with justification.
- Use generated contracts from `@tuneforge/shared-types` for backend-facing types.
- Prefer user-visible behavior tests (Vitest + Testing Library), not implementation details.

## Tauri conventions

- Keep `src-tauri/src/main.rs` minimal; backend business logic stays in Python.
- Do not add capabilities unless necessary; update `src-tauri/capabilities/default.json` only with clear need.

## Checks

- If frontend code changed: run from repo root `pnpm lint && pnpm typecheck && pnpm test`.
- If `src-tauri/**` changed: run `cd src-tauri && cargo check`.
