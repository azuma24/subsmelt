# PyInstaller spec for subsmelt-whisper (Windows one-folder build).
#
# Run from backend-whisper/ via:
#     pyinstaller scripts/backend-whisper.spec --clean --noconfirm
#
# The resulting dist/subsmelt-whisper/ folder is what the Inno Setup installer
# packages.
# -*- mode: python ; coding: utf-8 -*-

from PyInstaller.utils.hooks import collect_all, collect_submodules
import os

block_cipher = None

datas = []
binaries = []
hiddenimports = [
    *collect_submodules("uvicorn"),
    "uvicorn.logging",
    "uvicorn.loops",
    "uvicorn.loops.auto",
    "uvicorn.protocols",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.lifespan",
    "uvicorn.lifespan.on",
]

# Collect everything for the big ML deps — they have native DLLs + data that
# PyInstaller cannot always discover automatically.
for pkg in ("torch", "ctranslate2", "faster_whisper", "onnxruntime",
            "audio_separator", "silero_vad"):
    try:
        pkg_datas, pkg_binaries, pkg_hiddenimports = collect_all(pkg)
    except Exception:
        continue
    datas.extend(pkg_datas)
    binaries.extend(pkg_binaries)
    hiddenimports.extend(pkg_hiddenimports)

# Bundle ffmpeg.exe next to the main binary if it's been staged under bin/.
_ffmpeg = os.path.join("bin", "ffmpeg.exe")
if os.path.exists(_ffmpeg):
    binaries.append((_ffmpeg, "."))

a = Analysis(
    ["..\\subsmelt_whisper\\__main__.py"],
    pathex=[".."],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=["tkinter", "pytest"],
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    exclude_binaries=True,
    name="subsmelt-whisper",
    debug=False,
    strip=False,
    upx=False,
    console=True,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    name="subsmelt-whisper",
)
