from __future__ import annotations

import os

# Backend version (plan Phase 5). Read live from the environment so the Windows
# installer / run_server launcher can stamp the shipped version without a code
# change; falls back to this default for source/dev runs. Keep this default in
# step with the SubSmelt app version when cutting a coordinated release.
_DEFAULT_VERSION = "0.4.7"

# The two file-transport modes the backend supports (plan Phase 1/2):
#   shared — Model A: backend reads/writes a shared filesystem path.
#   upload — Model B: client uploads media, backend returns subtitle content.
TRANSPORT_MODES = ["shared", "upload"]


def backend_version() -> str:
    """Resolved backend version string (env override wins)."""
    return (os.environ.get("SUBSMELT_WHISPER_VERSION") or "").strip() or _DEFAULT_VERSION
