from __future__ import annotations

# Phase 3a — Hardware/software detection & provisioning ("doctor").
#
# This module DETECTS the host environment and emits a structured checklist plus
# guided "fix" descriptors (what to install, where to get it). It NEVER executes
# installers, never downloads drivers, never mutates the system, and never
# touches any schema. Actual silent install (VC++ redist, driver fetch, etc.) is
# the installer's / tray-app's job (Phase 3) — this module only tells them what
# to do.
#
# Cross-platform contract: every check runs inside its own try/except and can
# NEVER raise. On this macOS/Linux dev box (no NVIDIA, no ctranslate2 CUDA
# build, no pynvml) the GPU/driver/CUDA checks degrade gracefully to
# info/unknown rather than failing — a missing GPU is a valid CPU-only outcome,
# not an error.
#
# CLI:
#   python -m app.provision            -> JSON report (detect())
#   python -m app.provision --doctor   -> human checklist (doctor())

import json
import os
import platform
import shutil
import socket
import sys
from typing import Any, Callable, Optional, TypedDict

try:
    import psutil  # type: ignore
except Exception:  # pragma: no cover - psutil may be absent in minimal envs
    psutil = None

# gpu.py already provides import-guarded NVML / nvidia-smi / CTranslate2 probes
# that degrade to "no GPU" on a CPU box. Reuse them rather than re-implementing.
from .gpu import cuda_device_count, gpu_info

# ---------------------------------------------------------------------------
# Editable constants — keep these at the top so they can be tuned without
# hunting through logic. In production these may be sourced from a config file
# the app can update without a rebuild (see plan §3a "Implementation notes").
# ---------------------------------------------------------------------------

# Minimum NVIDIA display driver version that satisfies the CUDA 12 / cuDNN 9
# runtime CTranslate2 needs (bundled nvidia-cudnn-cu12 / nvidia-cublas-cu12
# wheels supply the rest — the full CUDA Toolkit is NOT required). Pinned
# conservatively; bump as the bundled CUDA runtime advances.
MIN_DRIVER_VERSION = "525.60.13"

# Official NVIDIA driver download page. Left as the general search page because
# the exact pre-filtered URL depends on GPU family/OS the wizard resolves at
# fix-time; the fix descriptor also carries the detected GPU model as a note.
NVIDIA_DRIVER_URL = "https://www.nvidia.com/Download/index.aspx"

# Where the bundled VC++ redistributable (and where to get it if absent) — only
# relevant on Windows; emitted as a fix descriptor, installed by the installer.
VCREDIST_URL = "https://aka.ms/vs/17/release/vc_redist.x64.exe"

# Resource floors. Below "warn" we flag a warning; the app still runs.
MIN_CPU_CORES_WARN = 2
MIN_RAM_MB_WARN = 4096           # 4 GiB — below this even small models struggle
MIN_DISK_FREE_MB_WARN = 5120     # 5 GiB free in the model dir before download
MIN_DISK_FREE_MB_FAIL = 1024     # under 1 GiB → model download will fail

# Windows build requirement (informational on other OSes).
MIN_WINDOWS_RELEASE = 10  # Win10+ x64


def _default_model_dir() -> str:
    """Model/cache directory: env MODEL_DIR, else HF_HOME, else ~/.cache/huggingface."""
    return (
        os.environ.get("MODEL_DIR")
        or os.environ.get("HF_HOME")
        or os.path.join(os.path.expanduser("~"), ".cache", "huggingface")
    )


def _default_port() -> int:
    raw = os.environ.get("PORT") or os.environ.get("SUBSMELT_WHISPER_PORT") or "8000"
    try:
        return int(raw)
    except (TypeError, ValueError):
        return 8000


# ---------------------------------------------------------------------------
# Report types
# ---------------------------------------------------------------------------

Status = str  # "ok" | "warn" | "fail" | "unknown" | "info" | "na"


class Fix(TypedDict, total=False):
    action: str
    label: str
    url: str


class Check(TypedDict, total=False):
    id: str
    label: str
    status: Status
    detail: str
    fix: Fix


class Report(TypedDict):
    ready: bool
    summary: str
    checks: list[Check]


