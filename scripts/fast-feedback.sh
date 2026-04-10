#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "=== Fast Feedback ==="

# 1. Repo validation
echo "--- Repo validation ---"
bash "$SCRIPT_DIR/validate-repo.sh"

# 2. Lint
echo "--- Lint ---"
bun run lint

# 3. Type check
echo "--- Type check ---"
bun run typecheck

# 4. Tests
echo "--- Tests ---"
bun run test

echo ""
echo "Fast feedback passed."
