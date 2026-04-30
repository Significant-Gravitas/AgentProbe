import type {
  PersistenceRepository,
  PresetWriteInput,
} from "../../../providers/persistence/types.ts";
import type {
  PresetRecord,
  RunSummary,
  ScenarioSelectionRef,
} from "../../../shared/types/contracts.ts";
import { AgentProbeConfigError } from "../../../shared/utils/errors.ts";
import {
  HttpInputError,
  optionalBoolean,
  optionalParallel,
  optionalPositiveInteger,
  optionalString,
  requiredSelection,
  requiredString,
} from "../validation.ts";
import type { SuiteController } from "./suite-controller.ts";

export type PresetPayload = {
  id: string;
  name: string;
  description: string | null;
  endpoint: string;
  personas: string;
  rubric: string;
  selection: ScenarioSelectionRef[];
  parallel: {
    enabled: boolean;
    limit: number | null;
  };
  repeat: number;
  dry_run: boolean;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  last_run: RunSummary | null;
};

export class PresetController {
  constructor(
    private readonly options: {
      repository: PersistenceRepository;
      suiteController: SuiteController;
    },
  ) {}

  toPayload(preset: PresetRecord): PresetPayload {
    return {
      id: preset.id,
      name: preset.name,
      description: preset.description ?? null,
      endpoint: preset.endpoint,
      personas: preset.personas,
      rubric: preset.rubric,
      selection: preset.selection,
      parallel: {
        enabled: preset.parallel.enabled,
        limit: preset.parallel.limit ?? null,
      },
      repeat: preset.repeat,
      dry_run: preset.dryRun,
      created_at: preset.createdAt,
      updated_at: preset.updatedAt,
      deleted_at: preset.deletedAt ?? null,
      last_run: preset.lastRun ?? null,
    };
  }

  async list(): Promise<PresetPayload[]> {
    return (await this.options.repository.listPresets()).map((preset) =>
      this.toPayload(preset),
    );
  }

  async get(
    id: string,
  ): Promise<{ preset: PresetPayload; warnings: unknown[] } | undefined> {
    const preset = await this.options.repository.getPreset(id);
    if (!preset) {
      return undefined;
    }
    const resolved = this.options.suiteController.resolveSelection(
      preset.selection,
      { allowMissing: true },
    );
    return {
      preset: this.toPayload(preset),
      warnings: resolved.warnings,
    };
  }

  async runs(id: string): Promise<RunSummary[] | undefined> {
    const preset = await this.options.repository.getPreset(id);
    if (!preset) {
      return undefined;
    }
    return await this.options.repository.listRunsForPreset(id);
  }

  private inputFromBody(body: Record<string, unknown>): PresetWriteInput {
    const selection = this.options.suiteController.resolveSelection(
      requiredSelection(body),
    );
    const parallel = optionalParallel(body) ?? { enabled: false };
    return {
      name: requiredString(body, "name"),
      description: optionalString(body, "description") ?? null,
      endpoint: this.options.suiteController.resolveDataFile(
        requiredString(body, "endpoint"),
      ).relativePath,
      personas: this.options.suiteController.resolveDataFile(
        requiredString(body, "personas"),
      ).relativePath,
      rubric: this.options.suiteController.resolveDataFile(
        requiredString(body, "rubric"),
      ).relativePath,
      selection: selection.refs,
      parallel,
      repeat: optionalPositiveInteger(body, "repeat") ?? 1,
      dryRun: optionalBoolean(body, "dry_run") ?? false,
    };
  }

  async create(body: Record<string, unknown>): Promise<PresetPayload> {
    try {
      return this.toPayload(
        await this.options.repository.createPreset(this.inputFromBody(body)),
      );
    } catch (error) {
      if (error instanceof HttpInputError) {
        throw error;
      }
      if (error instanceof AgentProbeConfigError) {
        throw new HttpInputError(400, "bad_request", error.message);
      }
      if (error instanceof Error && /unique constraint/i.test(error.message)) {
        throw new HttpInputError(
          409,
          "conflict",
          "A preset with that name already exists.",
        );
      }
      throw error;
    }
  }

  async update(
    id: string,
    body: Record<string, unknown>,
  ): Promise<PresetPayload | undefined> {
    const existing = await this.options.repository.getPreset(id);
    if (!existing) {
      return undefined;
    }
    const input = this.inputFromBody({ ...this.toPayload(existing), ...body });
    try {
      const preset = await this.options.repository.updatePreset(id, input);
      return preset ? this.toPayload(preset) : undefined;
    } catch (error) {
      if (error instanceof HttpInputError) {
        throw error;
      }
      if (error instanceof AgentProbeConfigError) {
        throw new HttpInputError(400, "bad_request", error.message);
      }
      if (error instanceof Error && /unique constraint/i.test(error.message)) {
        throw new HttpInputError(
          409,
          "conflict",
          "A preset with that name already exists.",
        );
      }
      throw error;
    }
  }

