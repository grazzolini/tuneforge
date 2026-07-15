# AGENTS.md (Desktop)

Scope: applies to `apps/desktop/**`.

Use the root `AGENTS.md` for global rules. This file adds desktop-specific guidance only.

## Frontend conventions

- Keep TypeScript strict; avoid `any` except narrow boundary cases with justification.
- Use generated contracts from `@tuneforge/shared-types` for backend-facing types.
- Prefer user-visible behavior tests (Vitest + Testing Library), not implementation details.

## Release media

- For material user-visible changes, evaluate whether the release-media capture catalog needs a
  deterministic screenshot or short silent video. Follow the catalog selection and validation
  rules in the root `AGENTS.md`.
- Prefer screenshots for stable UI states and videos for time-based behavior. Do not add duplicate,
  trivial, hardware-dependent, or non-deterministic coverage.
- Capture synthetic fixture data only; never use user files, copyrighted audio, accounts, or
  external services.

## Tauri conventions

- Keep `src-tauri/src/main.rs` minimal; backend business logic stays in Python.
- Do not add capabilities unless necessary; update `src-tauri/capabilities/default.json` only with clear need.

## Checks

- If frontend code changed: run from repo root `pnpm lint && pnpm typecheck && pnpm test`.
- If `src-tauri/**` changed: run `cd src-tauri && cargo check`.
