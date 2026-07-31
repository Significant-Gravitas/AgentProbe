import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import type {
  PersistenceRepository,
  StoredEndpointOverride,
} from "../../src/providers/persistence/types.ts";
import {
  type EndpointOverrideFields,
  EndpointOverridesController,
} from "../../src/runtime/server/controllers/endpoint-overrides-controller.ts";
import type { SuiteController } from "../../src/runtime/server/controllers/suite-controller.ts";

function makeRepository(
  initial: Record<string, StoredEndpointOverride> = {},
): PersistenceRepository {
  const overrides = new Map(Object.entries(initial));
  return {
    async getEndpointOverride(endpointPath: string) {
      return overrides.get(endpointPath);
    },
    async listEndpointOverrides() {
      return [...overrides.values()].sort((a, b) =>
        a.endpointPath.localeCompare(b.endpointPath),
      );
    },
    async putEndpointOverride(
      endpointPath: string,
      nextOverrides: Record<string, unknown>,
    ) {
      const stored: StoredEndpointOverride = {
        endpointPath,
        overrides: nextOverrides,
        updatedAt: "2026-05-04T00:00:00.000Z",
      };
      overrides.set(endpointPath, stored);
      return stored;
    },
    async deleteEndpointOverride(endpointPath: string) {
      return overrides.delete(endpointPath);
    },
  } as unknown as PersistenceRepository;
}

function makeSuiteController(root: string): SuiteController {
  return {
    resolveDataFile(path: string) {
      return {
        absolutePath: join(root, path),
        relativePath: path,
      };
    },
  } as unknown as SuiteController;
}

describe("EndpointOverridesController", () => {
  test("reads and writes base_url overrides, ignoring unknown fields", async () => {
    const controller = new EndpointOverridesController({
      repository: makeRepository(),
      suiteController: makeSuiteController(process.cwd()),
    });

    const saved = await controller.upsert("data/autogpt-endpoint.yaml", {
      base_url: " https://autogpt.example ",
      autogpt_jwt_secret: "removed-with-the-forge",
    });

    expect(saved).toEqual({
      endpoint_path: "data/autogpt-endpoint.yaml",
      base_url: "https://autogpt.example",
      updated_at: "2026-05-04T00:00:00.000Z",
    });

    const fields: EndpointOverrideFields = await controller.resolveFields(
      "data/autogpt-endpoint.yaml",
    );
    expect(fields).toEqual({
      baseUrl: "https://autogpt.example",
    });
  });

  test("reports autogpt preset metadata and drops stale jwt secret overrides", async () => {
    const controller = new EndpointOverridesController({
      repository: makeRepository({
        "data/autogpt-endpoint.yaml": {
          endpointPath: "data/autogpt-endpoint.yaml",
          overrides: {
            baseUrl: "https://autogpt.example",
            // Stored before the forge was removed; must not resurface.
            autogptJwtSecret: "stale-secret-override",
          },
          updatedAt: "2026-05-04T00:00:00.000Z",
        },
      }),
      suiteController: makeSuiteController(process.cwd()),
    });

    const result = await controller.get("data/autogpt-endpoint.yaml");
    expect(result.defaults.preset).toBe("autogpt");
    expect(result.override).toEqual({
      endpoint_path: "data/autogpt-endpoint.yaml",
      base_url: "https://autogpt.example",
      updated_at: "2026-05-04T00:00:00.000Z",
    });
    expect(
      await controller.resolveFields("data/autogpt-endpoint.yaml"),
    ).toEqual({ baseUrl: "https://autogpt.example" });
  });
});
