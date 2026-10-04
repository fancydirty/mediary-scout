import {
  DEFAULT_ACCOUNT_ID,
  isStagingJanitorId,
  isUserVisibleNotificationKind,
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
  type WorkflowStatus,
} from "./domain.js";
import { MAGNET_DEAD_LINK_TTL_MS } from "./acquisition-v2/dead-links.js";
import type { DeadLink, DeadLinkStore } from "./acquisition-v2/dead-links.js";
import {
  memoryDriveAllows,
  memoryFullError,
  memoryOtherDriveError,
  requireMemoryTitleKey,
  type AgentMemory,
  type AgentMemoryStore,
  type AgentMemorySummary,
} from "./agent-memory.js";
import {
  compareUserMessagesCreated,
  type EpisodeSource,
  type LandingSource,
  type LinkHistoryRow,
  type PendingReplacement,
  type RejectedResource,
  type UserMessage,
  type UserMessageScope,
  type UserRequestStore,
  readTransferFate,
  userMessageDrive,
} from "./user-requests.js";
import type {
  Account,
  ConnectedStorage,
  Session,
  UpsertConnectedStorageInput,
} from "./account-credentials.js";
import { normalizeScope, scopeMatches, type ScopeArg, type WorkflowScope } from "./workflow-scope.js";

/**
 * Tree model: the value stored in `connected_storage_id` for the degenerate
 * "no concrete drive" case — a legacy single-drive write that passed null, or an
 * account with zero drives. Real tree-model writes always carry a real drive id
 * (queue resolves the active workspace / primary drive; the worker threads the
 * claimed run's drive), so this sentinel is a contained backstop, NEVER shown in
 * UI. Keeping the column non-null lets `connected_storage_id` join the primary key
 * so the SAME title can be tracked independently on multiple drives.
 */
export const UNSCOPED_STORAGE = "__unscoped__";

/** Which queued runs the worker may claim while others are running. */
export interface QueuedRunDriveFilter {
  /** Skip runs on these drives: they already have a run going. Never hides a run
   *  with no bound drive (that one is excludeUnbound's job). */
  excludeConnectedStorageIds?: readonly string[];
  /** Skip runs with no bound drive: they land on their account's default drive,
   *  which is not known here, so the worker only starts one when nothing else runs. */
  excludeUnbound?: boolean;
}

/** How the worker claims when several queued runs may go side by side. */
export interface QueueClaimOptions extends QueuedRunDriveFilter {
  /** Told the claimed run and its drive right after the claim, before the run starts,
   *  so the worker counts that drive as busy for its next claim. */
  onClaimed?: (claimed: { workflowRunId: string; connectedStorageId: string | null }) => void;
}

/** claimNextQueuedWorkflowRun with the worker's claim options. Every queued runner
 *  claims through this, so the options reach the repository whatever the kind. */
export async function claimNextQueuedRun(
  repository: Pick<WorkflowRepository, "claimNextQueuedWorkflowRun">,
  kind: WorkflowKind,
  now: string,
  claim: QueueClaimOptions | undefined,
): Promise<PersistedWorkflowRunSnapshot | null> {
  const claimed = await repository.claimNextQueuedWorkflowRun({
    kind,
    now,
    ...(claim?.excludeConnectedStorageIds === undefined ? {} : { excludeConnectedStorageIds: claim.excludeConnectedStorageIds }),
    ...(claim?.excludeUnbound === undefined ? {} : { excludeUnbound: claim.excludeUnbound }),
  });
  if (claimed) {
    claim?.onClaimed?.({ workflowRunId: claimed.workflowRun.id, connectedStorageId: claimed.connectedStorageId });
  }
  return claimed;
}

/** Whether `recordRunId` is run `runId` itself or one of its per-season records
 *  (`${runId}_s${n}`, written by the series/replace/recovery runners). A queued run's
 *  notifications ride on either. */
export function isRunOrItsSeasonRecord(recordRunId: string, runId: string): boolean {
  if (recordRunId === runId) return true;
  const prefix = `${runId}_s`;
  return recordRunId.startsWith(prefix) && /^\d+$/.test(recordRunId.slice(prefix.length));
}

/** Whether a queued run on `connectedStorageId` (null or the unscoped sentinel =
 *  no bound drive) passes the worker's drive filter. */
export function passesQueuedRunDriveFilter(connectedStorageId: string | null, filter: QueuedRunDriveFilter): boolean {
  const drive = connectedStorageId === UNSCOPED_STORAGE ? null : connectedStorageId;
  if (drive === null) return filter.excludeUnbound !== true;
  return !(filter.excludeConnectedStorageIds ?? []).includes(drive);
}

/**
 * Composite key for per-(season, drive) episode buckets / lookups. A season's
 * episodes belong to a specific drive; keying only by season id would let one
 * drive's episodes clobber or shadow another's. The NUL separator cannot appear
 * in ids; a null/undefined storage collapses to the sentinel so a key always exists.
 */
export function seasonScopeKey(seasonId: string, connectedStorageId: string | null | undefined): string {
  return `${seasonId}\u0000${connectedStorageId ?? UNSCOPED_STORAGE}`;
}

/** Which active runs of the same title refuse a reservation, or null when the
 *  reservation is not title-exclusive at all (see ReserveWorkflowRunInput).
 *  `blockIfTitleHasActiveRun` ignores `staging_recovery`: a leftover-staging run
 *  must not pin the title against a user action. Callers that must also wait
 *  for one (the janitor) pass it in `blockIfTitleHasActiveKinds`. */
export function titleBlockFilter(
  input: Pick<ReserveWorkflowRunInput, "blockIfTitleHasActiveRun" | "blockIfTitleHasActiveKinds">,
): ((run: Pick<WorkflowRun, "kind">) => boolean) | null {
  if (input.blockIfTitleHasActiveRun === true) return (run) => run.kind !== "staging_recovery";
  const kinds = input.blockIfTitleHasActiveKinds;
  if (kinds && kinds.length > 0) return (run) => kinds.includes(run.kind);
  return null;
}

/** Whether a reservation or a save refuses a (season, drive) that is no longer
 *  tracked: asked for directly, or implied by keepCurrentEpisodes (nothing to keep). */
export function reservationRequiresTrackedSeason(
  input: Pick<ReserveWorkflowRunInput, "requireTrackedSeason" | "keepCurrentEpisodes">,
): boolean {
  return input.requireTrackedSeason === true || input.keepCurrentEpisodes === true;
}

export interface PersistWorkflowRunSnapshotInput {
  /** Owning account. Optional at the call site (single-user = implicit
   *  acct_default); the repository stamps it onto the account_id column. */
  accountId?: string;
  /** Owning connected storage (workspace/drive). Optional at the call site
   *  (single-drive = null until backfill/binding); stamped onto the
   *  connected_storage_id column. The tree model isolates data by (account,
   *  storage). */
  connectedStorageId?: string | null;
  title: MediaTitle;
  season: TrackedSeason;
  workflowRun: WorkflowRun;
  episodes: EpisodeState[];
  resourceSnapshots: ResourceSnapshot[];
  decisions: AgentDecision[];
  transferAttempts: TransferAttempt[];
  notifications: NotificationEvent[];
}

export interface PersistedWorkflowRunSnapshot extends PersistWorkflowRunSnapshotInput {
  /** Resolved owning account (always set — the worker uses it to load per-run
   *  credentials when it claims the run). */
  accountId: string;
  /** Resolved owning connected storage (workspace/drive); null for legacy/
   *  single-drive rows before backfill. The worker resolves the run's 网盘
   *  credentials from this. */
  connectedStorageId: string | null;
  obtainedEpisodes: string[];
  providerAheadEpisodes: string[];
}

export interface TrackedSeasonState {
  /** Resolved owning account of this tracking record. */
  accountId: string;
  /** Resolved owning connected storage (workspace/drive); null for legacy rows.
   *  The cross-(account,storage) patrol resolves per-drive credentials from it. */
  connectedStorageId: string | null;
  title: MediaTitle;
  season: TrackedSeason;
  episodes: EpisodeState[];
}

export interface ReserveWorkflowRunInput extends PersistWorkflowRunSnapshotInput {
  blockIfEpisodeStatesExist?: boolean;
  /**
   * Title-level mutual exclusion: refuse the reservation if any user-visible run
   * for the same media title is already active, regardless of season. A
   * `staging_recovery` does not count, queued or running, so a leftover-staging run
   * cannot pin the title against something the user asked for. That holds for
   * queue-drained user runs because the worker runs one job at a time: the user's
   * run starts after the recovery finishes, and a replace reservation writes no
   * episodes. Patrols are not queue-drained; they keep themselves out via
   * blockIfTitleHasActiveKinds. All seasons
   * of a title share one `Title (Year)/` show directory
   * and staging parent, so two concurrent acquisition runs would race on directory
   * creation, staging, and dedup. User-triggered acquisitions set this so a user
   * clicking "get S1", "get S2", "get S3" in quick succession can never spawn
   * overlapping writers on the same title.
   */
  blockIfTitleHasActiveRun?: boolean;
  /**
   * Narrower title-level exclusion: refuse only if an active run of one of these
   * kinds exists for the same (account, drive, title). The patrol sets
   * ["replace_request", "staging_recovery"]: either works the title's directories,
   * so a patrol beside it would race it, while patrol runs of other seasons must
   * not block each other. Checked under the same lock as blockIfTitleHasActiveRun.
   */
  blockIfTitleHasActiveKinds?: WorkflowKind[];
  /**
   * Refuse — `not_tracked`, nothing written — unless the (season, drive) is still
   * tracked when the reservation decides. For a caller that reserves from states it
   * read earlier (queueReplaceRequest, the patrol): the season may have been untracked
   * in between, and writing the run would track it again. Postgres checks it under the
   * title lock, which untrackTitle takes too; SQLite and InMemory decide synchronously.
   */
  requireTrackedSeason?: boolean;
  /**
   * Write ONLY the new run: the title, the season record and its episode states stay
   * exactly as stored when the reservation decides (the passed copies are not written).
   * For a caller that reserves from states it read earlier (queueReplaceRequest): a run
   * of that season that saved in between (an episode landed) must not be rolled back to
   * the stale copy. Decided in the same atomic section as the other checks. Implies
   * requireTrackedSeason: a season that is not tracked has nothing to keep.
   */
  keepCurrentEpisodes?: boolean;
  staleActiveRunStartedBefore?: string;
  staleFinishedAt?: string;
}

export type WorkflowRunReservationResult =
  | {
      status: "reserved";
      snapshot: PersistedWorkflowRunSnapshot;
    }
  | {
      status: "already_active";
      snapshot: PersistedWorkflowRunSnapshot;
    }
  | {
      status: "already_has_episode_state";
      episodes: EpisodeState[];
    }
  | {
      /** requireTrackedSeason was set and the (season, drive) is no longer tracked. */
      status: "not_tracked";
    };

