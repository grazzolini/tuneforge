# AGENTS.md (Backend)

Scope: `apps/backend/`

Follow root `AGENTS.md` plus the rules below for backend-only work.

## Stack and Tooling

- Python 3.11 only.
- Run Python commands with `uv run --python 3.11 ...`.
- FastAPI + SQLAlchemy 2 + Pydantic v2.

## Architecture

- Keep route handlers in `app/api/routes/` thin.
- Business logic belongs in `app/services/`.
- Audio/ML computation belongs in `app/engines/`.
- Routes should call services, not engines directly.

## Quality Gates

Run relevant checks for touched backend files:

```sh
cd apps/backend
uv run --python 3.11 ruff check .
uv run --python 3.11 mypy app
uv run --python 3.11 pytest
```

## API Surface Changes

If request/response schemas or routes change, regenerate shared contracts from repo root:

```sh
pnpm contracts:generate
```

## Data and Errors

- Raise `AppError` for user-facing failures.
- Keep DB schema changes in Alembic revisions under `alembic/versions/`.
- Document new config settings in `apps/backend/README.md`.
