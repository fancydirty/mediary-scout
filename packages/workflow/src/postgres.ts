import pg from "pg";
import type { Pool, PoolClient } from "pg";
import {
  DEFAULT_ACCOUNT_ID,
  episodeNumberFromCode,
  HIDDEN_NOTIFICATION_KINDS,
  isStagingJanitorId,
  isUserVisibleWorkflowKind,
  type AgentDecision,
  type AgentStep,
  type EpisodeState,
  type MediaTitle,
  type NotificationEvent,
  type ResourceSnapshot,
  type TrackedSeason,
  type TransferAttempt,
  type WorkflowKind,
  type WorkflowRun,
  type WorkflowRunProgress,
} from "./domain.js";
import {
  claimWorkflowRun,
  cloneWorkflowValue,
  compareTrackedSeasonStates,
  expireWorkflowRun,
  recoverOrphanRunningRun,
  tearsDownTrackingOnCancel,
  retriedWorkflowRun,
  isActiveWorkflowStatus,
  isQueueClaimableKind,
  isStaleActiveWorkflowRun,
  reservationRequiresTrackedSeason,
  titleBlockFilter,
  type PersistedWorkflowRunSnapshot,
  type PersistWorkflowRunSnapshotInput,
  type QueuedRunDriveFilter,
  type ReserveWorkflowRunInput,
  type TrackedSeasonState,
  validateWorkflowRunSnapshot,
  findStagingRecoveryIn,
  withDerivedEpisodeSummaries,
  workflowSnapshotFromReservation,
  DuplicateUsernameError,
  UNSCOPED_STORAGE,
  type WorkflowRunReservationResult,
  type WorkflowRepository,
} from "./repository.js";
import type {
  Account,
  ConnectedStorage,
  Session,
  UpsertConnectedStorageInput,
} from "./account-credentials.js";
import { normalizeScope, scopeMatches, type ScopeArg, type WorkflowScope } from "./workflow-scope.js";
import { MAGNET_DEAD_LINK_TTL_MS, type DeadLink } from "./acquisition-v2/dead-links.js";
import {
  agentMemoryFromRow,
  agentMemoryTitleKeyColumn,
  memoryDriveAllows,
  memoryFullError,
  memoryOtherDriveError,
  type AgentMemory,
  type AgentMemoryRow,
  type AgentMemoryStore,
  type AgentMemorySummary,
  type AgentMemoryScope,
} from "./agent-memory.js";
import {
  compareUserMessagesCreated,
  episodeSourceFromRow,
  pendingReplacementFromRow,
  rejectedResourceFromRow,
  userMessageFromRow,
  type EpisodeSource,
  type EpisodeSourceRow,
  type LandingSource,
  type LinkHistoryRow,
  linkHistoryFromStored,
  type PendingReplacement,
  type PendingReplacementRow,
  type RejectedResource,
  type RejectedResourceRow,
  type UserMessage,
  type UserMessageRow,
  type UserMessageScope,
  type UserRequestStore,
  userMessageDrive,
} from "./user-requests.js";

type Queryable = Pool | PoolClient;

// Same coherent model as the SQLite repo: each table is id (+ scope cols) plus a
// jsonb `payload` holding the domain object. node-postgres returns jsonb columns
// already parsed, and `$n::jsonb` casts a JSON.stringify'd text param on insert.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS media_titles (
    id text PRIMARY KEY,
    payload jsonb NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tracked_seasons (
    id text PRIMARY KEY,
    media_title_id text NOT NULL,
    payload jsonb NOT NULL
  );
  CREATE TABLE IF NOT EXISTS workflow_runs (
    id text PRIMARY KEY,
    tracked_season_id text NOT NULL,
    payload jsonb NOT NULL
  );
  CREATE TABLE IF NOT EXISTS episode_states (
    tracked_season_id text NOT NULL,
    episode_code text NOT NULL,
    payload jsonb NOT NULL,
    PRIMARY KEY (tracked_season_id, episode_code)
  );
  CREATE TABLE IF NOT EXISTS resource_snapshots (
    id text PRIMARY KEY,
    workflow_run_id text NOT NULL,
    ordinal int NOT NULL,
    payload jsonb NOT NULL
  );
  CREATE TABLE IF NOT EXISTS agent_decisions (
    workflow_run_id text NOT NULL,
    ordinal int NOT NULL,
    snapshot_id text NOT NULL,
    payload jsonb NOT NULL,
    PRIMARY KEY (workflow_run_id, ordinal)
  );
  CREATE TABLE IF NOT EXISTS agent_steps (
    workflow_run_id text NOT NULL,
    ordinal int NOT NULL,
    payload jsonb NOT NULL,
    PRIMARY KEY (workflow_run_id, ordinal)
  );
  CREATE TABLE IF NOT EXISTS transfer_attempts (
    id text PRIMARY KEY,
    workflow_run_id text NOT NULL,
    ordinal int NOT NULL,
    candidate_id text NOT NULL,
    payload jsonb NOT NULL
  );
  CREATE TABLE IF NOT EXISTS notifications (
    id text PRIMARY KEY,
    workflow_run_id text NOT NULL,
    ordinal int NOT NULL,
    payload jsonb NOT NULL
  );
  CREATE TABLE IF NOT EXISTS app_settings (
    key text PRIMARY KEY,
    value text NOT NULL
  );
  CREATE TABLE IF NOT EXISTS dead_links (
    key text PRIMARY KEY,
    kind text NOT NULL,
    reason text NOT NULL,
    permanent boolean NOT NULL DEFAULT true,
    expires_at text,
    recorded_at text NOT NULL
  );
  ALTER TABLE dead_links ADD COLUMN IF NOT EXISTS permanent boolean NOT NULL DEFAULT true;
  ALTER TABLE dead_links ADD COLUMN IF NOT EXISTS expires_at text;
  CREATE TABLE IF NOT EXISTS accounts (
    id text PRIMARY KEY,
    username text UNIQUE NOT NULL,
    password_hash text NOT NULL DEFAULT '',
    group_id text,
    is_owner boolean NOT NULL DEFAULT false,
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
    payload jsonb NOT NULL,
    root_cid text,
    movies_cid text,
    tv_cid text,
    anime_cid text,
    created_at text NOT NULL,
    UNIQUE (provider, provider_uid)
  );
  CREATE TABLE IF NOT EXISTS agent_memories (
    id text PRIMARY KEY,
    account_id text NOT NULL,
    scope text NOT NULL,
    title_key text NOT NULL DEFAULT '',
    name text NOT NULL,
    description text NOT NULL,
    kind text NOT NULL,
    body text NOT NULL,
    provider text,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    last_used_at text,
    source_run_id text,
    UNIQUE (account_id, scope, title_key, name)
  );
  CREATE TABLE IF NOT EXISTS user_messages (
    id text PRIMARY KEY,
    account_id text NOT NULL,
    drive text NOT NULL DEFAULT '',
    title_key text NOT NULL,
    body text NOT NULL,
    episode_tags text NOT NULL DEFAULT '[]',
    status text NOT NULL,
    urgent boolean NOT NULL DEFAULT false,
    run_id text,
    reply text,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    processed_at text
  );
  CREATE INDEX IF NOT EXISTS user_messages_work ON user_messages (account_id, drive, title_key, status);
  CREATE INDEX IF NOT EXISTS user_messages_pending ON user_messages (status, urgent);
  CREATE INDEX IF NOT EXISTS user_messages_run ON user_messages (run_id);
  CREATE TABLE IF NOT EXISTS pending_replacements (
    account_id text NOT NULL,
    drive text NOT NULL DEFAULT '',
    title_key text NOT NULL,
    episode text NOT NULL,
    message_id text NOT NULL,
    requested_at text NOT NULL,
    PRIMARY KEY (account_id, drive, title_key, episode)
  );
  CREATE TABLE IF NOT EXISTS rejected_resources (
    id text PRIMARY KEY,
    account_id text NOT NULL,
    title_key text NOT NULL,
    episode text NOT NULL,
    link_key text,
    label text NOT NULL,
    size_bytes bigint,
    reason text NOT NULL,
    message_id text,
    created_at text NOT NULL
  );
  CREATE INDEX IF NOT EXISTS rejected_resources_work ON rejected_resources (account_id, title_key);
  CREATE TABLE IF NOT EXISTS episode_sources (
    account_id text NOT NULL,
    drive text NOT NULL DEFAULT '',
    title_key text NOT NULL,
    episode text NOT NULL,
    link_key text,
    label text NOT NULL,
    size_bytes bigint,
    run_id text NOT NULL,
    recorded_at text NOT NULL,
    PRIMARY KEY (account_id, drive, title_key, episode)
  );
  CREATE TABLE IF NOT EXISTS account_settings (
    account_id text NOT NULL,
    key text NOT NULL,
    value text NOT NULL,
    PRIMARY KEY (account_id, key)
  );
  ALTER TABLE tracked_seasons ADD COLUMN IF NOT EXISTS account_id text NOT NULL DEFAULT 'acct_default';
  ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS account_id text NOT NULL DEFAULT 'acct_default';
  ALTER TABLE tracked_seasons ADD COLUMN IF NOT EXISTS connected_storage_id text;
  ALTER TABLE workflow_runs ADD COLUMN IF NOT EXISTS connected_storage_id text;
  ALTER TABLE connected_storages ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
  ALTER TABLE connected_storages ADD COLUMN IF NOT EXISTS frozen_reason text;
  ALTER TABLE connected_storages ADD COLUMN IF NOT EXISTS frozen_at text;
  INSERT INTO accounts (id, username, password_hash, is_owner, created_at)
    VALUES ('acct_default', 'default', '', true, now()::text)
    ON CONFLICT (id) DO NOTHING;
  -- Tree model: make connected_storage_id part of the tracked_seasons / episode_states
  -- primary key so the SAME title can be tracked independently on multiple drives.
  -- Idempotent + guarded; self-contained backfill so SET NOT NULL is safe regardless
  -- of when the separate backfillConnectedStorageId() runs.
  ALTER TABLE episode_states ADD COLUMN IF NOT EXISTS connected_storage_id text;
  -- 1) episodes inherit their season's drive
  UPDATE episode_states e SET connected_storage_id = ts.connected_storage_id
    FROM tracked_seasons ts WHERE e.tracked_season_id = ts.id AND e.connected_storage_id IS NULL;
  -- 2) null drive -> the account's earliest-created (primary) drive
  WITH primary_drive AS (
    SELECT DISTINCT ON (account_id) account_id, id FROM connected_storages ORDER BY account_id, created_at
  )
  UPDATE tracked_seasons t SET connected_storage_id = p.id FROM primary_drive p
    WHERE t.account_id = p.account_id AND t.connected_storage_id IS NULL;
  WITH primary_drive AS (
    SELECT DISTINCT ON (account_id) account_id, id FROM connected_storages ORDER BY account_id, created_at
  )
  UPDATE workflow_runs w SET connected_storage_id = p.id FROM primary_drive p
    WHERE w.account_id = p.account_id AND w.connected_storage_id IS NULL;
  -- episodes inherit again (their season may have just been pinned)
  UPDATE episode_states e SET connected_storage_id = ts.connected_storage_id
    FROM tracked_seasons ts WHERE e.tracked_season_id = ts.id AND e.connected_storage_id IS NULL;
  -- 3) anything still null (account with zero drives) -> sentinel, with a logged count (expected 0)
  DO $do$
  DECLARE n_ts int; n_wr int; n_ep int;
  BEGIN
    UPDATE tracked_seasons SET connected_storage_id = '__unscoped__' WHERE connected_storage_id IS NULL;
    GET DIAGNOSTICS n_ts = ROW_COUNT;
    UPDATE workflow_runs SET connected_storage_id = '__unscoped__' WHERE connected_storage_id IS NULL;
    GET DIAGNOSTICS n_wr = ROW_COUNT;
    UPDATE episode_states SET connected_storage_id = '__unscoped__' WHERE connected_storage_id IS NULL;
    GET DIAGNOSTICS n_ep = ROW_COUNT;
    IF n_ts > 0 OR n_wr > 0 OR n_ep > 0 THEN
      RAISE NOTICE 'drive-scope migration: % tracked_seasons / % workflow_runs / % episode_states fell back to __unscoped__ (expected 0)', n_ts, n_wr, n_ep;
    END IF;
  END $do$;
  -- 4) enforce NOT NULL now that no nulls remain
  ALTER TABLE tracked_seasons ALTER COLUMN connected_storage_id SET NOT NULL;
  ALTER TABLE episode_states ALTER COLUMN connected_storage_id SET NOT NULL;
  -- 5) swap the primary keys (only when the current PK does not yet include the drive)
  DO $do$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey)
      WHERE i.indrelid='tracked_seasons'::regclass AND i.indisprimary AND a.attname='connected_storage_id'
    ) THEN
      ALTER TABLE tracked_seasons DROP CONSTRAINT IF EXISTS tracked_seasons_pkey;
      ALTER TABLE tracked_seasons ADD PRIMARY KEY (id, connected_storage_id);
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey)
      WHERE i.indrelid='episode_states'::regclass AND i.indisprimary AND a.attname='connected_storage_id'
    ) THEN
      ALTER TABLE episode_states DROP CONSTRAINT IF EXISTS episode_states_pkey;
      ALTER TABLE episode_states ADD PRIMARY KEY (tracked_season_id, connected_storage_id, episode_code);
    END IF;
  END $do$;