export interface WorkflowRepository extends DeadLinkStore, AgentMemoryStore, UserRequestStore {
  saveWorkflowRunSnapshot(
    input: PersistWorkflowRunSnapshotInput & {
      /** Write the run only. The season's episode bucket stays as stored.
       *  Implies requireTrackedSeason: an untracked season has nothing to keep. */
      keepCurrentEpisodes?: boolean;
      /** Write nothing at all when this (season, drive) is no longer tracked.
       *  A recovery's late sibling write must not undo the user's untrack. */
      requireTrackedSeason?: boolean;
    },
  ): Promise<void>;
  reserveWorkflowRun(input: ReserveWorkflowRunInput): Promise<WorkflowRunReservationResult>;
  /** (account, storage)-scoped: returns null if the run belongs to a different
   *  account, or to a different storage when the scope pins one. Accepts a bare
   *  accountId (account-only, legacy) or a WorkflowScope. fail-closed. */
  getWorkflowRunSnapshot(
    workflowRunId: string,
    scope?: ScopeArg,
  ): Promise<PersistedWorkflowRunSnapshot | null>;
  /** Cross-account: the single-instance worker drains every account's queue.
   *  The returned snapshot carries `accountId` so the worker can load that
   *  account's credentials. The drive filter (see QueuedRunDriveFilter) lets the
   *  worker run several queued runs side by side without two on one drive. */
  claimNextQueuedWorkflowRun(input: {
    kind: WorkflowKind;
    now: string;
  } & QueuedRunDriveFilter): Promise<PersistedWorkflowRunSnapshot | null>;
  /**
   * Crash recovery on worker start. Each `running` run takes ONE of three exits,
   * checked in this order — an implementer of a new backend must preserve it:
   *  1. Kind with no queue claimer (`isQueueClaimableKind`) — terminal-failed.
   *     Takes precedence over the cap: `queued` counts as active, so parking such
   *     a run there strands it AND blocks that season forever.
   *  2. Under the cap — requeued with orphanRequeueCount++.
   *  3. At/over ORPHAN_REQUEUE_MAX — terminal-failed (poison-run crash-loop guard).
   * Returns how many were REQUEUED only (exit 2) — not the failed-out ones.
   */
  requeueRunningWorkflowRuns(now?: string): Promise<number>;
  /**
   * Drop finished runs (and their child rows) older than `olderThan` ISO time.
   * Keeps queued/running/reserved. Returns how many runs were deleted.
   */
  pruneFinishedWorkflowRuns(olderThan: string): Promise<number>;
  findActiveWorkflowRun(input: {
    trackedSeasonId: string;
    kind: WorkflowKind;
    accountId?: string;
    connectedStorageId?: string | null;
  }): Promise<PersistedWorkflowRunSnapshot | null>;
  /** Every queued/running run for the (account, storage) scope, newest first —
   *  drives the library "获取中" placeholders. Accepts accountId or WorkflowScope. */
  listActiveWorkflowRuns(scope?: ScopeArg): Promise<PersistedWorkflowRunSnapshot[]>;
  /** Queued or running `staging_recovery` for this exact leftover dir, or null.
   *  The janitor uses it so one staging dir is not queued twice. */
  findActiveStagingRecovery(input: {
    accountId: string;
    connectedStorageId: string | null;
    stagingDirectoryId: string;
  }): Promise<PersistedWorkflowRunSnapshot | null>;
  /** Lightweight mid-run update of the live agent progress shown on the activity
   *  page; `percent` is clamped monotonic so retries never rewind the bar. No-op
   *  for an unknown run. */
  updateWorkflowRunProgress(workflowRunId: string, progress: WorkflowRunProgress): Promise<void>;
  /** Append one live agent tool-call step to the run's durable trace. Best-effort,
   *  fire-and-forget at the call site (a trace write must never fail an acquisition). */
  appendAgentStep(workflowRunId: string, step: AgentStep): Promise<void>;
  /** The run's ordered step trace for post-mortem复盘. When a scope is given it is
   *  fail-closed (returns [] if the run isn't visible to that scope); no scope =
   *  raw read (psql-style复盘 / autonomous diagnosis). */
  listAgentSteps(workflowRunId: string, scope?: ScopeArg): Promise<AgentStep[]>;
  /** Drop a run's existing step trace. Called once when a (re)run's trace sink
   *  starts: manual retry / auto-requeue reuse the SAME run id, so the prior
   *  attempt's steps must be cleared before the fresh attempt appends from ordinal 0. */
  clearAgentSteps(workflowRunId: string): Promise<void>;
  /**
   * Cancel a still-QUEUED run (user changed their mind). Deletes the run AND the
   * tracking it created (the run snapshot is the title/season's only source until
   * the worker runs it), so the title vanishes from the library too — like the
   * 获取 click never happened. Refuses (not_cancellable) once the worker has
   * claimed it (running) or it is otherwise non-queued; that race is expected.
   * Pure DB: a queued run has created no 115 directories yet.
   *
   * A replace_request owns no tracking: only the run goes, and every pending message
   * of its work (those it held included) ends up pending and NOT urgent, so the idle
   * scan does not queue it right back — it waits for the patrol.
   */
  cancelQueuedWorkflowRun(
    workflowRunId: string,
    scope?: ScopeArg,
  ): Promise<{ status: "cancelled" | "not_cancellable" }>;
  /** Tree-model 取消追踪:删本盘(scope)下该 (tmdbId, mediaKind) 的追踪记录(级联
   *  runs/子表/episodes/season,条件删全局 title)。`mediaKind` 区分 TMDB 的
   *  movie/tv id 命名空间(同一数字 id 可同时是 movie 和 tv);"tv" 同时覆盖 tv 与
   *  anime(同一 tv 命名空间)。seasonNumber 给定=只删该季。任一目标季有 running run
   *  时拒绝(in_flight);这部作品在本盘有排队中或进行中的 replace_request 时也拒绝
   *  (它记在最低一季上,结束时会给覆盖到的每一季写记录,中途取消的季会被写回来)。
   *  与换源预留互斥(Postgres 共用作品锁;预留带 requireTrackedSeason 复核季仍在追踪):
   *  先预留的让这里 in_flight,先取消的让预留 not_tracked,不会两边都成功。
   *  不碰网盘文件。 */
  untrackTitle(
    tmdbId: number,
    scope: WorkflowScope,
    mediaKind: "movie" | "tv",
    seasonNumber?: number,
  ): Promise<{ status: "untracked" | "not_found" | "in_flight"; removedSeasons: number }>;
  /** Manual retry of a terminally `failed` run: reset it to immediately-claimable
   *  queued (counters cleared) so the worker re-runs it. Refuses (not_retriable)
   *  for any non-failed run. */
  retryFailedWorkflowRun(
    workflowRunId: string,
    scope?: ScopeArg,
  ): Promise<{ status: "retried" | "not_retriable" }>;
  getTrackedSeasonState(trackedSeasonId: string, scope?: ScopeArg): Promise<TrackedSeasonState | null>;
  listTrackedSeasonStates(scope?: ScopeArg): Promise<TrackedSeasonState[]>;
  /** EVERY account's tracked seasons (cross-account), each carrying its own
   *  accountId — drives the daily sweep, which patrols all users' shows and runs
   *  each under its owner's credentials. */
  listAllTrackedSeasonStates(): Promise<TrackedSeasonState[]>;
  listEpisodeStates(trackedSeasonId: string, scope?: ScopeArg): Promise<EpisodeState[]>;
  /** Most-recent-first notification feed for the (account, storage) scope. */
  listNotifications(input?: {
    limit?: number;
    accountId?: string;
    connectedStorageId?: string | null;
    /** ISO cutoff: only notifications with createdAt >= since (e.g. last 7 days). */
    since?: string;
  }): Promise<NotificationEvent[]>;
  /** Cross-account recent notifications, each tagged with its run's owning account
   *  — drives the worker's outbound push, which must deliver each user's events to
   *  THAT user's channels. Newest first. */
  listRecentNotificationsWithAccount(input?: {
    limit?: number;
    /** ISO cutoff applied BEFORE the limit so a flood of newer events cannot
     *  crowd out earlier post-cutoff notifications (push path uses this). */
    since?: string;
  }): Promise<Array<{ accountId: string; connectedStorageId: string | null; notification: NotificationEvent }>>;
  /** Instance-level (global) settings, e.g. the multi-account migration marker. */
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;
  /** Remove an instance-level setting (no-op if missing). */
  deleteSetting(key: string): Promise<void>;
  /** Per-account settings: LLM/TMDB/Prowlarr/PanSou/画质/语言/push, etc. */
  getAccountSetting(accountId: string, key: string): Promise<string | null>;
  setAccountSetting(accountId: string, key: string, value: string): Promise<void>;
  /** One-shot idempotent migration: pin legacy tracked_seasons/workflow_runs rows
   *  whose connected_storage_id is null to their account's earliest (primary)
   *  drive. Accounts with no drive are skipped. Returns how many rows were filled. */
  backfillConnectedStorageId(): Promise<number>;
  /** Connected network drives owned by the account (§7 multi-account). */
  listConnectedStorages(accountId: string): Promise<ConnectedStorage[]>;
  /** True if any account has at least one connected drive (cheap EXISTS). */
  hasAnyConnectedStorage(): Promise<boolean>;
  upsertConnectedStorage(row: UpsertConnectedStorageInput): Promise<void>;
  /** Hard-remove a drive from an account (frees the physical drive + drops its
   *  cookie). fail-closed on accountId. Tracking data (keyed by (account, cs_id),
   *  no FK to connected_storages) is untouched, so re-binding restores it. */
  deleteConnectedStorage(accountId: string, storageId: string): Promise<void>;
  /**
   * Atomically refuse unbind when the drive still has queued/running runs, else
   * delete the connected_storage row. Closes the TOCTOU between listActive and
   * deleteConnectedStorage. Returns the deleted row (for cookie cleanup) or
   * `{ ok:false, reason:"active_runs"|"not_found" }`.
   */
  tryUnbindConnectedStorage(
    accountId: string,
    storageId: string,
  ): Promise<
    | { ok: true; storage: ConnectedStorage }
    | { ok: false; reason: "active_runs" | "not_found" }
  >;
  /** Instance-wide lookup enforcing UNIQUE(provider, provider_uid) ownership. */
  findConnectedStorageByUid(provider: string, providerUid: string): Promise<ConnectedStorage | null>;
  /** Set a drive's status. `frozen` (cookie died → no acquisition/patrol) carries
   *  a reason + timestamp; `active` (re-bound/healthy) clears them. No-op if the
   *  storage id is unknown. */
  setConnectedStorageStatus(
    storageId: string,
    status: "active" | "frozen",
    frozenReason: string | null,
    frozenAt: string | null,
  ): Promise<void>;
  /** Accounts + sessions (§7 P1 auth). createAccount throws on a duplicate
   *  username (UNIQUE), surfaced to the register route as "用户名已存在". */
  createAccount(account: Account): Promise<void>;
  getAccountByUsername(username: string): Promise<Account | null>;
  getAccountById(id: string): Promise<Account | null>;
  listAccounts(): Promise<Account[]>;
  createSession(session: Session): Promise<void>;
  getSession(id: string): Promise<Session | null>;
  deleteSession(id: string): Promise<void>;
  /** §7 bootstrap: claim the seeded acct_default in place (set username+hash);
   *  is_owner stays true. Used when the first user adopts an existing instance. */
  adoptDefaultAccount(input: { username: string; passwordHash: string }): Promise<void>;
  /** Set ONLY the password hash (self change / owner reset / CLI escape hatch). */
  setAccountPassword(accountId: string, passwordHash: string): Promise<void>;
  /** Revoke an account's sessions (after reset/change); optionally keep one. */
  deleteSessionsForAccount(accountId: string, exceptSessionId?: string): Promise<void>;
  // recordDeadLink + listDeadLinkKeys come from DeadLinkStore.
}

/** Thrown by createAccount when the username is already taken. */
export class DuplicateUsernameError extends Error {
  constructor(username: string) {
    super(`Username already exists: ${username}`);
    this.name = "DuplicateUsernameError";
  }
}

export class InMemoryWorkflowRepository implements WorkflowRepository {
  private readonly workflowRuns = new Map<string, PersistWorkflowRunSnapshotInput>();
  private readonly episodesBySeason = new Map<string, EpisodeState[]>();
  private readonly settings = new Map<string, string>();
  private readonly accountSettings = new Map<string, Map<string, string>>();
  private readonly connectedStorages = new Map<string, ConnectedStorage>();
  private readonly accounts = new Map<string, Account>();
  private readonly sessions = new Map<string, Session>();
  private readonly deadLinks = new Map<string, DeadLink>();
  private readonly agentSteps = new Map<string, AgentStep[]>();
  private readonly agentMemories = new Map<string, AgentMemory>();
  private readonly userMessages = new Map<string, UserMessage>();
  private readonly pendingReplacements = new Map<string, PendingReplacement>();
  private readonly rejectedResources: RejectedResource[] = [];
  private readonly episodeSources = new Map<string, EpisodeSource>();

