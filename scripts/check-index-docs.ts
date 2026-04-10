#!/usr/bin/env bun
/**
 * Verifies every directory under docs/ has an INDEX.md and that each index
 * links to all sibling files and child directory INDEX.md files.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, dirname } from "path";

const REPO_ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
const DOCS_DIR = "docs";
const INDEX_NAME = "INDEX.md";

function walkDocDirectories(dir: string): string[] {
  const directories = [dir];
  for (const name of readdirSync(join(REPO_ROOT, dir)).sort()) {
    const rel = `${dir}/${name}`;
    const full = join(REPO_ROOT, rel);
    if (!statSync(full).isDirectory() || name.startsWith(".")) continue;
    directories.push(...walkDocDirectories(rel));
  }
  return directories;
}

const directories = new Set(walkDocDirectories(DOCS_DIR));

let failed = false;

function expectedEntries(dir: string): { files: string[]; subdirs: string[] } {
  const fullDir = join(REPO_ROOT, dir);
  const entries = readdirSync(fullDir).sort();
  const files = entries
    .filter((name) => name.endsWith(".md") && name !== INDEX_NAME)
    .sort();

  const subdirs = entries
    .filter((name) => statSync(join(fullDir, name)).isDirectory())
    .filter((name) => !name.startsWith("."))
    .map((name) => `${dir}/${name}`)
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
