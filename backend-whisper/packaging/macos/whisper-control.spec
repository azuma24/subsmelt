# -*- mode: python ; coding: utf-8 -*-
#
# PyInstaller spec for the SubSmelt Whisper menu-bar app (macOS).
#
# One "SubSmelt Whisper.app" with LSUIElement=true: a menu-bar controller, not
# a Dock app. It bundles the shared tray/GUI code from packaging/windows/tray/
# plus the macOS service_control; the Tk control window opens from the menu as
# a child process (--window), because Tk wants the main thread this process's
# event loop already owns.
#
#     pyinstaller packaging/macos/whisper-control.spec --clean --noconfirm
#
# Tiny build on purpose: no faster-whisper/ctranslate2, no model weights.
import os
import re

from PyInstaller.utils.hooks import collect_submodules

SPEC_DIR = os.path.abspath(SPECPATH)  # .../packaging/macos
BACKEND_ROOT = os.path.abspath(os.path.join(SPEC_DIR, "..", ".."))
TRAY_DIR = os.path.abspath(os.path.join(SPEC_DIR, "..", "windows", "tray"))
TRAY_SCRIPT = os.path.join(TRAY_DIR, "whisper_tray.py")

# Crash reports read the bundle's version; stamp the backend's so a report
# says which build crashed instead of PyInstaller's default 0.0.0.
_version_py = os.path.join(BACKEND_ROOT, "app", "version.py")
_match = re.search(r'_DEFAULT_VERSION = "([^"]+)"', open(_version_py, encoding="utf-8").read())
APP_VERSION = _match.group(1) if _match else "0.0.0"

# pystray picks its backend dynamically (darwin here); pull its submodules, the
# image library, and the shared modules the tray and the window import.
hiddenimports = [
    "server_launch",
    "gui_config",
    "whisper_gui",
    "service_control",
]
hiddenimports += collect_submodules("pystray")
hiddenimports += collect_submodules("PIL")

a = Analysis(
    [TRAY_SCRIPT],
    pathex=[TRAY_DIR, SPEC_DIR],
    binaries=[],
    datas=[],
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # tkinter stays IN: --window runs the Tk control window from this binary.
    excludes=["matplotlib", "pytest", "numpy", "faster_whisper", "ctranslate2", "winservice"],
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="SubSmelt Whisper",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,  # a menu-bar app shows no console
    disable_windowed_traceback=False,
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
    name="SubSmelt Whisper",
)

app = BUNDLE(
    coll,
    name="SubSmelt Whisper.app",
    info_plist={
        "CFBundleName": "SubSmelt Whisper",
        "CFBundleDisplayName": "SubSmelt Whisper",
        "CFBundleIdentifier": "com.subsmelt.whisper.control",
        "CFBundleShortVersionString": APP_VERSION,
        "CFBundleVersion": APP_VERSION,
        # Lives in the menu bar, not the Dock.
        "LSUIElement": True,
        "NSHighResolutionCapable": True,
        "LSMinimumSystemVersion": "13.0",
    },
)