  async getSetting(key: string): Promise<string | null> {
    return this.settings.get(key) ?? null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    this.settings.set(key, value);
  }

  async deleteSetting(key: string): Promise<void> {
    this.settings.delete(key);
  }

  async getAccountSetting(accountId: string, key: string): Promise<string | null> {
    return this.accountSettings.get(accountId)?.get(key) ?? null;
  }

  async setAccountSetting(accountId: string, key: string, value: string): Promise<void> {
    let bucket = this.accountSettings.get(accountId);
    if (!bucket) {
      bucket = new Map<string, string>();
      this.accountSettings.set(accountId, bucket);
    }
    bucket.set(key, value);
  }

  async backfillConnectedStorageId(): Promise<number> {
    // Earliest-created drive per account = its primary (root) workspace.
    const primaryByAccount = new Map<string, string>();
    for (const storage of [...this.connectedStorages.values()].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    )) {
      if (!primaryByAccount.has(storage.accountId)) {
        primaryByAccount.set(storage.accountId, storage.id);
      }
    }
    let filled = 0;
    for (const [id, snapshot] of this.workflowRuns) {
      if (snapshot.connectedStorageId != null) {
        continue;
      }
      const primary = primaryByAccount.get(snapshot.accountId ?? DEFAULT_ACCOUNT_ID);
      if (!primary) {
        continue; // account has no drive — leave the legacy row untouched
      }
      this.workflowRuns.set(id, { ...snapshot, connectedStorageId: primary });
      // Move this season's episode bucket from the null/sentinel key to the
      // primary-drive key so scoped reads still find them after backfill.
      const oldKey = seasonScopeKey(snapshot.season.id, snapshot.connectedStorageId);
      const newKey = seasonScopeKey(snapshot.season.id, primary);
      if (oldKey !== newKey) {
        const bucket = this.episodesBySeason.get(oldKey);
        if (bucket !== undefined) {
          this.episodesBySeason.set(newKey, bucket);
          this.episodesBySeason.delete(oldKey);
        }
      }
      filled += 1;
    }
    return filled;
  }

  async listConnectedStorages(accountId: string): Promise<ConnectedStorage[]> {
    return [...this.connectedStorages.values()]
      .filter((storage) => storage.accountId === accountId)
      .map((storage) => ({ ...storage }));
  }

  async hasAnyConnectedStorage(): Promise<boolean> {
    return this.connectedStorages.size > 0;
  }

  async upsertConnectedStorage(row: UpsertConnectedStorageInput): Promise<void> {
    // Refuse the multi-user unauthenticated sentinel — binds must never land on a ghost account.
    if (row.accountId === "acct_unauthenticated") {
      throw new Error("cannot bind storage to unauthenticated account");
    }
    const key = connectedStorageKey(row.provider, row.providerUid);
    const existing = this.connectedStorages.get(key);
    // Instance-wide UNIQUE(provider, provider_uid) ownership: a different account
    // can NEVER take over (or overwrite) a 网盘 already bound to someone else.
    // The binding path (resolveStorageBinding) rejects first; this is the DB-level
    // backstop so the primitive itself can't be used to steal ownership.
    if (existing && existing.accountId !== row.accountId) {
      return;
    }
    this.connectedStorages.set(key, {
      id: row.id,
      accountId: row.accountId,
      provider: row.provider,
      providerUid: row.providerUid,
      label: row.label ?? null,
      payload: row.payload,
      rootCid: row.rootCid ?? null,
      moviesCid: row.moviesCid ?? null,
      tvCid: row.tvCid ?? null,
      animeCid: row.animeCid ?? null,
      // Mirror Postgres: ON CONFLICT refresh does NOT touch status, so a re-scan
      // (refresh) keeps an existing frozen state until an explicit unfreeze.
      status: existing?.status ?? "active",
      frozenReason: existing?.frozenReason ?? null,
      frozenAt: existing?.frozenAt ?? null,
      createdAt: row.createdAt,
    });
  }

  async deleteConnectedStorage(accountId: string, storageId: string): Promise<void> {
    // The map is keyed by provider+uid, so find the entry by id (fail-closed on
    // account) and drop its key. Tracking data (keyed by (account, cs_id)) is
    // untouched — re-binding the same physical drive restores the same cs_id.
    for (const [key, storage] of this.connectedStorages) {
      if (storage.id === storageId && storage.accountId === accountId) {
        this.connectedStorages.delete(key);
        return;
      }
    }
  }

  async tryUnbindConnectedStorage(
    accountId: string,
    storageId: string,
  ): Promise<
    | { ok: true; storage: ConnectedStorage }
    | { ok: false; reason: "active_runs" | "not_found" }
  > {
    let found: ConnectedStorage | undefined;
    let foundKey: string | undefined;
    for (const [key, storage] of this.connectedStorages) {
      if (storage.id === storageId && storage.accountId === accountId) {
        found = storage;
        foundKey = key;
        break;
      }
    }
    if (!found || foundKey === undefined) {
      return { ok: false, reason: "not_found" };
    }
    const active = await this.listActiveWorkflowRuns({ accountId, connectedStorageId: storageId });
    if (active.length > 0) {
      return { ok: false, reason: "active_runs" };
    }
    this.connectedStorages.delete(foundKey);
    return { ok: true, storage: { ...found } };
  }

  async findConnectedStorageByUid(
    provider: string,
    providerUid: string,
  ): Promise<ConnectedStorage | null> {
    const found = this.connectedStorages.get(connectedStorageKey(provider, providerUid));
    return found ? { ...found } : null;
  }

  async setConnectedStorageStatus(
    storageId: string,
    status: "active" | "frozen",
    frozenReason: string | null,
    frozenAt: string | null,
  ): Promise<void> {
    for (const [key, storage] of this.connectedStorages) {
      if (storage.id === storageId) {
        this.connectedStorages.set(key, { ...storage, status, frozenReason, frozenAt });
        return;
      }
    }
  }

  async createAccount(account: Account): Promise<void> {
    for (const existing of this.accounts.values()) {
      if (existing.username === account.username) {
        throw new DuplicateUsernameError(account.username);
      }
    }
    this.accounts.set(account.id, { ...account });
  }

  async getAccountByUsername(username: string): Promise<Account | null> {
    for (const account of this.accounts.values()) {
      if (account.username === username) {
        return { ...account };
      }
    }
    return null;
  }

  async getAccountById(id: string): Promise<Account | null> {
    const found = this.accounts.get(id);
    return found ? { ...found } : null;
  }

  async listAccounts(): Promise<Account[]> {
    return [...this.accounts.values()].map((account) => ({ ...account }));
  }

  async createSession(session: Session): Promise<void> {
    this.sessions.set(session.id, { ...session });
  }

  async getSession(id: string): Promise<Session | null> {
    const found = this.sessions.get(id);
    return found ? { ...found } : null;
  }

  async deleteSession(id: string): Promise<void> {
    this.sessions.delete(id);
  }

  async adoptDefaultAccount(input: { username: string; passwordHash: string }): Promise<void> {
    const acct = this.accounts.get(DEFAULT_ACCOUNT_ID);
    if (!acct) {
      throw new Error("acct_default missing");
    }
    for (const other of this.accounts.values()) {
      if (other.id !== DEFAULT_ACCOUNT_ID && other.username === input.username) {
        throw new DuplicateUsernameError(input.username);
      }
    }
    this.accounts.set(DEFAULT_ACCOUNT_ID, {
      ...acct,
      username: input.username,
      passwordHash: input.passwordHash,
    });
  }

  async setAccountPassword(accountId: string, passwordHash: string): Promise<void> {
    const acct = this.accounts.get(accountId);
    if (acct) {
      this.accounts.set(accountId, { ...acct, passwordHash });
    }
  }

  async deleteSessionsForAccount(accountId: string, exceptSessionId?: string): Promise<void> {
    for (const [id, session] of this.sessions) {
      if (session.accountId === accountId && id !== exceptSessionId) {
        this.sessions.delete(id);
      }
    }
  }

  async recordDeadLink(input: {
    key: string;
    kind: DeadLink["kind"];
    reason: string;
    permanent: boolean;
    ttlMs?: number;
    now?: string;
  }): Promise<void> {
    // Idempotent: keep the first record (when it was first proven dead).
    if (this.deadLinks.has(input.key)) {
      return;
    }
    const recordedAt = input.now ?? new Date().toISOString();
    this.deadLinks.set(input.key, {
      key: input.key,
      kind: input.kind,
      reason: input.reason,
      permanent: input.permanent,
      recordedAt,
      expiresAt: input.permanent
        ? null
        : new Date(new Date(recordedAt).getTime() + (input.ttlMs ?? MAGNET_DEAD_LINK_TTL_MS)).toISOString(),
    });
  }

  async listDeadLinkKeys(options?: { now?: string }): Promise<string[]> {
    const now = options?.now ?? new Date().toISOString();
    return [...this.deadLinks.values()]
      .filter((link) => link.expiresAt === null || link.expiresAt > now)
      .map((link) => link.key);
  }

  async listAgentMemories(input: Parameters<AgentMemoryStore["listAgentMemories"]>[0]): Promise<AgentMemory[]> {
    const titleKey = input.scope === "title" ? requireMemoryTitleKey(input.titleKey) : null;
    return [...this.agentMemories.values()]
      .filter((m) => m.accountId === input.accountId && m.scope === input.scope && m.titleKey === titleKey)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
      .map((m) => ({ ...m }));
  }

  async upsertAgentMemory(input: Parameters<AgentMemoryStore["upsertAgentMemory"]>[0]): Promise<AgentMemory> {
    const titleKey = input.entry.scope === "title" ? requireMemoryTitleKey(input.titleKey) : null;
    const inScope = [...this.agentMemories.values()].filter(
      (m) => m.accountId === input.accountId && m.scope === input.entry.scope && m.titleKey === titleKey,
    );
    const existing = inScope.find((m) => m.name === input.entry.name);
    // No await between these checks and the set below → atomic for the in-memory store.
    if (input.onlyDrive && existing && !memoryDriveAllows(existing.provider, input.onlyDrive, input.legacyDrive)) {
      throw memoryOtherDriveError(input.entry.scope, input.entry.name, existing.provider!, input.onlyDrive);
    }
    if (!existing && input.maxEntries !== undefined && inScope.length >= input.maxEntries) {
      throw memoryFullError(input.entry.scope, inScope.length, input.maxEntries);
    }
    const row: AgentMemory = {
      id: existing?.id ?? `mem_${globalThis.crypto.randomUUID()}`,
      accountId: input.accountId,
      scope: input.entry.scope,
      titleKey,
      name: input.entry.name,
      description: input.entry.description,
      kind: input.entry.kind,
      body: input.entry.body,
      provider: input.entry.provider ?? null,
      createdAt: existing?.createdAt ?? input.now,
      updatedAt: input.now,
      lastUsedAt: existing?.lastUsedAt ?? null,
      sourceRunId: input.sourceRunId ?? existing?.sourceRunId ?? null,
    };
    this.agentMemories.set(row.id, row);
    return { ...row };
  }

  async deleteAgentMemory(input: Parameters<AgentMemoryStore["deleteAgentMemory"]>[0]): Promise<boolean> {
    const titleKey = input.scope === "title" ? requireMemoryTitleKey(input.titleKey) : null;
    for (const [id, m] of this.agentMemories) {
      if (m.accountId === input.accountId && m.scope === input.scope && m.titleKey === titleKey && m.name === input.name) {
        if (input.onlyDrive && !memoryDriveAllows(m.provider, input.onlyDrive, input.legacyDrive)) {
          throw memoryOtherDriveError(input.scope, input.name, m.provider!, input.onlyDrive);
        }
        this.agentMemories.delete(id);
        return true;
      }
    }
    return false;
  }

  async getMediaTitleName(titleKey: string): Promise<string | null> {
    for (const snapshot of this.workflowRuns.values()) {
      if (snapshot.title.id === titleKey) return snapshot.title.title;
    }
    return null;
  }

  async summarizeAgentMemories(input: { accountId: string; since: string }): Promise<AgentMemorySummary> {
    const rows = [...this.agentMemories.values()].filter((m) => m.accountId === input.accountId);
    const titleRows = rows.filter((m) => m.scope === "title");
    const latest = rows.reduce<AgentMemory | null>((best, m) => (!best || m.updatedAt > best.updatedAt ? m : best), null);
    return {
      titleEntries: titleRows.length,
      titleWorks: new Set(titleRows.map((m) => m.titleKey)).size,
      globalEntries: rows.length - titleRows.length,
      createdSince: rows.filter((m) => m.createdAt >= input.since).length,
      latest: latest ? { scope: latest.scope, titleKey: latest.titleKey, updatedAt: latest.updatedAt } : null,
    };
  }

  async touchAgentMemories(input: Parameters<AgentMemoryStore["touchAgentMemories"]>[0]): Promise<void> {
    for (const id of input.ids) {
      const m = this.agentMemories.get(id);
      if (m && m.accountId === input.accountId) m.lastUsedAt = input.now;
    }
  }

  // ---- user requests (see user-requests.ts). No await between read and write → atomic.
  async createUserMessage(input: Parameters<UserRequestStore["createUserMessage"]>[0]): Promise<UserMessage> {
    const busy = [...this.userMessages.values()].some((m) => sameWork(m, input) && m.status === "processing");
    const row: UserMessage = {
      id: `msg_${globalThis.crypto.randomUUID()}`,
      accountId: input.accountId, drive: input.drive, titleKey: input.titleKey,
      body: input.body, episodeTags: [...input.episodeTags],
      status: "pending", urgent: busy, runId: null, reply: null,
      createdAt: input.now, updatedAt: input.now, processedAt: null,
    };
    this.userMessages.set(row.id, row);
    return structuredClone(row);
  }

  async listUserMessages(scope: UserMessageScope): Promise<UserMessage[]> {
    return [...this.userMessages.values()]
      .filter((m) => sameWork(m, scope) && m.status !== "withdrawn")
      .sort((a, b) => -compareUserMessagesCreated(a, b))
      .map((m) => structuredClone(m));
  }

  async editUserMessage(input: Parameters<UserRequestStore["editUserMessage"]>[0]): Promise<UserMessage | null> {
    const m = this.userMessages.get(input.id);
    if (!m || m.accountId !== input.accountId || m.status !== "pending") return null;
    Object.assign(m, { body: input.body, episodeTags: [...input.episodeTags], updatedAt: input.now });
    return structuredClone(m);
  }

  async withdrawUserMessage(input: Parameters<UserRequestStore["withdrawUserMessage"]>[0]): Promise<boolean> {
    const m = this.userMessages.get(input.id);
    if (!m || m.accountId !== input.accountId || m.status !== "pending") return false;
    Object.assign(m, { status: "withdrawn", updatedAt: input.now });
    return true;
  }

  async markUserMessagesUrgent(input: Parameters<UserRequestStore["markUserMessagesUrgent"]>[0]): Promise<number> {
    let n = 0;
    for (const m of this.userMessages.values()) {
      if (sameWork(m, input) && m.status === "pending") {
        Object.assign(m, { urgent: true, updatedAt: input.now });
        n += 1;
      }
    }
    return n;
  }

  async clearUserMessagesUrgent(input: Parameters<UserRequestStore["clearUserMessagesUrgent"]>[0]): Promise<number> {
    return this.clearUserMessagesUrgentSync(input, input.now);
  }

  /** Sync form: cancel and crash recovery run it with no await in between. */
  private clearUserMessagesUrgentSync(work: UserMessageScope, now: string): number {
    let n = 0;
    for (const m of this.userMessages.values()) {
      if (sameWork(m, work) && m.status === "pending" && m.urgent) {
        Object.assign(m, { urgent: false, updatedAt: now });
        n += 1;
      }
    }
    return n;
  }

  async claimUserMessages(input: Parameters<UserRequestStore["claimUserMessages"]>[0]): Promise<UserMessage[]> {
    const claimed: UserMessage[] = [];
    for (const m of this.userMessages.values()) {
      // Idempotent per run: a run requeued after a crash gets its own messages back.
      if (sameWork(m, input) && (m.status === "pending" || (m.status === "processing" && m.runId === input.runId))) {
        Object.assign(m, { status: "processing", runId: input.runId, updatedAt: input.now });
        claimed.push(structuredClone(m));
      }
    }
    return claimed.sort(compareUserMessagesCreated);
  }

  async finishUserMessages(input: Parameters<UserRequestStore["finishUserMessages"]>[0]): Promise<void> {
    for (const m of this.userMessages.values()) {
      if (m.status === "processing" && m.runId === input.runId) {
        Object.assign(m, { status: "done", reply: structuredClone(input.reply), processedAt: input.now, updatedAt: input.now });
      }
    }
  }

  async releaseUserMessages(input: Parameters<UserRequestStore["releaseUserMessages"]>[0]): Promise<void> {
    for (const m of this.userMessages.values()) {
      if (m.status === "processing" && m.runId === input.runId) {
        Object.assign(m, { status: "pending", urgent: input.urgent ?? true, runId: null, updatedAt: input.now });
      }
    }
  }

  async releaseOrphanedUserMessages(input: { now: string; finishedBefore: string }): Promise<number> {
    let n = 0;
    for (const m of this.userMessages.values()) {
      if (m.status !== "processing") continue;
      const run = m.runId === null ? undefined : this.workflowRuns.get(m.runId);
      if (run && isActiveWorkflowStatus(run.workflowRun.status)) continue;
      const finishedAt = run?.workflowRun.finishedAt;
      if (run && finishedAt && finishedAt >= input.finishedBefore) continue;
      Object.assign(m, { status: "pending", urgent: false, runId: null, updatedAt: input.now });
      n += 1;
    }
    return n;
  }

  async listWorksWithPendingMessages(input: { urgentOnly: boolean }): Promise<UserMessageScope[]> {
    return uniqueWorks(
      [...this.userMessages.values()].filter((m) => m.status === "pending" && (!input.urgentOnly || m.urgent)),
    );
  }

  async listWorksWithProcessingMessages(): Promise<UserMessageScope[]> {
    return uniqueWorks([...this.userMessages.values()].filter((m) => m.status === "processing"));
  }

  async listPendingReplacements(scope: UserMessageScope): Promise<PendingReplacement[]> {
    return [...this.pendingReplacements.values()]
      .filter((p) => sameWork(p, scope))
      .sort((a, b) => a.episode.localeCompare(b.episode))
      .map((p) => ({ ...p }));
  }

  async listWorksWithPendingReplacements(): Promise<UserMessageScope[]> {
    return uniqueWorks([...this.pendingReplacements.values()]);
  }

  async addPendingReplacements(input: Parameters<UserRequestStore["addPendingReplacements"]>[0]): Promise<void> {
    for (const episode of input.episodes) {
      const key = workKey(input, episode);
      if (!this.pendingReplacements.has(key)) {
        this.pendingReplacements.set(key, {
          accountId: input.accountId, drive: input.drive, titleKey: input.titleKey,
          episode, messageId: input.messageId, requestedAt: input.now,
        });
      }
    }
  }

  async removePendingReplacements(input: Parameters<UserRequestStore["removePendingReplacements"]>[0]): Promise<number> {
    let n = 0;
    for (const episode of new Set(input.episodes)) if (this.pendingReplacements.delete(workKey(input, episode))) n += 1;
    return n;
  }

  async addRejectedResources(input: Parameters<UserRequestStore["addRejectedResources"]>[0]): Promise<void> {
    for (const item of input.items) {
      this.rejectedResources.push({
        ...item, id: `rej_${globalThis.crypto.randomUUID()}`,
        accountId: input.accountId, titleKey: input.titleKey, createdAt: input.now,
      });
    }
  }

  async listRejectedResources(input: { accountId: string; titleKey: string }): Promise<RejectedResource[]> {
    return this.rejectedResources
      .filter((r) => r.accountId === input.accountId && r.titleKey === input.titleKey)
      .sort(compareUserMessagesCreated)
      .map((r) => ({ ...r }));
  }

  async upsertEpisodeSource(input: EpisodeSource): Promise<void> {
    this.episodeSources.set(workKey(input, input.episode), { ...input });
  }

  async listEpisodeSources(scope: UserMessageScope): Promise<EpisodeSource[]> {
    return [...this.episodeSources.values()]
      .filter((s) => sameWork(s, scope))
      .sort((a, b) => a.episode.localeCompare(b.episode))
      .map((s) => ({ ...s }));
  }

  async listLandingSources(input: Parameters<UserRequestStore["listLandingSources"]>[0]): Promise<LandingSource[]> {
    if (input.fileIds.length === 0) return [];
    const wanted = new Set(input.fileIds);
    const runs = [...this.workflowRuns.values()]
      .filter((run) => {
        const work = workOfRun(run);
        return work.accountId === input.accountId && work.drive === input.drive;
      })
      .sort((a, b) => a.workflowRun.startedAt.localeCompare(b.workflowRun.startedAt) || a.workflowRun.id.localeCompare(b.workflowRun.id));
    const out: LandingSource[] = [];
    for (const run of runs) {
      // The candidate is looked up in the run's own snapshots, like the SQL join.
      const candidates = run.resourceSnapshots.flatMap((s) => (Array.isArray(s.candidates) ? s.candidates : []));
      for (const attempt of run.transferAttempts) {
        const landed = Array.isArray(attempt.materializedFileIds) ? attempt.materializedFileIds : [];
        for (const fileId of landed.filter((id) => wanted.has(id))) {
          for (const c of candidates) {
            if (c.id !== attempt.candidateId) continue;
            const url = c.providerPayload?.["url"];
            out.push({ fileId, url: typeof url === "string" && url !== "" ? url : null, title: c.title });
          }
        }
      }
    }
    return out;
  }

  async listLinkHistory(input: Parameters<UserRequestStore["listLinkHistory"]>[0]): Promise<LinkHistoryRow[]> {
    const runs = [...this.workflowRuns.values()]
      .filter((run) => {
        const work = workOfRun(run);
        return (
          work.accountId === input.accountId &&
          work.drive === input.drive &&
          work.titleKey === input.titleKey &&
          run.workflowRun.startedAt >= input.since &&
          run.workflowRun.id !== input.excludeRunId
        );
      })
      .sort((a, b) => a.workflowRun.startedAt.localeCompare(b.workflowRun.startedAt) || a.workflowRun.id.localeCompare(b.workflowRun.id));
    const out: LinkHistoryRow[] = [];
    for (const run of runs) {
      for (const attempt of run.transferAttempts) {
        const fate = readTransferFate(attempt.fate);
        out.push({
          url: urlInRunSnapshots(run.resourceSnapshots, attempt.candidateId),
          startedAt: run.workflowRun.startedAt,
          materializedCount: Array.isArray(attempt.materializedFileIds) ? attempt.materializedFileIds.length : 0,
          ...(fate ? { fate } : {}),
        });
      }
    }
    return out;
  }

  async saveWorkflowRunSnapshot(
    input: PersistWorkflowRunSnapshotInput & { keepCurrentEpisodes?: boolean; requireTrackedSeason?: boolean },
  ): Promise<void> {
    const { keepCurrentEpisodes, requireTrackedSeason: _requireTrackedSeason, ...snapshot } = input;
    validateWorkflowRunSnapshot(snapshot);

    const cloned = cloneWorkflowValue(snapshot);
    cloned.accountId = cloned.accountId ?? DEFAULT_ACCOUNT_ID;
    // Mirror Postgres' upsert (connected_storage_id set on insert, PRESERVED on
    // conflict): a re-persist that omits the storage (the worker finalize path
    // doesn't re-thread it) must keep the storage the run was queued onto, not
    // null it out. This is the storage analogue of §7's account-ownership lesson.
    const existing = this.workflowRuns.get(cloned.workflowRun.id);
    cloned.connectedStorageId =
      cloned.connectedStorageId ?? existing?.connectedStorageId ?? null;
    // Synchronous with the write below: no await, so an untrack cannot land between them.
    if (
      reservationRequiresTrackedSeason({
        ...(input.requireTrackedSeason === true ? { requireTrackedSeason: true } : {}),
        ...(keepCurrentEpisodes === true ? { keepCurrentEpisodes: true } : {}),
      }) &&
      !this.isSeasonTracked(cloned.season.id, cloned.connectedStorageId)
    ) {
      return;
    }
    const bucketKey = seasonScopeKey(cloned.season.id, cloned.connectedStorageId);
    if (keepCurrentEpisodes === true) {
      const current = this.episodesBySeason.get(bucketKey);
      if (current) cloned.episodes = cloneWorkflowValue(current);
      this.workflowRuns.set(cloned.workflowRun.id, cloned);
      return;
    }
    this.workflowRuns.set(cloned.workflowRun.id, cloned);
    this.episodesBySeason.set(bucketKey, cloneWorkflowValue(cloned.episodes));
  }

  async reserveWorkflowRun(input: ReserveWorkflowRunInput): Promise<WorkflowRunReservationResult> {
    const snapshot = workflowSnapshotFromReservation(input);
    validateWorkflowRunSnapshot(snapshot);
    // Before anything is written (the stale-run expiry included) and, like the checks
    // below, with no await between it and the write.
    if (reservationRequiresTrackedSeason(input) && !this.isSeasonTracked(snapshot.season.id, snapshot.connectedStorageId)) {
      return { status: "not_tracked" };
    }
    this.expireStaleActiveWorkflowRuns(input);

    const reservingScope = {
      accountId: snapshot.accountId ?? DEFAULT_ACCOUNT_ID,
      connectedStorageId: snapshot.connectedStorageId ?? null,
    };
    // The drive this run belongs to. Stored as-is (InMemory has no NOT-NULL
    // constraint, so legacy/null stays null for backfill to pin later); the
    // episode bucket key collapses null→sentinel via seasonScopeKey.
    const storageValue = snapshot.connectedStorageId ?? null;
    const blocksTitle = titleBlockFilter(input);
    if (blocksTitle) {
      const titleActive = Array.from(this.workflowRuns.values())
        .filter(
          (stored) =>
            // Title-level mutual exclusion is per (account, storage): two
            // different drives may each track the same title independently.
            scopeMatches(reservingScope, stored.accountId, stored.connectedStorageId) &&
            stored.season.mediaTitleId === snapshot.season.mediaTitleId &&
            isActiveWorkflowStatus(stored.workflowRun.status) &&
            blocksTitle(stored.workflowRun),
        )
        .sort((a, b) => b.workflowRun.startedAt.localeCompare(a.workflowRun.startedAt))[0];
      if (titleActive) {
        return {
          status: "already_active",
          snapshot: withDerivedEpisodeSummaries(cloneWorkflowValue(titleActive)),
        };
      }
    }

    // Synchronous on purpose: an await between the title check above and the set
    // below would let two concurrent reservations both pass the check.
    const activeRun = this.findActiveWorkflowRunSync({
      trackedSeasonId: snapshot.season.id,
      kind: snapshot.workflowRun.kind,
      accountId: reservingScope.accountId,
      connectedStorageId: reservingScope.connectedStorageId,
    });
    if (activeRun) {
      return {
        status: "already_active",
        snapshot: activeRun,
      };
    }

    // Scoped to THIS drive's bucket: a movie obtained on another drive must NOT
    // block reserving it here (the cross-drive already_tracked bug).
    const existingEpisodes = this.episodesBySeason.get(seasonScopeKey(snapshot.season.id, storageValue)) ?? [];
    if (input.blockIfEpisodeStatesExist === true && existingEpisodes.length > 0) {
      return {
        status: "already_has_episode_state",
        episodes: cloneWorkflowValue(existingEpisodes),
      };
    }

    const cloned = cloneWorkflowValue(snapshot);
    cloned.accountId = cloned.accountId ?? DEFAULT_ACCOUNT_ID;
    cloned.connectedStorageId = storageValue;
    const bucketKey = seasonScopeKey(cloned.season.id, storageValue);
    if (input.keepCurrentEpisodes === true) {
      // Tracking here is the latest run record of the (season, drive) plus its episode
      // bucket: this run's record carries the CURRENT title, season and episodes (not the
      // copies it was handed) and the bucket is left alone, so the season reads exactly
      // as before. The tracked check above guarantees a record exists.
      const current = this.latestSeasonRecordSync(cloned.season.id, storageValue)!;
      cloned.title = cloneWorkflowValue(current.title);
      cloned.season = cloneWorkflowValue(current.season);
      cloned.episodes = cloneWorkflowValue(this.episodesBySeason.get(bucketKey) ?? current.episodes);
      this.workflowRuns.set(cloned.workflowRun.id, cloned);
    } else {
      this.workflowRuns.set(cloned.workflowRun.id, cloned);
      this.episodesBySeason.set(bucketKey, cloneWorkflowValue(cloned.episodes));
    }

    return {
      status: "reserved",
      snapshot: withDerivedEpisodeSummaries(cloneWorkflowValue(cloned)),
    };
  }

  async getWorkflowRunSnapshot(
    workflowRunId: string,
    scopeArg: ScopeArg = undefined,
  ): Promise<PersistedWorkflowRunSnapshot | null> {
    const scope = normalizeScope(scopeArg);
    const stored = this.workflowRuns.get(workflowRunId);
    if (!stored || !scopeMatches(scope, stored.accountId, stored.connectedStorageId)) {
      return null;
    }

    return withDerivedEpisodeSummaries(cloneWorkflowValue(stored));
  }

  async claimNextQueuedWorkflowRun(input: {
    kind: WorkflowKind;
    now: string;
  } & QueuedRunDriveFilter): Promise<PersistedWorkflowRunSnapshot | null> {
    const queuedRun = Array.from(this.workflowRuns.values())
      .filter(
        (snapshot) =>
          snapshot.workflowRun.kind === input.kind &&
          snapshot.workflowRun.status === "queued" &&
          passesQueuedRunDriveFilter(snapshot.connectedStorageId ?? null, input),
      )
      .sort((a, b) => a.workflowRun.startedAt.localeCompare(b.workflowRun.startedAt))[0];
    if (!queuedRun) {
      return null;
    }

    const claimed = cloneWorkflowValue({
      ...queuedRun,
      workflowRun: claimWorkflowRun(queuedRun.workflowRun, input.now),
    });
    this.workflowRuns.set(claimed.workflowRun.id, claimed);

    return withDerivedEpisodeSummaries(cloneWorkflowValue(claimed));
  }

  async requeueRunningWorkflowRuns(now: string = new Date().toISOString()): Promise<number> {
    let requeued = 0;
    for (const [id, snapshot] of this.workflowRuns) {
      if (snapshot.workflowRun.status !== "running") {
        continue;
      }
      const recovered = recoverOrphanRunningRun(snapshot.workflowRun, now);
      this.workflowRuns.set(id, {
        ...snapshot,
        workflowRun: recovered.run,
      });
      if (recovered.action === "requeue") requeued += 1;
      // A replace run that will never run again hands its work back to the patrol: its
      // messages go back to pending, and none of the work's messages stays urgent (a run
      // that crashed the worker over and over must not be retried on every idle tick).
      else if (recovered.run.kind === "replace_request") {
        await this.releaseUserMessages({ runId: id, now, urgent: false });
        this.clearUserMessagesUrgentSync(workOfRun(snapshot), now);
      }
    }
    return requeued;
  }

  async pruneFinishedWorkflowRuns(olderThan: string): Promise<number> {
    let pruned = 0;
    for (const [id, snapshot] of this.workflowRuns) {
      if (!isPrunableFinishedRun(snapshot.workflowRun, olderThan)) continue;
      this.workflowRuns.delete(id);
      this.agentSteps.delete(id);
      pruned += 1;
    }
    return pruned;
  }

  async findActiveWorkflowRun(input: {
    trackedSeasonId: string;
    kind: WorkflowKind;
    accountId?: string;
    connectedStorageId?: string | null;
  }): Promise<PersistedWorkflowRunSnapshot | null> {
    return this.findActiveWorkflowRunSync(input);
  }

  private findActiveWorkflowRunSync(input: {
    trackedSeasonId: string;
    kind: WorkflowKind;
    accountId?: string;
    connectedStorageId?: string | null;
  }): PersistedWorkflowRunSnapshot | null {
    const scope = normalizeScope(
      input.accountId === undefined
        ? undefined
        : { accountId: input.accountId, connectedStorageId: input.connectedStorageId ?? null },
    );
    const activeRuns = Array.from(this.workflowRuns.values())
      .filter(
        (snapshot) =>
          scopeMatches(scope, snapshot.accountId, snapshot.connectedStorageId) &&
          snapshot.workflowRun.trackedSeasonId === input.trackedSeasonId &&
          snapshot.workflowRun.kind === input.kind &&
          isActiveWorkflowStatus(snapshot.workflowRun.status),
      )
      .sort((a, b) => b.workflowRun.startedAt.localeCompare(a.workflowRun.startedAt));
    const latest = activeRuns[0];
    return latest ? withDerivedEpisodeSummaries(cloneWorkflowValue(latest)) : null;
  }

  /** Whether the (season, drive) is tracked. InMemory derives tracking from the run
   *  records themselves, which untrackTitle deletes. */
  private isSeasonTracked(seasonId: string, connectedStorageId: string | null | undefined): boolean {
    const key = seasonScopeKey(seasonId, connectedStorageId);
    return Array.from(this.workflowRuns.values()).some(
      (stored) => seasonScopeKey(stored.season.id, stored.connectedStorageId) === key,
    );
  }

  /** The run record the (season, drive)'s tracking is read from — the latest one, as in
   *  listTrackedSeasonStates — or undefined when it is not tracked. */
  private latestSeasonRecordSync(
    seasonId: string,
    connectedStorageId: string | null | undefined,
  ): PersistWorkflowRunSnapshotInput | undefined {
    const key = seasonScopeKey(seasonId, connectedStorageId);
    return Array.from(this.workflowRuns.values())
      .filter((stored) => seasonScopeKey(stored.season.id, stored.connectedStorageId) === key)
      .sort((a, b) => b.workflowRun.startedAt.localeCompare(a.workflowRun.startedAt))[0];
  }

  async listActiveWorkflowRuns(
    scopeArg: ScopeArg = undefined,
  ): Promise<PersistedWorkflowRunSnapshot[]> {
    const scope = normalizeScope(scopeArg);
    return Array.from(this.workflowRuns.values())
      .filter(
        (snapshot) =>
          scopeMatches(scope, snapshot.accountId, snapshot.connectedStorageId) &&
          isActiveWorkflowStatus(snapshot.workflowRun.status),
      )
      .sort((a, b) => b.workflowRun.startedAt.localeCompare(a.workflowRun.startedAt))
      .map((snapshot) => withDerivedEpisodeSummaries(cloneWorkflowValue(snapshot)));
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
    const stored = this.workflowRuns.get(workflowRunId);
    if (!stored) {
      return;
    }
    const previousPercent = stored.workflowRun.progress?.percent ?? 0;
    this.workflowRuns.set(workflowRunId, {
      ...stored,
      workflowRun: {
        ...stored.workflowRun,
        progress: { ...progress, percent: Math.max(previousPercent, progress.percent) },
      },
    });
  }

  async appendAgentStep(workflowRunId: string, step: AgentStep): Promise<void> {
    const list = this.agentSteps.get(workflowRunId) ?? [];
    list.push(cloneWorkflowValue(step));
    this.agentSteps.set(workflowRunId, list);
  }

  async listAgentSteps(workflowRunId: string, scopeArg: ScopeArg = undefined): Promise<AgentStep[]> {
    if (scopeArg !== undefined) {
      const snapshot = await this.getWorkflowRunSnapshot(workflowRunId, scopeArg);
      if (!snapshot) {
        return [];
      }
    }
    return cloneWorkflowValue(this.agentSteps.get(workflowRunId) ?? []).sort((a, b) => a.ordinal - b.ordinal);
  }

  async clearAgentSteps(workflowRunId: string): Promise<void> {
    this.agentSteps.delete(workflowRunId);
  }

  async cancelQueuedWorkflowRun(
    workflowRunId: string,
    scopeArg: ScopeArg = undefined,
  ): Promise<{ status: "cancelled" | "not_cancellable" }> {
    const scope = normalizeScope(scopeArg);
    const stored = this.workflowRuns.get(workflowRunId);
    if (
      !stored ||
      !scopeMatches(scope, stored.accountId, stored.connectedStorageId) ||
      stored.workflowRun.status !== "queued"
    ) {
      return { status: "not_cancellable" };
    }
    const seasonId = stored.season.id;
    const storageValue = stored.connectedStorageId ?? UNSCOPED_STORAGE;
    this.workflowRuns.delete(workflowRunId);
    this.agentSteps.delete(workflowRunId);
    // Only an init run owns its season's tracking. Anything else (a replace_request
    // on a library that already has files) is just removed — plus, for a replace
    // run, any messages it held go back to pending.
    if (!tearsDownTrackingOnCancel(stored.workflowRun.kind)) {
      if (stored.workflowRun.kind === "replace_request") {
        // The user cancelled: nothing of this work stays urgent, or the idle scan would
        // queue it again within seconds. It waits for the patrol (or 现在处理).
        const now = new Date().toISOString();
        await this.releaseUserMessages({ runId: workflowRunId, now, urgent: false });
        this.clearUserMessagesUrgentSync(workOfRun(stored), now);
      }
      return { status: "cancelled" };
    }
    // Only drop THIS drive's episode bucket, and only if no run on the same
    // (season, drive) still references it — never touch another drive's episodes.
    const seasonStillReferenced = Array.from(this.workflowRuns.values()).some(
      (snapshot) =>
        snapshot.season.id === seasonId &&
        (snapshot.connectedStorageId ?? UNSCOPED_STORAGE) === storageValue,
    );
    if (!seasonStillReferenced) {
      this.episodesBySeason.delete(seasonScopeKey(seasonId, storageValue));
    }
    return { status: "cancelled" };
  }

  async untrackTitle(
    tmdbId: number,
    scope: WorkflowScope,
    mediaKind: "movie" | "tv",
    seasonNumber?: number,
  ): Promise<{ status: "untracked" | "not_found" | "in_flight"; removedSeasons: number }> {
    // Enumerate this drive's target seasons for the title (latest-by-season dedup).
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
    const targetSeasonIds = new Set(states.map((state) => state.season.id));
    const storageValue = scope.connectedStorageId ?? UNSCOPED_STORAGE;
    const work = { accountId: scope.accountId ?? DEFAULT_ACCOUNT_ID, drive: userMessageDrive(scope.connectedStorageId), titleKey: states[0]!.title.id };

    // In-flight guard: a running run on any target season → refuse, delete nothing.
    // A staging_recovery is hidden and cannot be cancelled from the activity page,
    // so it must not block the untrack. Its later writes no-op if the season is gone.
    const hasRunning = Array.from(this.workflowRuns.values()).some(
      (snapshot) =>
        targetSeasonIds.has(snapshot.season.id) &&
        scopeMatches(scope, snapshot.accountId, snapshot.connectedStorageId) &&
        snapshot.workflowRun.status === "running" &&
        snapshot.workflowRun.kind !== "staging_recovery",
    );
    // …and a queued or running replace_request of the work, whichever season it is recorded
    // on: it covers every season tracked when it starts and writes a record for each when it
    // ends (`${runId}_s<n>` beside the lock season's), so a season untracked in between would
    // be tracked again. Refuse until it has ended (or is cancelled). It stays running until its
    // last write (its terminal record comes after the season records and the request
    // bookkeeping), so once it has ended nothing of it is left to write.
    const replaceActive = Array.from(this.workflowRuns.values()).some(
      (snapshot) =>
        snapshot.workflowRun.kind === "replace_request" &&
        isActiveWorkflowStatus(snapshot.workflowRun.status) &&
        sameWork(workOfRun(snapshot), work),
    );
    if (hasRunning || replaceActive) {
      return { status: "in_flight", removedSeasons: 0 };
    }

    // Delete this drive's runs for these seasons + their episode buckets. InMemory
    // has no separate title table (title is embedded in the snapshot), so there is
    // no global title row to clean up.
    for (const [runId, snapshot] of Array.from(this.workflowRuns.entries())) {
      if (
        targetSeasonIds.has(snapshot.season.id) &&
        scopeMatches(scope, snapshot.accountId, snapshot.connectedStorageId)
      ) {
        this.workflowRuns.delete(runId);
        this.agentSteps.delete(runId);
      }
    }
    for (const seasonId of targetSeasonIds) {
      this.episodesBySeason.delete(seasonScopeKey(seasonId, storageValue));
    }

    // Clean up this work's pending user-request state too, so it doesn't come
    // back to haunt a fresh (re-)track: a stale pending message just keeps
    // producing not_tracked queue attempts, and a stale pending_replacement
    // would revive an old replace request the moment the title is re-tracked.
    // episode_sources and rejected_resources stay — they're useful history if
    // the user re-tracks. Processing messages are untouched (a running run
    // already refused above; nothing here is mid-flight). Untracking the last
    // season still tracked on this drive, one season at a time, is the whole work.
    const workGone =
      seasonNumber === undefined ||
      !Array.from(this.workflowRuns.values()).some((snapshot) => sameWork(workOfRun(snapshot), work));
    if (workGone) {
      const now = new Date().toISOString();
      for (const m of this.userMessages.values()) {
        if (sameWork(m, work) && m.status === "pending") Object.assign(m, { status: "withdrawn", updatedAt: now });
      }
      for (const [key, p] of this.pendingReplacements) {
        if (sameWork(p, work)) this.pendingReplacements.delete(key);
      }
    } else {
      const seasonPrefix = `S${String(seasonNumber).padStart(2, "0")}E`;
      for (const [key, p] of this.pendingReplacements) {
        if (sameWork(p, work) && p.episode.startsWith(seasonPrefix)) this.pendingReplacements.delete(key);
      }
    }

    return { status: "untracked", removedSeasons: targetSeasonIds.size };
  }

  async retryFailedWorkflowRun(
    workflowRunId: string,
    scopeArg: ScopeArg = undefined,
  ): Promise<{ status: "retried" | "not_retriable" }> {
    const scope = normalizeScope(scopeArg);
    const stored = this.workflowRuns.get(workflowRunId);
    // A kind with no queue claimer can never leave `queued` — retrying it would
    // strand the run and re-block the season (see isQueueClaimableKind).
    // A hidden kind is claimable by the worker but must not be reachable here.
    if (
      !stored ||
      !scopeMatches(scope, stored.accountId, stored.connectedStorageId) ||
      stored.workflowRun.status !== "failed" ||
      !isQueueClaimableKind(stored.workflowRun.kind) ||
      !isUserVisibleWorkflowKind(stored.workflowRun.kind)
    ) {
      return { status: "not_retriable" };
    }
    this.workflowRuns.set(workflowRunId, {
      ...stored,
      workflowRun: retriedWorkflowRun(stored.workflowRun, new Date().toISOString()),
    });
    return { status: "retried" };
  }

  async getTrackedSeasonState(
    trackedSeasonId: string,
    scopeArg: ScopeArg = undefined,
  ): Promise<TrackedSeasonState | null> {
    const scope = normalizeScope(scopeArg);
    const latestSnapshot = Array.from(this.workflowRuns.values())
      .filter(
        (snapshot) =>
          isVisibleTrackedSnapshot(snapshot) &&
          snapshot.season.id === trackedSeasonId &&
          scopeMatches(scope, snapshot.accountId, snapshot.connectedStorageId),
      )
      .sort((a, b) => b.workflowRun.startedAt.localeCompare(a.workflowRun.startedAt))[0];
    if (!latestSnapshot) {
      return null;
    }

    return cloneWorkflowValue({
      accountId: latestSnapshot.accountId ?? DEFAULT_ACCOUNT_ID,
      connectedStorageId: latestSnapshot.connectedStorageId ?? null,
      title: latestSnapshot.title,
      season: latestSnapshot.season,
      episodes:
        this.episodesBySeason.get(seasonScopeKey(trackedSeasonId, latestSnapshot.connectedStorageId)) ??
        latestSnapshot.episodes,
    });
  }

  async listTrackedSeasonStates(
    scopeArg: ScopeArg = undefined,
  ): Promise<TrackedSeasonState[]> {
    const scope = normalizeScope(scopeArg);
    const latestBySeason = new Map<string, PersistWorkflowRunSnapshotInput>();
    const snapshots = Array.from(this.workflowRuns.values())
      .filter(
        (snapshot) =>
          isVisibleTrackedSnapshot(snapshot) &&
          scopeMatches(scope, snapshot.accountId, snapshot.connectedStorageId),
      )
      .sort((a, b) => b.workflowRun.startedAt.localeCompare(a.workflowRun.startedAt));
    for (const snapshot of snapshots) {
      // Key by (season, drive): season.id is drive-independent, so the same season on
      // two drives is two distinct tracked entities — collapsing by season id alone
      // would drop a drive (mirrors the tracked_seasons (id, connected_storage_id) PK).
      const key = seasonScopeKey(snapshot.season.id, snapshot.connectedStorageId);
      if (!latestBySeason.has(key)) {
        latestBySeason.set(key, snapshot);
      }
    }

    return Array.from(latestBySeason.values())
      .map((snapshot) =>
        cloneWorkflowValue({
          accountId: snapshot.accountId ?? DEFAULT_ACCOUNT_ID,
          connectedStorageId: snapshot.connectedStorageId ?? null,
          title: snapshot.title,
          season: snapshot.season,
          episodes:
            this.episodesBySeason.get(seasonScopeKey(snapshot.season.id, snapshot.connectedStorageId)) ??
            snapshot.episodes,
        }),
      )
      .sort(compareTrackedSeasonStates);
  }

  async listAllTrackedSeasonStates(): Promise<TrackedSeasonState[]> {
    const latestBySeason = new Map<string, PersistWorkflowRunSnapshotInput>();
    const snapshots = Array.from(this.workflowRuns.values())
      .filter((snapshot) => isVisibleTrackedSnapshot(snapshot))
      .sort((a, b) => b.workflowRun.startedAt.localeCompare(a.workflowRun.startedAt));
    for (const snapshot of snapshots) {
      // Key by (season, drive): season.id is drive-independent, so the same season on
      // two drives is two distinct tracked entities — collapsing by season id alone
      // would drop a drive (mirrors the tracked_seasons (id, connected_storage_id) PK).
      const key = seasonScopeKey(snapshot.season.id, snapshot.connectedStorageId);
      if (!latestBySeason.has(key)) {
        latestBySeason.set(key, snapshot);
      }
    }
    return Array.from(latestBySeason.values())
      .map((snapshot) =>
        cloneWorkflowValue({
          accountId: snapshot.accountId ?? DEFAULT_ACCOUNT_ID,
          connectedStorageId: snapshot.connectedStorageId ?? null,
          title: snapshot.title,
          season: snapshot.season,
          episodes:
            this.episodesBySeason.get(seasonScopeKey(snapshot.season.id, snapshot.connectedStorageId)) ??
            snapshot.episodes,
        }),
      )
      .sort(compareTrackedSeasonStates);
  }

  async listEpisodeStates(
    trackedSeasonId: string,
    scopeArg: ScopeArg = undefined,
  ): Promise<EpisodeState[]> {
    // Episodes are per (season, drive). A concrete-drive scope reads that drive's
    // bucket; an account-only scope (null storage) merges across the account's
    // drives that have this season (the legacy "match all drives" semantics).
    const scope = normalizeScope(scopeArg);
    if (scope.connectedStorageId != null) {
      return cloneWorkflowValue(
        this.episodesBySeason.get(seasonScopeKey(trackedSeasonId, scope.connectedStorageId)) ?? [],
      );
    }
    const storages = new Set<string | null | undefined>();
    for (const snapshot of this.workflowRuns.values()) {
      if (
        snapshot.season.id === trackedSeasonId &&
        scopeMatches(scope, snapshot.accountId, snapshot.connectedStorageId)
      ) {
        storages.add(snapshot.connectedStorageId);
      }
    }
    const out: EpisodeState[] = [];
    for (const storage of storages) {
      out.push(...(this.episodesBySeason.get(seasonScopeKey(trackedSeasonId, storage)) ?? []));
    }
    return cloneWorkflowValue(out);
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
    const since = input?.since;
    const all = [...this.workflowRuns.values()]
      .filter((snapshot) => scopeMatches(scope, snapshot.accountId, snapshot.connectedStorageId))
      .flatMap((snapshot) => snapshot.notifications.map((notification) => ({ ...notification })))
      .filter((notification) => isUserVisibleNotificationKind(notification.kind))
      .filter((notification) => since === undefined || notification.createdAt >= since);
    all.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return all.slice(0, input?.limit ?? 100);
  }

  async listRecentNotificationsWithAccount(input?: {
    limit?: number;
    since?: string;
  }): Promise<Array<{ accountId: string; connectedStorageId: string | null; notification: NotificationEvent }>> {
    const since = input?.since;
    const all = [...this.workflowRuns.values()]
      .flatMap((snapshot) =>
        snapshot.notifications.map((notification) => ({
          accountId: snapshot.accountId ?? DEFAULT_ACCOUNT_ID,
          connectedStorageId: snapshot.connectedStorageId ?? null,
          notification: { ...notification },
        })),
      )
      .filter((entry) => isUserVisibleNotificationKind(entry.notification.kind))
      .filter((entry) => since === undefined || entry.notification.createdAt >= since);
    all.sort((left, right) => right.notification.createdAt.localeCompare(left.notification.createdAt));
    return all.slice(0, input?.limit ?? 100);
  }

  private expireStaleActiveWorkflowRuns(input: ReserveWorkflowRunInput): void {
    if (!input.staleActiveRunStartedBefore) {
      return;
    }
    const reservationSnapshot = workflowSnapshotFromReservation(input);
    const reservingStorage = reservationSnapshot.connectedStorageId ?? UNSCOPED_STORAGE;
    const staleRuns = Array.from(this.workflowRuns.values()).filter(
      (stored) =>
        stored.workflowRun.trackedSeasonId === reservationSnapshot.season.id &&
        // Only expire stale runs on the SAME drive being reserved — never another drive's.
        (stored.connectedStorageId ?? UNSCOPED_STORAGE) === reservingStorage &&
        stored.workflowRun.kind === reservationSnapshot.workflowRun.kind &&
        isActiveWorkflowStatus(stored.workflowRun.status) &&
        isStaleActiveWorkflowRun(stored.workflowRun, input.staleActiveRunStartedBefore!),
    );

    for (const staleRun of staleRuns) {
      const expired = cloneWorkflowValue({
        ...staleRun,
        workflowRun: expireWorkflowRun(
          staleRun.workflowRun,
          input.staleFinishedAt ?? reservationSnapshot.workflowRun.startedAt,
        ),
        episodes: [],
      });
      this.workflowRuns.set(expired.workflowRun.id, expired);
      this.episodesBySeason.set(seasonScopeKey(expired.season.id, expired.connectedStorageId), []);
    }
  }
}

