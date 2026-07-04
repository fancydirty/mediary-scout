import Database from "better-sqlite3";
import type {
  AgentStep,
  EpisodeState,
  NotificationEvent,
  WorkflowKind,
  WorkflowRunProgress,
} from "./domain.js";
import type { DeadLink } from "./acquisition-v2/dead-links.js";
import type {
  Account,
  ConnectedStorage,
  Session,
  UpsertConnectedStorageInput,
} from "./account-credentials.js";
import type { ScopeArg, WorkflowScope } from "./workflow-scope.js";
import type {
  PersistedWorkflowRunSnapshot,
  PersistWorkflowRunSnapshotInput,
  ReserveWorkflowRunInput,
  TrackedSeasonState,
  WorkflowRepository,
  WorkflowRunReservationResult,
} from "./repository.js";

/**
 * The SQLite schema mirrors the Postgres schema (`packages/workflow/src/postgres.ts`),
 * with `text` payload columns instead of `jsonb` (SQLite has no jsonb; payloads are
 * JSON.stringify'd text). The tree-model scope columns (account_id,
 * connected_storage_id) and the composite primary keys that Postgres reaches through
 * a chain of idempotent ALTERs are declared inline here — a fresh SQLite database
 * needs the FINAL shape up front, not the migration steps. The acct_default seed row
 * matches Postgres so later tasks behave identically.
 */
