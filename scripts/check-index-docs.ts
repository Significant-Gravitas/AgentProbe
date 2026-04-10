#!/usr/bin/env bun
/**
 * Verifies every directory under docs/ has an INDEX.md and that each index
 * links to all sibling files and child directory INDEX.md files.
 */

import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";

const REPO_ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
const DOCS_DIR = "docs";
const INDEX_NAME = "INDEX.md";

const tracked = execFileSync("git", ["ls-files"], {
  cwd: REPO_ROOT,
  encoding: "utf8",
})
  .split("\n")
  .filter((p) => p && p.startsWith(`${DOCS_DIR}/`));

const directories = new Set([DOCS_DIR]);
for (const path of tracked) {
  const parts = path.split("/");
  if (parts.length <= 1) continue;
  let current = "";
  for (let i = 0; i < parts.length - 1; i++) {
    current = current ? `${current}/${parts[i]}` : parts[i];
    if (current === DOCS_DIR || current.startsWith(`${DOCS_DIR}/`)) {
      directories.add(current);
    }
  }
}

let failed = false;

function expectedEntries(dir: string): { files: string[]; subdirs: string[] } {
  const prefix = `${dir}/`;
  const files = tracked
    .filter((p) => p.startsWith(prefix))
    .map((p) => p.slice(prefix.length))
    .filter((p) => p && !p.includes("/") && p !== INDEX_NAME)
    .sort();

  const subdirs = [...directories]
    .filter((c) => c !== dir)
    .filter((c) => c.startsWith(`${dir}/`) && !c.slice(dir.length + 1).includes("/"))
    .sort();

  return { files, subdirs };
}

for (const dir of [...directories].sort()) {
  const indexPath = join(REPO_ROOT, dir, INDEX_NAME);
  const label = `${dir}/${INDEX_NAME}`;

  if (!existsSync(indexPath)) {
    console.error(`Missing ${label}`);
    failed = true;
    continue;
  }

  const content = readFileSync(indexPath, "utf8");

  if (
    !/^## Purpose\b/m.test(content) ||
    !/^## File conventions\b/m.test(content)
  ) {
    console.error(`Incomplete directory contract in ${label}`);
    failed = true;
  }

  const { files, subdirs } = expectedEntries(dir);

  for (const file of files) {
    if (!content.includes(`(${file})`)) {
      const fullPath = `${dir}/${file}`;
      console.error(`Missing file link for ${fullPath} in ${label}`);
      failed = true;
    }
  }

  for (const child of subdirs) {
    const childName = child.split("/").slice(-1)[0];
    if (
      !content.includes(`(${childName}/INDEX.md)`) &&
      !content.includes(`(${childName}/)`)
    ) {
      console.error(
        `Missing child index link for ${child}/INDEX.md in ${label}`
      );
      failed = true;
    }
  }
}

if (failed) process.exit(1);
console.log("All directory indexes are present and up to date.");
