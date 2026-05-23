#!/usr/bin/env python3
"""Validate a Codex skill package structure without external dependencies."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

MAX_NAME_LENGTH = 64
MAX_DESCRIPTION_LENGTH = 1024
MAX_BODY_LINES_WARNING = 500
NAME_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$")
LOCAL_LINK_RE = re.compile(r"\[[^\]]+\]\(([^)]+)\)")


def split_frontmatter(text: str) -> tuple[str | None, str | None]:
    if not text.startswith("---"):
        return None, None
    closing = text.find("\n---", 3)
    if closing == -1:
        return None, None
    frontmatter = text[3:closing].strip()
    body = text[closing + 4 :].strip()
    return frontmatter, body


def yaml_scalar(frontmatter: str, key: str) -> str | None:
    lines = frontmatter.splitlines()
    for index, line in enumerate(lines):
        stripped = line.strip()
        if not stripped.startswith(f"{key}:"):
            continue
        value = stripped[len(key) + 1 :].strip()
        if value in {">", ">-", "|", "|-", ">+", "|+"}:
            parts: list[str] = []
            for follow in lines[index + 1 :]:
                if follow.startswith((" ", "\t")):
                    parts.append(follow.strip())
                    continue
                break
            return " ".join(parts).strip()
        return value.strip().strip('"').strip("'")
    return None


def local_links(body: str) -> list[str]:
    found: list[str] = []
    for match in LOCAL_LINK_RE.finditer(body):
        target = match.group(1).strip()
        if target.startswith(("http://", "https://", "mailto:", "#")):
            continue
        target = target.split("#", 1)[0]
        if target:
            found.append(target)
    return found


def is_relative_inside(root: Path, target: Path) -> bool:
    try:
        target.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def validate(skill_dir: Path) -> dict[str, object]:
    errors: list[str] = []
    warnings: list[str] = []
    root = skill_dir.resolve()

    if not root.exists():
        return {"valid": False, "errors": [f"path does not exist: {root}"], "warnings": []}
    if not root.is_dir():
        return {"valid": False, "errors": [f"path is not a directory: {root}"], "warnings": []}

    skill_md = root / "SKILL.md"
    if not skill_md.exists():
        return {"valid": False, "errors": ["SKILL.md is missing"], "warnings": []}

    text = skill_md.read_text(encoding="utf-8")
    frontmatter, body = split_frontmatter(text)
    if frontmatter is None or body is None:
        return {
            "valid": False,
            "errors": ["SKILL.md must start with closed YAML frontmatter"],
            "warnings": [],
        }

    name = yaml_scalar(frontmatter, "name")
    description = yaml_scalar(frontmatter, "description")

    if not name:
        errors.append("frontmatter field 'name' is required")
    else:
        if len(name) > MAX_NAME_LENGTH:
            errors.append(f"name exceeds {MAX_NAME_LENGTH} characters")
        if not NAME_RE.match(name):
            errors.append("name must use lowercase letters, digits, and hyphens only")
        if name != root.name:
            errors.append(f"name '{name}' must match directory name '{root.name}'")

    if not description:
        errors.append("frontmatter field 'description' is required")
    elif len(description) > MAX_DESCRIPTION_LENGTH:
        errors.append(f"description exceeds {MAX_DESCRIPTION_LENGTH} characters")

    body_lines = body.splitlines()
    if len(body_lines) > MAX_BODY_LINES_WARNING:
        warnings.append(
            f"SKILL.md body has {len(body_lines)} lines; consider moving details to references/"
        )

    for link in local_links(body):
        if Path(link).is_absolute():
            warnings.append(f"local markdown link should be relative: {link}")
            continue
        resolved = root / link
        if not is_relative_inside(root, resolved):
            errors.append(f"local markdown link escapes skill directory: {link}")
        elif not resolved.exists():
            warnings.append(f"local markdown link target is missing: {link}")

    for dirname in ("scripts", "references", "assets", "agents"):
        candidate = root / dirname
        if candidate.exists() and not candidate.is_dir():
            errors.append(f"{dirname}/ exists but is not a directory")

    return {"valid": not errors, "errors": errors, "warnings": warnings}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("skill_dir", type=Path)
    parser.add_argument("--json", action="store_true", help="print machine-readable JSON")
    args = parser.parse_args()

    result = validate(args.skill_dir)
    if args.json:
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        status = "VALID" if result["valid"] else "INVALID"
        print(f"Status: {status}")
        for key in ("errors", "warnings"):
            values = result[key]
            if values:
                print(f"{key.capitalize()}:")
                for value in values:
                    print(f"  - {value}")
    return 0 if result["valid"] else 1


if __name__ == "__main__":
    sys.exit(main())
