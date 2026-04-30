from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app import __version__
from app.api.routes.artifacts import router as artifacts_router
from app.api.routes.chord_backends import router as chord_backends_router
from app.api.routes.health import router as health_router
from app.api.routes.jobs import router as jobs_router
from app.api.routes.projects import router as projects_router
from app.config import ensure_data_dirs, get_settings
from app.db import SessionLocal, UnknownDatabaseRevisionError, reconfigure_engine, run_migrations
from app.errors import AppError
from app.schemas import ErrorInfo, ErrorResponse
from app.services.jobs import InProcessJobRunner

logger = logging.getLogger("tuneforge.startup")


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    ensure_data_dirs(settings)
    reconfigure_engine(settings)
    try:
        run_migrations(settings)
    except UnknownDatabaseRevisionError as error:
        logger.error("%s", error)
        raise
    runner = InProcessJobRunner(SessionLocal, max_workers=settings.max_workers)
    runner.recover_running_jobs()
    runner.start()
    app.state.job_runner = runner
    try:
        yield
    finally:
        runner.stop()


app = FastAPI(title="Tuneforge API", version=__version__, lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:1420",
        "http://localhost:1420",
        "tauri://localhost",
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(AppError)
async def app_error_handler(_: Request, exc: AppError) -> JSONResponse:
    payload = ErrorResponse(error=ErrorInfo(code=exc.code, message=exc.message, details=exc.details))
    return JSONResponse(status_code=exc.status_code, content=payload.model_dump())


@app.exception_handler(RequestValidationError)
async def validation_error_handler(_: Request, exc: RequestValidationError) -> JSONResponse:
    serialized_errors = jsonable_encoder(exc.errors())
    payload = ErrorResponse(
        error=ErrorInfo(
            code="INVALID_REQUEST",
            message="Request validation failed.",
            details={"errors": serialized_errors},
        ),
    )
    return JSONResponse(status_code=422, content=payload.model_dump())


app.include_router(health_router, prefix=get_settings().api_prefix)
app.include_router(chord_backends_router, prefix=get_settings().api_prefix)
app.include_router(projects_router, prefix=get_settings().api_prefix)
app.include_router(jobs_router, prefix=get_settings().api_prefix)
app.include_router(artifacts_router, prefix=get_settings().api_prefix)