export function validateWorkflowRunSnapshot(input: PersistWorkflowRunSnapshotInput): void {
  if (input.season.mediaTitleId !== input.title.id) {
    throw new Error("Tracked season does not belong to media title");
  }
  if (input.workflowRun.trackedSeasonId !== input.season.id) {
    throw new Error("Workflow run does not belong to tracked season");
  }

  for (const episode of input.episodes) {
    if (episode.trackedSeasonId !== input.season.id) {
      throw new Error(`Episode ${episode.episodeCode} does not belong to tracked season`);
    }
  }

  for (const transferAttempt of input.transferAttempts) {
    if (transferAttempt.workflowRunId !== input.workflowRun.id) {
      throw new Error(`Transfer attempt ${transferAttempt.id} does not belong to workflow run`);
    }
  }

  for (const notification of input.notifications) {
    if (notification.workflowRunId !== input.workflowRun.id) {
      throw new Error(`Notification ${notification.id} does not belong to workflow run`);
    }
  }

  const candidateIdsBySnapshot = new Map<string, Set<string>>();
  const allCandidateIds = new Set<string>();
  for (const snapshot of input.resourceSnapshots) {
    const snapshotCandidateIds = new Set<string>();
    for (const candidate of snapshot.candidates) {
      if (candidate.snapshotId !== snapshot.id) {
        throw new Error(`Resource candidate ${candidate.id} does not belong to snapshot ${snapshot.id}`);
      }
      snapshotCandidateIds.add(candidate.id);
      allCandidateIds.add(candidate.id);
    }
    candidateIdsBySnapshot.set(snapshot.id, snapshotCandidateIds);
  }

  for (const decision of input.decisions) {
    const candidateIds = candidateIdsBySnapshot.get(decision.snapshotId);
    if (!candidateIds) {
      throw new Error(`Agent decision referenced unknown resource snapshot ${decision.snapshotId}`);
    }

    const decisionCandidateIds = [
      ...decision.selectedCandidateIds,
      ...decision.rejectedCandidateIds,
      ...Object.keys(decision.episodeMapping),
      ...Object.keys(decision.providerAheadEpisodeMapping),
    ];
    if (decisionCandidateIds.some((candidateId) => !candidateIds.has(candidateId))) {
      throw new Error("Agent decision referenced candidates outside persisted resource snapshots");
    }
  }

  for (const transferAttempt of input.transferAttempts) {
    if (!allCandidateIds.has(transferAttempt.candidateId)) {
      throw new Error(`Transfer attempt ${transferAttempt.id} referenced an unknown candidate`);
    }
  }
}

