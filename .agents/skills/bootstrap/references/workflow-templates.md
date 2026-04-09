# Workflow and PR Templates

Replace `{{placeholders}}` with project-specific values.

---

## .github/pull_request_template.md

```markdown
## Intent

_What does this PR do and why?_

## Behavior changes

_What user-visible behavior changed? If none, write "No behavior changes."_

## Validation

- [ ] `./scripts/fast-feedback.sh` passed
- [ ] `./scripts/ui-smoke.sh` passed (if UI changed)
- [ ] Behavior docs updated (if behavior changed)

## Screenshots / video

_Attach for user-facing changes. Write "N/A" for backend-only changes._
```

---

## .github/workflows/pr-fast.yml

```yaml
name: PR Fast Feedback

on:
  pull_request:
    branches: [main, master]

permissions:
  contents: read

jobs:
  fast-feedback:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: '{{package_manager}}'

      # Add other setup steps as needed (e.g., Go, Python, etc.)

      - name: Install dependencies
        run: {{install_command}}

      - name: Fast feedback
        run: ./scripts/fast-feedback.sh
```

---

## .github/workflows/pr-ui-smoke.yml

Only include if the project has a browser frontend.

```yaml
name: PR UI Smoke

on:
  pull_request:
    branches: [main, master]
    paths:
      - '{{frontend_dir}}/**'
      - 'e2e/**'
      - 'playwright.config.*'

permissions:
  contents: read

jobs:
  smoke:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: '{{package_manager}}'

      - name: Install dependencies
        run: {{install_command}}

      - name: Install Playwright browsers
        run: npx playwright install --with-deps chromium

      - name: Run smoke tests
        run: ./scripts/ui-smoke.sh
        env:
          ARTIFACTS_DIR: ${{ github.workspace }}/test-results

      - name: Upload artifacts
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: smoke-results
          path: test-results/
          retention-days: 7
```

---

## .github/workflows/nightly-baseline.yml

```yaml
name: Nightly Baseline

on:
  schedule:
    - cron: '30 4 * * *'  # 4:30 AM UTC daily
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: write

jobs:
  baseline:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: '{{package_manager}}'

      - name: Install dependencies
        run: {{install_command}}

      - name: Install Playwright browsers
        run: npx playwright install --with-deps chromium

      - name: Run full test suite
        id: tests
        continue-on-error: true
        run: npx playwright test --reporter=html
        env:
          ARTIFACTS_DIR: ${{ github.workspace }}/test-results

      - name: Upload results
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: baseline-results
          path: test-results/
          retention-days: 30

      - name: Open fix-forward PR on failure
        if: steps.tests.outcome == 'failure'
        uses: peter-evans/create-pull-request@v6
        with:
          title: 'fix: nightly baseline failure'
          body: |
            The nightly baseline suite failed.
            See the [workflow run](${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}) for details.
          branch: fix/nightly-baseline
          delete-branch: true
```

---

## .github/workflows/weekly-doc-gardening.yml

```yaml
name: Weekly Doc Gardening

on:
  schedule:
    - cron: '0 9 * * 1'  # 9 AM UTC every Monday
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: write

jobs:
  refresh:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: '{{package_manager}}'

      - name: Install dependencies
        run: {{install_command}}

      - name: Refresh generated docs
        run: |
          node scripts/generate-workspace-docs.mjs
          node scripts/refresh-quality-score.mjs

      - name: Check for changes
        id: changes
        run: |
          if git diff --quiet; then
            echo "changed=false" >> "$GITHUB_OUTPUT"
          else
            echo "changed=true" >> "$GITHUB_OUTPUT"
          fi

      - name: Open maintenance PR
        if: steps.changes.outputs.changed == 'true'
        uses: peter-evans/create-pull-request@v6
        with:
          title: 'docs: refresh generated docs'
          body: |
            Weekly automated refresh of generated documentation.
            Review the changes and merge if they look correct.
          branch: docs/weekly-refresh
          delete-branch: true
```

---

## .github/workflows/automerge.yml

```yaml
name: Automerge

on:
  pull_request_review:
    types: [submitted]
  check_suite:
    types: [completed]

permissions:
  contents: write
  pull-requests: write

jobs:
  automerge:
    runs-on: ubuntu-latest
    # Only run for PRs that are approved and all checks pass
    if: >
      github.event.review.state == 'approved' ||
      github.event.check_suite.conclusion == 'success'
    steps:
      - uses: actions/checkout@v4

      - name: Check automerge eligibility
        id: eligible
        run: |
          # Stage 1: No automerge — human merge required
          # Uncomment Stage 2 when the repo is stable enough:
          #
          # ELIGIBLE_PATHS=(
          #   "docs/"
          #   "e2e/"
          #   "**/*.test.*"
          #   "**/*.spec.*"
          # )
          #
          # PROTECTED_PATHS=(
          #   "**/migrations/**"
          #   "**/auth/**"
          #   "**/billing/**"
          #   "**/.env*"
          #   "**/credentials*"
          #   "**/secrets*"
          #   ".github/**"
          #   "AGENTS.md"
          #   "docs/HARNESS.md"
          # )

          echo "eligible=false" >> "$GITHUB_OUTPUT"
          echo "Stage 1: automerge disabled. Human merge required."

      # Uncomment when ready for Stage 2:
      # - name: Auto-merge
      #   if: steps.eligible.outputs.eligible == 'true'
      #   run: gh pr merge --auto --squash "${{ github.event.pull_request.number }}"
      #   env:
      #     GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

---

## Automerge path classification file

Create `.github/automerge-paths.json` to configure eligible paths:

```json
{
  "stage": 1,
  "eligible_paths": [],
  "protected_paths": [
    "**/migrations/**",
    "**/auth/**",
    "**/billing/**",
    "**/.env*",
    "**/credentials*",
    "**/secrets*",
    ".github/**",
    "AGENTS.md",
    "docs/HARNESS.md"
  ],
  "notes": "Stage 1: no automerge. Graduate to Stage 2 after repo is stable."
}
```
