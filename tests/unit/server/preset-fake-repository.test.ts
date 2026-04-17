import { describe, expect, test } from "bun:test";

import type {
  PersistenceRepository,
  PresetWriteInput,
} from "../../../src/providers/persistence/types.ts";
import { PresetController } from "../../../src/runtime/server/controllers/preset-controller.ts";
import type { SuiteController } from "../../../src/runtime/server/controllers/suite-controller.ts";
import type {
  PresetRecord,
  RunRecord,
  RunSummary,
  ScenarioSelectionRef,
} from "../../../src/shared/types/contracts.ts";

class FakeRepository implements PersistenceRepository {
  readonly kind = "sqlite" as const;
  readonly dbUrl = "fake://memory";
  presets: PresetRecord[] = [];

  async initialize(): Promise<void> {}

  async createPreset(input: PresetWriteInput): Promise<PresetRecord> {
    const preset: PresetRecord = {
      id: "preset-fake",
      name: input.name,
      description: input.description ?? null,
      endpoint: input.endpoint,
      personas: input.personas,
      rubric: input.rubric,
      selection: input.selection,
      parallel: {
        enabled: input.parallel?.enabled ?? false,
        limit: input.parallel?.limit ?? null,
      },
      repeat: input.repeat ?? 1,
      dryRun: input.dryRun ?? false,
      createdAt: "2026-04-17T00:00:00.000Z",
      updatedAt: "2026-04-17T00:00:00.000Z",
      deletedAt: null,
      lastRun: null,
    };
    this.presets.push(preset);
    return preset;
  }

  async getPreset(presetId: string): Promise<PresetRecord | undefined> {
    return this.presets.find((preset) => preset.id === presetId);
  }

  async listPresets(): Promise<PresetRecord[]> {
    return this.presets;
  }

  async updatePreset(): Promise<PresetRecord | undefined> {
    return undefined;
  }

  async softDeletePreset(): Promise<PresetRecord | undefined> {
    return undefined;
  }

  async listRuns(): Promise<RunSummary[]> {
    return [];
  }

  async listRunsForPreset(): Promise<RunSummary[]> {
    return [];
  }

  async getRun(): Promise<RunRecord | undefined> {
    return undefined;
  }

  async latestRunForSuite(): Promise<RunRecord | undefined> {
    return undefined;
  }

  async markRunCancelled(): Promise<RunRecord | undefined> {
    return undefined;
  }
}

const fakeSuiteController = {
  resolveSelection(selection: ScenarioSelectionRef[]) {
    return { refs: selection, warnings: [] };
  },
  resolveDataFile(path: string) {
    return {
      relativePath: path,
      absolutePath: `/virtual/${path}`,
    };
  },
} as unknown as SuiteController;

describe("preset controller repository boundary", () => {
  test("creates a preset through a fake repository without touching disk", async () => {
    const repository = new FakeRepository();
    const controller = new PresetController({
      repository,
      suiteController: fakeSuiteController,
    });

    const preset = await controller.create({
      name: "Smoke preset",
      endpoint: "endpoint.yaml",
      personas: "personas.yaml",
      rubric: "rubric.yaml",
      selection: [{ file: "scenarios.yaml", id: "smoke" }],
      parallel: { enabled: true, limit: 2 },
      repeat: 3,
      dry_run: true,
    });

    expect(preset).toMatchObject({
      id: "preset-fake",
      name: "Smoke preset",
      endpoint: "endpoint.yaml",
      personas: "personas.yaml",
      rubric: "rubric.yaml",
      repeat: 3,
      dry_run: true,
      parallel: { enabled: true, limit: 2 },
    });
    expect(repository.presets).toHaveLength(1);
  });
});
