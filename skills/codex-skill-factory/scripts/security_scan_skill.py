#!/usr/bin/env python3
"""Scan a Codex skill folder for obvious secret and unsafe-code risks."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

SECRET_PATTERNS: list[tuple[str, re.Pattern[str], str]] = [
    ("OpenAI API key", re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b"), "high"),
    ("AWS access key", re.compile(r"\bAKIA[A-Z0-9]{16}\b"), "high"),
    ("GitHub token", re.compile(r"\bgh[pousr]_[A-Za-z0-9_]{20,}\b"), "high"),
    ("GitLab token", re.compile(r"\bglpat-[A-Za-z0-9_-]{20,}\b"), "high"),
    ("Slack token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b"), "high"),
    (
        "generic secret assignment",
        re.compile(r"""(?i)\b(api[_-]?key|secret|token|password)\b\s*[:=]\s*["'][^"']{8,}["']"""),
        "medium",
    ),
]

PYTHON_RISK_PATTERNS: list[tuple[str, re.Pattern[str], str]] = [
    ("eval usage", re.compile(r"\beval\s*\("), "high"),
    ("exec usage", re.compile(r"\bexec\s*\("), "high"),
    ("subprocess shell=True", re.compile(r"\bsubprocess\.[a-zA-Z_]+\s*\([^)]*shell\s*=\s*True"), "high"),
    ("os.system usage", re.compile(r"\bos\.system\s*\("), "high"),
    ("dynamic import", re.compile(r"\b__import__\s*\("), "medium"),
]

TEXT_EXTENSIONS = {
    ".cfg",
    ".css",
    ".html",
    ".ini",
    ".js",
    ".json",
    ".md",
    ".ps1",
    ".py",
    ".rst",
    ".sh",
    ".toml",
    ".ts",
    ".txt",
    ".yaml",
    ".yml",
}
SKIP_DIRS = {
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
MAX_TEXT_BYTES = 5 * 1024 * 1024


def is_env_file(path: Path) -> bool:
    name = path.name.lower()
    return name == ".env" or name.startswith(".env.")


def should_scan_text(path: Path) -> bool:
    return path.suffix.lower() in TEXT_EXTENSIONS and path.stat().st_size <= MAX_TEXT_BYTES


def scan(skill_dir: Path) -> dict[str, object]:
    root = skill_dir.resolve()
    issues: list[dict[str, object]] = []

    if not root.exists() or not root.is_dir():
        return {
            "clean": False,
            "issues": [
                {
                    "severity": "high",
                    "file": str(root),
                    "line": 0,
                    "pattern": "missing_skill_directory",
                    "message": "skill directory is missing or not a directory",
                }
            ],
        }

    for current, dirs, files in os.walk(root):
        dirs[:] = [directory for directory in dirs if directory not in SKIP_DIRS]
        current_path = Path(current)
        for filename in files:
            path = current_path / filename
            rel = path.relative_to(root).as_posix()

            if is_env_file(path):
                issues.append(
                    {
                        "severity": "high",
                        "file": rel,
                        "line": 0,
                        "pattern": "env_file",
                        "message": ".env files must not be included in skills",
                    }
                )
                continue

            if not should_scan_text(path):
                continue

            try:
                lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
            except OSError as exc:
                issues.append(
                    {
                        "severity": "medium",
                        "file": rel,
                        "line": 0,
                        "pattern": "read_error",
                        "message": f"could not scan file: {exc}",
                    }
                )
                continue

            is_python = path.suffix.lower() == ".py"
            for line_number, line in enumerate(lines, start=1):
                for label, pattern, severity in SECRET_PATTERNS:
                    if pattern.search(line):
                        issues.append(
                            {
                                "severity": severity,
                                "file": rel,
                                "line": line_number,
                                "pattern": label,
                                "message": "possible hardcoded secret",
                            }
                        )
                if is_python:
                    for label, pattern, severity in PYTHON_RISK_PATTERNS:
                        if pattern.search(line):
                            issues.append(
                                {
                                    "severity": severity,
                                    "file": rel,
                                    "line": line_number,
                                    "pattern": label,
                                    "message": "review unsafe code pattern before packaging",
                                }
                            )

    severity_order = {"high": 0, "medium": 1, "low": 2}
    issues.sort(key=lambda item: (severity_order.get(str(item["severity"]), 9), str(item["file"]), int(item["line"])))
    return {"clean": not issues, "issues": issues}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("skill_dir", type=Path)
    parser.add_argument("--json", action="store_true", help="print machine-readable JSON")
    args = parser.parse_args()

    result = scan(args.skill_dir)
    if args.json:
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        print(f"Status: {'CLEAN' if result['clean'] else 'ISSUES FOUND'}")
        for issue in result["issues"]:
            print(
                f"  - [{issue['severity']}] {issue['file']}:{issue['line']} "
                f"{issue['pattern']} - {issue['message']}"
            )
    return 0 if result["clean"] else 1


if __name__ == "__main__":
    sys.exit(main())
