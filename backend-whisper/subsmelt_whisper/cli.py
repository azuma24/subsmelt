"""Small CLI wrapping: serve, regenerate-api-key, show-config."""

from __future__ import annotations

import sys

import typer

from .config import get_settings, rotate_api_key

app = typer.Typer(help="subsmelt-whisper CLI")


@app.command()
def serve() -> None:
    """Run the FastAPI server (foreground)."""
    from .main import main as server_main

    server_main()


@app.command("regenerate-api-key")
def regenerate_api_key() -> None:
    """Generate a new API key and persist it to config.ini."""
    settings = get_settings()
    new_key = rotate_api_key(settings)
    typer.echo(new_key)
    typer.echo(
        f"New API key saved to {settings.config_file}. Restart the service for it to take effect.",
        err=True,
    )


@app.command("show-config")
def show_config() -> None:
    """Print resolved config."""
    settings = get_settings()
    typer.echo(f"config_file:    {settings.config_file}")
    typer.echo(f"media_dir:      {settings.media_dir}")
    typer.echo(f"models_dir:     {settings.models_dir}")
    typer.echo(f"host:           {settings.host}")
    typer.echo(f"port:           {settings.port}")
    typer.echo(f"device:         {settings.device}")
    typer.echo(f"compute_type:   {settings.compute_type}")
    typer.echo(f"max_concurrent: {settings.max_concurrent}")
    typer.echo(f"auth_required:  {not settings.auth_disabled}")


def main() -> None:
    # When argv has no subcommand, default to `serve` (matches the Windows service).
    if len(sys.argv) == 1:
        sys.argv.append("serve")
    app()


if __name__ == "__main__":
    main()