export function withDerivedEpisodeSummaries(input: PersistWorkflowRunSnapshotInput): PersistedWorkflowRunSnapshot {
  return {
    ...input,
    accountId: input.accountId ?? DEFAULT_ACCOUNT_ID,
    connectedStorageId: input.connectedStorageId ?? null,
    obtainedEpisodes: input.episodes
      .filter((episode) => episode.obtained)
      .map((episode) => episode.episodeCode),
    providerAheadEpisodes: input.episodes
      .filter((episode) => episode.obtained && episode.metadataStatus === "provider_ahead")
      .map((episode) => episode.episodeCode),
  };
}

/** Instance-wide key for the UNIQUE(provider, provider_uid) ownership index. */
export function connectedStorageKey(provider: string, providerUid: string): string {
  return `${provider}:${providerUid}`;
}

export function cloneWorkflowValue<T>(value: T): T {
  return structuredClone(value);
}

export function isActiveWorkflowStatus(status: WorkflowStatus): boolean {
  return status === "queued" || status === "running";
}

/** Hides rows the previous janitor wrote. */
function isVisibleTrackedSnapshot(snapshot: PersistWorkflowRunSnapshotInput): boolean {
  return !isStagingJanitorId(snapshot.workflowRun.id) && !isStagingJanitorId(snapshot.season.id);
}

