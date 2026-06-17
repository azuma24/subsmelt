# -*- mode: python ; coding: utf-8 -*-
#
# PyInstaller spec for the SubSmelt Whisper native GUI app (Tkinter + tray).
#
# WINDOWS-BUILD-ONLY. Produces a small WINDOWED onefile whisper-gui.exe (no
# console). It launches/controls the sibling run_server.exe, so it must NOT
# bundle the heavy server/CUDA deps — keep this tiny. build-local.ps1 copies it
# into dist\whisper-server\ next to run_server.exe.
#
#     pyinstaller packaging\windows\whisper-gui.spec --clean --noconfirm
import os

from PyInstaller.utils.hooks import collect_submodules

SPEC_DIR = os.path.abspath(SPECPATH)
GUI_SCRIPT = os.path.join(SPEC_DIR, "tray", "whisper_gui.py")

hiddenimports = []
hiddenimports += collect_submodules("pystray")
hiddenimports += collect_submodules("PIL")

block_cipher = None

a = Analysis(
    [GUI_SCRIPT],
    pathex=[SPEC_DIR],
    binaries=[],
    datas=[],
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["matplotlib", "numpy", "faster_whisper", "ctranslate2", "onnxruntime"],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name="whisper-gui",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    runtime_tmpdir=None,
    console=False,            # windowed app: no console
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