  async delete(id: string): Promise<PresetPayload | undefined> {
    const preset = await this.options.repository.softDeletePreset(id);
    return preset ? this.toPayload(preset) : undefined;
  }

  async createFromRun(
    runId: string,
    body: Record<string, unknown>,
  ): Promise<PresetPayload> {
    const run = await this.options.repository.getRun(runId);
    if (!run) {
      throw new HttpInputError(
        404,
        "not_found",
        `Run \`${runId}\` was not found.`,
      );
    }
    if (!run.sourcePaths) {
      throw new HttpInputError(
        400,
        "bad_request",
        `Run \`${runId}\` did not record source paths and cannot be cloned into a preset.`,
      );
    }

    const rebaseToDataRoot = (raw: string): string => {
      try {
        return this.options.suiteController.resolveDataFile(raw).relativePath;
      } catch (firstError) {
        const normalized = raw.replaceAll("\\", "/");
        const marker = "/data/";
        const markerIndex = normalized.lastIndexOf(marker);
        const candidates: string[] = [];
        if (markerIndex !== -1) {
          candidates.push(normalized.slice(markerIndex + marker.length));
        }
        const baseName = normalized.split("/").pop();
        if (baseName) candidates.push(baseName);
        for (const candidate of candidates) {
          if (!candidate) continue;
          try {
            return this.options.suiteController.resolveDataFile(candidate)
              .relativePath;
          } catch {
            // try next candidate
          }
        }
        throw firstError;
      }
    };

    const tryRebase = (
      raw: string,
      label: string,
    ): { ok: true; value: string } | { ok: false; message: string } => {
      try {
        return { ok: true, value: rebaseToDataRoot(raw) };
      } catch (error) {
        return {
          ok: false,
          message: `${label} (\`${raw}\`): ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    };

    const endpointOutcome = tryRebase(run.sourcePaths.endpoint, "endpoint");
    const personasOutcome = tryRebase(run.sourcePaths.personas, "personas");
    const rubricOutcome = tryRebase(run.sourcePaths.rubric, "rubric");
    const failures = [endpointOutcome, personasOutcome, rubricOutcome].filter(
      (outcome): outcome is { ok: false; message: string } =>
        outcome.ok === false,
    );
    if (failures.length > 0) {
      throw new HttpInputError(
        400,
        "bad_request",
        `Run \`${runId}\` was recorded with source paths that do not exist under this data root. ${failures
          .map((f) => f.message)
          .join("; ")}`,
      );
    }
    const resolvedEndpoint = (endpointOutcome as { ok: true; value: string })
      .value;
    const resolvedPersonas = (personasOutcome as { ok: true; value: string })
      .value;
    const resolvedRubric = (rubricOutcome as { ok: true; value: string }).value;

    const inventoryById = new Map<string, string>();
    for (const summary of this.options.suiteController.scenarios()) {
      if (!inventoryById.has(summary.id)) {
        inventoryById.set(summary.id, summary.sourcePath);
      }
    }

    const orderedIds: string[] = [];
    if (run.scenarios.length > 0) {
      for (const scenario of run.scenarios) {
        orderedIds.push(scenario.scenarioId);
      }
    } else if (run.selectedScenarioIds && run.selectedScenarioIds.length > 0) {
      for (const id of run.selectedScenarioIds) {
        orderedIds.push(id);
      }
    }

    const selection: ScenarioSelectionRef[] = [];
    const seen = new Set<string>();
    const unresolved: string[] = [];
    for (const id of orderedIds) {
      const file = inventoryById.get(id);
      if (!file) {
        unresolved.push(id);
        continue;
      }
      const key = `${file}::${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      selection.push({ file, id });
    }

    if (selection.length === 0) {
      const reason =
        orderedIds.length === 0
          ? "the run has no scenarios recorded"
          : `none of the run's scenarios (${unresolved.slice(0, 3).join(", ")}${unresolved.length > 3 ? ", …" : ""}) match a current suite file`;
      throw new HttpInputError(
        400,
        "bad_request",
        `Run \`${runId}\` cannot be cloned into a preset: ${reason}.`,
      );
    }

    const fallbackName =
      typeof body.name === "string" && body.name.trim().length > 0
        ? body.name
        : `${run.label ?? run.preset ?? "Run"} (saved ${new Date().toISOString()})`;

    const derivedBody: Record<string, unknown> = {
      ...body,
      name: fallbackName,
      endpoint: resolvedEndpoint,
      personas: resolvedPersonas,
      rubric: resolvedRubric,
      selection,
    };

    return this.create(derivedBody);
  }
}
