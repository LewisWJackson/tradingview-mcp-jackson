#!/bin/bash
# Usage: ./scripts/pr.sh "commit message" ["PR title"]
# Stages all changes, commits, pushes to your fork, and opens a PR to upstream.

set -e

MSG="${1:-}"
TITLE="${2:-$MSG}"
UPSTREAM="LewisWJackson/tradingview-mcp-jackson"

if [ -z "$MSG" ]; then
  echo "Usage: ./scripts/pr.sh \"commit message\" [\"PR title\"]"
  exit 1
fi

git add -A
git commit -m "$MSG

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"

git push

BRANCH=$(git rev-parse --abbrev-ref HEAD)
FORK_USER=$(gh api user --jq .login)

gh pr create \
  --repo "$UPSTREAM" \
  --base main \
  --head "${FORK_USER}:${BRANCH}" \
  --title "$TITLE" \
  --body "$(cat <<EOF
## Changes
$MSG

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
