# Codex-Safe Skill Distribution

Role marker: navigation/reference. The scripts are the executable source of truth; this file explains when to use them.

## What This Standard Allows

- Validate a skill folder before reuse.
- Scan a skill folder for obvious secrets and unsafe script patterns.
- Create a local zip package for review or controlled rollout.
- Prepare global-kit or repo-local diffs after explicit approval for writes outside the current workspace.

## What This Standard Does Not Allow

- Auto-install into user-level runtime folders.
- Modify editor or Codex configuration.
- Push, publish, create remotes, or update registries without explicit approval.
- Read or package `.env` / `.env.*` files.

## Recommended Rollout Shape

1. Build or update the skill in a repository workspace.
2. Run validation and security scan.
3. Package a clean artifact.
4. Promote durable standards to `C:\Users\nitta\codex-global-kit`.
5. Sync allowlisted content into `C:\Users\nitta\.codex` only when needed.
6. Apply repo-local adoption one repository at a time, respecting each repo's `AGENTS.md`.
