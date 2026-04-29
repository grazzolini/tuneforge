# AGENTS.md (Backend)

Scope: applies to `apps/backend/**`.

Use the root `AGENTS.md` for global rules. This file adds backend-specific guidance only.

## Backend boundaries

- Keep route handlers thin in `app/api/routes`.
- Put orchestration and persistence logic in `app/services`.
- Put compute/audio/ML logic in `app/engines`.
- Do not call engines directly from routes.

## Python and tooling

- Run Python commands with `uv run --python 3.11 ...`.
- Required checks when backend code changes:
  - `uv run --python 3.11 ruff check .`
  - `uv run --python 3.11 mypy app`
  - `uv run --python 3.11 pytest`

## API/schema changes

- If request/response models or routes change, regenerate shared contracts from repo root:
  - `pnpm contracts:generate`
- Never hand-edit generated files.

## Migrations

- Database schema changes require a new Alembic revision in `alembic/versions/`.
- Avoid destructive migrations unless explicitly approved by a human.
