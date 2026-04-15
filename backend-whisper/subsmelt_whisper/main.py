"""FastAPI app entry-point."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings, log_first_run_banner
from .routers import admin, health, models, transcribe
from .state.db import get_store
from .state.queue import get_queue, shutdown_queue


def _configure_logging(level: str) -> None:
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    )


@asynccontextmanager
async def lifespan(_app: FastAPI):
    settings = get_settings()
    _configure_logging(settings.log_level)
    log = logging.getLogger("subsmelt_whisper")
    log_first_run_banner(settings)
    if settings.auth_disabled:
        log.warning(
            "API key is empty — authentication is DISABLED. "
            "Only expose this service on trusted networks."
        )
    # Initialise shared singletons eagerly so first request is fast.
    get_store(settings.config_dir)
    get_queue(settings.max_concurrent)
    log.info(
        "subsmelt-whisper ready on %s:%d — media_dir=%s models_dir=%s",
        settings.host, settings.port, settings.media_dir, settings.models_dir,
    )
    try:
        yield
    finally:
        shutdown_queue()


def create_app() -> FastAPI:
    app = FastAPI(
        title="subsmelt-whisper",
        version="0.1.0",
        description="Audio-to-text transcription backend for subsmelt.",
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(transcribe.router)
    app.include_router(models.router)
    app.include_router(admin.router)
    app.include_router(health.router)
    return app


app = create_app()


def main() -> None:
    """Entry point for ``python -m subsmelt_whisper`` / ``subsmelt-whisper`` CLI."""
    import uvicorn

    settings = get_settings()
    uvicorn.run(
        "subsmelt_whisper.main:app",
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level.lower(),
    )


if __name__ == "__main__":
    main()
