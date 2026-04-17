import { AgentProbeConfigError } from "../../shared/utils/errors.ts";
import { PostgresRepository } from "./postgres-backend.ts";
import { SqliteRepository } from "./sqlite-backend.ts";
import {
  type PersistenceRepository,
  POSTGRES_RUN_RECORDING_UNSUPPORTED_MESSAGE,
  type RecordingRepository,
} from "./types.ts";
import { parseDbUrl } from "./url.ts";

/**
 * Instantiate the persistence backend implied by the URL. Returns a fresh
 * repository each call; callers are expected to hold a single long-lived
 * instance where appropriate.
 */
export function createRepository(dbUrl: string): PersistenceRepository {
  const parsed = parseDbUrl(dbUrl);
  if (parsed.kind === "sqlite") {
    return new SqliteRepository(parsed.rawUrl);
  }
  if (parsed.kind === "postgres") {
    return new PostgresRepository(parsed.rawUrl);
  }
  // parseDbUrl already throws for unsupported schemes, but keep a defensive fallback.
  throw new AgentProbeConfigError(
    `Unsupported backend for URL ${parsed.displayUrl}`,
  );
}

/** Instantiate a repository that can create run recorders. */
export function createRecordingRepository(dbUrl: string): RecordingRepository {
  const parsed = parseDbUrl(dbUrl);
  if (parsed.kind === "sqlite") {
    return new SqliteRepository(parsed.rawUrl);
  }
  throw new AgentProbeConfigError(POSTGRES_RUN_RECORDING_UNSUPPORTED_MESSAGE);
}

export { parseDbUrl } from "./url.ts";