/** The leftover dir id carried on a queued staging_recovery, or null. */
export function stagingRecoveryDirectoryId(run: Pick<WorkflowRun, "auditEvents">): string | null {
  for (let index = run.auditEvents.length - 1; index >= 0; index -= 1) {
    const event = run.auditEvents[index];
    if (event?.type !== "staging_recovery_queued") continue;
    const id = event.data?.["stagingDirectoryId"];
    if (typeof id === "string" && id.length > 0) return id;
  }
  return null;
}

export function findStagingRecoveryIn(
  runs: readonly PersistedWorkflowRunSnapshot[],
  stagingDirectoryId: string,
): PersistedWorkflowRunSnapshot | null {
  return (
    runs.find(
      (run) =>
        run.workflowRun.kind === "staging_recovery" &&
        stagingRecoveryDirectoryId(run.workflowRun) === stagingDirectoryId,
    ) ?? null
  );
}

export function workflowSnapshotFromReservation(input: ReserveWorkflowRunInput): PersistWorkflowRunSnapshotInput {
  const {
    blockIfEpisodeStatesExist: _blockIfEpisodeStatesExist,
    requireTrackedSeason: _requireTrackedSeason,
    keepCurrentEpisodes: _keepCurrentEpisodes,
    staleActiveRunStartedBefore: _staleActiveRunStartedBefore,
    staleFinishedAt: _staleFinishedAt,
    ...snapshot
  } = input;
  return snapshot;
}

