import { parseEndpointsYaml } from "../../../domains/validation/load-suite.ts";
import type {
  PersistenceRepository,
  StoredEndpointOverride,
} from "../../../providers/persistence/types.ts";
import type { Endpoints } from "../../../shared/types/contracts.ts";
import { resolveEnvInValue } from "../../../shared/utils/template.ts";
import { HttpInputError } from "../validation.ts";
import type { SuiteController } from "./suite-controller.ts";

export type EndpointOverridePayload = {
  endpoint_path: string;
  base_url: string | null;
  updated_at: string;
};

export type EndpointDefaultsPayload = {
  endpoint_path: string;
  preset: string | null;
  transport: string | null;
  base_url: string | null;
  base_url_resolved: string | null;
};

export type EndpointOverrideFields = {
  baseUrl?: string;
};

const KNOWN_FIELDS: Array<keyof EndpointOverrideFields> = ["baseUrl"];

function readBaseUrlFromConnection(connection: unknown): string | undefined {
  if (!connection || typeof connection !== "object") {
    return undefined;
  }
  const raw = connection as Record<string, unknown>;
  if (typeof raw.baseUrl === "string") {
    return raw.baseUrl;
  }
  if (typeof raw.url === "string") {
    return raw.url;
  }
  return undefined;
}

function toPayload(stored: StoredEndpointOverride): EndpointOverridePayload {
  const baseUrl =
    typeof stored.overrides.baseUrl === "string"
      ? stored.overrides.baseUrl
      : null;
  return {
    endpoint_path: stored.endpointPath,
    base_url: baseUrl,
    updated_at: stored.updatedAt,
  };
}

function pickKnownFields(raw: Record<string, unknown>): EndpointOverrideFields {
  const result: EndpointOverrideFields = {};
  if (Object.hasOwn(raw, "base_url")) {
    const value = raw.base_url;
    if (value === null || value === undefined || value === "") {
      // explicit clear — caller can also use DELETE
    } else if (typeof value !== "string") {
      throw new HttpInputError(
        400,
        "bad_request",
        "base_url must be a string.",
      );
    } else {
      const trimmed = value.trim();
      if (trimmed) {
        result.baseUrl = trimmed;
      }
    }
  }
  return result;
}

export class EndpointOverridesController {
  constructor(
    private readonly options: {
      repository: PersistenceRepository;
      suiteController: SuiteController;
    },
  ) {}

  private resolveRelativePath(rawPath: string): string {
    return this.options.suiteController.resolveDataFile(rawPath).relativePath;
  }

  /**
   * Load the saved override fields for an endpoint, applying any known
   * normalization. Returns an empty object when no override is stored.
   */
  async resolveFields(endpointPath: string): Promise<EndpointOverrideFields> {
    const stored =
      await this.options.repository.getEndpointOverride(endpointPath);
    if (!stored) {
      return {};
    }
    const fields: EndpointOverrideFields = {};
    if (typeof stored.overrides.baseUrl === "string") {
      fields.baseUrl = stored.overrides.baseUrl;
    }
    return fields;
  }

  async list(): Promise<EndpointOverridePayload[]> {
    const stored = await this.options.repository.listEndpointOverrides();
    return stored.map((entry) => toPayload(entry));
  }

  async get(rawPath: string): Promise<{
    override: EndpointOverridePayload | null;
    defaults: EndpointDefaultsPayload;
  }> {
    const resolved = this.options.suiteController.resolveDataFile(rawPath);
    const stored = await this.options.repository.getEndpointOverride(
      resolved.relativePath,
    );
    let endpointConfig: Endpoints;
    try {
      endpointConfig = parseEndpointsYaml(resolved.absolutePath);
    } catch (error) {
      throw new HttpInputError(
        400,
        "bad_request",
        `Endpoint YAML at \`${resolved.relativePath}\` could not be parsed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const rawBaseUrl = readBaseUrlFromConnection(endpointConfig.connection);
    const resolvedBaseUrl = rawBaseUrl ? safeResolveEnv(rawBaseUrl) : null;
    return {
      override: stored ? toPayload(stored) : null,
      defaults: {
        endpoint_path: resolved.relativePath,
        preset: endpointConfig.preset ?? null,
        transport: endpointConfig.transport ?? null,
        base_url: rawBaseUrl ?? null,
        base_url_resolved: resolvedBaseUrl,
      },
    };
  }

  async upsert(
    rawPath: string,
    body: Record<string, unknown>,
  ): Promise<EndpointOverridePayload> {
    const relativePath = this.resolveRelativePath(rawPath);
    const fields = pickKnownFields(body);
    const overridesObject: Record<string, unknown> = {};
    for (const key of KNOWN_FIELDS) {
      const value = fields[key];
      if (value !== undefined) {
        overridesObject[key] = value;
      }
    }
    if (Object.keys(overridesObject).length === 0) {
      // Empty override == clear.
      await this.options.repository.deleteEndpointOverride(relativePath);
      return {
        endpoint_path: relativePath,
        base_url: null,
        updated_at: new Date().toISOString(),
      };
    }
    const stored = await this.options.repository.putEndpointOverride(
      relativePath,
      overridesObject,
    );
    return toPayload(stored);
  }

  async delete(rawPath: string): Promise<boolean> {
    const relativePath = this.resolveRelativePath(rawPath);
    return this.options.repository.deleteEndpointOverride(relativePath);
  }
}

function safeResolveEnv(value: string): string {
  try {
    return resolveEnvInValue(value);
  } catch {
    return value;
  }
}
