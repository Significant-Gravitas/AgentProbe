import { describe, expect, test } from "bun:test";

import { PostgresRepository } from "../../../src/providers/persistence/postgres-backend.ts";
import { withPostgresTestDatabase } from "./postgres-test-utils.ts";

describe("PostgresRepository secrets and endpoint overrides", () => {
  test("round-trips encrypted secret envelopes and endpoint overrides", async () => {
    await withPostgresTestDatabase(async (url) => {
      const repo = new PostgresRepository(url);
      await repo.initialize();
      try {
        await repo.putSecret("open_router_api_key", {
          ciphertext: "sealed",
          iv: "iv",
          authTag: "tag",
        });
        expect(await repo.getSecret("open_router_api_key")).toEqual({
          ciphertext: "sealed",
          iv: "iv",
          authTag: "tag",
        });
        expect(await repo.deleteSecret("open_router_api_key")).toBe(true);
        expect(await repo.getSecret("open_router_api_key")).toBeUndefined();

        const saved = await repo.putEndpointOverride("data/endpoint.yaml", {
          connection: { baseUrl: "https://example.test" },
          opaqueSetting: "value-override",
          auth: { type: "none" },
        });
        expect(saved.endpointPath).toBe("data/endpoint.yaml");
        expect(saved.overrides).toEqual({
          connection: { baseUrl: "https://example.test" },
          opaqueSetting: "value-override",
          auth: { type: "none" },
        });
        expect(await repo.listEndpointOverrides()).toHaveLength(1);
        expect(
          await repo.getEndpointOverride("data/endpoint.yaml"),
        ).toMatchObject({
          endpointPath: "data/endpoint.yaml",
          overrides: {
            connection: { baseUrl: "https://example.test" },
            opaqueSetting: "value-override",
          },
        });
        expect(await repo.deleteEndpointOverride("data/endpoint.yaml")).toBe(
          true,
        );
        expect(
          await repo.getEndpointOverride("data/endpoint.yaml"),
        ).toBeUndefined();
      } finally {
        await repo.close();
      }
    });
  });
});
