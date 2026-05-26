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

// The three memory packs that together cover the full dream-system
// roadmap surface: multi-session conversational (judge), retrieval
// ranking, and the dream-validation trio (demotion/procedure/dedup).
// All three vendor a per-file selection so the preset is stable across
// scenario reorders and additive YAML changes.
const MULTI_SESSION_MEMORY_SCENARIO_IDS = [
  "mem-retention-basic-identity",
  "mem-retention-incidental-facts",
  "mem-distill-authed-http-image-gen",
  "mem-distill-onboarding-workflow",
  "mem-distill-weekly-report-format",
  "mem-distill-implicit-tool-preferences",
  "mem-distill-lead-cleaning-procedure",
  "mem-rigidity-email-tone-override",
  "mem-rigidity-tool-migration",
  "mem-rigidity-pricing-update",
  "mem-abstain-ambiguous-reference",
  "mem-abstain-no-fabricated-preferences",
  "mem-temporal-stale-team-member",
  "mem-temporal-deprecated-procedure",
  "mem-continuation-interrupted-task",
  "mem-continuation-project-state",
  "mem-crossdomain-business-identity",
  "mem-crossdomain-customer-allergy-with-negative",
  "mem-crossdomain-pricing-structure-with-negative",
  "mem-crossdomain-shipping-schedule-reasoning",
  "mem-crossdomain-notion-rate-limit",
  "mem-procupdate-clean-replacement",
  "mem-procupdate-additive",
  "mem-compositional-board-prep",
  "mem-introspection-what-do-you-know",
  "mem-introspection-gaps",
  "mem-longtail-lawyer-recall",
  "mem-hygiene-bounded-time",
  "mem-hygiene-temporary-status",
  "mem-negative-one-off-qualifier",
  "mem-negative-forget-on-request",
] as const;

const RETRIEVAL_MEMORY_SCENARIO_IDS = [
  "mem-retrieval-forget-on-request",
  "mem-retrieval-warm-context-sarah",
  "mem-retrieval-stale-fact-demotion",
  "mem-retrieval-scope-filter-project",
  "mem-retrieval-cascading-expiry",
] as const;

const DREAM_VALIDATION_SCENARIO_IDS = [
  "dream-demotion-retract-discipline",
  "dream-demotion-snodgrass-violation",
  "dream-demotion-stale-fact",
  "dream-demotion-cascade-bounded",
  "dream-demotion-cascade-runaway",
  "dream-procedure-weekly-report",
  "dream-procedure-client-onboarding",
  "dream-dedup-near-duplicates",
  "dream-dedup-false-positive",
] as const;

export const FULL_MEMORY_DEFAULT_PRESET: PresetWriteInput = {
  name: "Full Memory Suite",
  description:
    "All memory-related scenarios in one preset: multi-session conversational, retrieval ranking, and dream-system validation (demotion / procedure / dedup). Covers the full P-1 -> P2 dream-system roadmap surface.",
  endpoint: "autogpt-endpoint.yaml",
  personas: "personas.yaml",
  rubric: "rubric.yaml",
  selection: [
    ...MULTI_SESSION_MEMORY_SCENARIO_IDS.map((id) => ({
      file: "multi-session-memory.yaml",
      id,
    })),
    ...RETRIEVAL_MEMORY_SCENARIO_IDS.map((id) => ({
      file: "retrieval-memory.yaml",
      id,
    })),
    ...DREAM_VALIDATION_SCENARIO_IDS.map((id) => ({
      file: "dream-validation.yaml",
      id,
    })),
  ],
  parallel: { enabled: false, limit: null },
  repeat: 1,
  dryRun: false,
};

const DEFAULT_PRESETS = [
  PRE_RELEASE_DEFAULT_PRESET,
  FULL_MEMORY_DEFAULT_PRESET,
] as const;

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