def _check(
    check_id: str,
    label: str,
    fn: Callable[[], Check],
) -> Check:
    """Run a single probe, guaranteeing it never raises.

    On any unexpected exception the check degrades to ``unknown`` with the error
    text in detail — the report as a whole must always be producible.
    """
    try:
        result = fn()
        result.setdefault("id", check_id)
        result.setdefault("label", label)
        result.setdefault("status", "unknown")
        result.setdefault("detail", "")
        return result
    except Exception as exc:  # pragma: no cover - defensive; probes self-guard
        return {
            "id": check_id,
            "label": label,
            "status": "unknown",
            "detail": f"probe failed: {exc!r}",
        }


# ---------------------------------------------------------------------------
# Individual checks — each returns a Check; none raise.
# ---------------------------------------------------------------------------

def _check_os() -> Check:
    system = platform.system()
    release = platform.release()
    machine = platform.machine()
    arch64 = platform.architecture()[0] == "64bit" or machine.lower() in {
        "x86_64", "amd64", "arm64", "aarch64",
    }
    detail = f"{system} {release} ({machine})"

    if system == "Windows":
        # Require Win10+ x64 for the Windows build.
        try:
            major = int(str(release).split(".")[0])
        except (ValueError, IndexError):
            major = 0
        is_x64 = machine.lower() in {"amd64", "x86_64"}
        if major >= MIN_WINDOWS_RELEASE and is_x64:
            return {"status": "ok", "detail": detail}
        return {
            "status": "fail",
            "detail": f"{detail} — requires Windows {MIN_WINDOWS_RELEASE}+ x64",
        }

    # Non-Windows: informational. The Windows server build targets Windows, but
    # the backend itself runs fine on Linux/macOS for dev and Docker.
    return {
        "status": "info",
        "detail": f"{detail} — non-Windows host (Windows build targets Win{MIN_WINDOWS_RELEASE}+ x64)",
    }


def _check_cpu() -> Check:
    cores: Optional[int] = None
    if psutil is not None:
        cores = psutil.cpu_count(logical=True)
    if cores is None:
        cores = os.cpu_count()
    if not cores:
        return {"status": "unknown", "detail": "could not determine CPU core count"}
    if cores < MIN_CPU_CORES_WARN:
        return {
            "status": "warn",
            "detail": f"{cores} logical core(s) — {MIN_CPU_CORES_WARN}+ recommended",
        }
    return {"status": "ok", "detail": f"{cores} logical core(s)"}


def _check_ram() -> Check:
    if psutil is None:
        return {"status": "unknown", "detail": "psutil unavailable — cannot measure RAM"}
    total_mb = int(psutil.virtual_memory().total / 1024 / 1024)
    if total_mb < MIN_RAM_MB_WARN:
        return {
            "status": "warn",
            "detail": f"{total_mb} MB total — {MIN_RAM_MB_WARN} MB+ recommended",
        }
    return {"status": "ok", "detail": f"{total_mb} MB total RAM"}


def _check_gpu() -> Check:
    gpus = gpu_info()
    if not gpus:
        # No NVIDIA GPU is a valid CPU-only outcome — info, not fail.
        return {
            "status": "info",
            "detail": "no NVIDIA GPU detected — CPU-only mode",
        }
    names = ", ".join(
        f"{g['name']} ({g['total_vram_mb']} MB total, {g['free_vram_mb']} MB free)"
        for g in gpus
    )
    return {"status": "ok", "detail": names}


