"""Admin routes — API key rotation."""

from __future__ import annotations

from fastapi import APIRouter, Depends

from ..auth import require_auth
from ..config import Settings, get_settings, rotate_api_key

router = APIRouter(tags=["admin"])


@router.post(
    "/admin/api-key/rotate",
    dependencies=[Depends(require_auth)],
)
def rotate_key(settings: Settings = Depends(get_settings)) -> dict:
    new_key = rotate_api_key(settings)
    return {"ok": True, "api_key": new_key}
