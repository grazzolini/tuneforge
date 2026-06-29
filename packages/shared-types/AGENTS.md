# AGENTS.md (Shared Types)

Scope: applies to `packages/shared-types/**`.

This package is generated-contract focused.

- Source of truth is backend OpenAPI output, not manual edits.
- Do not hand-edit:
  - `openapi.json` (ignored local generator output; do not commit)
  - `src/generated/openapi.ts` (committed generated contract; CI checks drift)
- After backend API changes, regenerate from repo root:
  - `pnpm contracts:generate`
- If the generated TypeScript contract changes, commit `src/generated/openapi.ts` in the same PR as backend API changes.