def _parse_driver_version() -> Optional[str]:
    """Best-effort NVIDIA driver version via NVML, then nvidia-smi. None if absent."""
    # NVML first.
    try:
        import pynvml  # type: ignore

        pynvml.nvmlInit()
        try:
            version = pynvml.nvmlSystemGetDriverVersion()
            if isinstance(version, bytes):
                version = version.decode("utf-8", "replace")
            if version:
                return str(version).strip()
        finally:
            try:
                pynvml.nvmlShutdown()
            except Exception:  # pragma: no cover
                pass
    except Exception:  # pragma: no cover - optional dep / no driver
        pass

    # nvidia-smi fallback.
    try:
        import subprocess

        completed = subprocess.run(
            ["nvidia-smi", "--query-gpu=driver_version", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        if completed.returncode == 0 and completed.stdout.strip():
            return completed.stdout.strip().splitlines()[0].strip()
    except Exception:  # pragma: no cover - nvidia-smi absent
        pass
    return None


def _version_tuple(version: str) -> tuple[int, ...]:
    parts: list[int] = []
    for chunk in version.split("."):
        digits = "".join(ch for ch in chunk if ch.isdigit())
        parts.append(int(digits) if digits else 0)
    return tuple(parts)


def _driver_meets_minimum(installed: str, minimum: str) -> bool:
    return _version_tuple(installed) >= _version_tuple(minimum)


def _check_nvidia_driver() -> Check:
    gpus = gpu_info()
    gpu_note = f" (GPU: {gpus[0]['name']})" if gpus else ""
    installed = _parse_driver_version()

    if installed is None:
        if not gpus:
            # No GPU and no driver — expected on a CPU-only box. Not a failure.
            return {
                "status": "info",
                "detail": "no NVIDIA driver detected — CPU-only mode (driver only needed for GPU)",
            }
        # GPU present but no readable driver version → guide install.
        return {
            "status": "fail",
            "detail": f"NVIDIA GPU present but driver version unreadable{gpu_note}",
            "fix": {
                "action": "download_driver",
                "label": f"Download NVIDIA driver {MIN_DRIVER_VERSION}+{gpu_note}",
                "url": NVIDIA_DRIVER_URL,
            },
        }

    if _driver_meets_minimum(installed, MIN_DRIVER_VERSION):
        return {
            "status": "ok",
            "detail": f"driver {installed} (>= {MIN_DRIVER_VERSION}){gpu_note}",
        }

    return {
        "status": "fail",
        "detail": f"driver {installed} is below minimum {MIN_DRIVER_VERSION}{gpu_note}",
        "fix": {
            "action": "download_driver",
            "label": f"Update NVIDIA driver to {MIN_DRIVER_VERSION}+{gpu_note}",
            "url": NVIDIA_DRIVER_URL,
        },
    }


def _check_cuda_runtime() -> Check:
    count = cuda_device_count()
    if count > 0:
        return {"status": "ok", "detail": f"CTranslate2 sees {count} CUDA device(s)"}
    return {
        "status": "info",
        "detail": "CTranslate2 reports 0 CUDA devices — CPU mode",
    }


def _check_disk() -> Check:
    model_dir = _default_model_dir()
    # disk_usage needs an existing path; walk up to the first that exists.
    probe = model_dir
    while probe and not os.path.exists(probe):
        parent = os.path.dirname(probe)
        if parent == probe:
            break
        probe = parent
    try:
        usage = shutil.disk_usage(probe or os.path.expanduser("~"))
    except Exception:
        return {"status": "unknown", "detail": f"could not measure free disk for {model_dir}"}
    free_mb = int(usage.free / 1024 / 1024)
    detail = f"{free_mb} MB free at {model_dir}"
    if free_mb < MIN_DISK_FREE_MB_FAIL:
        return {
            "status": "fail",
            "detail": f"{detail} — under {MIN_DISK_FREE_MB_FAIL} MB; model download will fail",
        }
    if free_mb < MIN_DISK_FREE_MB_WARN:
        return {
            "status": "warn",
            "detail": f"{detail} — {MIN_DISK_FREE_MB_WARN} MB+ recommended for model downloads",
        }
    return {"status": "ok", "detail": detail}


def _check_vcredist() -> Check:
    if platform.system() != "Windows":
        return {"status": "na", "detail": "not applicable (Windows-only requirement)"}

    # Presence of msvcp140.dll on PATH / System32, or the registry key.
    if shutil.which("msvcp140.dll"):
        return {"status": "ok", "detail": "msvcp140.dll present on PATH"}
    system_root = os.environ.get("SystemRoot", r"C:\Windows")
    dll_path = os.path.join(system_root, "System32", "msvcp140.dll")
    if os.path.exists(dll_path):
        return {"status": "ok", "detail": f"msvcp140.dll present ({dll_path})"}

    # Registry check (best-effort; winreg is Windows-only).
    try:
        import winreg  # type: ignore

        key = winreg.OpenKey(
            winreg.HKEY_LOCAL_MACHINE,
            r"SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64",
        )
        try:
            installed, _ = winreg.QueryValueEx(key, "Installed")
            if installed:
                return {"status": "ok", "detail": "VC++ redistributable registered"}
        finally:
            winreg.CloseKey(key)
    except Exception:  # pragma: no cover - Windows-only path
        pass

    return {
        "status": "fail",
        "detail": "Visual C++ runtime (msvcp140.dll) not found",
        "fix": {
            "action": "install_vcredist",
            "label": "Install Visual C++ 2015-2022 Redistributable (x64)",
            "url": VCREDIST_URL,
        },
    }


def _check_ffmpeg() -> Check:
    bundled = os.environ.get("SUBSMELT_FFMPEG")
    if bundled and os.path.exists(bundled):
        return {"status": "ok", "detail": f"bundled ffmpeg ({bundled})"}
    found = shutil.which("ffmpeg")
    if found:
        return {"status": "ok", "detail": f"ffmpeg on PATH ({found})"}
    return {
        "status": "fail",
        "detail": "ffmpeg not found (set SUBSMELT_FFMPEG or add to PATH)",
        "fix": {
            "action": "install_ffmpeg",
            "label": "Bundle ffmpeg.exe with the app or install it on PATH",
            "url": "https://ffmpeg.org/download.html",
        },
    }


def _check_port() -> Check:
    port = _default_port()
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(("127.0.0.1", port))
        return {"status": "ok", "detail": f"port {port} is bindable"}
    except OSError as exc:
        return {
            "status": "warn",
            "detail": f"port {port} is not bindable: {exc.strerror or exc}",
            "fix": {
                "action": "reconfigure_port",
                "label": f"Choose a different port (PORT env); {port} is in use",
            },
        }
    finally:
        sock.close()


# Ordered registry of (id, label, fn). Order drives both the report and the
# doctor output.
_CHECKS: list[tuple[str, str, Callable[[], Check]]] = [
    ("os", "Operating system / architecture", _check_os),
    ("cpu", "CPU cores", _check_cpu),
    ("ram", "System RAM", _check_ram),
    ("gpu", "NVIDIA GPU + VRAM", _check_gpu),
    ("nvidia_driver", "NVIDIA driver version", _check_nvidia_driver),
    ("cuda_runtime", "CUDA runtime (CTranslate2)", _check_cuda_runtime),
    ("disk", "Free disk (model dir)", _check_disk),
    ("vcredist", "Visual C++ runtime", _check_vcredist),
    ("ffmpeg", "ffmpeg", _check_ffmpeg),
    ("port", "Server port", _check_port),
]

# A "fail" in any of these blocks readiness. cuda_runtime / gpu / nvidia_driver
# are intentionally NOT blockers: their non-ok states are CPU-mode info, and the
# CPU path is always a valid fallback.
_READINESS_BLOCKERS = {"os", "disk", "vcredist", "ffmpeg"}


def detect() -> Report:
    """Run every check and return a structured, machine-readable report.

    Never raises: each probe is individually guarded. ``ready`` is False if any
    blocking check (see ``_READINESS_BLOCKERS``) failed.
    """
    checks: list[Check] = [_check(cid, label, fn) for cid, label, fn in _CHECKS]

    failed_blockers = [
        c["id"]
        for c in checks
        if c.get("id") in _READINESS_BLOCKERS and c.get("status") == "fail"
    ]
    warns = [c["id"] for c in checks if c.get("status") == "warn"]
    ready = not failed_blockers

    if failed_blockers:
        summary = "Not ready: " + ", ".join(failed_blockers) + " need attention."
    elif warns:
        summary = "Ready (with warnings: " + ", ".join(warns) + ")."
    else:
        summary = "Ready."

    return {"ready": ready, "summary": summary, "checks": checks}


_STATUS_GLYPH = {
    "ok": "✓",       # ✓
    "warn": "⚠",     # ⚠
    "fail": "✗",     # ✗
    "unknown": "?",
    "info": "ℹ",     # ℹ
    "na": "-",
}


def doctor() -> str:
    """Human/CLI-formatted checklist built from :func:`detect`."""
    report = detect()
    lines: list[str] = []
    lines.append("SubSmelt Whisper — system doctor")
    lines.append("=" * 40)
    for check in report["checks"]:
        glyph = _STATUS_GLYPH.get(check.get("status", "unknown"), "?")
        status = str(check.get("status", "unknown")).upper()
        lines.append(f"{glyph} [{status:7}] {check.get('label', check.get('id'))}")
        detail = check.get("detail")
        if detail:
            lines.append(f"        {detail}")
        fix = check.get("fix")
        if fix:
            fix_line = f"        fix: {fix.get('label', fix.get('action', ''))}"
            if fix.get("url"):
                fix_line += f"  <{fix['url']}>"
            lines.append(fix_line)
    lines.append("-" * 40)
    state = "READY" if report["ready"] else "NOT READY"
    lines.append(f"{state}: {report['summary']}")
    return "\n".join(lines)


def main(argv: Optional[list[str]] = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if "--doctor" in args:
        print(doctor())
    else:
        print(json.dumps(detect(), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
