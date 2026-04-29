# AGENTS.md (Shared Types)

Scope: applies to `packages/shared-types/**`.

This package is generated-contract focused.

- Source of truth is backend OpenAPI output, not manual edits.
- Do not hand-edit:
  - `openapi.json`
  - `src/generated/openapi.ts`
- After backend API changes, regenerate from repo root:
  - `pnpm contracts:generate`
- If generated output changes, commit it in the same PR as backend API changes.
