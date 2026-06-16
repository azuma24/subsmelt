# -*- mode: python ; coding: utf-8 -*-
#
# PyInstaller spec for the SubSmelt Whisper Windows backend (plan Phase 3).
#
# WINDOWS-BUILD-ONLY: this spec is authored to be run on a Windows build host.
# It cannot be built or executed on macOS/Linux. Build with:
#
#     pyinstaller packaging\windows\whisper-server.spec --clean --noconfirm
#
# It produces an --onedir bundle at dist\whisper-server\ whose entrypoint is
# run_server.exe (built from ../../run_server.py). --onedir (NOT --onefile) is
# deliberate: CTranslate2 + the multi-DLL CUDA runtime + future model files make
# onefile extraction slow and DLL discovery brittle (plan Phase 3).
#
# Models are NOT bundled. The installer ships zero weights; the model manager
# downloads them on demand into the user's model dir (plan Phase 3 / 3a).
#
# Run this spec from the backend-whisper/ directory so the relative paths below
# (run_server.py, app/) resolve. SPECPATH is set by PyInstaller to this file's dir.
import os
import sys

from PyInstaller.utils.hooks import collect_dynamic_libs, collect_submodules

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
# This spec lives at backend-whisper/packaging/windows/whisper-server.spec.
# The project root for the app is two levels up.
SPEC_DIR = os.path.abspath(SPECPATH)                      # .../packaging/windows
BACKEND_ROOT = os.path.abspath(os.path.join(SPEC_DIR, "..", ".."))  # .../backend-whisper
ENTRY_SCRIPT = os.path.join(BACKEND_ROOT, "run_server.py")
APP_DIR = os.path.join(BACKEND_ROOT, "app")

# ---------------------------------------------------------------------------
# Hidden imports
# ---------------------------------------------------------------------------
# uvicorn imports its protocol/loop implementations dynamically, FastAPI/Starlette
# and pydantic v2 (pydantic_core is a compiled ext) need help, and faster-whisper
# pulls ctranslate2 + tokenizers. Collect submodules so PyInstaller's static
# analysis does not miss dynamically imported modules.
hiddenimports = []
hiddenimports += collect_submodules("uvicorn")
hiddenimports += collect_submodules("faster_whisper")
hiddenimports += collect_submodules("ctranslate2")
hiddenimports += collect_submodules("fastapi")
hiddenimports += collect_submodules("starlette")
hiddenimports += collect_submodules("pydantic")
hiddenimports += [
    "pydantic_core",
    "anyio",
    "sniffio",
    "h11",
    "click",
    "psutil",
    # uvicorn[standard] extras commonly resolved at runtime:
    "uvicorn.logging",
    "uvicorn.loops.auto",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.lifespan.on",
    # the launcher imports these lazily for the CUDA probe:
    "ctranslate2",
]

# ---------------------------------------------------------------------------
# Binaries: CUDA runtime DLLs (the #1 footgun — plan §4 risk #1)
# ---------------------------------------------------------------------------
# cuDNN/cuBLAS ship as pip wheels (nvidia-cudnn-cu12, nvidia-cublas-cu12). Their
# DLLs (e.g. cudnn_ops64_9.dll, cublas64_12.dll) live under the wheel's
# site-packages, typically nvidia\cudnn\bin and nvidia\cublas\bin.
# collect_dynamic_libs walks those packages and returns (src, dest) tuples so the
# DLLs land beside the exe and on the DLL search path that run_server.add_dll_directory
# also covers. If a wheel name changes, update the package names here.
binaries = []
for nvidia_pkg in ("nvidia.cudnn", "nvidia.cublas"):
    try:
        binaries += collect_dynamic_libs(nvidia_pkg)
    except Exception as exc:  # pragma: no cover - build-host dependent
        # Do not hard-fail the spec parse; the README documents installing these
        # wheels before building. Print so the build log shows the gap.
        print(f"[whisper-server.spec] WARNING: could not collect {nvidia_pkg}: {exc}")
# CTranslate2 also ships its own DLLs (libctranslate2, cublasLt, etc.).
try:
    binaries += collect_dynamic_libs("ctranslate2")
except Exception as exc:  # pragma: no cover
    print(f"[whisper-server.spec] WARNING: could not collect ctranslate2 libs: {exc}")

# ---------------------------------------------------------------------------
# Data files
# ---------------------------------------------------------------------------
# Bundle the app/ package so app.main:app is importable from the frozen exe.
# (PyInstaller also follows the import graph, but shipping the source tree keeps
# the package layout intact and makes "app.main:app" resolvable by uvicorn.)
#
# ffmpeg.exe: DROP-IN REQUIRED. Place a static ffmpeg.exe at
#   backend-whisper/packaging/windows/vendor/ffmpeg.exe
# before building (see README). It is copied to the bundle root; the installer/
# launcher then sets SUBSMELT_FFMPEG to point at it (consumed by app/audio.py).
datas = [
    (APP_DIR, "app"),
]
_ffmpeg = os.path.join(SPEC_DIR, "vendor", "ffmpeg.exe")
if os.path.isfile(_ffmpeg):
    datas.append((_ffmpeg, "."))
else:
    print("[whisper-server.spec] NOTE: vendor/ffmpeg.exe not found — drop it in "
          "before building so the bundle is self-contained (see README).")

block_cipher = None

a = Analysis(
    [ENTRY_SCRIPT],
    pathex=[BACKEND_ROOT],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # large-v3 models etc. are never bundled; nothing to exclude there.
    excludes=["tkinter", "matplotlib", "pytest"],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,         # onedir: binaries live in COLLECT, not the exe
    name="run_server",             # -> run_server.exe
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,                     # UPX + CUDA DLLs can corrupt; keep off
    console=True,                  # service captures stdout/stderr to a log file
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    # icon="vendor\\whisper.ico",  # optional: drop an icon in vendor/ and enable
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="whisper-server",         # -> dist\whisper-server\
)
