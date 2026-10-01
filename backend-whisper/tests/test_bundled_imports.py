"""Every module-level import in app/ must be stdlib or a package the Windows
installer locks. Anything else crashes the frozen server at import, before it
can log, the way the 0.6.0 installer died on a module it never bundled."""

import ast
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONSTRAINTS = ROOT / "packaging" / "windows" / "constraints.txt"
IMPORT_NAME_TO_PACKAGE = {"yaml": "pyyaml", "pynvml": "nvidia_ml_py", "multipart": "python_multipart"}


def locked_packages() -> set[str]:
    names = set()
    for line in CONSTRAINTS.read_text().splitlines():
        if "==" in line and not line.startswith("#"):
            names.add(line.split("==")[0].strip().lower().replace("-", "_"))
    return names


def deferred_imports(tree: ast.AST) -> set[int]:
    """Imports inside a function or a try block load lazily or degrade on failure."""
    ids = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Try)):
            ids.update(id(n) for n in ast.walk(node) if isinstance(n, (ast.Import, ast.ImportFrom)))
    return ids


def unbundled_module_level_imports() -> list[str]:
    locked = locked_packages()
    found = []
    for path in sorted((ROOT / "app").glob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        deferred = deferred_imports(tree)
        for node in ast.walk(tree):
            if id(node) in deferred:
                continue
            if isinstance(node, ast.Import):
                names = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                names = [node.module]
            else:
                continue
            for name in names:
                top = name.split(".")[0]
                if top in sys.stdlib_module_names or top == "app":
                    continue
                if IMPORT_NAME_TO_PACKAGE.get(top, top).lower() not in locked:
                    found.append(f"{path.name}:{node.lineno} imports {name}")
    return found


class BundledImportTests(unittest.TestCase):
    def test_every_module_level_import_is_stdlib_or_locked_for_the_installer(self):
        self.assertEqual(unbundled_module_level_imports(), [])

    def test_the_lock_names_the_runtime_packages(self):
        self.assertTrue({"faster_whisper", "av", "ctranslate2", "fastapi", "uvicorn"} <= locked_packages())
