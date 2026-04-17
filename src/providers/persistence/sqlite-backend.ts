import {
  initDb,
  SqliteRunRecorder,
  createPreset as sqliteCreatePreset,
  getPreset as sqliteGetPreset,
  getRun as sqliteGetRun,
  latestRunForSuite as sqliteLatestRunForSuite,
  listPresets as sqliteListPresets,
  listRuns as sqliteListRuns,
  listRunsForPreset as sqliteListRunsForPreset,
  markRunCancelled as sqliteMarkRunCancelled,
  softDeletePreset as sqliteSoftDeletePreset,
  updatePreset as sqliteUpdatePreset,
} from "./sqlite-run-history.ts";
import type {
  PresetWriteInput,
  RecordingRepository,
  RunRecorder,
} from "./types.ts";

/** SQLite-backed repository; wraps the existing synchronous free-function API. */
export class SqliteRepository implements RecordingRepository {
  readonly kind = "sqlite" as const;
  readonly dbUrl: string;

  constructor(dbUrl: string) {
    this.dbUrl = dbUrl;
  }

  async initialize(): Promise<void> {
    initDb(this.dbUrl);
  }

  createRecorder(): RunRecorder {
    return new SqliteRunRecorder(this.dbUrl);
  }

  async createPreset(input: PresetWriteInput) {
    return sqliteCreatePreset(input, { dbUrl: this.dbUrl });
  }

  async getPreset(
    presetId: string,
    options: { includeDeleted?: boolean } = {},
  ) {
    return sqliteGetPreset(presetId, {
      dbUrl: this.dbUrl,
      includeDeleted: options.includeDeleted,
    });
  }

  async listPresets(options: { includeDeleted?: boolean } = {}) {
    return sqliteListPresets({
      dbUrl: this.dbUrl,
      includeDeleted: options.includeDeleted,
    });
  }

  async updatePreset(presetId: string, input: Partial<PresetWriteInput>) {
    return sqliteUpdatePreset(presetId, input, { dbUrl: this.dbUrl });
  }

  async softDeletePreset(presetId: string) {
    return sqliteSoftDeletePreset(presetId, { dbUrl: this.dbUrl });
  }

  async listRuns() {
    return sqliteListRuns({ dbUrl: this.dbUrl });
  }

  async listRunsForPreset(presetId: string) {
    return sqliteListRunsForPreset(presetId, { dbUrl: this.dbUrl });
  }

  async getRun(runId: string) {
    return sqliteGetRun(runId, { dbUrl: this.dbUrl });
  }

  async latestRunForSuite(
    suiteFingerprint: string,
    options: { beforeStartedAt?: string } = {},
  ) {
    return sqliteLatestRunForSuite(suiteFingerprint, {
      dbUrl: this.dbUrl,
      beforeStartedAt: options.beforeStartedAt,
    });
  }

  async markRunCancelled(runId: string, options: { exitCode?: number } = {}) {
    return sqliteMarkRunCancelled(runId, {
      dbUrl: this.dbUrl,
      exitCode: options.exitCode,
    });
  }
}
