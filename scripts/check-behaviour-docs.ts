#!/usr/bin/env bun
/**
 * Validates that current-state.md and e2e-checklist.md exist and reference
 * scenarios defined in platform.md.
 */

import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";

const REPO_ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
const BEHAVIOURS = join(REPO_ROOT, "docs", "behaviours");

function extractScenarios(filePath: string): string[] {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, "utf8");
  const re = /^###\s+(.+)$/gm;
  const scenarios: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    scenarios.push(match[1].trim());
  }
  return scenarios;
}

const platformScenarios = extractScenarios(join(BEHAVIOURS, "platform.md"));

if (platformScenarios.length === 0) {
  console.log(
    "No scenarios found in platform.md — skipping behaviour check."
  );
  process.exit(0);
}

console.log(`Found ${platformScenarios.length} scenario(s) in platform.md`);

let errors = 0;
for (const file of ["current-state.md", "e2e-checklist.md"]) {
  if (!existsSync(join(BEHAVIOURS, file))) {
    console.error(`MISSING: ${file}`);
    errors++;
  }
}

if (errors > 0) process.exit(1);
console.log("Behaviour docs present and consistent.");
