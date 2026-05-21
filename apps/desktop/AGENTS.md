# AGENTS.md (Desktop)

Scope: `apps/desktop/`

Follow root `AGENTS.md` plus the rules below for desktop-only work.

## Stack and Tooling

- Frontend: React + TypeScript + Vite + Vitest.
- Shell: Tauri 2 (Rust).

## Conventions

- Use strict TypeScript; avoid `any` except justified boundary cases.
- Use generated contracts from `@tuneforge/shared-types` for backend schema types.
- Keep `src-tauri/src/main.rs` minimal; business logic stays in backend services.

## Quality Gates

Run relevant checks for touched desktop files:

```sh
cd apps/desktop
pnpm vitest run
pnpm tsc --noEmit
```

If `src-tauri/` changes were made:

```sh
cd apps/desktop/src-tauri
cargo check
```
