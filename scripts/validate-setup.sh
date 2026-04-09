#!/usr/bin/env bash
set -euo pipefail

# validate-setup.sh
#
# Checks that all expected files from an agent-first bootstrap exist.
# Run after bootstrapping to verify completeness, or at any time to
# check if the repo structure has drifted.
#
# Usage:
#   ./scripts/validate-setup.sh [--has-frontend] [--has-harness]

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

HAS_FRONTEND=false
HAS_HARNESS=false

for arg in "$@"; do
  case "$arg" in
    --has-frontend) HAS_FRONTEND=true ;;
    --has-harness)  HAS_HARNESS=true ;;
  esac
done

# --- colour helpers (no-op if not a terminal) ---
if [ -t 1 ]; then
  GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[0;33m'; NC='\033[0m'
else
  GREEN=''; RED=''; YELLOW=''; NC=''
fi

PASS=0
FAIL=0
WARN=0

pass()  { PASS=$((PASS + 1)); echo -e "  ${GREEN}✓${NC} $1"; }
fail()  { FAIL=$((FAIL + 1)); echo -e "  ${RED}✗${NC} $1"; }
warn()  { WARN=$((WARN + 1)); echo -e "  ${YELLOW}?${NC} $1 (optional)"; }

check_file() {
  local path="$1"
  local label="${2:-$1}"
  if [ -f "$REPO_ROOT/$path" ]; then
    pass "$label"
  else
    fail "$label  →  missing $path"
  fi
}

check_dir() {
  local path="$1"
  local label="${2:-$1}"
  if [ -d "$REPO_ROOT/$path" ]; then
    pass "$label"
  else
    fail "$label  →  missing $path"
  fi
}

check_executable() {
  local path="$1"
  local label="${2:-$1}"
  if [ -f "$REPO_ROOT/$path" ]; then
    if [ -x "$REPO_ROOT/$path" ]; then
      pass "$label"
    else
      fail "$label  →  exists but not executable"
    fi
  else
    fail "$label  →  missing $path"
  fi
}

check_optional() {
  local path="$1"
  local label="${2:-$1}"
  if [ -f "$REPO_ROOT/$path" ]; then
    pass "$label"
  else
    warn "$label  →  $path"
  fi
}

# ============================================================
echo ""
echo "=== Bootstrap Setup Validation ==="
echo "Repo: $REPO_ROOT"
echo ""

# --- Core documents ---
echo "── Core documents ──"
check_file "AGENTS.md"            "AGENTS.md (router)"
check_file "README.md"            "README.md"
echo ""

# --- Docs structure ---
echo "── Docs ──"
check_file "docs/README.md"             "docs/README.md (index)"
check_file "docs/ARCHITECTURE.md"       "docs/ARCHITECTURE.md"
check_file "docs/HARNESS.md"            "docs/HARNESS.md (agent contract)"
check_file "docs/QUALITY_SCORE.md"      "docs/QUALITY_SCORE.md"
echo ""

# --- Behaviour docs ---
echo "── Behaviour docs ──"
check_file "docs/behaviours/README.md"        "docs/behaviours/README.md"
check_file "docs/behaviours/platform.md"      "docs/behaviours/platform.md (spec)"
check_file "docs/behaviours/current-state.md" "docs/behaviours/current-state.md"
check_file "docs/behaviours/e2e-checklist.md" "docs/behaviours/e2e-checklist.md"
echo ""

# --- Exec plans ---
echo "── Exec plans ──"
check_file "docs/exec-plans/README.md"   "docs/exec-plans/README.md"
check_dir  "docs/exec-plans/active"      "docs/exec-plans/active/"
check_dir  "docs/exec-plans/completed"   "docs/exec-plans/completed/"
echo ""

# --- Generated / playbooks dirs ---
echo "── Generated & playbooks ──"
check_dir "docs/generated"   "docs/generated/"
check_dir "docs/playbooks"   "docs/playbooks/"
echo ""

# --- Scripts (always expected) ---
echo "── Scripts (core) ──"
check_executable "scripts/validate-repo.sh"            "validate-repo.sh"
check_executable "scripts/fast-feedback.sh"            "fast-feedback.sh"
check_file       "scripts/generate-workspace-docs.py"  "generate-workspace-docs.py"
check_file       "scripts/refresh-quality-score.py"    "refresh-quality-score.py"
check_file       "scripts/check-doc-links.py"          "check-doc-links.py"
check_file       "scripts/check-agents-drift.py"       "check-agents-drift.py"
check_file       "scripts/check-behaviour-docs.py"     "check-behaviour-docs.py"
check_executable "scripts/check-generated-docs.sh"     "check-generated-docs.sh"
echo ""

# --- Scripts (conditional) ---
echo "── Scripts (conditional) ──"
if $HAS_FRONTEND; then
  check_executable "scripts/ui-smoke.sh" "ui-smoke.sh (frontend)"
else
  check_optional   "scripts/ui-smoke.sh" "ui-smoke.sh (frontend)"
fi

if $HAS_HARNESS; then
  check_executable "scripts/harness/run-local.sh" "harness/run-local.sh"
else
  check_optional   "scripts/harness/run-local.sh" "harness/run-local.sh"
fi
echo ""

# --- Tests ---
echo "── Tests ──"
if $HAS_FRONTEND; then
  check_file "playwright.config.ts"          "playwright.config.ts"
  check_file "e2e/smoke.behavior.spec.ts"    "e2e/smoke.behavior.spec.ts"
else
  check_optional "playwright.config.ts"       "playwright.config.ts"
  check_optional "e2e/smoke.behavior.spec.ts" "e2e/smoke.behavior.spec.ts"
fi
echo ""

# --- GitHub CI ---
echo "── GitHub workflows ──"
check_file ".github/pull_request_template.md"             "PR template"
check_file ".github/workflows/pr-fast.yml"                "pr-fast.yml"
check_file ".github/workflows/nightly-baseline.yml"       "nightly-baseline.yml"
check_file ".github/workflows/weekly-doc-gardening.yml"   "weekly-doc-gardening.yml"
check_file ".github/workflows/automerge.yml"              "automerge.yml"

if $HAS_FRONTEND; then
  check_file ".github/workflows/pr-ui-smoke.yml"          "pr-ui-smoke.yml (frontend)"
else
  check_optional ".github/workflows/pr-ui-smoke.yml"      "pr-ui-smoke.yml (frontend)"
fi
echo ""

# --- Automerge config ---
echo "── Automerge config ──"
check_optional ".github/automerge-paths.json" "automerge-paths.json"
echo ""

# ============================================================
echo "──────────────────────────────"
echo -e "  ${GREEN}Passed: $PASS${NC}    ${RED}Failed: $FAIL${NC}    ${YELLOW}Optional missing: $WARN${NC}"
echo "──────────────────────────────"

if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "Bootstrap is incomplete. $FAIL required file(s) missing."
  exit 1
else
  echo ""
  echo "Bootstrap setup is complete."
  exit 0
fi
