# -*- mode: python ; coding: utf-8 -*-
#
# PyInstaller spec for the SubSmelt Whisper macOS backend (Apple Silicon).
# build.sh runs it; to run it by hand, fill a vendor dir with fetch-vendor.sh
# first and point SUBSMELT_MACOS_VENDOR at it:
#
#     SUBSMELT_MACOS_VENDOR=<vendor> pyinstaller packaging/macos/whisper-server.spec --clean --noconfirm
#
# It produces an --onedir bundle at dist/whisper-server/ whose executable is
# whisper-server (built from ../../run_server.py), with the vendored runtimes
# beside it:
#
#     whisper-server/whisper-server
#     whisper-server/nemo-speech/{bin,lib,share}   found by app/nemotron_runtime.py
#     whisper-server/ffmpeg/{ffmpeg,ffprobe}       found by run_server.bundled_ffmpeg
#
# No model weights and no CUDA wheels: models download on demand through the
# model manager into the user's model dir.
import os
import shutil

from PyInstaller.utils.hooks import collect_all, collect_data_files, collect_dynamic_libs, collect_submodules

SPEC_DIR = os.path.abspath(SPECPATH)
BACKEND_ROOT = os.path.abspath(os.path.join(SPEC_DIR, "..", ".."))
ENTRY_SCRIPT = os.path.join(BACKEND_ROOT, "run_server.py")
APP_DIR = os.path.join(BACKEND_ROOT, "app")
VENDOR_DIR = os.environ.get("SUBSMELT_MACOS_VENDOR") or os.path.join(SPEC_DIR, "vendor")

for runtime in ("nemo-speech/bin/nemo-speech", "ffmpeg/ffmpeg"):
    if not os.path.isfile(os.path.join(VENDOR_DIR, runtime)):
        raise SystemExit(f"[whisper-server.spec] {runtime} missing from {VENDOR_DIR}; run fetch-vendor.sh first")

datas = [(APP_DIR, "app")]
binaries = []
hiddenimports = []

# faster-whisper ships its Silero VAD model as package data, ctranslate2 its
# dylib and PyAV its bundled libav dylibs; collect_all takes all three kinds.
for package in ("faster_whisper", "ctranslate2", "av"):
    package_datas, package_binaries, package_hiddenimports = collect_all(package)
    datas += package_datas
    binaries += package_binaries
    hiddenimports += package_hiddenimports

# onnxruntime runs the VAD model.
datas += collect_data_files("onnxruntime")
binaries += collect_dynamic_libs("onnxruntime")
hiddenimports += collect_submodules("onnxruntime")

# OpenCC reads its configs and dictionaries from beside its own __file__, and
# app/chinese_script.py imports it lazily.
datas += collect_data_files("opencc")
hiddenimports += ["opencc"]

hiddenimports += collect_submodules("uvicorn")
# FastAPI imports python-multipart by name only when a form is parsed.
hiddenimports += ["multipart", "python_multipart"]

# uvicorn imports app.main:app from a string, so static analysis never reaches
# the app package. List its modules from the files, as the Windows spec does.
_app_modules = sorted(
    "app." + name[:-3] for name in os.listdir(APP_DIR) if name.endswith(".py") and name != "__init__.py"
)
if "app.main" not in _app_modules:
    raise SystemExit(f"[whisper-server.spec] no app modules found under {APP_DIR}")
hiddenimports += ["app", *_app_modules]

a = Analysis(
    [ENTRY_SCRIPT],
    pathex=[BACKEND_ROOT],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["tkinter", "matplotlib", "pytest", "winservice"],
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="whisper-server",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    argv_emulation=False,
    target_arch="arm64",
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="whisper-server",
)

# A datas entry would land under _internal/, where neither app/ nor run_server
# looks, so copy the runtimes into the finished bundle (COLLECT has run).
# symlinks=True keeps nemo-speech's versioned dylib links intact.
for runtime in ("nemo-speech", "ffmpeg"):
    shutil.copytree(
        os.path.join(VENDOR_DIR, runtime),
        os.path.join(DISTPATH, "whisper-server", runtime),
        symlinks=True,
        dirs_exist_ok=True,
    )