`;

/**
 * Fixed key for the Postgres advisory lock that serializes schema creation. Any
 * stable arbitrary value works; every DDL path against this database must agree
 * on it (see also the TMDB cache in apps/web, which reuses this key) so all
 * first-boot schema creation is mutually serialized through one lock.
 */
export const WORKFLOW_SCHEMA_ADVISORY_LOCK_KEY = 4_011_989_141;

/**
 * Create the schema, serialized across connections AND processes by a Postgres
 * advisory lock.
 *
 * `CREATE TABLE IF NOT EXISTS` (and the other IF-NOT-EXISTS DDL here) is NOT
 * concurrency-safe: two connections running this against a brand-new database at
 * once race on the system catalogs and one fails with a deadlock (40P01) or a
 * `pg_type`/`pg_class` unique-violation (23505). That only bites on the very
 * first boot of an empty DB — exactly the docker-compose first-run, where the
 * in-process worker and the first HTTP requests (possibly living in separate
 * Next bundles, each with its own pool) all trigger schema init together.
 *
 * `pg_advisory_xact_lock` makes it deterministic: the first connection takes the
 * lock and runs the DDL; the rest block on the lock and, once it's released at
 * COMMIT, run the same idempotent IF-NOT-EXISTS statements against the
 * now-existing schema (cheap no-ops). The lock is transaction-scoped, so it is
 * always released — even if the DDL throws and we roll back.
 */
/**
 * SQLSTATEs that mean "the connection string / database is misconfigured" —
 * retrying can never fix these, so a schema-init failure carrying one is cached
 * (fail fast) rather than re-attempted on every poll. Everything else (connection
 * refused, timeouts, unknown codes, admin-shutdown during a restart) is treated
 * as transient and retried — the safe default, because misclassifying a transient
 * error as permanent is exactly what wedges the process for hours.
 */
const PERMANENT_SCHEMA_INIT_SQLSTATES = new Set<string>([
  "28P01", // invalid_password
  "28000", // invalid_authorization_specification
  "3D000", // invalid_catalog_name (database does not exist)
]);

/** connected_storage_id is NOT NULL and holds UNSCOPED_STORAGE for unbound works; the
 *  sentinel is internal, so every reader hands callers null instead. */
function storageFromColumn(raw: unknown): string | null {
  const value = (raw as string | null | undefined) ?? null;
  return value === UNSCOPED_STORAGE ? null : value;
}

function isPermanentSchemaInitError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" && PERMANENT_SCHEMA_INIT_SQLSTATES.has(code);
}

export async function initializeWorkflowPostgresSchema(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [WORKFLOW_SCHEMA_ADVISORY_LOCK_KEY]);
    await client.query(SCHEMA);
    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Surface the original DDL error, not a secondary rollback failure.
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function createPostgresWorkflowRepository(options: {
  connectionString: string;
}): Promise<PostgresWorkflowRepository> {
  const pool = new pg.Pool({ connectionString: options.connectionString });
  await initializeWorkflowPostgresSchema(pool);
  return new PostgresWorkflowRepository(pool, Promise.resolve());
}

/**
 * Synchronous construction for callers that can't await (e.g. the web app's
 * cached `getWorkflowRepository()` getter). The schema is created lazily on
 * first use.
 */
export function createPostgresWorkflowRepositorySync(options: {
  connectionString: string;
}): PostgresWorkflowRepository {
  return new PostgresWorkflowRepository(new pg.Pool({ connectionString: options.connectionString }));
}

export class PostgresWorkflowRepository implements WorkflowRepository {
  private schemaReady: Promise<void> | undefined;

  constructor(
    private readonly pool: Pool,
    alreadyInitialized?: Promise<void>,
  ) {
    this.schemaReady = alreadyInitialized;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /** Create the schema once, memoized — lets the repo be constructed without
   *  awaiting yet still self-initialize on first query.
   *
   *  Only a SUCCESSFUL init is memoized. If init rejects with a TRANSIENT error
   *  (e.g. postgres isn't accepting connections yet because the web container won
   *  the restart race on a host reboot — 2026-07-21 incident), the memo is cleared
   *  so the next call re-attempts instead of replaying the cached rejection
   *  forever. That self-heals the whole repo once the database becomes reachable —
   *  the worker's next poll drains the queue instead of the process staying wedged
   *  until a manual restart.
   *
   *  An UNAMBIGUOUSLY-PERMANENT error (bad password, missing database) keeps its
   *  rejection cached so we fail fast instead of hammering the DB with a doomed
   *  connection on every poll. Unknown/unclassified errors default to retry — the
   *  safe direction, since misclassifying a transient error as permanent is what
   *  reintroduces the multi-hour hang this guards against. */
  private ensureSchema(): Promise<void> {
    if (this.schemaReady === undefined) {
      this.schemaReady = initializeWorkflowPostgresSchema(this.pool).catch((error) => {
        if (!isPermanentSchemaInitError(error)) {
          this.schemaReady = undefined;
        }
        throw error;
      });
    }
    return this.schemaReady;
  }

  async saveWorkflowRunSnapshot(
    input: PersistWorkflowRunSnapshotInput & { keepCurrentEpisodes?: boolean; requireTrackedSeason?: boolean },
  ): Promise<void> {
    const { keepCurrentEpisodes, requireTrackedSeason, ...rest } = input;
    validateWorkflowRunSnapshot(rest);
    const snapshot = cloneWorkflowValue(rest);
    const requireTracked = reservationRequiresTrackedSeason({
      ...(requireTrackedSeason === true ? { requireTrackedSeason: true } : {}),
      ...(keepCurrentEpisodes === true ? { keepCurrentEpisodes: true } : {}),
    });
    await this.withTransaction(async (client) => {
      if (requireTracked) {
        const accountId = snapshot.accountId ?? DEFAULT_ACCOUNT_ID;
        const connectedStorageId = snapshot.connectedStorageId ?? UNSCOPED_STORAGE;
        // Same lock untrackTitle takes, then a row lock, so this write cannot
        // recreate a season the user has just dropped.
        await lockWorkflowTitle(client, accountId, snapshot.connectedStorageId, snapshot.season.mediaTitleId);
        const tracked = await client.query(
          "SELECT 1 FROM tracked_seasons WHERE id = $1 AND connected_storage_id = $2 FOR KEY SHARE",
          [snapshot.season.id, connectedStorageId],
        );
        if ((tracked.rowCount ?? 0) === 0) return;
      }
      await this.replaceWorkflowRunSnapshot(client, snapshot, { runOnly: keepCurrentEpisodes === true });
    });
  }

  async reserveWorkflowRun(input: ReserveWorkflowRunInput): Promise<WorkflowRunReservationResult> {
    const snapshot = cloneWorkflowValue(workflowSnapshotFromReservation(input));
    validateWorkflowRunSnapshot(snapshot);
    const accountId = snapshot.accountId ?? DEFAULT_ACCOUNT_ID;
    const connectedStorageId = snapshot.connectedStorageId ?? UNSCOPED_STORAGE;

    const blocksTitle = titleBlockFilter(input);
    const requireTracked = reservationRequiresTrackedSeason(input);
    return this.withTransaction(async (client) => {
      if (blocksTitle || requireTracked) {
        // READ COMMITTED alone lets two concurrent reservations both see no active
        // run for the title and both insert. Serialize them per (account, drive,
        // title) for the rest of this transaction; untrackTitle takes the same lock.
        await lockWorkflowTitle(client, accountId, snapshot.connectedStorageId, snapshot.season.mediaTitleId);
      }

      // Under that lock and before anything is written: a season untracked since the
      // caller read it stays untracked. FOR KEY SHARE also holds off a teardown that does
      // not take the title lock (cancelling a queued init run) until this commits; one
      // already under way is waited for, and then the row is gone.
      if (requireTracked) {
        const tracked = await client.query(
          "SELECT 1 FROM tracked_seasons WHERE id = $1 AND connected_storage_id = $2 FOR KEY SHARE",
          [snapshot.season.id, connectedStorageId],
        );
        if ((tracked.rowCount ?? 0) === 0) {
          return { status: "not_tracked" };
        }
      }

      await this.expireStaleActiveWorkflowRuns(client, input);

      if (blocksTitle) {
        const titleActive = (await this.selectWorkflowRunsForTitle(client, snapshot.season.mediaTitleId, accountId, connectedStorageId))
          .filter((workflowRun) => isActiveWorkflowStatus(workflowRun.status) && blocksTitle(workflowRun))
          .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
        if (titleActive) {
          const activeSnapshot = await this.loadWorkflowRunSnapshot(client, titleActive.id);
          if (!activeSnapshot) {
            throw new Error(`Missing active workflow run ${titleActive.id}`);
          }
          return { status: "already_active", snapshot: activeSnapshot };
        }
      }

      const activeRun = (await this.selectWorkflowRuns(client, snapshot.season.id, connectedStorageId))
        .filter(
          (workflowRun) =>
            workflowRun.kind === snapshot.workflowRun.kind && isActiveWorkflowStatus(workflowRun.status),
        )
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
      if (activeRun) {
        const activeSnapshot = await this.loadWorkflowRunSnapshot(client, activeRun.id);
        if (!activeSnapshot) {
          throw new Error(`Missing active workflow run ${activeRun.id}`);
        }
        return { status: "already_active", snapshot: activeSnapshot };
      }

      const existingEpisodes = await this.selectEpisodeStates(client, snapshot.season.id, connectedStorageId);
      if (input.blockIfEpisodeStatesExist === true && existingEpisodes.length > 0) {
        return { status: "already_has_episode_state", episodes: existingEpisodes };
      }

      if (input.keepCurrentEpisodes === true) {
        // Only the run: the title, season record and episode states are not written at
        // all, so a run that saved them since the caller read them keeps what it saved.
        // The reply is the run as stored, with the season's current state.
        await this.replaceWorkflowRunSnapshot(client, snapshot, { runOnly: true });
        const reserved = await this.loadWorkflowRunSnapshot(client, snapshot.workflowRun.id);
        if (!reserved) {
          throw new Error(`Missing reserved workflow run ${snapshot.workflowRun.id}`);
        }
        return { status: "reserved", snapshot: reserved };
      }

      await this.replaceWorkflowRunSnapshot(client, snapshot);
      return {
        status: "reserved",
        snapshot: withDerivedEpisodeSummaries(cloneWorkflowValue(snapshot)),
      };
    });
  }

  async getWorkflowRunSnapshot(
    workflowRunId: string,
    scopeArg: ScopeArg = undefined,
  ): Promise<PersistedWorkflowRunSnapshot | null> {
    const scope = normalizeScope(scopeArg);
    const snapshot = await this.loadWorkflowRunSnapshot(this.pool, workflowRunId);
    if (
      !snapshot ||
      snapshot.accountId !== scope.accountId ||
      (scope.connectedStorageId != null && snapshot.connectedStorageId !== scope.connectedStorageId)
    ) {
      return null;
    }
    return snapshot;
  }

  async claimNextQueuedWorkflowRun(input: {
    kind: WorkflowKind;
    now: string;
  } & QueuedRunDriveFilter): Promise<PersistedWorkflowRunSnapshot | null> {
    const claimedRunId = await this.withTransaction(async (client) => {
      // Drive filter. A run with no bound drive (the unscoped sentinel; NULL on rows written
      // before the sentinel) is never hidden by the drive list: `NULL <> ALL(...)` is NULL,
      // so the IS NULL is spelled out.
      const params: unknown[] = [input.kind, input.now];
      let driveClause = "";
      const busyDrives = input.excludeConnectedStorageIds ?? [];
      if (busyDrives.length > 0) {
        params.push([...busyDrives]);
        driveClause += ` AND (connected_storage_id IS NULL OR connected_storage_id <> ALL($${params.length}::text[]))`;
      }
      if (input.excludeUnbound === true) {
        params.push(UNSCOPED_STORAGE);
        driveClause += ` AND connected_storage_id IS NOT NULL AND connected_storage_id <> $${params.length}`;
      }
      // Lock exactly one FIFO-ready row. Under READ COMMITTED a plain read followed
      // by upsert lets two workers see and claim the same queued run; SKIP LOCKED
      // instead lets the second worker move on without waiting for duplicate work.
      const result = await client.query<{ payload: WorkflowRun }>(
        "SELECT payload FROM workflow_runs " +
          "WHERE payload->>'kind' = $1 AND payload->>'status' = 'queued' " +
          "AND (payload->>'nextAttemptAt' IS NULL OR payload->>'nextAttemptAt' <= $2)" +
          driveClause +
          " ORDER BY payload->>'startedAt' ASC LIMIT 1 FOR UPDATE SKIP LOCKED",
        params,
      );
      const queuedRun = result.rows[0]?.payload;
      if (!queuedRun) {
        return null;
      }
      const claimedRun = claimWorkflowRun(queuedRun, input.now);
      await this.upsertWorkflowRun(client, claimedRun);
      return claimedRun.id;
    });
    // Cross-account: load the claimed run WITHOUT an account filter (the worker
    // drains every account's queue; the snapshot carries its own accountId).
    return claimedRunId ? this.loadWorkflowRunSnapshot(this.pool, claimedRunId) : null;
  }

  async requeueRunningWorkflowRuns(now: string = new Date().toISOString()): Promise<number> {
    return this.withTransaction(async (client) => {
      const running = (await this.allWorkflowRuns(client)).filter(
        (workflowRun) => workflowRun.status === "running",
      );
      let requeued = 0;
      for (const workflowRun of running) {
        const recovered = recoverOrphanRunningRun(workflowRun, now);
        await this.upsertWorkflowRun(client, recovered.run);
        if (recovered.action === "requeue") requeued += 1;
        // A replace run that will never run again hands its work back to the patrol: its
        // messages go back to pending, and none of the work's messages stays urgent (a run
        // that crashed the worker over and over must not be retried on every idle tick).
        else if (recovered.run.kind === "replace_request") {
          await releaseUserMessagesWith(client, recovered.run.id, now, false);
          const work = await workOfRunWith(client, recovered.run.id);
          if (work) await clearUserMessagesUrgentWith(client, work, now);
        }
      }
      return requeued;
    });
  }

  async pruneFinishedWorkflowRuns(olderThan: string): Promise<number> {
    return this.withTransaction(async (client) => {
      await this.ensureSchema();
      // Identify prunable finished runs first (status + finishedAt < cutoff).
      const candidates = await client.query<{ id: string }>(
        "SELECT id FROM workflow_runs WHERE payload->>'status' = ANY($1::text[]) " +
          "AND payload->>'finishedAt' IS NOT NULL AND payload->>'finishedAt' < $2",
        [["succeeded", "failed", "partial", "no_coverage"], olderThan],
      );
      const ids = candidates.rows.map((row) => row.id);
      if (ids.length === 0) return 0;
      await client.query("DELETE FROM notifications WHERE workflow_run_id = ANY($1::text[])", [ids]);
      await client.query("DELETE FROM transfer_attempts WHERE workflow_run_id = ANY($1::text[])", [ids]);
      await client.query("DELETE FROM agent_decisions WHERE workflow_run_id = ANY($1::text[])", [ids]);
      await client.query("DELETE FROM agent_steps WHERE workflow_run_id = ANY($1::text[])", [ids]);
      await client.query("DELETE FROM resource_snapshots WHERE workflow_run_id = ANY($1::text[])", [ids]);
      await client.query("DELETE FROM workflow_runs WHERE id = ANY($1::text[])", [ids]);
      return ids.length;
    });
  }

  async findActiveWorkflowRun(input: {
    trackedSeasonId: string;
    kind: WorkflowKind;
    accountId?: string;
    connectedStorageId?: string | null;
  }): Promise<PersistedWorkflowRunSnapshot | null> {
    const scope = normalizeScope(
      input.accountId === undefined
        ? undefined
        : { accountId: input.accountId, connectedStorageId: input.connectedStorageId ?? null },
    );
    await this.ensureSchema();
    // Scope-filter (account + storage) BEFORE picking the latest: with drive-independent
    // season ids the same season can be active on multiple drives, so taking the latest
    // across all drives and THEN dropping cross-storage could return null even though a
    // scoped active run exists on an older drive. Mirror the InMemory oracle.
    const result = await this.pool.query<{
      payload: WorkflowRun;
      account_id: string;
      connected_storage_id: string | null;
    }>(
      "SELECT payload, account_id, connected_storage_id FROM workflow_runs WHERE tracked_season_id = $1 AND account_id = $2",
      [input.trackedSeasonId, scope.accountId],
    );
    const latest = result.rows
      .filter((row) => {
        const rawStorage = row.connected_storage_id ?? null;
        const storage = rawStorage === UNSCOPED_STORAGE ? null : rawStorage;
        return (
          scopeMatches(scope, row.account_id ?? DEFAULT_ACCOUNT_ID, storage) &&
          row.payload.kind === input.kind &&
          isActiveWorkflowStatus(row.payload.status)
        );
      })
      .map((row) => row.payload)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    return latest ? this.getWorkflowRunSnapshot(latest.id, scope) : null;
  }

  async listActiveWorkflowRuns(
    scopeArg: ScopeArg = undefined,
  ): Promise<PersistedWorkflowRunSnapshot[]> {
    const scope = normalizeScope(scopeArg);
    const runs = (await this.allWorkflowRunsForAccount(this.pool, scope.accountId))
      .filter((workflowRun) => isActiveWorkflowStatus(workflowRun.status))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const snapshots: PersistedWorkflowRunSnapshot[] = [];
    for (const run of runs) {
      try {
        // Full scope drops runs on other storages of the same account.
        const snapshot = await this.getWorkflowRunSnapshot(run.id, scope);
        if (snapshot) {
          snapshots.push(snapshot);
        }
      } catch {
        // Orphaned/inconsistent run — skip rather than crash callers.
      }
    }
    return snapshots;
  }

  async findActiveStagingRecovery(input: {
    accountId: string;
    connectedStorageId: string | null;
    stagingDirectoryId: string;
  }): Promise<PersistedWorkflowRunSnapshot | null> {
    const runs = await this.listActiveWorkflowRuns({
      accountId: input.accountId,
      connectedStorageId: input.connectedStorageId,
    });
    return findStagingRecoveryIn(runs, input.stagingDirectoryId);
  }

  async updateWorkflowRunProgress(workflowRunId: string, progress: WorkflowRunProgress): Promise<void> {
    await this.withTransaction(async (client) => {
      const run = await this.selectOne<WorkflowRun>(
        client,
        "SELECT payload FROM workflow_runs WHERE id = $1",
        [workflowRunId],
      );
      if (!run) {
        return;
      }
      const previousPercent = run.progress?.percent ?? 0;
      await this.upsertWorkflowRun(client, {
        ...run,
        progress: { ...progress, percent: Math.max(previousPercent, progress.percent) },
      });
    });
  }

  async appendAgentStep(workflowRunId: string, step: AgentStep): Promise<void> {
    // Hot path: fires once per agent tool call, in parallel across runs. A single
    // autocommit INSERT on the pool — no BEGIN/COMMIT/connect overhead of a tx.
    await this.ensureSchema();
    await this.pool.query(
      "INSERT INTO agent_steps (workflow_run_id, ordinal, payload) VALUES ($1, $2, $3::jsonb) " +
        "ON CONFLICT (workflow_run_id, ordinal) DO NOTHING",
      [workflowRunId, step.ordinal, json(step)],
    );
  }

  async listAgentSteps(workflowRunId: string, scopeArg: ScopeArg = undefined): Promise<AgentStep[]> {
    // Scope gate reads ONLY the run's two ownership columns — not the full snapshot
    // (season/title/episodes/...) the old getWorkflowRunSnapshot load pulled in.
    if (scopeArg !== undefined && !(await this.runMatchesScope(workflowRunId, scopeArg))) {
      return [];
    }
    return this.selectMany<AgentStep>(
      this.pool,
      "SELECT payload FROM agent_steps WHERE workflow_run_id = $1 ORDER BY ordinal",
      [workflowRunId],
    );
  }

  /** Lightweight (account, storage) visibility check for a run: reads just the two
   *  scope columns and applies the same scopeMatches predicate as everywhere else.
   *  Fail-closed — an unknown run is not visible to any scope. */
  private async runMatchesScope(workflowRunId: string, scopeArg: ScopeArg): Promise<boolean> {
    const scope = normalizeScope(scopeArg);
    await this.ensureSchema();
    const row = await this.pool.query(
      "SELECT account_id, connected_storage_id FROM workflow_runs WHERE id = $1",
      [workflowRunId],
    );
    const owner = row.rows[0];
    if (!owner) {
      return false;
    }
    const ownerAccount = (owner.account_id as string | undefined) ?? DEFAULT_ACCOUNT_ID;
    return scopeMatches(scope, ownerAccount, storageFromColumn(owner.connected_storage_id));
  }

  async clearAgentSteps(workflowRunId: string): Promise<void> {
    await this.ensureSchema();
    await this.pool.query("DELETE FROM agent_steps WHERE workflow_run_id = $1", [workflowRunId]);
  }

  async cancelQueuedWorkflowRun(
    workflowRunId: string,
    scopeArg: ScopeArg = undefined,
  ): Promise<{ status: "cancelled" | "not_cancellable" }> {
    const scope = normalizeScope(scopeArg);
    return this.withTransaction(async (client) => {
      await this.ensureSchema();
      const row = await client.query(
        "SELECT payload, account_id, connected_storage_id FROM workflow_runs WHERE id = $1",
        [workflowRunId],
      );
      const run = (row.rows[0]?.payload as WorkflowRun | undefined) ?? null;
      const owner = (row.rows[0]?.account_id as string | undefined) ?? DEFAULT_ACCOUNT_ID;
      const ownerStorage = (row.rows[0]?.connected_storage_id as string | null | undefined) ?? null;
      if (
        !run ||
        owner !== scope.accountId ||
        (scope.connectedStorageId != null && ownerStorage !== scope.connectedStorageId) ||
        run.status !== "queued"
      ) {
        return { status: "not_cancellable" as const };
      }
      const seasonId = run.trackedSeasonId;
      // Tree model: the (season, drive) being torn down — never touch another drive.
      const storageValue = ownerStorage ?? UNSCOPED_STORAGE;
      // The run's own children.
      await client.query("DELETE FROM notifications WHERE workflow_run_id = $1", [workflowRunId]);
      await client.query("DELETE FROM transfer_attempts WHERE workflow_run_id = $1", [workflowRunId]);
      await client.query("DELETE FROM agent_decisions WHERE workflow_run_id = $1", [workflowRunId]);
      await client.query("DELETE FROM agent_steps WHERE workflow_run_id = $1", [workflowRunId]);
      await client.query("DELETE FROM resource_snapshots WHERE workflow_run_id = $1", [workflowRunId]);
      await client.query("DELETE FROM workflow_runs WHERE id = $1", [workflowRunId]);

      // Only an init run owns its season's tracking; a cancelled replace_request is
      // just removed, and any messages it held go back to pending.
      if (!tearsDownTrackingOnCancel(run.kind)) {
        if (run.kind === "replace_request") {
          // The user cancelled: nothing of this work stays urgent, or the idle scan would
          // queue it again within seconds. It waits for the patrol (or 现在处理).
          const now = new Date().toISOString();
          await releaseUserMessagesWith(client, workflowRunId, now, false);
          const season = await client.query("SELECT media_title_id FROM tracked_seasons WHERE id = $1 AND connected_storage_id = $2", [
            seasonId,
            storageValue,
          ]);
          const titleKey = season.rows[0]?.media_title_id as string | undefined;
          if (titleKey !== undefined) {
            await clearUserMessagesUrgentWith(
              client,
              { accountId: owner, drive: userMessageDrive(ownerStorage === UNSCOPED_STORAGE ? null : ownerStorage), titleKey },
              now,
            );
          }
        }
        return { status: "cancelled" as const };
      }
      // Only tear down the tracking when no OTHER run on the SAME (season, drive)
      // still references it (a queued init is the sole run for its fresh season →
      // torn down, vanishing from the library; a re-queued run beside acquired
      // history is not). Scoped to this drive so another drive's tracking survives.
      const others = await client.query(
        "SELECT 1 FROM workflow_runs WHERE tracked_season_id = $1 AND connected_storage_id = $2 LIMIT 1",
        [seasonId, storageValue],
      );
      if (others.rowCount === 0) {
        await this.teardownSeasonScoped(client, seasonId, storageValue);
      }
      return { status: "cancelled" as const };
    });
  }

  /** Tear down one (season, drive): delete its episodes + tracked_seasons row, then
   *  delete the global media_titles row only when NO tracked_seasons reference that
   *  title anywhere (another drive tracking the same show must survive). Shared by
   *  cancelQueuedWorkflowRun and untrackTitle. */
  private async teardownSeasonScoped(
    client: PoolClient,
    seasonId: string,
    storageValue: string,
  ): Promise<void> {
    await client.query(
      "DELETE FROM episode_states WHERE tracked_season_id = $1 AND connected_storage_id = $2",
      [seasonId, storageValue],
    );
    const season = await this.selectOne<TrackedSeason>(
      client,
      "SELECT payload FROM tracked_seasons WHERE id = $1 AND connected_storage_id = $2",
      [seasonId, storageValue],
    );
    await client.query("DELETE FROM tracked_seasons WHERE id = $1 AND connected_storage_id = $2", [
      seasonId,
      storageValue,
    ]);
    if (season) {
      const siblingSeasons = await client.query(
        "SELECT 1 FROM tracked_seasons WHERE media_title_id = $1 LIMIT 1",
        [season.mediaTitleId],
      );
      if (siblingSeasons.rowCount === 0) {
        await client.query("DELETE FROM media_titles WHERE id = $1", [season.mediaTitleId]);
      }
    }
  }

  async untrackTitle(
    tmdbId: number,
    scope: WorkflowScope,
    mediaKind: "movie" | "tv",
    seasonNumber?: number,
  ): Promise<{ status: "untracked" | "not_found" | "in_flight"; removedSeasons: number }> {
    // Enumerate this drive's target seasons for the title (reuse scoped read).
    // Match mediaKind too: TMDB movie/tv id namespaces collide (movie 278 ≠ tv 278),
    // so filtering by numeric tmdbId alone would untrack the wrong title. "tv"
    // covers both tv and anime (same tv namespace).
    const wantMovie = mediaKind === "movie";
    const states = (await this.listTrackedSeasonStates(scope)).filter(
      (state) =>
        state.title.tmdbId === tmdbId &&
        (state.title.type === "movie") === wantMovie &&
        (seasonNumber === undefined || state.season.seasonNumber === seasonNumber),
    );
    if (states.length === 0) {
      return { status: "not_found", removedSeasons: 0 };
    }
    const targetSeasonIds = states.map((state) => state.season.id);
    const storageValue = scope.connectedStorageId ?? UNSCOPED_STORAGE;
    const workScope = {
      accountId: scope.accountId ?? DEFAULT_ACCOUNT_ID,
      drive: userMessageDrive(scope.connectedStorageId),
      titleKey: states[0]!.title.id,
    };

    return this.withTransaction(async (client) => {
      await this.ensureSchema();
      // First the lock a replace reservation takes: one reserved from states read before
      // this untrack has either committed (and is seen below → in_flight) or waits, then
      // finds the season gone (not_tracked) instead of tracking it again.
      await lockWorkflowTitle(client, workScope.accountId, scope.connectedStorageId, workScope.titleKey);
      // In-flight guard: a running run on any target season → refuse, delete nothing.
      // A staging_recovery is hidden and cannot be cancelled, so it does not count.
      const running = await client.query(
        "SELECT 1 FROM workflow_runs WHERE tracked_season_id = ANY($1) AND connected_storage_id = $2 " +
          "AND payload->>'status' = 'running' AND payload->>'kind' IS DISTINCT FROM 'staging_recovery' LIMIT 1",
        [targetSeasonIds, storageValue],
      );
      // …and a queued or running replace_request of the work, whichever season it is
      // recorded on: it covers every season tracked when it starts and writes a record for
      // each when it ends, so a season untracked in between would be tracked again. It stays
      // running until its last write (its terminal record comes after the season records and
      // the request bookkeeping), so once it has ended nothing of it is left to write.
      const replaceActive = (await this.selectWorkflowRunsForTitle(client, workScope.titleKey, workScope.accountId, storageValue)).some(
        (run) => run.kind === "replace_request" && isActiveWorkflowStatus(run.status),
      );
      if ((running.rowCount ?? 0) > 0 || replaceActive) {
        return { status: "in_flight" as const, removedSeasons: 0 };
      }
      // For each season: delete all run children + runs, then tear down the season.
      for (const seasonId of targetSeasonIds) {
        const runIdsSub =
          "(SELECT id FROM workflow_runs WHERE tracked_season_id = $1 AND connected_storage_id = $2)";
        await client.query(`DELETE FROM notifications WHERE workflow_run_id IN ${runIdsSub}`, [
          seasonId,
          storageValue,
        ]);
        await client.query(`DELETE FROM transfer_attempts WHERE workflow_run_id IN ${runIdsSub}`, [
          seasonId,
          storageValue,
        ]);
        await client.query(`DELETE FROM agent_decisions WHERE workflow_run_id IN ${runIdsSub}`, [
          seasonId,
          storageValue,
        ]);
        await client.query(`DELETE FROM agent_steps WHERE workflow_run_id IN ${runIdsSub}`, [
          seasonId,
          storageValue,
        ]);
        await client.query(`DELETE FROM resource_snapshots WHERE workflow_run_id IN ${runIdsSub}`, [
          seasonId,
          storageValue,
        ]);
        await client.query(
          "DELETE FROM workflow_runs WHERE tracked_season_id = $1 AND connected_storage_id = $2",
          [seasonId, storageValue],
        );
        await this.teardownSeasonScoped(client, seasonId, storageValue);
      }

      // Clean up this work's pending user-request state too, so it doesn't come
      // back to haunt a fresh (re-)track: a stale pending message just keeps
      // producing not_tracked queue attempts, and a stale pending_replacement
      // would revive an old replace request the moment the title is re-tracked.
      // episode_sources and rejected_resources stay — they're useful history if
      // the user re-tracks. Processing messages are untouched (a running run
      // already refused above; nothing here is mid-flight). Untracking the last
      // season still tracked on this drive, one season at a time, is the whole work.
      await lockUserMessageWork(client, workScope);
      const workGone =
        seasonNumber === undefined ||
        (await this.selectWorkflowRunsForTitle(client, workScope.titleKey, workScope.accountId, storageValue)).length === 0;
      if (workGone) {
        const now = new Date().toISOString();
        await client.query(
          "UPDATE user_messages SET status = 'withdrawn', updated_at = $1 WHERE account_id = $2 AND drive = $3 AND title_key = $4 AND status = 'pending'",
          [now, workScope.accountId, workScope.drive, workScope.titleKey],
        );
        await client.query(
          "DELETE FROM pending_replacements WHERE account_id = $1 AND drive = $2 AND title_key = $3",
          [workScope.accountId, workScope.drive, workScope.titleKey],
        );
      } else {
        const seasonPrefix = `S${String(seasonNumber).padStart(2, "0")}E%`;
        await client.query(
          "DELETE FROM pending_replacements WHERE account_id = $1 AND drive = $2 AND title_key = $3 AND episode LIKE $4",
          [workScope.accountId, workScope.drive, workScope.titleKey, seasonPrefix],
        );
      }

      return { status: "untracked" as const, removedSeasons: targetSeasonIds.length };
    });
  }

  async retryFailedWorkflowRun(
    workflowRunId: string,
    scopeArg: ScopeArg = undefined,
  ): Promise<{ status: "retried" | "not_retriable" }> {
    const scope = normalizeScope(scopeArg);
    return this.withTransaction(async (client) => {
      await this.ensureSchema();
      const row = await client.query(
        "SELECT payload, account_id, connected_storage_id FROM workflow_runs WHERE id = $1",
        [workflowRunId],
      );
      const run = (row.rows[0]?.payload as WorkflowRun | undefined) ?? null;
      const owner = (row.rows[0]?.account_id as string | undefined) ?? DEFAULT_ACCOUNT_ID;
      const ownerStorage = (row.rows[0]?.connected_storage_id as string | null | undefined) ?? null;
      // A kind with no queue claimer can never leave `queued` — retrying it would
      // strand the run and re-block the season (see isQueueClaimableKind).
      // A hidden kind is claimable by the worker but must not be reachable here.
      if (
        !run ||
        owner !== scope.accountId ||
        (scope.connectedStorageId != null && ownerStorage !== scope.connectedStorageId) ||
        run.status !== "failed" ||
        !isQueueClaimableKind(run.kind) ||
        !isUserVisibleWorkflowKind(run.kind)
      ) {
        return { status: "not_retriable" as const };
      }
      // account_id / connected_storage_id are preserved on conflict by upsert.
      await this.upsertWorkflowRun(client, retriedWorkflowRun(run, new Date().toISOString()));
      return { status: "retried" as const };
    });
  }

  async getTrackedSeasonState(
    trackedSeasonId: string,
    scopeArg: ScopeArg = undefined,
  ): Promise<TrackedSeasonState | null> {
    const scope = normalizeScope(scopeArg);
    await this.ensureSchema();
    const result = await this.pool.query(
      "SELECT payload, connected_storage_id FROM tracked_seasons " +
        "WHERE id = $1 AND account_id = $2 AND ($3::text IS NULL OR connected_storage_id = $3)",
      [trackedSeasonId, scope.accountId, scope.connectedStorageId],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    const season = row.payload as TrackedSeason;
    // Hides rows the previous janitor wrote.
    if (isStagingJanitorId(season.id)) {
      return null;
    }
    const title = await this.requireTitle(this.pool, season);
    return {
      accountId: scope.accountId,
      connectedStorageId: storageFromColumn(row.connected_storage_id),
      title,
      season,
      episodes: await this.selectEpisodeStates(this.pool, season.id, (row.connected_storage_id as string | null) ?? UNSCOPED_STORAGE),
    };
  }

  async listTrackedSeasonStates(
    scopeArg: ScopeArg = undefined,
  ): Promise<TrackedSeasonState[]> {
    const scope = normalizeScope(scopeArg);
    await this.ensureSchema();
    const result = await this.pool.query(
      "SELECT payload, connected_storage_id FROM tracked_seasons " +
        "WHERE account_id = $1 AND ($2::text IS NULL OR connected_storage_id = $2)",
      [scope.accountId, scope.connectedStorageId],
    );
    const states: TrackedSeasonState[] = [];
    for (const row of result.rows) {
      const season = row.payload as TrackedSeason;
      // Hides rows the previous janitor wrote.
      if (isStagingJanitorId(season.id)) {
        continue;
      }
      states.push({
        accountId: scope.accountId,
        connectedStorageId: storageFromColumn(row.connected_storage_id),
        title: await this.requireTitle(this.pool, season),
        season,
        episodes: await this.selectEpisodeStates(this.pool, season.id, (row.connected_storage_id as string | null) ?? UNSCOPED_STORAGE),
      });
    }
    return states.sort(compareTrackedSeasonStates);
  }

  async listAllTrackedSeasonStates(): Promise<TrackedSeasonState[]> {
    await this.ensureSchema();
    const result = await this.pool.query(
      "SELECT payload, account_id, connected_storage_id FROM tracked_seasons",
    );
    const states: TrackedSeasonState[] = [];
    for (const row of result.rows) {
      const season = row.payload as TrackedSeason;
      // Hides rows the previous janitor wrote.
      if (isStagingJanitorId(season.id)) {
        continue;
      }
      const accountId = (row.account_id as string | undefined) ?? DEFAULT_ACCOUNT_ID;
      states.push({
        accountId,
        connectedStorageId: storageFromColumn(row.connected_storage_id),
        title: await this.requireTitle(this.pool, season),
        season,
        episodes: await this.selectEpisodeStates(this.pool, season.id, (row.connected_storage_id as string | null) ?? UNSCOPED_STORAGE),
      });
    }
    return states.sort(compareTrackedSeasonStates);
  }

  async listEpisodeStates(
    trackedSeasonId: string,
    scopeArg: ScopeArg = undefined,
  ): Promise<EpisodeState[]> {
    // Episodes carry their own connected_storage_id now; join the season on BOTH
    // (id, storage) so each episode attributes to its own drive's season row, then
    // gate the account (episode_states has no account column) and optional storage.
    const scope = normalizeScope(scopeArg);
    const episodes = await this.selectMany<EpisodeState>(
      this.pool,
      "SELECT e.payload AS payload FROM episode_states e " +
        "JOIN tracked_seasons ts ON e.tracked_season_id = ts.id AND e.connected_storage_id = ts.connected_storage_id " +
        "WHERE e.tracked_season_id = $1 AND ts.account_id = $2 " +
        "AND ($3::text IS NULL OR e.connected_storage_id = $3)",
      [trackedSeasonId, scope.accountId, scope.connectedStorageId],
    );
    return episodes.sort((a, b) => episodeNumberFromCode(a.episodeCode) - episodeNumberFromCode(b.episodeCode));
  }

  async listNotifications(input?: {
    limit?: number;
    accountId?: string;
    connectedStorageId?: string | null;
    since?: string;
  }): Promise<NotificationEvent[]> {
    const scope = normalizeScope(
      input?.accountId === undefined
        ? undefined
        : { accountId: input.accountId, connectedStorageId: input.connectedStorageId ?? null },
    );
    // ISO-8601 UTC timestamps sort lexicographically = chronologically, so a string
    // `>=` on payload->>'createdAt' is a correct (and indexable) recency cutoff.
    const all = await this.selectMany<NotificationEvent>(
      this.pool,
      "SELECT n.payload AS payload FROM notifications n " +
        "JOIN workflow_runs wr ON n.workflow_run_id = wr.id " +
        "WHERE wr.account_id = $1 AND ($2::text IS NULL OR wr.connected_storage_id = $2) " +
        "AND ($3::text IS NULL OR (n.payload->>'createdAt') >= $3) " +
        "AND COALESCE(n.payload->>'kind', '') <> ALL($4::text[])",
      [scope.accountId, scope.connectedStorageId, input?.since ?? null, HIDDEN_NOTIFICATION_KINDS],
    );
    all.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return all.slice(0, input?.limit ?? 100);
  }

  async listRecentNotificationsWithAccount(input?: {
    limit?: number;
    since?: string;
  }): Promise<Array<{ accountId: string; connectedStorageId: string | null; notification: NotificationEvent }>> {
    await this.ensureSchema();
    // since + ORDER BY + LIMIT all in SQL so a large history cannot force a full-table
    // pull into JS just to throw most rows away.
    const limit = input?.limit ?? 100;
    const result = await this.pool.query(
      "SELECT n.payload AS payload, wr.account_id AS account_id, wr.connected_storage_id AS connected_storage_id FROM notifications n " +
        "JOIN workflow_runs wr ON n.workflow_run_id = wr.id " +
        "WHERE ($1::text IS NULL OR (n.payload->>'createdAt') >= $1) " +
        "AND COALESCE(n.payload->>'kind', '') <> ALL($3::text[]) " +
        "ORDER BY (n.payload->>'createdAt') DESC LIMIT $2",
      [input?.since ?? null, limit, HIDDEN_NOTIFICATION_KINDS],
    );
    return result.rows.map((row) => {
      const rawStorage = (row.connected_storage_id as string | null | undefined) ?? null;
      return {
        accountId: (row.account_id as string | undefined) ?? DEFAULT_ACCOUNT_ID,
        // Collapse the internal sentinel back to null, same as loadWorkflowRunSnapshot:
        // callers must never observe UNSCOPED_STORAGE.
        connectedStorageId: rawStorage === UNSCOPED_STORAGE ? null : rawStorage,
        notification: row.payload as NotificationEvent,
      };
    });
  }

  async getSetting(key: string): Promise<string | null> {
    await this.ensureSchema();
    const result = await this.pool.query("SELECT value FROM app_settings WHERE key = $1", [key]);
    return result.rows[0]?.value ?? null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      "INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
      [key, value],
    );
  }

  async deleteSetting(key: string): Promise<void> {
    await this.ensureSchema();
    await this.pool.query("DELETE FROM app_settings WHERE key = $1", [key]);
  }

  async getAccountSetting(accountId: string, key: string): Promise<string | null> {
    await this.ensureSchema();
    const result = await this.pool.query(
      "SELECT value FROM account_settings WHERE account_id = $1 AND key = $2",
      [accountId, key],
    );
    return result.rows[0]?.value ?? null;
  }

  async setAccountSetting(accountId: string, key: string, value: string): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      "INSERT INTO account_settings (account_id, key, value) VALUES ($1, $2, $3) " +
        "ON CONFLICT (account_id, key) DO UPDATE SET value = EXCLUDED.value",
      [accountId, key, value],
    );
  }

  async backfillConnectedStorageId(): Promise<number> {
    await this.ensureSchema();
    // Each account's earliest-created drive is its primary (root) workspace; pin
    // every legacy null-storage row to it. Accounts with no drive are skipped
    // (no matching row in the primary CTE). Idempotent: only null rows are touched.
    const primaryCte =
      "WITH primary_drive AS (" +
      "SELECT DISTINCT ON (account_id) account_id, id FROM connected_storages " +
      "ORDER BY account_id, created_at" +
      ") ";
    const ts = await this.pool.query(
      primaryCte +
        "UPDATE tracked_seasons t SET connected_storage_id = p.id FROM primary_drive p " +
        "WHERE t.account_id = p.account_id AND t.connected_storage_id IS NULL",
    );
    const wr = await this.pool.query(
      primaryCte +
        "UPDATE workflow_runs w SET connected_storage_id = p.id FROM primary_drive p " +
        "WHERE w.account_id = p.account_id AND w.connected_storage_id IS NULL",
    );
    return (ts.rowCount ?? 0) + (wr.rowCount ?? 0);
  }

  async listConnectedStorages(accountId: string): Promise<ConnectedStorage[]> {
    await this.ensureSchema();
    const result = await this.pool.query(
      "SELECT id, account_id, provider, provider_uid, label, payload, root_cid, movies_cid, tv_cid, anime_cid, status, frozen_reason, frozen_at, created_at " +
        "FROM connected_storages WHERE account_id = $1 ORDER BY created_at",
      [accountId],
    );
    return result.rows.map((row) => connectedStorageFromRow(row));
  }

  async hasAnyConnectedStorage(): Promise<boolean> {
    await this.ensureSchema();
    const result = await this.pool.query("SELECT 1 FROM connected_storages LIMIT 1");
    return result.rowCount !== null && result.rowCount > 0;
  }

  async upsertConnectedStorage(row: UpsertConnectedStorageInput): Promise<void> {
    await this.ensureSchema();
    // Refuse the multi-user unauthenticated sentinel — binds must never land on a ghost account.
    if (row.accountId === "acct_unauthenticated") {
      throw new Error("cannot bind storage to unauthenticated account");
    }
    // Instance-wide UNIQUE(provider, provider_uid) ownership: on conflict NEVER
    // reassign account_id, and only refresh the row when the SAME account owns it
    // (the WHERE makes a cross-account conflict a no-op — it can't steal or
    // overwrite another account's 网盘). The binding path rejects first; this is
    // the DB-level backstop.
    await this.pool.query(
      "INSERT INTO connected_storages " +
        "(id, account_id, provider, provider_uid, label, payload, root_cid, movies_cid, tv_cid, anime_cid, created_at) " +
        "VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11) " +
        "ON CONFLICT (provider, provider_uid) DO UPDATE SET " +
        "label = EXCLUDED.label, payload = EXCLUDED.payload, " +
        "root_cid = EXCLUDED.root_cid, movies_cid = EXCLUDED.movies_cid, tv_cid = EXCLUDED.tv_cid, anime_cid = EXCLUDED.anime_cid " +
        "WHERE connected_storages.account_id = EXCLUDED.account_id",
      [
        row.id,
        row.accountId,
        row.provider,
        row.providerUid,
        row.label ?? null,
        json(row.payload),
        row.rootCid ?? null,
        row.moviesCid ?? null,
        row.tvCid ?? null,
        row.animeCid ?? null,
        row.createdAt,
      ],
    );
  }

  async deleteConnectedStorage(accountId: string, storageId: string): Promise<void> {
    await this.ensureSchema();
    // Only the drive row (incl. its cookie) is removed. Tracking tables key on
    // (account_id, connected_storage_id) and have NO FK to connected_storages, so
    // their rows persist; re-binding the same drive (same cs_id) reconnects them.
    // account_id in the WHERE is fail-closed: can't delete another account's drive.
    await this.pool.query("DELETE FROM connected_storages WHERE id = $1 AND account_id = $2", [
      storageId,
      accountId,
    ]);
  }

  async tryUnbindConnectedStorage(
    accountId: string,
    storageId: string,
  ): Promise<
    | { ok: true; storage: ConnectedStorage }
    | { ok: false; reason: "active_runs" | "not_found" }
  > {
    return this.withTransaction(async (client) => {
      const locked = await client.query(
        "SELECT id, account_id, provider, provider_uid, label, payload, root_cid, movies_cid, tv_cid, anime_cid, status, frozen_reason, frozen_at, created_at " +
          "FROM connected_storages WHERE id = $1 AND account_id = $2 FOR UPDATE",
        [storageId, accountId],
      );
      if (locked.rows.length === 0) {
        return { ok: false as const, reason: "not_found" as const };
      }
      const active = await client.query(
        "SELECT 1 FROM workflow_runs " +
          "WHERE account_id = $1 AND connected_storage_id = $2 " +
          "AND payload->>'status' IN ('queued', 'running') " +
          "LIMIT 1",
        [accountId, storageId],
      );
      if (active.rows.length > 0) {
        return { ok: false as const, reason: "active_runs" as const };
      }
      await client.query("DELETE FROM connected_storages WHERE id = $1 AND account_id = $2", [
        storageId,
        accountId,
      ]);
      return {
        ok: true as const,
        storage: connectedStorageFromRow(locked.rows[0] as Record<string, unknown>),
      };
    });
  }

  async findConnectedStorageByUid(
    provider: string,
    providerUid: string,
  ): Promise<ConnectedStorage | null> {
    await this.ensureSchema();
    const result = await this.pool.query(
      "SELECT id, account_id, provider, provider_uid, label, payload, root_cid, movies_cid, tv_cid, anime_cid, status, frozen_reason, frozen_at, created_at " +
        "FROM connected_storages WHERE provider = $1 AND provider_uid = $2",
      [provider, providerUid],
    );
    const row = result.rows[0];
    return row ? connectedStorageFromRow(row) : null;
  }

  async setConnectedStorageStatus(
    storageId: string,
    status: "active" | "frozen",
    frozenReason: string | null,
    frozenAt: string | null,
  ): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      "UPDATE connected_storages SET status = $2, frozen_reason = $3, frozen_at = $4 WHERE id = $1",
      [storageId, status, frozenReason, frozenAt],
    );
  }

  async createAccount(account: Account): Promise<void> {
    await this.ensureSchema();
    try {
      await this.pool.query(
        "INSERT INTO accounts (id, username, password_hash, group_id, is_owner, created_at) " +
          "VALUES ($1, $2, $3, $4, $5, $6)",
        [account.id, account.username, account.passwordHash, account.groupId, account.isOwner, account.createdAt],
      );
    } catch (error) {
      // 23505 = unique_violation (username UNIQUE).
      if (error && typeof error === "object" && (error as { code?: string }).code === "23505") {
        throw new DuplicateUsernameError(account.username);
      }
      throw error;
    }
  }

  async getAccountByUsername(username: string): Promise<Account | null> {
    await this.ensureSchema();
    const result = await this.pool.query(
      "SELECT id, username, password_hash, group_id, is_owner, created_at FROM accounts WHERE username = $1",
      [username],
    );
    const row = result.rows[0];
    return row ? accountFromRow(row) : null;
  }

  async getAccountById(id: string): Promise<Account | null> {
    await this.ensureSchema();
    const result = await this.pool.query(
      "SELECT id, username, password_hash, group_id, is_owner, created_at FROM accounts WHERE id = $1",
      [id],
    );
    const row = result.rows[0];
    return row ? accountFromRow(row) : null;
  }

  async listAccounts(): Promise<Account[]> {
    await this.ensureSchema();
    const result = await this.pool.query(
      "SELECT id, username, password_hash, group_id, is_owner, created_at FROM accounts ORDER BY created_at",
    );
    return result.rows.map((row) => accountFromRow(row));
  }

  async createSession(session: Session): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      "INSERT INTO sessions (id, account_id, expires_at, created_at) VALUES ($1, $2, $3, $4)",
      [session.id, session.accountId, session.expiresAt, session.createdAt],
    );
  }

  async getSession(id: string): Promise<Session | null> {
    await this.ensureSchema();
    const result = await this.pool.query(
      "SELECT id, account_id, expires_at, created_at FROM sessions WHERE id = $1",
      [id],
    );
    const row = result.rows[0];
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
    await this.ensureSchema();
    await this.pool.query("DELETE FROM sessions WHERE id = $1", [id]);
  }

  async adoptDefaultAccount(input: { username: string; passwordHash: string }): Promise<void> {
    await this.ensureSchema();
    try {
      await this.pool.query("UPDATE accounts SET username = $1, password_hash = $2 WHERE id = $3", [
        input.username,
        input.passwordHash,
        DEFAULT_ACCOUNT_ID,
      ]);
    } catch (error) {
      if (error && typeof error === "object" && (error as { code?: string }).code === "23505") {
        throw new DuplicateUsernameError(input.username);
      }
      throw error;
    }
  }

  async setAccountPassword(accountId: string, passwordHash: string): Promise<void> {
    await this.ensureSchema();
    await this.pool.query("UPDATE accounts SET password_hash = $1 WHERE id = $2", [passwordHash, accountId]);
  }

  async deleteSessionsForAccount(accountId: string, exceptSessionId?: string): Promise<void> {
    await this.ensureSchema();
    await this.pool.query("DELETE FROM sessions WHERE account_id = $1 AND ($2::text IS NULL OR id <> $2)", [
      accountId,
      exceptSessionId ?? null,
    ]);
  }

  async recordDeadLink(input: {
    key: string;
    kind: DeadLink["kind"];
    reason: string;
    permanent: boolean;
    ttlMs?: number;
    now?: string;
  }): Promise<void> {
    await this.ensureSchema();
    const recordedAt = input.now ?? new Date().toISOString();
    const expiresAt = input.permanent
      ? null
      : new Date(new Date(recordedAt).getTime() + (input.ttlMs ?? MAGNET_DEAD_LINK_TTL_MS)).toISOString();
    // Idempotent: keep the first record (when it was first proven dead).
    await this.pool.query(
      "INSERT INTO dead_links (key, kind, reason, permanent, expires_at, recorded_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (key) DO NOTHING",
      [input.key, input.kind, input.reason, input.permanent, expiresAt, recordedAt],
    );
  }

  async listDeadLinkKeys(options?: { now?: string }): Promise<string[]> {
    await this.ensureSchema();
    // Permanent deaths (expires_at NULL) always filter; soft ones only until their
    // own expiry (so an unresolvable magnet's longer TTL is honored per-record).
    const now = options?.now ?? new Date().toISOString();
    const result = await this.pool.query(
      "SELECT key FROM dead_links WHERE expires_at IS NULL OR expires_at > $1",
      [now],
    );
    return result.rows.map((row) => String(row.key));
  }

  async listAgentMemories(input: Parameters<AgentMemoryStore["listAgentMemories"]>[0]): Promise<AgentMemory[]> {
    await this.ensureSchema();
    const result = await this.pool.query<AgentMemoryRow>(
      "SELECT * FROM agent_memories WHERE account_id = $1 AND scope = $2 AND title_key = $3 ORDER BY updated_at DESC, name ASC",
      [input.accountId, input.scope, agentMemoryTitleKeyColumn(input.scope, input.titleKey)],
    );
    return result.rows.map(agentMemoryFromRow);
  }

  async upsertAgentMemory(input: Parameters<AgentMemoryStore["upsertAgentMemory"]>[0]): Promise<AgentMemory> {
    const titleKey = agentMemoryTitleKeyColumn(input.entry.scope, input.titleKey);
    return this.withTransaction(async (client) => {
    if (input.maxEntries !== undefined) {
      // Serialize writers of THIS scope for the rest of the transaction, so the count
      // below and the insert cannot interleave with another writer (no overshoot).
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `agent_memories:${input.accountId}:${input.entry.scope}:${titleKey}`,
      ]);
      const exists = await client.query(
        "SELECT 1 FROM agent_memories WHERE account_id = $1 AND scope = $2 AND title_key = $3 AND name = $4",
        [input.accountId, input.entry.scope, titleKey, input.entry.name],
      );
      if (exists.rowCount === 0) {
        const count = await client.query<{ n: string }>(
          "SELECT count(*) AS n FROM agent_memories WHERE account_id = $1 AND scope = $2 AND title_key = $3",
          [input.accountId, input.entry.scope, titleKey],
        );
        const n = Number(count.rows[0]?.n ?? 0);
        if (n >= input.maxEntries) throw memoryFullError(input.entry.scope, n, input.maxEntries);
      }
    }
    const result = await client.query<AgentMemoryRow>(
      "INSERT INTO agent_memories (id, account_id, scope, title_key, name, description, kind, body, provider, created_at, updated_at, last_used_at, source_run_id) " +
        "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, NULL, $11) " +
        "ON CONFLICT (account_id, scope, title_key, name) DO UPDATE SET description = EXCLUDED.description, kind = EXCLUDED.kind, " +
        "body = EXCLUDED.body, provider = EXCLUDED.provider, updated_at = EXCLUDED.updated_at, " +
        "source_run_id = COALESCE(EXCLUDED.source_run_id, agent_memories.source_run_id) " +
        // The drive guard is part of the conflict update itself: it holds even when two
        // first writes race (no row to lock yet) — the loser hits the conflict and the
        // WHERE, and gets no row back.
        "WHERE $12::text IS NULL OR agent_memories.provider IS NULL OR agent_memories.provider = $12::text " +
        "OR agent_memories.provider = $13::text RETURNING *",
      [
        `mem_${globalThis.crypto.randomUUID()}`,
        input.accountId,
        input.entry.scope,
        titleKey,
        input.entry.name,
        input.entry.description,
        input.entry.kind,
        input.entry.body,
        input.entry.provider ?? null,
        input.now,
        input.sourceRunId ?? null,
        input.onlyDrive ?? null,
        input.legacyDrive ?? null,
      ],
    );
    if (result.rows.length === 0) {
      const stored = await client.query<{ provider: string | null }>(
        "SELECT provider FROM agent_memories WHERE account_id = $1 AND scope = $2 AND title_key = $3 AND name = $4",
        [input.accountId, input.entry.scope, titleKey, input.entry.name],
      );
      throw memoryOtherDriveError(input.entry.scope, input.entry.name, stored.rows[0]?.provider ?? "another drive", input.onlyDrive ?? "");
    }
    return agentMemoryFromRow(result.rows[0]!);
    });
  }

  async deleteAgentMemory(input: Parameters<AgentMemoryStore["deleteAgentMemory"]>[0]): Promise<boolean> {
    await this.ensureSchema();
    const titleKey = agentMemoryTitleKeyColumn(input.scope, input.titleKey);
    // One conditional statement: a note of another drive is never matched, whatever
    // was inserted or re-tagged concurrently.
    const result = await this.pool.query(
      "DELETE FROM agent_memories WHERE account_id = $1 AND scope = $2 AND title_key = $3 AND name = $4 " +
        "AND ($5::text IS NULL OR provider IS NULL OR provider = $5::text OR provider = $6::text)",
      [input.accountId, input.scope, titleKey, input.name, input.onlyDrive ?? null, input.legacyDrive ?? null],
    );
    if ((result.rowCount ?? 0) > 0) return true;
    if (!input.onlyDrive) return false;
    // Nothing deleted: tell "absent" apart from "another drive's note".
    const stored = await this.pool.query<{ provider: string | null }>(
      "SELECT provider FROM agent_memories WHERE account_id = $1 AND scope = $2 AND title_key = $3 AND name = $4",
      [input.accountId, input.scope, titleKey, input.name],
    );
    const provider = stored.rows[0]?.provider;
    if (provider && !memoryDriveAllows(provider, input.onlyDrive, input.legacyDrive)) throw memoryOtherDriveError(input.scope, input.name, provider, input.onlyDrive);
    return false;
  }

  async getMediaTitleName(titleKey: string): Promise<string | null> {
    await this.ensureSchema();
    const result = await this.pool.query<{ title: string | null }>("SELECT payload->>'title' AS title FROM media_titles WHERE id = $1", [titleKey]);
    return result.rows[0]?.title ?? null;
  }

  async summarizeAgentMemories(input: { accountId: string; since: string }): Promise<AgentMemorySummary> {
    await this.ensureSchema();
    const counts = await this.pool.query<{ title_entries: string; title_works: string; global_entries: string; created_since: string }>(
      "SELECT " +
        "COUNT(*) FILTER (WHERE scope = 'title') AS title_entries, " +
        "COUNT(DISTINCT title_key) FILTER (WHERE scope = 'title') AS title_works, " +
        "COUNT(*) FILTER (WHERE scope = 'global') AS global_entries, " +
        "COUNT(*) FILTER (WHERE created_at >= $2) AS created_since " +
        "FROM agent_memories WHERE account_id = $1",
      [input.accountId, input.since],
    );
    const latest = await this.pool.query<{ scope: AgentMemoryScope; title_key: string; updated_at: string }>(
      "SELECT scope, title_key, updated_at FROM agent_memories WHERE account_id = $1 ORDER BY updated_at DESC LIMIT 1",
      [input.accountId],
    );
    const c = counts.rows[0]!;
    const l = latest.rows[0];
    return {
      titleEntries: Number(c.title_entries),
      titleWorks: Number(c.title_works),
      globalEntries: Number(c.global_entries),
      createdSince: Number(c.created_since),
      latest: l ? { scope: l.scope, titleKey: l.title_key || null, updatedAt: l.updated_at } : null,
    };
  }

  async touchAgentMemories(input: Parameters<AgentMemoryStore["touchAgentMemories"]>[0]): Promise<void> {
    await this.ensureSchema();
    if (input.ids.length === 0) return;
    await this.pool.query("UPDATE agent_memories SET last_used_at = $1 WHERE account_id = $2 AND id = ANY($3::text[])", [
      input.now,
      input.accountId,
      input.ids,
    ]);
  }

  // ---- user requests (see user-requests.ts)
  async createUserMessage(input: Parameters<UserRequestStore["createUserMessage"]>[0]): Promise<UserMessage> {
    return this.withTransaction(async (client) => {
      // The EXISTS sees only the statement snapshot, so on its own a claim committing
      // concurrently could leave this message non-urgent (harmless: it would wait for
      // the patrol). The work lock, shared with claimUserMessages, makes urgent exact.
      await lockUserMessageWork(client, input);
      const result = await client.query<UserMessageRow>(
        "INSERT INTO user_messages (id, account_id, drive, title_key, body, episode_tags, status, urgent, run_id, reply, created_at, updated_at, processed_at) " +
          "VALUES ($1, $2, $3, $4, $5, $6, 'pending', EXISTS (SELECT 1 FROM user_messages WHERE account_id = $2 AND drive = $3 AND title_key = $4 AND status = 'processing'), NULL, NULL, $7, $7, NULL) RETURNING *",
        [`msg_${globalThis.crypto.randomUUID()}`, input.accountId, input.drive, input.titleKey, input.body, JSON.stringify(input.episodeTags), input.now],
      );
      return userMessageFromRow(result.rows[0]!);
    });
  }

  async listUserMessages(scope: UserMessageScope): Promise<UserMessage[]> {
    await this.ensureSchema();
    const result = await this.pool.query<UserMessageRow>(
      "SELECT * FROM user_messages WHERE account_id = $1 AND drive = $2 AND title_key = $3 AND status <> 'withdrawn' ORDER BY created_at DESC, id DESC",
      [scope.accountId, scope.drive, scope.titleKey],
    );
    return result.rows.map(userMessageFromRow);
  }

  async editUserMessage(input: Parameters<UserRequestStore["editUserMessage"]>[0]): Promise<UserMessage | null> {
    await this.ensureSchema();
    const result = await this.pool.query<UserMessageRow>(
      "UPDATE user_messages SET body = $1, episode_tags = $2, updated_at = $3 WHERE id = $4 AND account_id = $5 AND status = 'pending' RETURNING *",
      [input.body, JSON.stringify(input.episodeTags), input.now, input.id, input.accountId],
    );
    return result.rows[0] ? userMessageFromRow(result.rows[0]) : null;
  }

  async withdrawUserMessage(input: Parameters<UserRequestStore["withdrawUserMessage"]>[0]): Promise<boolean> {
    await this.ensureSchema();
    const result = await this.pool.query(
      "UPDATE user_messages SET status = 'withdrawn', updated_at = $1 WHERE id = $2 AND account_id = $3 AND status = 'pending'",
      [input.now, input.id, input.accountId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async markUserMessagesUrgent(input: Parameters<UserRequestStore["markUserMessagesUrgent"]>[0]): Promise<number> {
    await this.ensureSchema();
    const result = await this.pool.query(
      "UPDATE user_messages SET urgent = true, updated_at = $1 WHERE account_id = $2 AND drive = $3 AND title_key = $4 AND status = 'pending'",
      [input.now, input.accountId, input.drive, input.titleKey],
    );
    return result.rowCount ?? 0;
  }

  async clearUserMessagesUrgent(input: Parameters<UserRequestStore["clearUserMessagesUrgent"]>[0]): Promise<number> {
    await this.ensureSchema();
    return clearUserMessagesUrgentWith(this.pool, input, input.now);
  }

  async claimUserMessages(input: Parameters<UserRequestStore["claimUserMessages"]>[0]): Promise<UserMessage[]> {
    return this.withTransaction(async (client) => {
      // Same lock as createUserMessage, so a create overlapping this claim sees it.
      await lockUserMessageWork(client, input);
      // One UPDATE … RETURNING: a concurrent edit/withdraw either lands before (and is
      // claimed as edited) or finds status <> 'pending' and does nothing.
      const result = await client.query<UserMessageRow>(
        // Idempotent per run: a run requeued after a crash re-claims its own messages.
        "UPDATE user_messages SET status = 'processing', run_id = $1, updated_at = $2 WHERE account_id = $3 AND drive = $4 AND title_key = $5 AND (status = 'pending' OR (status = 'processing' AND run_id = $1)) RETURNING *",
        [input.runId, input.now, input.accountId, input.drive, input.titleKey],
      );
      return result.rows.map(userMessageFromRow).sort(compareUserMessagesCreated);
    });
  }

  async finishUserMessages(input: Parameters<UserRequestStore["finishUserMessages"]>[0]): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      "UPDATE user_messages SET status = 'done', reply = $1, processed_at = $2, updated_at = $2 WHERE run_id = $3 AND status = 'processing'",
      [JSON.stringify(input.reply), input.now, input.runId],
    );
  }

  async releaseUserMessages(input: Parameters<UserRequestStore["releaseUserMessages"]>[0]): Promise<void> {
    await this.ensureSchema();
    await releaseUserMessagesWith(this.pool, input.runId, input.now, input.urgent ?? true);
  }

  async releaseOrphanedUserMessages(input: { now: string; finishedBefore: string }): Promise<number> {
    await this.ensureSchema();
    // A processing message whose run is gone, or finished before the cutoff: back to
    // pending for the patrol (not urgent), like every other way a run ends unfinished.
    const result = await this.pool.query(
      "UPDATE user_messages SET status = 'pending', urgent = false, run_id = NULL, updated_at = $1 WHERE status = 'processing' AND NOT EXISTS (" +
        "SELECT 1 FROM workflow_runs r WHERE r.id = user_messages.run_id AND (r.payload->>'status' IN ('queued', 'running') " +
        "OR r.payload->>'finishedAt' >= $2))",
      [input.now, input.finishedBefore],
    );
    return result.rowCount ?? 0;
  }

  async listWorksWithProcessingMessages(): Promise<UserMessageScope[]> {
    await this.ensureSchema();
    const result = await this.pool.query<{ account_id: string; drive: string; title_key: string }>(
      "SELECT DISTINCT account_id, drive, title_key FROM user_messages WHERE status = 'processing' ORDER BY account_id, drive, title_key",
    );
    return result.rows.map((r) => ({ accountId: r.account_id, drive: r.drive, titleKey: r.title_key }));
  }

  async listWorksWithPendingMessages(input: { urgentOnly: boolean }): Promise<UserMessageScope[]> {
    await this.ensureSchema();
    const result = await this.pool.query<{ account_id: string; drive: string; title_key: string }>(
      `SELECT DISTINCT account_id, drive, title_key FROM user_messages WHERE status = 'pending'${input.urgentOnly ? " AND urgent" : ""} ORDER BY account_id, drive, title_key`,
    );
    return result.rows.map((r) => ({ accountId: r.account_id, drive: r.drive, titleKey: r.title_key }));
  }

  async listPendingReplacements(scope: UserMessageScope): Promise<PendingReplacement[]> {
    await this.ensureSchema();
    const result = await this.pool.query<PendingReplacementRow>(
      "SELECT * FROM pending_replacements WHERE account_id = $1 AND drive = $2 AND title_key = $3 ORDER BY episode",
      [scope.accountId, scope.drive, scope.titleKey],
    );
    return result.rows.map(pendingReplacementFromRow);
  }

  async listWorksWithPendingReplacements(): Promise<UserMessageScope[]> {
    await this.ensureSchema();
    const result = await this.pool.query<{ account_id: string; drive: string; title_key: string }>(
      "SELECT DISTINCT account_id, drive, title_key FROM pending_replacements ORDER BY account_id, drive, title_key",
    );
    return result.rows.map((r) => ({ accountId: r.account_id, drive: r.drive, titleKey: r.title_key }));
  }

  async addPendingReplacements(input: Parameters<UserRequestStore["addPendingReplacements"]>[0]): Promise<void> {
    await this.ensureSchema();
    if (input.episodes.length === 0) return;
    await this.pool.query(
      "INSERT INTO pending_replacements (account_id, drive, title_key, episode, message_id, requested_at) " +
        "SELECT $1, $2, $3, e, $5, $6 FROM unnest($4::text[]) AS e ON CONFLICT DO NOTHING",
      [input.accountId, input.drive, input.titleKey, input.episodes, input.messageId, input.now],
    );
  }

  async removePendingReplacements(input: Parameters<UserRequestStore["removePendingReplacements"]>[0]): Promise<number> {
    await this.ensureSchema();
    const result = await this.pool.query(
      "DELETE FROM pending_replacements WHERE account_id = $1 AND drive = $2 AND title_key = $3 AND episode = ANY($4::text[])",
      [input.accountId, input.drive, input.titleKey, input.episodes],
    );
    return result.rowCount ?? 0;
  }

  async addRejectedResources(input: Parameters<UserRequestStore["addRejectedResources"]>[0]): Promise<void> {
    await this.ensureSchema();
    await this.withTransaction(async (client) => {
      for (const i of input.items) {
        await client.query(
          "INSERT INTO rejected_resources (id, account_id, title_key, episode, link_key, label, size_bytes, reason, message_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
          [`rej_${globalThis.crypto.randomUUID()}`, input.accountId, input.titleKey, i.episode, i.linkKey, i.label, i.sizeBytes, i.reason, i.messageId, input.now],
        );
      }
    });
  }

  async listRejectedResources(input: { accountId: string; titleKey: string }): Promise<RejectedResource[]> {
    await this.ensureSchema();
    const result = await this.pool.query<RejectedResourceRow>(
      "SELECT * FROM rejected_resources WHERE account_id = $1 AND title_key = $2 ORDER BY created_at, id",
      [input.accountId, input.titleKey],
    );
    return result.rows.map(rejectedResourceFromRow);
  }

  async upsertEpisodeSource(input: EpisodeSource): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      "INSERT INTO episode_sources (account_id, drive, title_key, episode, link_key, label, size_bytes, run_id, recorded_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) " +
        "ON CONFLICT (account_id, drive, title_key, episode) DO UPDATE SET link_key = EXCLUDED.link_key, label = EXCLUDED.label, size_bytes = EXCLUDED.size_bytes, run_id = EXCLUDED.run_id, recorded_at = EXCLUDED.recorded_at",
      [input.accountId, input.drive, input.titleKey, input.episode, input.linkKey, input.label, input.sizeBytes, input.runId, input.recordedAt],
    );
  }

  async listEpisodeSources(scope: UserMessageScope): Promise<EpisodeSource[]> {
    await this.ensureSchema();
    const result = await this.pool.query<EpisodeSourceRow>(
      "SELECT * FROM episode_sources WHERE account_id = $1 AND drive = $2 AND title_key = $3 ORDER BY episode",
      [scope.accountId, scope.drive, scope.titleKey],
    );
    return result.rows.map(episodeSourceFromRow);
  }

  async listLandingSources(input: Parameters<UserRequestStore["listLandingSources"]>[0]): Promise<LandingSource[]> {
    if (input.fileIds.length === 0) return [];
    await this.ensureSchema();
    // An unbound work ("") is stored under the sentinel, never NULL (see storageFromColumn).
    const storage = input.drive === "" ? UNSCOPED_STORAGE : input.drive;
    // jsonb_array_elements* throws on a non-array: the CASE guards read one as [].
    const result = await this.pool.query<{ file_id: string; url: string | null; title: string | null }>(
      "SELECT f.id AS file_id, " +
        "CASE WHEN jsonb_typeof(c->'providerPayload'->'url') = 'string' AND c->'providerPayload'->>'url' <> '' " +
        "THEN c->'providerPayload'->>'url' END AS url, " +
        "c->>'title' AS title " +
        "FROM transfer_attempts t " +
        "JOIN workflow_runs r ON r.id = t.workflow_run_id " +
        "CROSS JOIN LATERAL jsonb_array_elements_text(" +
        "CASE WHEN jsonb_typeof(t.payload->'materializedFileIds') = 'array' THEN t.payload->'materializedFileIds' ELSE '[]'::jsonb END" +
        ") WITH ORDINALITY AS f(id, ord) " +
        "JOIN resource_snapshots s ON s.workflow_run_id = t.workflow_run_id " +
        "CROSS JOIN LATERAL jsonb_array_elements(" +
        "CASE WHEN jsonb_typeof(s.payload->'candidates') = 'array' THEN s.payload->'candidates' ELSE '[]'::jsonb END" +
        ") AS c " +
        "WHERE r.account_id = $1 AND r.connected_storage_id = $2 AND f.id = ANY($3::text[]) " +
        "AND c->>'id' = t.candidate_id " +
        "ORDER BY r.payload->>'startedAt', r.id, t.ordinal, f.ord, s.ordinal",
      [input.accountId, storage, input.fileIds],
    );
    return result.rows.map((r) => ({ fileId: String(r.file_id), url: r.url === null ? null : String(r.url), title: String(r.title ?? "") }));
  }

  async listLinkHistory(input: Parameters<UserRequestStore["listLinkHistory"]>[0]): Promise<LinkHistoryRow[]> {
    await this.ensureSchema();
    // An unbound work ("") is stored under the sentinel, never NULL (see storageFromColumn).
    const storage = input.drive === "" ? UNSCOPED_STORAGE : input.drive;
    // One row per attempt. jsonb_array_elements throws on a non-array, so a bad
    // candidates payload reads as [] (no url) instead of failing the read. fate is
    // parsed in JS, same as the other engines.
    const exclude = input.excludeRunId !== undefined;
    const params: unknown[] = [input.accountId, storage, input.titleKey, input.since];
    if (exclude) params.push(input.excludeRunId);
    const result = await this.pool.query<{ url: string | null; started_at: string | null; materialized_count: number | null; fate: unknown }>(
      "SELECT (" +
        "SELECT CASE WHEN jsonb_typeof(c.elem->'providerPayload'->'url') = 'string' AND c.elem->'providerPayload'->>'url' <> '' " +
        "THEN c.elem->'providerPayload'->>'url' END " +
        "FROM resource_snapshots s " +
        "CROSS JOIN LATERAL jsonb_array_elements(" +
        "CASE WHEN jsonb_typeof(s.payload->'candidates') = 'array' THEN s.payload->'candidates' ELSE '[]'::jsonb END" +
        ") WITH ORDINALITY AS c(elem, ord) " +
        "WHERE s.workflow_run_id = t.workflow_run_id AND c.elem->>'id' = t.candidate_id " +
        "ORDER BY s.ordinal, c.ord LIMIT 1" +
        ") AS url, " +
        "r.payload->>'startedAt' AS started_at, " +
        "CASE WHEN jsonb_typeof(t.payload->'materializedFileIds') = 'array' THEN jsonb_array_length(t.payload->'materializedFileIds') ELSE 0 END AS materialized_count, " +
        "t.payload->'fate' AS fate " +
        "FROM transfer_attempts t " +
        "JOIN workflow_runs r ON r.id = t.workflow_run_id " +
        "JOIN tracked_seasons ts ON ts.id = r.tracked_season_id AND ts.connected_storage_id = r.connected_storage_id " +
        "WHERE r.account_id = $1 AND r.connected_storage_id = $2 AND ts.media_title_id = $3 " +
        "AND r.payload->>'startedAt' >= $4" +
        (exclude ? " AND r.id <> $5" : "") +
        " ORDER BY r.payload->>'startedAt', r.id, t.ordinal",
      params,
    );
    const out: LinkHistoryRow[] = [];
    for (const row of result.rows) {
      const mapped = linkHistoryFromStored({
        url: row.url,
        startedAt: row.started_at,
        materializedCount: row.materialized_count,
        fate: row.fate,
      });
      if (mapped) out.push(mapped);
    }
    return out;
  }

  // ---- private ----

  private async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    await this.ensureSchema();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async loadWorkflowRunSnapshot(
    executor: Queryable,
    workflowRunId: string,
  ): Promise<PersistedWorkflowRunSnapshot | null> {
    await this.ensureSchema();
    const runRow = await executor.query(
      "SELECT payload, account_id, connected_storage_id FROM workflow_runs WHERE id = $1",
      [workflowRunId],
    );
    const workflowRun = (runRow.rows[0]?.payload as WorkflowRun | undefined) ?? null;
    if (!workflowRun) {
      return null;
    }
    const accountId = (runRow.rows[0]?.account_id as string | undefined) ?? DEFAULT_ACCOUNT_ID;
    // Collapse the UNSCOPED_STORAGE sentinel back to null for the domain snapshot — the
    // sentinel is an internal NOT-NULL detail and must never leak into connectedStorageId
    // (matches SQLite + InMemory). The season/episode lookups below re-collapse via
    // `?? UNSCOPED_STORAGE`, so scoping stays correct.
    const rawStorage = (runRow.rows[0]?.connected_storage_id as string | null | undefined) ?? null;
    const connectedStorageId = rawStorage === UNSCOPED_STORAGE ? null : rawStorage;
    // Scope the season to THIS run's drive: tracked_seasons PK is
    // (id, connected_storage_id), so the same season id can exist on multiple drives
    // with different per-drive payloads (storageDirectoryId, totals, status). Loading
    // by id alone could hydrate the wrong drive's season and break cross-drive isolation.
    const season = await this.selectOne<TrackedSeason>(
      executor,
      "SELECT payload FROM tracked_seasons WHERE id = $1 AND connected_storage_id = $2",
      [workflowRun.trackedSeasonId, connectedStorageId ?? UNSCOPED_STORAGE],
    );
    if (!season) {
      throw new Error(`Missing tracked season ${workflowRun.trackedSeasonId} for workflow run ${workflowRun.id}`);
    }
    const title = await this.requireTitle(executor, season);
    return withDerivedEpisodeSummaries({
      accountId,
      connectedStorageId,
      title,
      season,
      workflowRun,
      episodes: await this.selectEpisodeStates(executor, season.id, connectedStorageId ?? UNSCOPED_STORAGE),
      resourceSnapshots: await this.selectMany<ResourceSnapshot>(
        executor,
        "SELECT payload FROM resource_snapshots WHERE workflow_run_id = $1 ORDER BY ordinal",
        [workflowRun.id],
      ),
      decisions: await this.selectMany<AgentDecision>(
        executor,
        "SELECT payload FROM agent_decisions WHERE workflow_run_id = $1 ORDER BY ordinal",
        [workflowRun.id],
      ),
      transferAttempts: await this.selectMany<TransferAttempt>(
        executor,
        "SELECT payload FROM transfer_attempts WHERE workflow_run_id = $1 ORDER BY ordinal",
        [workflowRun.id],
      ),
      notifications: await this.selectMany<NotificationEvent>(
        executor,
        "SELECT payload FROM notifications WHERE workflow_run_id = $1 ORDER BY ordinal",
        [workflowRun.id],
      ),
    });
  }

  private async replaceWorkflowRunSnapshot(
    client: PoolClient,
    snapshot: PersistWorkflowRunSnapshotInput,
    /** runOnly: write the run and its child rows only — the title, season record and
     *  episode states stay as stored (a keepCurrentEpisodes reservation). */
    options: { runOnly?: boolean } = {},
  ): Promise<void> {
    // A re-persist may omit accountId/connectedStorageId (the worker finalize path
    // doesn't re-thread them). upsertWorkflowRun preserves the stored values on
    // conflict, but the season upsert + episode bucket delete/insert key on
    // (id, connected_storage_id) — falling back to the unscoped sentinel would write
    // those into a DIFFERENT bucket than reads resolve, silently dropping the update.
    // Resolve the run's stored scope first (mirrors the InMemory oracle).
    const existing = await client.query<{
      account_id: string | null;
      connected_storage_id: string | null;
    }>("SELECT account_id, connected_storage_id FROM workflow_runs WHERE id = $1", [
      snapshot.workflowRun.id,
    ]);
    const accountId =
      snapshot.accountId ?? existing.rows[0]?.account_id ?? DEFAULT_ACCOUNT_ID;
    const connectedStorageId =
      snapshot.connectedStorageId ?? existing.rows[0]?.connected_storage_id ?? UNSCOPED_STORAGE;
    const writeSeasonState = options.runOnly !== true;
    if (writeSeasonState) {
      await this.upsert(client, "media_titles", "(id, payload)", [snapshot.title.id, json(snapshot.title)], "$1, $2::jsonb");
      await this.upsertTrackedSeason(client, snapshot.season, accountId, connectedStorageId);
    }
    await this.upsertWorkflowRun(client, snapshot.workflowRun, accountId, connectedStorageId);
    await this.deleteWorkflowRunChildren(client, snapshot.workflowRun.id);

    if (writeSeasonState) {
      // Scope to THIS drive's episodes — never wipe another drive's episodes for the same season.
      await client.query(
        "DELETE FROM episode_states WHERE tracked_season_id = $1 AND connected_storage_id = $2",
        [snapshot.season.id, connectedStorageId],
      );
      for (const episode of snapshot.episodes) {
        await client.query(
          "INSERT INTO episode_states (tracked_season_id, connected_storage_id, episode_code, payload) VALUES ($1, $2, $3, $4::jsonb)",
          [snapshot.season.id, connectedStorageId, episode.episodeCode, json(episode)],
        );
      }
    }
    // Snapshot ids are content-addressed and can legitimately recur; keep
    // persistence idempotent on the id instead of crashing on a duplicate.
    for (const [ordinal, resourceSnapshot] of snapshot.resourceSnapshots.entries()) {
      await client.query(
        "INSERT INTO resource_snapshots (id, workflow_run_id, ordinal, payload) VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (id) DO NOTHING",
        [resourceSnapshot.id, snapshot.workflowRun.id, ordinal, json(resourceSnapshot)],
      );
    }
    for (const [ordinal, decision] of snapshot.decisions.entries()) {
      await client.query(
        "INSERT INTO agent_decisions (workflow_run_id, ordinal, snapshot_id, payload) VALUES ($1, $2, $3, $4::jsonb)",
        [snapshot.workflowRun.id, ordinal, decision.snapshotId, json(decision)],
      );
    }
    for (const [ordinal, attempt] of snapshot.transferAttempts.entries()) {
      await client.query(
        "INSERT INTO transfer_attempts (id, workflow_run_id, ordinal, candidate_id, payload) VALUES ($1, $2, $3, $4, $5::jsonb)",
        [attempt.id, snapshot.workflowRun.id, ordinal, attempt.candidateId, json(attempt)],
      );
    }
    for (const [ordinal, notification] of snapshot.notifications.entries()) {
      await client.query(
        "INSERT INTO notifications (id, workflow_run_id, ordinal, payload) VALUES ($1, $2, $3, $4::jsonb)",
        [notification.id, snapshot.workflowRun.id, ordinal, json(notification)],
      );
    }
  }

  private async upsertTrackedSeason(
    client: PoolClient,
    season: TrackedSeason,
    accountId: string = DEFAULT_ACCOUNT_ID,
    connectedStorageId: string | null = null,
  ): Promise<void> {
    // account_id / connected_storage_id are set on first insert and PRESERVED on
    // conflict (ownership + workspace are immutable; re-saves only update payload).
    await client.query(
      "INSERT INTO tracked_seasons (id, media_title_id, account_id, connected_storage_id, payload) VALUES ($1, $2, $3, $4, $5::jsonb) " +
        "ON CONFLICT (id, connected_storage_id) DO UPDATE SET media_title_id = EXCLUDED.media_title_id, payload = EXCLUDED.payload",
      [season.id, season.mediaTitleId, accountId, connectedStorageId, json(season)],
    );
  }

  private async upsertWorkflowRun(
    client: PoolClient,
    workflowRun: WorkflowRun,
    accountId: string = DEFAULT_ACCOUNT_ID,
    connectedStorageId: string | null = null,
  ): Promise<void> {
    // account_id / connected_storage_id set on insert, preserved on conflict — so
    // claim/requeue/progress updates (which don't know the owner) never clobber it.
    await client.query(
      "INSERT INTO workflow_runs (id, tracked_season_id, account_id, connected_storage_id, payload) VALUES ($1, $2, $3, $4, $5::jsonb) " +
        "ON CONFLICT (id) DO UPDATE SET tracked_season_id = EXCLUDED.tracked_season_id, payload = EXCLUDED.payload",
      [workflowRun.id, workflowRun.trackedSeasonId, accountId, connectedStorageId, json(workflowRun)],
    );
  }

  private async upsert(
    client: PoolClient,
    table: string,
    columns: string,
    params: unknown[],
    placeholders: string,
  ): Promise<void> {
    await client.query(
      `INSERT INTO ${table} ${columns} VALUES (${placeholders}) ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload`,
      params,
    );
  }

  private async deleteWorkflowRunChildren(
    client: PoolClient,
    workflowRunId: string,
  ): Promise<void> {
    await client.query("DELETE FROM notifications WHERE workflow_run_id = $1", [workflowRunId]);
    await client.query("DELETE FROM transfer_attempts WHERE workflow_run_id = $1", [workflowRunId]);
    await client.query("DELETE FROM agent_decisions WHERE workflow_run_id = $1", [workflowRunId]);
    // NOTE: do NOT delete agent_steps here. This runs on every saveWorkflowRunSnapshot
    // (re-persist) to clear children the snapshot RE-INSERTS. agent_steps are written
    // incrementally by the trace sink and are NOT in the snapshot, so deleting them here
    // would wipe a completed run's trace at finalize. Cross-attempt clearing is handled
    // by clearAgentSteps (sink start); true teardown is in cancel/untrack.
    await client.query("DELETE FROM resource_snapshots WHERE workflow_run_id = $1", [workflowRunId]);
  }

  private async expireStaleActiveWorkflowRuns(
    client: PoolClient,
    input: ReserveWorkflowRunInput,
  ): Promise<void> {
    if (!input.staleActiveRunStartedBefore) {
      return;
    }
    const snapshot = workflowSnapshotFromReservation(input);
    // Only expire stale runs on the SAME drive being reserved, and clear only that
    // drive's episodes — never touch another drive's runs/episodes for the season.
    const connectedStorageId = snapshot.connectedStorageId ?? UNSCOPED_STORAGE;
    const staleRuns = (await this.selectWorkflowRuns(client, snapshot.season.id, connectedStorageId)).filter(
      (workflowRun) =>
        workflowRun.kind === snapshot.workflowRun.kind &&
        isActiveWorkflowStatus(workflowRun.status) &&
        isStaleActiveWorkflowRun(workflowRun, input.staleActiveRunStartedBefore!),
    );
    for (const staleRun of staleRuns) {
      const expiredRun = expireWorkflowRun(staleRun, input.staleFinishedAt ?? snapshot.workflowRun.startedAt);
      await this.upsertWorkflowRun(client, expiredRun);
      await client.query(
        "DELETE FROM episode_states WHERE tracked_season_id = $1 AND connected_storage_id = $2",
        [snapshot.season.id, connectedStorageId],
      );
    }
  }

  private async requireTitle(executor: Queryable, season: TrackedSeason): Promise<MediaTitle> {
    const title = await this.selectOne<MediaTitle>(
      executor,
      "SELECT payload FROM media_titles WHERE id = $1",
      [season.mediaTitleId],
    );
    if (!title) {
      throw new Error(`Missing media title ${season.mediaTitleId} for tracked season ${season.id}`);
    }
    return title;
  }

  private async selectEpisodeStates(
    executor: Queryable,
    trackedSeasonId: string,
    connectedStorageId: string,
  ): Promise<EpisodeState[]> {
    const episodes = await this.selectMany<EpisodeState>(
      executor,
      "SELECT payload FROM episode_states WHERE tracked_season_id = $1 AND connected_storage_id = $2",
      [trackedSeasonId, connectedStorageId],
    );
    return episodes.sort((a, b) => episodeNumberFromCode(a.episodeCode) - episodeNumberFromCode(b.episodeCode));
  }

  private async selectWorkflowRuns(
    executor: Queryable,
    trackedSeasonId: string,
    connectedStorageId: string | null = null,
  ): Promise<WorkflowRun[]> {
    return this.selectMany<WorkflowRun>(
      executor,
      "SELECT payload FROM workflow_runs WHERE tracked_season_id = $1 " +
        "AND ($2::text IS NULL OR connected_storage_id = $2)",
      [trackedSeasonId, connectedStorageId],
    );
  }

  private async selectWorkflowRunsForTitle(
    executor: Queryable,
    mediaTitleId: string,
    accountId: string,
    connectedStorageId: string | null = null,
  ): Promise<WorkflowRun[]> {
    // media_titles is global (shared cache); ownership lives on tracked_seasons —
    // so the title-level active-run lock must be scoped to the reserving
    // (account, storage): two drives may each track the same title independently.
    return this.selectMany<WorkflowRun>(
      executor,
      "SELECT wr.payload AS payload FROM workflow_runs wr " +
        "JOIN tracked_seasons ts ON wr.tracked_season_id = ts.id " +
        "WHERE ts.media_title_id = $1 AND wr.account_id = $2 " +
        "AND ($3::text IS NULL OR wr.connected_storage_id = $3)",
      [mediaTitleId, accountId, connectedStorageId],
    );
  }

  private async allWorkflowRuns(executor: Queryable): Promise<WorkflowRun[]> {
    return this.selectMany<WorkflowRun>(executor, "SELECT payload FROM workflow_runs", []);
  }

  private async allWorkflowRunsForAccount(executor: Queryable, accountId: string): Promise<WorkflowRun[]> {
    return this.selectMany<WorkflowRun>(
      executor,
      "SELECT payload FROM workflow_runs WHERE account_id = $1",
      [accountId],
    );
  }

  private async selectOne<T>(executor: Queryable, sql: string, params: unknown[]): Promise<T | null> {
    await this.ensureSchema();
    const result = await executor.query(sql, params);
    return (result.rows[0]?.payload as T) ?? null;
  }

  private async selectMany<T>(executor: Queryable, sql: string, params: unknown[]): Promise<T[]> {
    await this.ensureSchema();
    const result = await executor.query(sql, params);
    return result.rows.map((row) => row.payload as T);
  }
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function accountFromRow(row: Record<string, unknown>): Account {
  return {
    id: String(row.id),
    username: String(row.username),
    passwordHash: String(row.password_hash),
    groupId: (row.group_id as string | null | undefined) ?? null,
    isOwner: Boolean(row.is_owner),
    createdAt: String(row.created_at),
  };
}

function connectedStorageFromRow(row: Record<string, unknown>): ConnectedStorage {
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    provider: String(row.provider),
    providerUid: String(row.provider_uid),
    label: (row.label as string | null | undefined) ?? null,
    payload: row.payload,
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

/** processing(runId) → pending (urgent or not), on the pool or inside a transaction. */
async function releaseUserMessagesWith(db: Pick<PoolClient, "query">, runId: string, now: string, urgent: boolean): Promise<void> {
  await db.query(
    "UPDATE user_messages SET status = 'pending', urgent = $3, run_id = NULL, updated_at = $1 WHERE run_id = $2 AND status = 'processing'",
    [now, runId, urgent],
  );
}

/** Transaction-scoped lock on one work's user messages (create vs claim). */
async function lockUserMessageWork(client: PoolClient, scope: UserMessageScope): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    `user_messages:${scope.accountId}:${scope.drive}:${scope.titleKey}`,
  ]);
}

/** Transaction-scoped lock on one title's runs on one drive, taken first by a
 *  title-exclusive (or requireTrackedSeason) reservation and by untrackTitle, so
 *  neither decides on rows the other is changing. A null drive and the unscoped
 *  sentinel are the same rows, so they are the same lock. */
async function lockWorkflowTitle(
  client: PoolClient,
  accountId: string,
  connectedStorageId: string | null | undefined,
  mediaTitleId: string,
): Promise<void> {
  const drive = connectedStorageId === UNSCOPED_STORAGE ? "" : (connectedStorageId ?? "");
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`workflow_title:${accountId}:${drive}:${mediaTitleId}`]);
}

/** This work's pending messages → not urgent (they wait for the patrol), on the pool or
 *  inside a transaction. Returns how many changed. */
async function clearUserMessagesUrgentWith(db: Pick<PoolClient, "query">, work: UserMessageScope, now: string): Promise<number> {
  const result = await db.query(
    "UPDATE user_messages SET urgent = false, updated_at = $1 WHERE account_id = $2 AND drive = $3 AND title_key = $4 AND status = 'pending' AND urgent",
    [now, work.accountId, work.drive, work.titleKey],
  );
  return result.rowCount ?? 0;
}

/** The work (account, drive, title) of a stored run: its own row plus its season's. */
async function workOfRunWith(db: Pick<PoolClient, "query">, runId: string): Promise<UserMessageScope | null> {
  const result = await db.query<{ account_id: string | null; connected_storage_id: string | null; media_title_id: string }>(
    "SELECT r.account_id, r.connected_storage_id, s.media_title_id FROM workflow_runs r " +
      "JOIN tracked_seasons s ON s.id = r.tracked_season_id AND s.connected_storage_id = r.connected_storage_id WHERE r.id = $1",
    [runId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const storage = row.connected_storage_id === UNSCOPED_STORAGE ? null : row.connected_storage_id;
  return { accountId: row.account_id ?? DEFAULT_ACCOUNT_ID, drive: userMessageDrive(storage), titleKey: row.media_title_id };
}