export const SQLITE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS media_titles (
    id text PRIMARY KEY,
    payload text NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tracked_seasons (
    id text NOT NULL,
    media_title_id text NOT NULL,
    account_id text NOT NULL DEFAULT 'acct_default',
    connected_storage_id text NOT NULL,
    payload text NOT NULL,
    PRIMARY KEY (id, connected_storage_id)
  );
  CREATE TABLE IF NOT EXISTS workflow_runs (
    id text PRIMARY KEY,
    tracked_season_id text NOT NULL,
    account_id text NOT NULL DEFAULT 'acct_default',
    connected_storage_id text NOT NULL,
    payload text NOT NULL
  );
  CREATE TABLE IF NOT EXISTS episode_states (
    tracked_season_id text NOT NULL,
    connected_storage_id text NOT NULL,
    episode_code text NOT NULL,
    payload text NOT NULL,
    PRIMARY KEY (tracked_season_id, connected_storage_id, episode_code)
  );
  CREATE TABLE IF NOT EXISTS resource_snapshots (
    id text PRIMARY KEY,
    workflow_run_id text NOT NULL,
    ordinal integer NOT NULL,
    payload text NOT NULL
  );
  CREATE TABLE IF NOT EXISTS agent_decisions (
    workflow_run_id text NOT NULL,
    ordinal integer NOT NULL,
    snapshot_id text NOT NULL,
    payload text NOT NULL,
    PRIMARY KEY (workflow_run_id, ordinal)
  );
  CREATE TABLE IF NOT EXISTS agent_steps (
    workflow_run_id text NOT NULL,
    ordinal integer NOT NULL,
    payload text NOT NULL,
    PRIMARY KEY (workflow_run_id, ordinal)
  );
  CREATE TABLE IF NOT EXISTS transfer_attempts (
    id text PRIMARY KEY,
    workflow_run_id text NOT NULL,
    ordinal integer NOT NULL,
    candidate_id text NOT NULL,
    payload text NOT NULL
  );
  CREATE TABLE IF NOT EXISTS notifications (
    id text PRIMARY KEY,
    workflow_run_id text NOT NULL,
    ordinal integer NOT NULL,
    payload text NOT NULL
  );
  CREATE TABLE IF NOT EXISTS app_settings (
    key text PRIMARY KEY,
    value text NOT NULL
  );
  CREATE TABLE IF NOT EXISTS account_settings (
    account_id text NOT NULL,
    key text NOT NULL,
    value text NOT NULL,
    PRIMARY KEY (account_id, key)
  );
  CREATE TABLE IF NOT EXISTS dead_links (
    key text PRIMARY KEY,
    kind text NOT NULL,
    reason text NOT NULL,
    permanent integer NOT NULL DEFAULT 1,
    expires_at text,
    recorded_at text NOT NULL
  );
  CREATE TABLE IF NOT EXISTS accounts (
    id text PRIMARY KEY,
    username text UNIQUE NOT NULL,
    password_hash text NOT NULL DEFAULT '',
    group_id text,
    is_owner integer NOT NULL DEFAULT 0,
    created_at text NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id text PRIMARY KEY,
    account_id text NOT NULL,
    expires_at text NOT NULL,
    created_at text NOT NULL
  );
  CREATE TABLE IF NOT EXISTS connected_storages (
    id text PRIMARY KEY,
    account_id text NOT NULL,
    provider text NOT NULL,
    provider_uid text NOT NULL,
    label text,
    payload text NOT NULL,
    root_cid text,
    movies_cid text,
    tv_cid text,
    anime_cid text,
    status text NOT NULL DEFAULT 'active',
    frozen_reason text,
    frozen_at text,
    created_at text NOT NULL,
    UNIQUE (provider, provider_uid)
  );
  INSERT INTO accounts (id, username, password_hash, is_owner, created_at)
    VALUES ('acct_default', 'default', '', 1, '1970-01-01T00:00:00.000Z')
    ON CONFLICT (id) DO NOTHING;
`;

export function createSqliteWorkflowRepository(options: { path: string }): SqliteWorkflowRepository {
  return new SqliteWorkflowRepository(new Database(options.path));
}

export class SqliteWorkflowRepository implements WorkflowRepository {
  constructor(private readonly db: Database.Database) {
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SQLITE_SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  async saveWorkflowRunSnapshot(_input: PersistWorkflowRunSnapshotInput): Promise<void> {
    throw new Error("not implemented");
  }

  async reserveWorkflowRun(_input: ReserveWorkflowRunInput): Promise<WorkflowRunReservationResult> {
    throw new Error("not implemented");
  }

  async getWorkflowRunSnapshot(
    _workflowRunId: string,
    _scope?: ScopeArg,
  ): Promise<PersistedWorkflowRunSnapshot | null> {
    throw new Error("not implemented");
  }

  async claimNextQueuedWorkflowRun(_input: {
    kind: WorkflowKind;
    now: string;
  }): Promise<PersistedWorkflowRunSnapshot | null> {
    throw new Error("not implemented");
  }

  async requeueRunningWorkflowRuns(): Promise<number> {
    throw new Error("not implemented");
  }

  async findActiveWorkflowRun(_input: {
    trackedSeasonId: string;
    kind: WorkflowKind;
    accountId?: string;
    connectedStorageId?: string | null;
  }): Promise<PersistedWorkflowRunSnapshot | null> {
    throw new Error("not implemented");
  }

  async listActiveWorkflowRuns(_scope?: ScopeArg): Promise<PersistedWorkflowRunSnapshot[]> {
    throw new Error("not implemented");
  }

  async updateWorkflowRunProgress(
    _workflowRunId: string,
    _progress: WorkflowRunProgress,
  ): Promise<void> {
    throw new Error("not implemented");
  }

  async appendAgentStep(_workflowRunId: string, _step: AgentStep): Promise<void> {
    throw new Error("not implemented");
  }

  async listAgentSteps(_workflowRunId: string, _scope?: ScopeArg): Promise<AgentStep[]> {
    throw new Error("not implemented");
  }

  async clearAgentSteps(_workflowRunId: string): Promise<void> {
    throw new Error("not implemented");
  }

  async cancelQueuedWorkflowRun(
    _workflowRunId: string,
    _scope?: ScopeArg,
  ): Promise<{ status: "cancelled" | "not_cancellable" }> {
    throw new Error("not implemented");
  }

  async untrackTitle(
    _tmdbId: number,
    _scope: WorkflowScope,
    _mediaKind: "movie" | "tv",
    _seasonNumber?: number,
  ): Promise<{ status: "untracked" | "not_found" | "in_flight"; removedSeasons: number }> {
    throw new Error("not implemented");
  }

  async retryFailedWorkflowRun(
    _workflowRunId: string,
    _scope?: ScopeArg,
  ): Promise<{ status: "retried" | "not_retriable" }> {
    throw new Error("not implemented");
  }

  async getTrackedSeasonState(
    _trackedSeasonId: string,
    _scope?: ScopeArg,
  ): Promise<TrackedSeasonState | null> {
    throw new Error("not implemented");
  }

  async listTrackedSeasonStates(_scope?: ScopeArg): Promise<TrackedSeasonState[]> {
    throw new Error("not implemented");
  }

  async listAllTrackedSeasonStates(): Promise<TrackedSeasonState[]> {
    throw new Error("not implemented");
  }

  async listEpisodeStates(_trackedSeasonId: string, _scope?: ScopeArg): Promise<EpisodeState[]> {
    throw new Error("not implemented");
  }

  async listNotifications(_input?: {
    limit?: number;
    accountId?: string;
    connectedStorageId?: string | null;
    since?: string;
  }): Promise<NotificationEvent[]> {
    throw new Error("not implemented");
  }

  async listRecentNotificationsWithAccount(_input?: {
    limit?: number;
  }): Promise<Array<{ accountId: string; connectedStorageId: string | null; notification: NotificationEvent }>> {
    throw new Error("not implemented");
  }

  async getSetting(key: string): Promise<string | null> {
    const row = this.db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    this.db
      .prepare(
        "INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  async getAccountSetting(accountId: string, key: string): Promise<string | null> {
    const row = this.db
      .prepare("SELECT value FROM account_settings WHERE account_id = ? AND key = ?")
      .get(accountId, key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  async setAccountSetting(accountId: string, key: string, value: string): Promise<void> {
    this.db
      .prepare(
        "INSERT INTO account_settings (account_id, key, value) VALUES (?, ?, ?) ON CONFLICT (account_id, key) DO UPDATE SET value = excluded.value",
      )
      .run(accountId, key, value);
  }

  async backfillConnectedStorageId(): Promise<number> {
    throw new Error("not implemented");
  }

  async listConnectedStorages(_accountId: string): Promise<ConnectedStorage[]> {
    throw new Error("not implemented");
  }

  async upsertConnectedStorage(_row: UpsertConnectedStorageInput): Promise<void> {
    throw new Error("not implemented");
  }

  async deleteConnectedStorage(_accountId: string, _storageId: string): Promise<void> {
    throw new Error("not implemented");
  }

  async findConnectedStorageByUid(
    _provider: string,
    _providerUid: string,
  ): Promise<ConnectedStorage | null> {
    throw new Error("not implemented");
  }

  async setConnectedStorageStatus(
    _storageId: string,
    _status: "active" | "frozen",
    _frozenReason: string | null,
    _frozenAt: string | null,
  ): Promise<void> {
    throw new Error("not implemented");
  }

  async createAccount(_account: Account): Promise<void> {
    throw new Error("not implemented");
  }

  async getAccountByUsername(_username: string): Promise<Account | null> {
    throw new Error("not implemented");
  }

  async getAccountById(_id: string): Promise<Account | null> {
    throw new Error("not implemented");
  }

  async listAccounts(): Promise<Account[]> {
    throw new Error("not implemented");
  }

  async createSession(_session: Session): Promise<void> {
    throw new Error("not implemented");
  }

  async getSession(_id: string): Promise<Session | null> {
    throw new Error("not implemented");
  }

  async deleteSession(_id: string): Promise<void> {
    throw new Error("not implemented");
  }

  async adoptDefaultAccount(_input: { username: string; passwordHash: string }): Promise<void> {
    throw new Error("not implemented");
  }

  async setAccountPassword(_accountId: string, _passwordHash: string): Promise<void> {
    throw new Error("not implemented");
  }

  async deleteSessionsForAccount(_accountId: string, _exceptSessionId?: string): Promise<void> {
    throw new Error("not implemented");
  }

  async recordDeadLink(_input: {
    key: string;
    kind: DeadLink["kind"];
    reason: string;
    permanent: boolean;
    ttlMs?: number;
    now?: string;
  }): Promise<void> {
    throw new Error("not implemented");
  }

  async listDeadLinkKeys(_options?: { now?: string }): Promise<string[]> {
    throw new Error("not implemented");
  }
}
