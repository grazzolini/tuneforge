# AGENTS.md (Shared Types)

Scope: `packages/shared-types/`

Follow root `AGENTS.md` plus the rules below.

## Generated Sources

- `openapi.json` and `src/generated/openapi.ts` are generated.
- Do not hand-edit generated outputs.

## Regeneration

From repo root:

```sh
pnpm contracts:generate
```

Commit regenerated files when backend HTTP surface changes.