export function expireWorkflowRun(workflowRun: WorkflowRun, finishedAt: string): WorkflowRun {
  return {
    ...workflowRun,
    status: "failed",
    finishedAt,
    auditEvents: [
      ...workflowRun.auditEvents,
      {
        type: "workflow_expired",
        message: `Expired stale active workflow run ${workflowRun.id}`,
      },
    ],
  };
}

/** True when an active run is safe to expire as abandoned.
 *  Uses progress.updatedAt as liveness when present so a slow-but-alive transfer
 *  (startedAt old, progress still refreshing) is not killed mid-flight. A run with
 *  no progress falls back to startedAt-only, matching the historical crash path. */
export function isStaleActiveWorkflowRun(
  workflowRun: WorkflowRun,
  staleActiveRunStartedBefore: string,
): boolean {
  if (workflowRun.startedAt >= staleActiveRunStartedBefore) {
    return false;
  }
  const liveAt = workflowRun.progress?.updatedAt;
  if (liveAt !== undefined && liveAt >= staleActiveRunStartedBefore) {
    return false;
  }
  return true;
}

export function claimWorkflowRun(workflowRun: WorkflowRun, claimedAt: string): WorkflowRun {
  return {
    ...workflowRun,
    status: "running",
    finishedAt: null,
    auditEvents: [
      ...workflowRun.auditEvents,
      {
        type: "workflow_claimed",
        message: `Claimed queued workflow run ${workflowRun.id}`,
        data: { claimedAt },
      },
    ],
  };
}

/** Max automatic retries for a transient failure before terminal `failed`. */
export const AUTO_REQUEUE_MAX = 3;
/** Backoff before each auto-retry (index = the count BEFORE this attempt):
 *  1min, 5min, 15min. Rides out a multi-minute home-network blip without
 *  hammering the queue. */
export const AUTO_REQUEUE_BACKOFF_MS = [60_000, 300_000, 900_000];
/** Max crash-recovery requeues (running→queued on worker start) before the run
 *  is terminal-failed. A poison run that crashes the worker every claim would
 *  otherwise loop forever across restarts. */
