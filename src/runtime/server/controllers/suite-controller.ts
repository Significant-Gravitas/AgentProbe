import { statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import {
  iterYamlFiles,
  parseYamlFile,
} from "../../../domains/validation/load-suite.ts";
import type {
  Endpoints,
  Persona,
  Rubric,
  Scenario,
} from "../../../shared/types/contracts.ts";
import { AgentProbeConfigError } from "../../../shared/utils/errors.ts";

const DEFAULT_CACHE_TTL_MS = 30_000;

export type SuiteSummary = {
  id: string;
  path: string;
  relativePath: string;
  schema: "scenarios" | "personas" | "rubrics" | "endpoints";
  objectCount: number;
  scenarioIds: string[];
};

export type ScenarioSummary = {
  suiteId: string;
  id: string;
  name: string;
  tags: string[];
  priority: string | null;
  persona: string | null;
  rubric: string | null;
  sourcePath: string;
};

export type SuiteInventory = {
  dataPath: string;
  suites: SuiteSummary[];
  scenarios: ScenarioSummary[];
  personas: Array<{
    suiteId: string;
    id: string;
    name: string;
    sourcePath: string;
  }>;
  rubrics: Array<{
    suiteId: string;
    id: string;
    name: string;
    sourcePath: string;
  }>;
  endpoints: Array<{
    suiteId: string;
    preset: string | null;
    transport: string | null;
    sourcePath: string;
  }>;
  scannedAt: string;
  errors: Array<{ path: string; message: string }>;
};

type SuiteCacheEntry = {
  fingerprint: string;
  inventory: SuiteInventory;
  expiresAt: number;
};

function fileFingerprint(path: string): string {
  try {
    const stat = statSync(path);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return "missing";
  }
}

function directoryFingerprint(dataPath: string, files: string[]): string {
  return `${dataPath}|${files
    .map((file) => `${file}=${fileFingerprint(file)}`)
    .join(",")}`;
}

function suiteIdFromFile(path: string, dataPath: string): string {
  const relativePath = relative(dataPath, path);
  return relativePath.replaceAll(/[\\/]/g, "__").replace(/\.(ya?ml)$/i, "");
}

function buildInventory(dataPath: string): SuiteInventory {
  const resolvedData = resolve(dataPath);
  const files = iterYamlFiles(resolvedData);
  const suites: SuiteSummary[] = [];
  const scenarios: ScenarioSummary[] = [];
  const personas: SuiteInventory["personas"] = [];
  const rubrics: SuiteInventory["rubrics"] = [];
  const endpoints: SuiteInventory["endpoints"] = [];
  const errors: SuiteInventory["errors"] = [];

  for (const file of files) {
    let parsed: ReturnType<typeof parseYamlFile>;
    try {
      parsed = parseYamlFile(file);
    } catch (error) {
      errors.push({
        path: file,
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const suiteId = suiteIdFromFile(file, resolvedData);
    const relativePath = relative(resolvedData, file) || file;

    if ("scenarios" in parsed) {
      const scenarioItems: Scenario[] = parsed.scenarios;
      suites.push({
        id: suiteId,
        path: relativePath,
        relativePath,
        schema: "scenarios",
        objectCount: scenarioItems.length,
        scenarioIds: scenarioItems.map((item) => item.id),
      });
      for (const scenario of scenarioItems) {
        scenarios.push({
          suiteId,
          id: scenario.id,
          name: scenario.name,
          tags: scenario.tags,
          priority: scenario.priority ?? null,
          persona: scenario.persona ?? null,
          rubric: scenario.rubric ?? null,
          sourcePath: relativePath,
        });
      }
      continue;
    }
    if ("personas" in parsed) {
      const items: Persona[] = parsed.personas;
      suites.push({
        id: suiteId,
        path: relativePath,
        relativePath,
        schema: "personas",
        objectCount: items.length,
        scenarioIds: [],
      });
      for (const persona of items) {
        personas.push({
          suiteId,
          id: persona.id,
          name: persona.name,
          sourcePath: relativePath,
        });
      }
      continue;
    }
    if ("rubrics" in parsed) {
      const items: Rubric[] = parsed.rubrics;
      suites.push({
        id: suiteId,
        path: relativePath,
        relativePath,
        schema: "rubrics",
        objectCount: items.length,
        scenarioIds: [],
      });
      for (const rubric of items) {
        rubrics.push({
          suiteId,
          id: rubric.id,
          name: rubric.name,
          sourcePath: relativePath,
        });
      }
      continue;
    }
    const endpointsDoc: Endpoints = parsed;
    suites.push({
      id: suiteId,
      path: relativePath,
      relativePath,
      schema: "endpoints",
      objectCount: 1,
      scenarioIds: [],
    });
    endpoints.push({
      suiteId,
      preset: endpointsDoc.preset ?? null,
      transport: endpointsDoc.transport ?? null,
      sourcePath: relativePath,
    });
  }

  suites.sort((left, right) => left.id.localeCompare(right.id));
  scenarios.sort((left, right) => {
    const suiteCompare = left.suiteId.localeCompare(right.suiteId);
    return suiteCompare !== 0 ? suiteCompare : left.id.localeCompare(right.id);
  });

  return {
    dataPath: resolvedData,
    suites,
    scenarios,
    personas,
    rubrics,
    endpoints,
    scannedAt: new Date().toISOString(),
    errors,
  };
}

export class SuiteController {
  private readonly dataPath: string;
  private readonly ttlMs: number;
  private cache?: SuiteCacheEntry;

  constructor(options: { dataPath: string; ttlMs?: number }) {
    this.dataPath = resolve(options.dataPath);
    this.ttlMs = options.ttlMs ?? DEFAULT_CACHE_TTL_MS;
  }

  private refreshIfNeeded(): SuiteInventory {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) {
      return this.cache.inventory;
    }

    let files: string[];
    try {
      files = iterYamlFiles(this.dataPath);
    } catch (error) {
      if (error instanceof AgentProbeConfigError) {
        throw error;
      }
      throw new AgentProbeConfigError(
        `Unable to read suite directory ${this.dataPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const fingerprint = directoryFingerprint(this.dataPath, files);
    if (this.cache && this.cache.fingerprint === fingerprint) {
      this.cache.expiresAt = now + this.ttlMs;
      return this.cache.inventory;
    }

    const inventory = buildInventory(this.dataPath);
    this.cache = {
      fingerprint,
      inventory,
      expiresAt: now + this.ttlMs,
    };
    return inventory;
  }

  inventory(): SuiteInventory {
    return this.refreshIfNeeded();
  }

  suites(): SuiteSummary[] {
    return this.refreshIfNeeded().suites;
  }

  suite(suiteId: string): SuiteSummary | undefined {
    return this.suites().find((suite) => suite.id === suiteId);
  }

  scenarios(): ScenarioSummary[] {
    return this.refreshIfNeeded().scenarios;
  }

  scenariosForSuite(suiteId: string): ScenarioSummary[] {
    return this.scenarios().filter((item) => item.suiteId === suiteId);
  }

  invalidate(): void {
    this.cache = undefined;
  }

  get resolvedDataPath(): string {
    return this.dataPath;
  }

  resolveSuitePath(suiteId: string): string | undefined {
    const suite = this.suite(suiteId);
    if (!suite) {
      return undefined;
    }
    return join(this.dataPath, suite.relativePath);
  }
}
