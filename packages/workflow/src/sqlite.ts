import Database from "better-sqlite3";
import { DEFAULT_ACCOUNT_ID } from "./domain.js";
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
import { DuplicateUsernameError } from "./repository.js";
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

  private connectedStorageFromRow(row: Record<string, unknown>): ConnectedStorage {
    return {
      id: String(row.id),
      accountId: String(row.account_id),
      provider: String(row.provider),
      providerUid: String(row.provider_uid),
      label: (row.label as string | null | undefined) ?? null,
      payload: JSON.parse(String(row.payload)),
      rootCid: (row.root_cid as string | null | undefined) ?? null,
      moviesCid: (row.movies_cid as string | null | undefined) ?? null,
      tvCid: (row.tv_cid as string | null | undefined) ?? null,
      animeCid: (row.anime_cid as string | null | undefined) ?? null,
      status: (row.status as "active" | "frozen" | null | undefined) ?? "active",
      frozenReason: (row.frozen_reason as string | null | undefined) ?? null,
      frozenAt: (row.frozen_at as string | null | undefined) ?? null,
      createdAt: String(row.created_at),
    };
  }

  async listConnectedStorages(accountId: string): Promise<ConnectedStorage[]> {
    const rows = this.db
      .prepare(
        "SELECT id, account_id, provider, provider_uid, label, payload, root_cid, movies_cid, tv_cid, anime_cid, status, frozen_reason, frozen_at, created_at " +
          "FROM connected_storages WHERE account_id = ? ORDER BY created_at",
      )
      .all(accountId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.connectedStorageFromRow(row));
  }

  async upsertConnectedStorage(row: UpsertConnectedStorageInput): Promise<void> {
    // Instance-wide UNIQUE(provider, provider_uid) ownership: on conflict NEVER
    // reassign account_id, and only refresh the row when the SAME account owns it
    // (the WHERE makes a cross-account conflict a no-op — it can't steal or
    // overwrite another account's 网盘). status/frozen are intentionally absent
    // from the column list and the SET, so a re-scan preserves a frozen state.
    this.db
      .prepare(
        "INSERT INTO connected_storages " +
          "(id, account_id, provider, provider_uid, label, payload, root_cid, movies_cid, tv_cid, anime_cid, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT (provider, provider_uid) DO UPDATE SET " +
          "label = excluded.label, payload = excluded.payload, " +
          "root_cid = excluded.root_cid, movies_cid = excluded.movies_cid, tv_cid = excluded.tv_cid, anime_cid = excluded.anime_cid " +
          "WHERE connected_storages.account_id = excluded.account_id",
      )
      .run(
        row.id,
        row.accountId,
        row.provider,
        row.providerUid,
        row.label ?? null,
        JSON.stringify(row.payload),
        row.rootCid ?? null,
        row.moviesCid ?? null,
        row.tvCid ?? null,
        row.animeCid ?? null,
        row.createdAt,
      );
  }

  async deleteConnectedStorage(accountId: string, storageId: string): Promise<void> {
    // account_id in the WHERE is fail-closed: can't delete another account's drive.
    this.db
      .prepare("DELETE FROM connected_storages WHERE id = ? AND account_id = ?")
      .run(storageId, accountId);
  }

  async findConnectedStorageByUid(
    provider: string,
    providerUid: string,
  ): Promise<ConnectedStorage | null> {
    const row = this.db
      .prepare(
        "SELECT id, account_id, provider, provider_uid, label, payload, root_cid, movies_cid, tv_cid, anime_cid, status, frozen_reason, frozen_at, created_at " +
          "FROM connected_storages WHERE provider = ? AND provider_uid = ?",
      )
      .get(provider, providerUid) as Record<string, unknown> | undefined;
    return row ? this.connectedStorageFromRow(row) : null;
  }

  async setConnectedStorageStatus(
    storageId: string,
    status: "active" | "frozen",
    frozenReason: string | null,
    frozenAt: string | null,
  ): Promise<void> {
    this.db
      .prepare(
        "UPDATE connected_storages SET status = ?, frozen_reason = ?, frozen_at = ? WHERE id = ?",
      )
      .run(status, frozenReason, frozenAt, storageId);
  }

  private accountFromRow(row: Record<string, unknown>): Account {
    return {
      id: String(row.id),
      username: String(row.username),
      passwordHash: String(row.password_hash),
      groupId: (row.group_id as string | null | undefined) ?? null,
      isOwner: row.is_owner === 1,
      createdAt: String(row.created_at),
    };
  }

  async createAccount(account: Account): Promise<void> {
    try {
      this.db
        .prepare(
          "INSERT INTO accounts (id, username, password_hash, group_id, is_owner, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          account.id,
          account.username,
          account.passwordHash,
          account.groupId,
          account.isOwner ? 1 : 0,
          account.createdAt,
        );
    } catch (error) {
      if (error instanceof Error && /UNIQUE constraint failed: accounts\.username/.test(error.message)) {
        throw new DuplicateUsernameError(account.username);
      }
      throw error;
    }
  }

  async getAccountByUsername(username: string): Promise<Account | null> {
    const row = this.db
      .prepare(
        "SELECT id, username, password_hash, group_id, is_owner, created_at FROM accounts WHERE username = ?",
      )
      .get(username) as Record<string, unknown> | undefined;
    return row ? this.accountFromRow(row) : null;
  }

  async getAccountById(id: string): Promise<Account | null> {
    const row = this.db
      .prepare(
        "SELECT id, username, password_hash, group_id, is_owner, created_at FROM accounts WHERE id = ?",
      )
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.accountFromRow(row) : null;
  }

  async listAccounts(): Promise<Account[]> {
    const rows = this.db
      .prepare(
        "SELECT id, username, password_hash, group_id, is_owner, created_at FROM accounts ORDER BY created_at",
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => this.accountFromRow(row));
  }

  async createSession(session: Session): Promise<void> {
    this.db
      .prepare("INSERT INTO sessions (id, account_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
      .run(session.id, session.accountId, session.expiresAt, session.createdAt);
  }

  async getSession(id: string): Promise<Session | null> {
    const row = this.db
      .prepare("SELECT id, account_id, expires_at, created_at FROM sessions WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row
      ? {
          id: String(row.id),
          accountId: String(row.account_id),
          expiresAt: String(row.expires_at),
          createdAt: String(row.created_at),
        }
      : null;
  }

  async deleteSession(id: string): Promise<void> {
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }

  async adoptDefaultAccount(input: { username: string; passwordHash: string }): Promise<void> {
    try {
      this.db
        .prepare("UPDATE accounts SET username = ?, password_hash = ? WHERE id = ?")
        .run(input.username, input.passwordHash, DEFAULT_ACCOUNT_ID);
    } catch (error) {
      if (error instanceof Error && /UNIQUE constraint failed: accounts\.username/.test(error.message)) {
        throw new DuplicateUsernameError(input.username);
      }
      throw error;
    }
  }

  async setAccountPassword(accountId: string, passwordHash: string): Promise<void> {
    this.db
      .prepare("UPDATE accounts SET password_hash = ? WHERE id = ?")
      .run(passwordHash, accountId);
  }

  async deleteSessionsForAccount(accountId: string, exceptSessionId?: string): Promise<void> {
    if (exceptSessionId === undefined) {
      this.db.prepare("DELETE FROM sessions WHERE account_id = ?").run(accountId);
    } else {
      this.db
        .prepare("DELETE FROM sessions WHERE account_id = ? AND id != ?")
        .run(accountId, exceptSessionId);
    }
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
