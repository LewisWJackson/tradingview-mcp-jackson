#!/usr/bin/env python3
"""Create a reviewable zip package for a Codex skill after safe checks pass."""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent


def load_function(script_name: str, function_name: str):
    spec = importlib.util.spec_from_file_location(script_name, SCRIPT_DIR / script_name)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"could not load {script_name}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return getattr(module, function_name)


validate = load_function("validate_skill_package.py", "validate")
scan = load_function("security_scan_skill.py", "scan")

EXCLUDED_DIRS = {
    ".git",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".venv",
    "__pycache__",
    "build",
    "dist",
    "node_modules",
    "venv",
}
EXCLUDED_SUFFIXES = {".log", ".pyc", ".pyo", ".tmp", ".zip"}


def is_env_file(path: Path) -> bool:
    name = path.name.lower()
    return name == ".env" or name.startswith(".env.")


def should_include(path: Path, root: Path) -> bool:
    rel_parts = path.relative_to(root).parts
    if any(part in EXCLUDED_DIRS for part in rel_parts):
        return False
    if is_env_file(path):
        return False
    if path.suffix.lower() in EXCLUDED_SUFFIXES:
        return False
    return path.is_file()


def package(skill_dir: Path, output_dir: Path) -> dict[str, object]:
    root = skill_dir.resolve()
    validation = validate(root)
    security = scan(root)

    if not validation["valid"] or not security["clean"]:
        return {
            "packaged": False,
            "archive": None,
            "validation": validation,
            "security": security,
        }

    output_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    archive = output_dir.resolve() / f"{root.name}-{stamp}.zip"

    manifest = {
        "skill": root.name,
        "created_utc": stamp,
        "source": str(root),
        "checks": {
            "validation": validation,
            "security": security,
        },
        "auto_installed": False,
    }

    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(root.rglob("*")):
            if should_include(path, root):
                zf.write(path, Path(root.name) / path.relative_to(root))
        zf.writestr(
            str(Path(root.name) / "PACKAGE_MANIFEST.json"),
            json.dumps(manifest, indent=2, ensure_ascii=False),
        )

    return {
        "packaged": True,
        "archive": str(archive),
        "validation": validation,
        "security": security,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("skill_dir", type=Path)
    parser.add_argument("--output-dir", type=Path, default=Path("output/skill-packages"))
    parser.add_argument("--json", action="store_true", help="print machine-readable JSON")
    args = parser.parse_args()

    result = package(args.skill_dir, args.output_dir)
    if args.json:
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        if result["packaged"]:
            print(f"Packaged: {result['archive']}")
        else:
            print("Package not created because validation or security scan failed.")
            print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0 if result["packaged"] else 1


if __name__ == "__main__":
    sys.exit(main())
