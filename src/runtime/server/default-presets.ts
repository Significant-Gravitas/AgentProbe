import { statSync } from "node:fs";

import type {
  PersistenceRepository,
  PresetWriteInput,
} from "../../providers/persistence/types.ts";
import { AgentProbeConfigError } from "../../shared/utils/errors.ts";
import type { LogFormat } from "./config.ts";
import type { SuiteController } from "./controllers/suite-controller.ts";

const PRE_RELEASE_SCENARIO_IDS = [
  "task-001",
  "task-012",
  "task-021",
  "task-029",
  "task-037",
  "task-045",
  "task-052",
  "task-059",
  "task-066",
  "task-073",
  "task-080",
  "task-086",
  "task-091",
  "task-096",
] as const;

export const PRE_RELEASE_DEFAULT_PRESET: PresetWriteInput = {
  name: "Pre Release Checks",
  description: null,
  endpoint: "autogpt-endpoint.yaml",
  personas: "personas.yaml",
  rubric: "rubric.yaml",
  selection: PRE_RELEASE_SCENARIO_IDS.map((id) => ({
    file: "baseline-scenarios.yaml",
    id,
  })),
  parallel: { enabled: false, limit: null },
  repeat: 1,
  dryRun: false,
};

const DEFAULT_PRESETS = [PRE_RELEASE_DEFAULT_PRESET] as const;

export type DefaultPresetSeedResult = {
  name: string;
  status: "created" | "existing" | "restored" | "skipped";
  presetId?: string;
  reason?: string;
};

function normalizeDefaultPreset(
  preset: PresetWriteInput,
  suiteController: SuiteController,
): PresetWriteInput {
  const endpoint = requireDataFile(
    preset.endpoint,
    "endpoint",
    suiteController,
  );
  const personas = requireDataFile(
    preset.personas,
    "personas",
    suiteController,
  );
  const rubric = requireDataFile(preset.rubric, "rubric", suiteController);
  const input: PresetWriteInput = {
    name: preset.name,
    description: preset.description ?? null,
    endpoint: endpoint.relativePath,
    personas: personas.relativePath,
    rubric: rubric.relativePath,
    selection: suiteController.resolveSelection(preset.selection).refs,
  };
  if (preset.parallel) {
    input.parallel = {
      enabled: Boolean(preset.parallel.enabled),
      limit: preset.parallel.limit ?? null,
    };
  }
  if (preset.repeat !== undefined) {
    input.repeat = preset.repeat;
  }
  if (preset.dryRun !== undefined) {
    input.dryRun = preset.dryRun;
  }
  return input;
}

function requireDataFile(
  path: string,
  label: string,
  suiteController: SuiteController,
): { absolutePath: string; relativePath: string } {
  const resolved = suiteController.resolveDataFile(path);
  try {
    if (statSync(resolved.absolutePath).isFile()) {
      return resolved;
    }
  } catch {}
  throw new AgentProbeConfigError(
    `Default preset ${label} file \`${resolved.relativePath}\` was not found.`,
  );
}

function skipReason(error: unknown): string | undefined {
  if (error instanceof AgentProbeConfigError) {
    return error.message;
  }
  if (error instanceof Error && error.name === "AgentProbeConfigError") {
    return error.message;
  }
  return undefined;
}

export async function seedDefaultPresets(options: {
  repository: PersistenceRepository;
  suiteController: SuiteController;
}): Promise<DefaultPresetSeedResult[]> {
  const existingPresets = await options.repository.listPresets({
    includeDeleted: true,
  });
  const existingByName = new Map(
    existingPresets.map((preset) => [preset.name, preset]),
  );
  const results: DefaultPresetSeedResult[] = [];

  for (const preset of DEFAULT_PRESETS) {
    let input: PresetWriteInput;
    try {
      input = normalizeDefaultPreset(preset, options.suiteController);
    } catch (error) {
      const reason = skipReason(error);
      if (!reason) {
        throw error;
      }
      results.push({ name: preset.name, status: "skipped", reason });
      continue;
    }

    const existing = existingByName.get(input.name);
    if (existing && !existing.deletedAt) {
      results.push({
        name: input.name,
        status: "existing",
        presetId: existing.id,
      });
      continue;
    }

    const seeded = await options.repository.upsertPresetByName(input);
    existingByName.set(input.name, seeded);
    results.push({
      name: input.name,
      status: existing?.deletedAt ? "restored" : "created",
      presetId: seeded.id,
    });
  }

  return results;
}

export function logDefaultPresetSeedResults(
  results: DefaultPresetSeedResult[],
  options: { logFormat: LogFormat },
): void {
  for (const result of results) {
    if (result.status === "existing" || result.status === "skipped") {
      continue;
    }
    if (options.logFormat === "json") {
      process.stderr.write(
        `${JSON.stringify({
          ts: new Date().toISOString(),
          level: "info",
          component: "agentprobe.default_presets",
          event: `default_preset_${result.status}`,
          preset_name: result.name,
          preset_id: result.presetId ?? null,
        })}\n`,
      );
      continue;
    }
    process.stderr.write(
      `[server] ${result.status} default preset ${result.name}\n`,
    );
  }
}