export const ORPHAN_REQUEUE_MAX = 5;
/** Which kinds a worker actually claims out of `queued`. Crash recovery may only
 *  park a run in `queued` if some worker will claim it back — otherwise the run
 *  becomes an invisible tombstone that also BLOCKS the season (queued counts as
 *  active in `isActiveWorkflowStatus`, so `reserveWorkflowRun` returns
 *  already_active forever).
 *
 *  `type3_monitor` is deliberately absent: patrol runs are created directly as
 *  `running` by `reserveWorkflowRun` (worker.ts) and no `claimNextQueuedWorkflowRun`
 *  call site asks for that kind. Keep this table in sync with the claim call sites
 *  in `worker.ts` — the `Record<WorkflowKind, boolean>` annotation is what enforces
 *  this: adding a WorkflowKind without a decision here is a tsc error (TS2741),
 *  not merely a failing test. */
const KIND_HAS_QUEUE_CLAIMER: Record<WorkflowKind, boolean> = {
  type1_package_init: true,
  type2_init: true,
  movie_init: true,
  type3_monitor: false,
  replace_request: true,
  staging_recovery: true,
};

/** Whether cancelling a queued run of this kind tears down its season's tracking.
 *  Only an init run owns the season (cancelling it = "never mind, don't track");
 *  a replace_request runs on a library that already has files and must never take
 *  the tracking down with it. `=== true` for the same reason as isQueueClaimableKind. */
const KIND_OWNS_TRACKING: Record<WorkflowKind, boolean> = {
  type1_package_init: true,
  type2_init: true,
  movie_init: true,
  type3_monitor: false,
  replace_request: false,
  staging_recovery: false,
};

export function tearsDownTrackingOnCancel(kind: WorkflowKind): boolean {
  return KIND_OWNS_TRACKING[kind] === true;
}

/** True when a `queued` run of this kind will actually be picked up by a worker.
 *
 *  KNOWN LIMITATION (deliberate, documented rather than hidden): this invariant is
 *  enforced per write-site, not centrally. Callers that can move a run into
 *  `queued` must consult this predicate themselves — currently
 *  `recoverOrphanRunningRun` (crash recovery) and `retryFailedWorkflowRun` (all
 *  three repository implementations). `retryFailedWorkflowRun` also refuses a
 *  kind `isUserVisibleWorkflowKind` rejects: `staging_recovery` is claimable, but
 *  a user retry must not requeue a hidden run. Nothing structurally prevents a future
 *  write-site from forgetting. Candidates for a central fix, best first:
 *    1. The shared pure transitions themselves (`retriedWorkflowRun`,
 *       `recoverOrphanRunningRun`) — already one place each rather than three,
 *       needing no per-backend persistence change; would have to throw, since
 *       their signatures cannot express a refusal.
 *    2. Each backend's `upsertWorkflowRun` — catches every path, but is three
 *       edits and touches every persistence test fixture.
 *  `validateWorkflowRunSnapshot` is NOT viable: it runs on only 2 of the 7 upsert
 *  paths per backend (save + reserve), so it would miss expire/claim/recover/
 *  progress/retry entirely.
 *  Left as follow-up. Note the invariant currently holds with no gaps — of the
 *  five non-validated paths, expire writes `failed`, claim writes `running`,
 *  progress does not touch status, and recover/retry are both guarded.
 *  The `=== true` is load-bearing, not superstition: runs are persisted as JSON and
 *  read back with an unchecked `as WorkflowRun` cast, so a row written by another
 *  version can carry an unknown `kind`. Such a kind reads back `undefined` and is
 *  treated as NOT claimable — i.e. terminal-fail rather than park-forever-and-block
 *  the season, which is the safer of the two failure directions. */
export function isQueueClaimableKind(kind: WorkflowKind): boolean {
  return KIND_HAS_QUEUE_CLAIMER[kind] === true;
}
/** Default retention for finished workflow history (activity / agent_steps). */
export const FINISHED_RUN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Transient failure → back to `queued` with backoff. The worker's claim query
 *  (see claimableQueuedRuns) skips it until `nextAttemptAt`. Caller guarantees
 *  the prior count is below AUTO_REQUEUE_MAX. */
export function requeueWorkflowRunForRetry(
  workflowRun: WorkflowRun,
  errorMessage: string,
  now: string,
): WorkflowRun {
  const priorCount = workflowRun.autoRequeueCount ?? 0;
  const nextCount = priorCount + 1;
  const backoffMs = AUTO_REQUEUE_BACKOFF_MS[priorCount] ?? AUTO_REQUEUE_BACKOFF_MS.at(-1)!;
  return {
    ...workflowRun,
    status: "queued",
    finishedAt: null,
    autoRequeueCount: nextCount,
    nextAttemptAt: new Date(Date.parse(now) + backoffMs).toISOString(),
    auditEvents: [
      ...workflowRun.auditEvents,
      {
        type: "workflow_auto_requeued",
        message: `Transient failure, auto-retry ${nextCount}/${AUTO_REQUEUE_MAX}: ${errorMessage}`,
        data: { attempt: nextCount, backoffMs },
      },
    ],
  };
}

/** Terminal failure (transient retries exhausted, or a non-transient error). */
export function failWorkflowRun(
  workflowRun: WorkflowRun,
  errorMessage: string,
  finishedAt: string,
): WorkflowRun {
  return {
    ...workflowRun,
    status: "failed",
    finishedAt,
    auditEvents: [
      ...workflowRun.auditEvents,
      { type: "workflow_failed", message: errorMessage },
    ],
  };
}

/**
 * Crash-recovery decision for one orphaned `running` run. Checked in this order:
 * - Kind with no queue claimer → terminal fail. Takes precedence over the cap:
 *   never park such a run in `queued`, where nothing would ever claim it back and
 *   its `queued`-counts-as-active status would block the season indefinitely.
 * - Under the cap → requeue with orphanRequeueCount++.
 * - At/over the cap → terminal fail so the worker stops crash-looping on it.
 */
export function recoverOrphanRunningRun(
  workflowRun: WorkflowRun,
  now: string,
): { action: "requeue" | "fail"; run: WorkflowRun } {
  const prior = workflowRun.orphanRequeueCount ?? 0;
  // An orphaned run of a kind nobody claims must be terminated, not requeued:
  // `queued` counts as active, so parking it there strands the run AND blocks
  // every future patrol of that season until the 30-min stale sweep happens to
  // run (which also deletes that drive's episode_states as a side effect).
  if (!isQueueClaimableKind(workflowRun.kind)) {
    return {
      action: "fail",
      run: {
        ...workflowRun,
        status: "failed",
        finishedAt: now,
        auditEvents: [
          ...workflowRun.auditEvents,
          {
            type: "orphan_unclaimable",
            message: `Crash recovery cannot requeue kind ${workflowRun.kind} (no queue claimer) — marking failed so the season is not blocked`,
            data: { kind: workflowRun.kind },
          },
        ],
      },
    };
  }
  if (prior >= ORPHAN_REQUEUE_MAX) {
    return {
      action: "fail",
      run: {
        ...workflowRun,
        status: "failed",
        finishedAt: now,
        auditEvents: [
          ...workflowRun.auditEvents,
          {
            type: "orphan_requeue_capped",
            message: `Orphan recovery cap (${ORPHAN_REQUEUE_MAX}) reached — marking failed to break crash loop`,
            data: { orphanRequeueCount: prior },
          },
        ],
      },
    };
  }
  const next = prior + 1;
  return {
    action: "requeue",
    run: {
      ...workflowRun,
      status: "queued",
      finishedAt: null,
      orphanRequeueCount: next,
      auditEvents: [
        ...workflowRun.auditEvents,
        {
          type: "orphan_requeued",
          message: `Crash recovery requeued running run (${next}/${ORPHAN_REQUEUE_MAX})`,
          data: { orphanRequeueCount: next },
        },
      ],
    },
  };
}

const PRUNABLE_RUN_STATUSES = new Set([
  "succeeded",
  "failed",
  "partial",
  "no_coverage",
]);

/** Pure predicate: finished run whose finishedAt is strictly before cutoff. */
export function isPrunableFinishedRun(run: WorkflowRun, olderThan: string): boolean {
  if (!PRUNABLE_RUN_STATUSES.has(run.status)) return false;
  if (!run.finishedAt) return false;
  return run.finishedAt < olderThan;
}

/** Manual retry: a `failed` run → immediately-claimable queued, counters reset
 *  (clears nextAttemptAt + autoRequeueCount + orphanRequeueCount so it claims
 *  on the next tick and crash-recovery gets a fresh budget). */
export function retriedWorkflowRun(workflowRun: WorkflowRun, now: string): WorkflowRun {
  const next: WorkflowRun = {
    ...workflowRun,
    status: "queued",
    finishedAt: null,
    autoRequeueCount: 0,
    orphanRequeueCount: 0,
    auditEvents: [
      ...workflowRun.auditEvents,
      { type: "workflow_manual_retried", message: `Manually retried at ${now}` },
    ],
  };
  delete next.nextAttemptAt;
  return next;
}

/** Queued runs of `kind` eligible to claim NOW (nextAttemptAt unset or ≤ now),
 *  oldest-first (FIFO). This is what makes auto-retry backoff real — a requeued
 *  run with a future nextAttemptAt is not claimable yet. */
export function claimableQueuedRuns(
  runs: WorkflowRun[],
  kind: WorkflowKind,
  now: string,
): WorkflowRun[] {
  return runs
    .filter(
      (run) =>
        run.kind === kind &&
        run.status === "queued" &&
        (run.nextAttemptAt === undefined || run.nextAttemptAt <= now),
    )
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

export function compareTrackedSeasonStates(a: TrackedSeasonState, b: TrackedSeasonState): number {
  return (
    a.title.title.localeCompare(b.title.title) ||
    a.season.seasonNumber - b.season.seasonNumber ||
    a.season.id.localeCompare(b.season.id)
  );
}

/** The candidate's url in the earliest snapshot that contains it; null when unusable or absent. */
function urlInRunSnapshots(snapshots: ReadonlyArray<{ candidates: unknown }>, candidateId: string): string | null {
  for (const snapshot of snapshots) {
    const candidates = Array.isArray(snapshot.candidates) ? snapshot.candidates : [];
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== "object" || (candidate as { id?: unknown }).id !== candidateId) continue;
      const url = (candidate as { providerPayload?: { url?: unknown } }).providerPayload?.url;
      return typeof url === "string" && url !== "" ? url : null;
    }
  }
  return null;
}

function sameWork(a: UserMessageScope, b: UserMessageScope): boolean {
  return a.accountId === b.accountId && a.drive === b.drive && a.titleKey === b.titleKey;
}

/** The work (account, drive, title) a run belongs to — the key of its user messages. */
function workOfRun(snapshot: Pick<PersistWorkflowRunSnapshotInput, "accountId" | "connectedStorageId" | "title">): UserMessageScope {
  return {
    accountId: snapshot.accountId ?? DEFAULT_ACCOUNT_ID,
    drive: userMessageDrive(snapshot.connectedStorageId),
    titleKey: snapshot.title.id,
  };
}

function workKey(scope: UserMessageScope, episode: string): string {
  return JSON.stringify([scope.accountId, scope.drive, scope.titleKey, episode]);
}

function uniqueWorks(rows: UserMessageScope[]): UserMessageScope[] {
  const seen = new Map<string, UserMessageScope>();
  for (const r of rows) seen.set(workKey(r, ""), { accountId: r.accountId, drive: r.drive, titleKey: r.titleKey });
  return [...seen.values()].sort(
    (a, b) => a.accountId.localeCompare(b.accountId) || a.drive.localeCompare(b.drive) || a.titleKey.localeCompare(b.titleKey),
  );
}
