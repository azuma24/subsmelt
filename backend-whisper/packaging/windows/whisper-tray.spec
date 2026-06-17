# -*- mode: python ; coding: utf-8 -*-
#
# PyInstaller spec for the SubSmelt Whisper system-tray controller.
#
# WINDOWS-BUILD-ONLY. Produces a small ONEFILE whisper-tray.exe (no CUDA/model
# deps — just pystray + pillow). build-local.ps1 copies it into
# dist\whisper-server\ so the standalone tray's run_server.exe sibling resolves.
#
#     pyinstaller packaging\windows\whisper-tray.spec --clean --noconfirm
#
# The tray itself launches/stops the sibling run_server.exe (standalone mode),
# so it must NOT bundle the heavy server deps — keep this build tiny.
import os

from PyInstaller.utils.hooks import collect_submodules

SPEC_DIR = os.path.abspath(SPECPATH)                       # .../packaging/windows
TRAY_SCRIPT = os.path.join(SPEC_DIR, "tray", "whisper_tray.py")

# pystray picks a backend dynamically (win32 on Windows); pull its submodules and
# PIL so the frozen exe has them.
hiddenimports = []
hiddenimports += collect_submodules("pystray")
hiddenimports += collect_submodules("PIL")

block_cipher = None

a = Analysis(
    [TRAY_SCRIPT],
    pathex=[SPEC_DIR],
    binaries=[],
    datas=[],
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["tkinter", "matplotlib", "numpy", "faster_whisper", "ctranslate2"],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

# ONEFILE: a single whisper-tray.exe (small; no server deps bundled).
exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name="whisper-tray",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    runtime_tmpdir=None,
    console=False,            # tray app: no console window
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
