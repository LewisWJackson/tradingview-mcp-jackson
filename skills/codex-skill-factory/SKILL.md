---
name: codex-skill-factory
description: Validate, security scan, and package Codex skills without auto-installing, changing user-level config, pushing git remotes, or touching secrets. Use when creating or updating a skill, reviewing an existing skill folder, preparing a skill for global standardization, or packaging a skill for repo rollout.
---

# Codex Skill Factory

Use this skill after a skill has been drafted and before it is promoted to global standards or copied into another repository. It adds the safe parts of an agent-skill factory: validation, security scanning, and distribution packaging.

## Safety Boundary

- Do not auto-install skills into `C:\Users\nitta\.codex`, `~/.agents`, editor config folders, or other user-level paths.
- Do not create remotes, push, publish, or update registries unless the user explicitly approves that separate action.
- Do not read, write, package, delete, or normalize `.env` / `.env.*` files.
- Treat generated archives as reviewable artifacts, not as accepted governance.
- For durable global standards, edit `C:\Users\nitta\codex-global-kit` first, then sync allowlisted content into live runtime only when explicitly requested and approved.

## Workflow

1. Read project-local `AGENTS.md`, relevant docs, and the target skill's `SKILL.md`.
2. Run structure validation:
   ```powershell
   python skills\codex-skill-factory\scripts\validate_skill_package.py <skill-dir>
   ```
3. Run security scan:
   ```powershell
   python skills\codex-skill-factory\scripts\security_scan_skill.py <skill-dir>
   ```
4. Package only after both checks pass:
   ```powershell
   python skills\codex-skill-factory\scripts\package_skill.py <skill-dir> --output-dir output\skill-packages
   ```
5. For global standardization, prepare a scoped diff against `C:\Users\nitta\codex-global-kit`. Ask for approval before writing outside the current workspace.
6. For each repo rollout, read that repo's local `AGENTS.md` first, then copy or adapt only the skill, docs, and validators that are relevant to that repo.

## Validation Rules

`validate_skill_package.py` checks:

- `SKILL.md` exists and starts with YAML frontmatter.
- `name` and `description` are present and non-empty.
- Skill name matches the directory and uses lowercase letters, digits, and hyphens.
- Description is no longer than 1024 characters.
- `SKILL.md` body stays under 500 lines unless intentionally justified.
- Local markdown links point to existing files.
- Referenced `scripts/`, `references/`, and `assets/` paths remain inside the skill directory.

## Security Scan Rules

`security_scan_skill.py` checks:

- `.env` and `.env.*` files are present anywhere in the skill tree.
- Common API key/token patterns appear in text files.
- Python scripts contain risky dynamic execution or shell invocation patterns.
- Package caches, virtualenvs, git metadata, build outputs, and binary blobs are skipped.

The scan reports filenames and line numbers for text files it can safely read. It reports `.env` files by path only and does not read their contents.

## Packaging Rules

`package_skill.py` creates a zip archive only when validation and security scan pass. It excludes:

- `.git`, caches, virtualenvs, build outputs, and test runtime state.
- `.env` / `.env.*` files.
- `.pyc`, logs, temporary files, and existing package archives.

The archive is meant for review, handoff, or controlled rollout. It is not installed automatically.

## Promotion Checklist

Before promoting a skill to global standards:

1. Confirm the skill solves a recurring cross-repo workflow.
2. Confirm local repo rules do not already provide a stricter workflow.
3. Run validation, security scan, and package creation.
4. Add or update a global standard/reference in `C:\Users\nitta\codex-global-kit`.
5. Sync to live `.codex` only after the canonical global-kit change is accepted.
6. Roll out repo-local adoption with minimal diffs and repo-specific validation.
