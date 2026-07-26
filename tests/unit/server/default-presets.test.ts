import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { SqliteRepository } from "../../../src/providers/persistence/sqlite-backend.ts";
import { SuiteController } from "../../../src/runtime/server/controllers/suite-controller.ts";
import {
  PRE_RELEASE_DEFAULT_PRESET,
  seedDefaultPresets,
} from "../../../src/runtime/server/default-presets.ts";
import { DATA_DIR, makeTempDir } from "../support.ts";

function sqliteRepository(prefix: string): SqliteRepository {
  const root = makeTempDir(prefix);
  return new SqliteRepository(`sqlite:///${join(root, "runs.sqlite3")}`);
}

describe("default preset seeding", () => {
  test("seeds the source-backed pre-release preset into an empty SQLite repository", async () => {
    const repository = sqliteRepository("default-presets");
    await repository.initialize();
    const suiteController = new SuiteController({ dataPath: DATA_DIR });

    const results = await seedDefaultPresets({
      repository,
      suiteController,
    });
    expect(results[0]).toMatchObject({
      name: PRE_RELEASE_DEFAULT_PRESET.name,
      status: "created",
    });

    const presets = await repository.listPresets();
    expect(presets).toHaveLength(1);
    const preset = presets[0];
    expect(preset).toMatchObject({
      name: "Pre Release Checks",
      description: null,
      endpoint: "autogpt-endpoint.yaml",
      personas: "personas.yaml",
      rubric: "rubric.yaml",
      parallel: { enabled: false, limit: null },
      repeat: 1,
      dryRun: false,
    });
    expect(preset?.selection).toEqual(PRE_RELEASE_DEFAULT_PRESET.selection);

    const secondPass = await seedDefaultPresets({
      repository,
      suiteController,
    });
    expect(secondPass[0]).toMatchObject({
      name: PRE_RELEASE_DEFAULT_PRESET.name,
      status: "existing",
      presetId: preset?.id,
    });
    expect(await repository.listPresets()).toHaveLength(1);
  });

  test("restores a soft-deleted default preset by name", async () => {
    const repository = sqliteRepository("default-presets-restore");
    await repository.initialize();
    const suiteController = new SuiteController({ dataPath: DATA_DIR });
    await seedDefaultPresets({ repository, suiteController });
    const seeded = (await repository.listPresets())[0];
    expect(seeded).toBeDefined();

    await repository.softDeletePreset(seeded?.id ?? "");
    expect(await repository.listPresets()).toHaveLength(0);

    const results = await seedDefaultPresets({
      repository,
      suiteController,
    });
    expect(results[0]).toMatchObject({
      name: PRE_RELEASE_DEFAULT_PRESET.name,
      status: "restored",
      presetId: seeded?.id,
    });
    const presets = await repository.listPresets();
    expect(presets).toHaveLength(1);
    expect(presets[0]?.deletedAt ?? null).toBeNull();
  });

  test("skips seeding when the data root does not include packaged default files", async () => {
    const root = makeTempDir("default-presets-empty-data");
    const dataPath = join(root, "data");
    mkdirSync(dataPath, { recursive: true });
    const repository = new SqliteRepository(
      `sqlite:///${join(root, "runs.sqlite3")}`,
    );
    await repository.initialize();

    const results = await seedDefaultPresets({
      repository,
      suiteController: new SuiteController({ dataPath }),
    });
    expect(results[0]).toMatchObject({
      name: PRE_RELEASE_DEFAULT_PRESET.name,
      status: "skipped",
    });
    expect(await repository.listPresets()).toHaveLength(0);
  });
});
