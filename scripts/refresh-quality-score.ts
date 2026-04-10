#!/usr/bin/env bun
/**
 * Regenerates docs/QUALITY_SCORE.md from current repo state.
 */

import { existsSync, readdirSync, writeFileSync } from "fs";
import { join, dirname } from "path";

const REPO_ROOT = join(dirname(new URL(import.meta.url).pathname), "..");

function check(
  name: string,
  condition: boolean
): { name: string; status: string; ok: boolean } {
  return { name, status: condition ? "\u{1F7E2}" : "\u{1F7E1}", ok: condition };
}

const testsDir = join(REPO_ROOT, "tests");
const hasTests =
  existsSync(testsDir) &&
  readdirSync(testsDir).some((f) => f.startsWith("test_") && f.endsWith(".py"));

const checks = [
  check("CI config", existsSync(join(REPO_ROOT, ".github", "workflows"))),
  check("Test suite", hasTests),
  check(
    "Behaviour spec",
    existsSync(join(REPO_ROOT, "docs", "behaviours", "platform.md"))
  ),
  check("AGENTS.md", existsSync(join(REPO_ROOT, "AGENTS.md"))),
  check("Harness doc", existsSync(join(REPO_ROOT, "docs", "HARNESS.md"))),
];

const date = new Date().toISOString().split("T")[0];
const rows = checks
  .map(
    (c) =>
      `| ${c.name.padEnd(18)} | ${c.status}     | ${c.ok ? "Present" : "Missing"} |`
  )
  .join("\n");

const content = `# Quality Score

Last updated: ${date}

## Health summary

| Area               | Status | Notes                     |
|--------------------|--------|---------------------------|
${rows}

## Incidents

_No incidents yet._

## Next cleanup targets

1. Expand test coverage
2. Fill out remaining behavior scenarios
3. Add integration tests for core paths
`;

writeFileSync(join(REPO_ROOT, "docs", "QUALITY_SCORE.md"), content);
console.log("Refreshed docs/QUALITY_SCORE.md");
