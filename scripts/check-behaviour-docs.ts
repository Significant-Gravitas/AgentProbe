#!/usr/bin/env bun
/**
 * Validates that current-state.md and e2e-checklist.md exist and reference
 * scenarios defined in docs/product-specs/platform.md.
 */

import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";

const REPO_ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
const PRODUCT_SPECS = join(REPO_ROOT, "docs", "product-specs");

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

function readText(filePath: string): string {
  return existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
}

const platformScenarios = extractScenarios(join(PRODUCT_SPECS, "platform.md"));

if (platformScenarios.length === 0) {
  console.log(
    "No scenarios found in platform.md — skipping behaviour check."
  );
  process.exit(0);
}

console.log(`Found ${platformScenarios.length} scenario(s) in platform.md`);

let errors = 0;
for (const file of ["current-state.md", "e2e-checklist.md"]) {
  const filePath = join(PRODUCT_SPECS, file);
  if (!existsSync(filePath)) {
    console.error(`MISSING: ${file}`);
    errors++;
    continue;
  }

  const content = readText(filePath);
  for (const scenario of platformScenarios) {
    if (!content.includes(scenario)) {
      console.error(`MISSING SCENARIO REFERENCE: ${file} -> ${scenario}`);
      errors++;
    }
  }
}

if (errors > 0) process.exit(1);
console.log("Product specs are present and consistent.");
