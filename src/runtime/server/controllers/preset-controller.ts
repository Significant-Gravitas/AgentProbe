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
}
