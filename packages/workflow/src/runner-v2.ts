import { DEFAULT_ACCOUNT_ID } from "./domain.js";
import type { AgentMemoryStore } from "./agent-memory.js";
import type { LanguageModel } from "ai";
import type {
  AcquisitionSeasonScope,
  AuditEvent,
  EpisodeState,
  MediaTitle,
  NotificationEvent,
  TrackedSeason,
  WorkflowKind,
  WorkflowRun,
  WorkflowRunMetadata,
  WorkflowStatus,
} from "./domain.js";
import { runTvAcquisitionV2, type RunTvAcquisitionV2Request } from "./acquisition-v2/run-tv-v2.js";
import type { BridgedV2Result } from "./acquisition-v2/workflow-v2-bridge.js";
import { makeProgressSink } from "./acquisition-v2/progress-sink.js";
import { makeAgentTraceSink, combineToolEventSinks } from "./acquisition-v2/agent-trace-sink.js";
import { runMovieAcquisitionV2, type MovieAcquisitionV2Result, type RunMovieAcquisitionV2Request } from "./movie-workflow-v2.js";
import type { JevJudge } from "./jev-judge.js";
import type { ResourceProvider, StorageExecutor } from "./ports.js";
import type { PersistWorkflowRunSnapshotInput, WorkflowRepository } from "./repository.js";
import { userMessageDrive } from "./user-requests.js";
import { stampReplaceNotification } from "./notification-report.js";

/**
 * Phase 7d — production persist wrappers on the V2 engine. These mirror the old
 * runner.ts `*AndPersist` functions (same persisted record shapes so the
 * repository/frontend are unchanged) but the semantic loop is the sandboxed
 * strong agent (`model` injected) instead of the old weak AgentNodes. type2 /
 * series / type3 are the same resource-sync workflow; only the persistence
 * convention (single record vs per-season records, kind, trigger) differs.
 */

interface TvV2Common {
  title: MediaTitle;
  categoryParentId: string;
  resourceProvider: ResourceProvider;
  storage: StorageExecutor;
  model: LanguageModel;
  repository: WorkflowRepository;
  /** §7: owning account, stamped onto the persisted tracking record so a
   *  multi-user acquisition stays owned by the user who triggered it. */
  accountId?: string;
  /** Tree model: owning connected storage (drive/workspace), stamped alongside
   *  accountId so the record stays pinned to the drive it landed on. */
  connectedStorageId?: string | null;
  workflowRun: WorkflowRunMetadata;
  searchBudget?: number;
  maxSteps?: number;
  preferredLanguage?: string;
  /** Global quality preference ("high"/"medium"); undefined = 不限 (no guidance). */
  qualityPreference?: "high" | "medium";
  /** The run's drive brand ("pan115" | "quark") — selects brand-specific skill. */
  storageProvider?: string;
  /** assrt token (Settings → 字幕来源). Undefined = 字幕流程不触发。 */
  assrtToken?: string;
  /** Optional Jev candidate prefilter (Settings); resolved per account by the worker. */
  jevJudge?: JevJudge;
  /** Agent memory on/off (Settings → AI 模型, default on). When on, the repository
   *  itself is the memory store, scoped to `accountId`. */
  agentMemory?: boolean;
  /**
   * Wall clock for the run. Drives the engine's timestamps (including the
   * terminal notification's `createdAt`) AND the persisted `finishedAt`, which
   * is stamped *after* the acquisition awaits — so completion time reflects when
   * the run actually ended, not when it was claimed. Defaults to live time;
   * tests inject a deterministic clock. (See worker.ts: passing a precomputed
   * `finishedAt` as a call argument used to freeze it at run-start.)
   */
  now?: () => string;
}

function resolveNow(input: { now?: () => string }): () => string {
  return input.now ?? (() => new Date().toISOString());
}

// ⚠ TS does not excess-property-check spread expressions: a field spread by worker.ts that is NOT listed here is silently dropped (this happened to jevJudge on 2026-09-20 and was only caught by the live A/B). Every optional worker→workflow field must appear in TvV2Common, here, and in run-tv-v2.ts.
function passthrough(input: TvV2Common): {
  searchBudget?: number;
  maxSteps?: number;
  preferredLanguage?: string;
  qualityPreference?: "high" | "medium";
  storageProvider?: string;
  assrtToken?: string;
  jevJudge?: JevJudge;
  memory?: { store: AgentMemoryStore; accountId: string; drive?: string };
} {
  return {
    ...memoryOption(input),
    ...(input.searchBudget === undefined ? {} : { searchBudget: input.searchBudget }),
    ...(input.maxSteps === undefined ? {} : { maxSteps: input.maxSteps }),
    ...(input.preferredLanguage === undefined ? {} : { preferredLanguage: input.preferredLanguage }),
    ...(input.qualityPreference === undefined ? {} : { qualityPreference: input.qualityPreference }),
    ...(input.storageProvider === undefined ? {} : { storageProvider: input.storageProvider }),
    ...(input.assrtToken === undefined ? {} : { assrtToken: input.assrtToken }),
    ...(input.jevJudge === undefined ? {} : { jevJudge: input.jevJudge }),
  };
}

/** The repository IS the memory store; memory is on unless the account turned it off. */
function memoryOption(input: {
  repository: WorkflowRepository;
  accountId?: string;
  agentMemory?: boolean;
  connectedStorageId?: string | null;
  storageProvider?: string;
}): {
  memory?: { store: AgentMemoryStore; accountId: string; drive?: string };
} {
  if (input.agentMemory === false) return {};
  // The concrete drive (two 115 accounts are two drives); the brand only when the
  // run carries no connected storage (legacy single-drive setups).
  const drive = input.connectedStorageId ?? input.storageProvider;
  return { memory: { store: input.repository, accountId: input.accountId ?? DEFAULT_ACCOUNT_ID, ...(drive ? { drive } : {}) } };
}

/** Episodes of this work (on this drive) that hold an old + replacement copy on
 *  purpose — every run of it protects its existing files and says so to the agent,
 *  so a later keep-larger dedup cannot undo a replacement. A failed read fails
 *  CLOSED: it is logged and the run still protects its existing files, only without
 *  naming episodes (it must never fail a patrol, nor let one delete a kept copy). */
async function protectExistingOption(input: {
  repository: WorkflowRepository;
  accountId?: string;
  connectedStorageId?: string | null;
  title: MediaTitle;
}): Promise<{ protectExisting?: NonNullable<RunTvAcquisitionV2Request["protectExisting"]> }> {
  try {
    const sources = await input.repository.listEpisodeSources({
      accountId: input.accountId ?? DEFAULT_ACCOUNT_ID,
      drive: userMessageDrive(input.connectedStorageId),
      titleKey: input.title.id,
    });
    return sources.length > 0 ? { protectExisting: { episodes: sources.map((s) => s.episode) } } : {};
  } catch (error) {
    console.error(`[user-message] could not read episode sources of ${input.title.id}: ${String(error).slice(0, 300)}`);
    return { protectExisting: { episodes: "unknown" } };
  }
}

const LINK_HISTORY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** This work's transfers from the last 30 days, excluding the run in progress.
 *  Read lazily once the orchestrator starts; a failing read is logged and treated
 *  as an empty list (fail open — it must never fail a run). */
function linkHistoryOption(input: {
  repository: WorkflowRepository;
  accountId?: string;
  connectedStorageId?: string | null;
  title: MediaTitle;
  workflowRunId: string;
  now: () => string;
}): { linkHistory: NonNullable<RunTvAcquisitionV2Request["linkHistory"]> } {
  const accountId = input.accountId ?? DEFAULT_ACCOUNT_ID;
  const drive = userMessageDrive(input.connectedStorageId);
  const titleKey = input.title.id;
  return {
    linkHistory: {
      list: async () => {
        try {
          const since = new Date(Date.parse(input.now()) - LINK_HISTORY_WINDOW_MS).toISOString();
          return await input.repository.listLinkHistory({
            accountId,
            drive,
            titleKey,
            since,
            excludeRunId: input.workflowRunId,
          });
        } catch (error) {
          console.error(`[link-history] could not read link history of ${titleKey}: ${String(error).slice(0, 300)}`);
          return [];
        }
      },
    },
  };
}

/** This work's rejected resources (account + work scoped), for every run of it: the
 *  search filter and the transfer-time guard keep a patrol from landing what the
 *  user rejected. Read lazily on every search/transfer; a failing read is logged and
 *  treated as an empty list (fail open — it must never fail a patrol). */
function rejectedLookupOption(input: {
  repository: WorkflowRepository;
  accountId?: string;
  title: MediaTitle;
}): { rejectedLookup: NonNullable<RunTvAcquisitionV2Request["rejectedLookup"]> } {
  const accountId = input.accountId ?? DEFAULT_ACCOUNT_ID;
  return {
    rejectedLookup: {
      list: async () => {
        try {
          return (await input.repository.listRejectedResources({ accountId, titleKey: input.title.id })).map((r) => ({
            episode: r.episode,
            linkKey: r.linkKey,
            label: r.label,
            sizeBytes: r.sizeBytes,
          }));
        } catch (error) {
          console.error(`[user-message] could not read rejected resources of ${input.title.id}: ${String(error).slice(0, 300)}`);
          return [];
        }
      },
    },
  };
}

/** The run's onProgress: live activity progress (for the activity page) AND the
 *  durable per-step trace (for post-mortem复盘), combined + isolated so one can't
 *  break the other. `apiCallCount` surfaces the 115 budget burn per step (real 115
 *  only; fakes omit it). */
function progressAndTraceSink(input: {
  repository: WorkflowRepository;
  workflowRunId: string;
  neededHint: number;
  storage: StorageExecutor;
}): ReturnType<typeof combineToolEventSinks> {
  return combineToolEventSinks(
    makeProgressSink({
      repository: input.repository,
      workflowRunId: input.workflowRunId,
      neededHint: input.neededHint,
    }),
    makeAgentTraceSink({
      repository: input.repository,
      workflowRunId: input.workflowRunId,
      apiCallCount: () => input.storage.apiCallCount?.(),
    }),
  );
}

async function persistSingleSeason(input: {
  kind: WorkflowKind;
  title: MediaTitle;
  bridged: BridgedV2Result;
  workflowRun: WorkflowRunMetadata;
  repository: WorkflowRepository;
  accountId?: string;
  connectedStorageId?: string | null;
}): Promise<void> {
  const seasonResult = input.bridged.seasons[0]!;
  await input.repository.saveWorkflowRunSnapshot({
    ...(input.accountId ? { accountId: input.accountId } : {}),
    ...(input.connectedStorageId != null ? { connectedStorageId: input.connectedStorageId } : {}),
    title: input.title,
    season: seasonResult.season,
    workflowRun: {
      id: input.workflowRun.id,
      kind: input.kind,
      status: input.bridged.status,
      trackedSeasonId: seasonResult.season.id,
      startedAt: input.workflowRun.startedAt,
      finishedAt: input.workflowRun.finishedAt,
      auditEvents: input.bridged.auditEvents,
    },
    episodes: seasonResult.episodes,
    resourceSnapshots: input.bridged.resourceSnapshots,
    decisions: input.bridged.decisions,
    transferAttempts: input.bridged.transferAttempts,
    notifications: input.bridged.notifications,
  });
}

export async function runType2InitializationV2AndPersist(
  input: TvV2Common & { season: TrackedSeason },
): Promise<BridgedV2Result> {
  const now = resolveNow(input);
  const bridged = await runTvAcquisitionV2({
    title: input.title,
    mode: "type2",
    seasons: [
      {
        seasonNumber: input.season.seasonNumber,
        totalEpisodes: input.season.totalEpisodes,
        latestAiredEpisode: input.season.latestAiredEpisode,
        qualityPreference: input.season.qualityPreference,
        status: input.season.status,
      },
    ],
    categoryParentId: input.categoryParentId,
    resourceProvider: input.resourceProvider,
    storage: input.storage,
    deadLinkStore: input.repository,
    model: input.model,
    workflowRunId: input.workflowRun.id,
    now,
    onProgress: progressAndTraceSink({
      repository: input.repository,
      workflowRunId: input.workflowRun.id,
      neededHint: Math.min(input.season.latestAiredEpisode, input.season.totalEpisodes),
      storage: input.storage,
    }),
    ...passthrough(input),
    ...(await protectExistingOption(input)),
    ...rejectedLookupOption(input),
    ...linkHistoryOption({ ...input, workflowRunId: input.workflowRun.id, now }),
  });

  await persistSingleSeason({
    kind: "type2_init",
    title: input.title,
    bridged,
    // Stamp finishedAt AFTER the run — it (and the notification createdAt) must
    // be the real completion time, not the claim time.
    workflowRun: { ...input.workflowRun, finishedAt: now() },
    repository: input.repository,
    ...(input.accountId ? { accountId: input.accountId } : {}),
    ...(input.connectedStorageId != null ? { connectedStorageId: input.connectedStorageId } : {}),
  });
  return bridged;
}

export async function runType3MonitoringV2AndPersist(
  input: TvV2Common & { season: TrackedSeason; episodes: EpisodeState[] },
): Promise<BridgedV2Result> {
  const now = resolveNow(input);
  const bridged = await runTvAcquisitionV2({
    title: input.title,
    mode: "type3",
    seasons: [
      {
        seasonNumber: input.season.seasonNumber,
        totalEpisodes: input.season.totalEpisodes,
        latestAiredEpisode: input.season.latestAiredEpisode,
        qualityPreference: input.season.qualityPreference,
        status: input.season.status,
      },
    ],
    categoryParentId: input.categoryParentId,
    resourceProvider: input.resourceProvider,
    storage: input.storage,
    deadLinkStore: input.repository,
    model: input.model,
    workflowRunId: input.workflowRun.id,
    // 实有 = the DB obtained marks; the need is aired − these (NOT a 115 scan).
    priorObtained: input.episodes.filter((episode) => episode.obtained).map((episode) => episode.episodeCode),
    now,
    onProgress: progressAndTraceSink({
      repository: input.repository,
      workflowRunId: input.workflowRun.id,
      neededHint: input.episodes.filter((episode) => episode.airStatus === "aired" && !episode.obtained).length,
      storage: input.storage,
    }),
    ...passthrough(input),
    ...(await protectExistingOption(input)),
    ...rejectedLookupOption(input),
    ...linkHistoryOption({ ...input, workflowRunId: input.workflowRun.id, now }),
  });

  await persistSingleSeason({
    kind: "type3_monitor",
    title: input.title,
    bridged,
    workflowRun: { ...input.workflowRun, finishedAt: now() },
    repository: input.repository,
    ...(input.accountId ? { accountId: input.accountId } : {}),
    ...(input.connectedStorageId != null ? { connectedStorageId: input.connectedStorageId } : {}),
  });
  return bridged;
}

export async function runSeriesInitializationV2AndPersist(
  // `seasonQualityRecord` is the LEGACY per-season record string (e.g. "4K"),
  // distinct from TvV2Common.qualityPreference (the new high/medium agent
  // preference that drives qualityGuidance via passthrough). Renamed to avoid a
  // key collision on the intersection type.
  input: TvV2Common & { seasons: AcquisitionSeasonScope[]; seasonQualityRecord?: string },
): Promise<BridgedV2Result> {
  const quality = input.seasonQualityRecord ?? "4K";
  const now = resolveNow(input);
  const bridged = await runTvAcquisitionV2({
    title: input.title,
    mode: "series",
    seasons: input.seasons.map((season) => ({
      seasonNumber: season.seasonNumber,
      totalEpisodes: season.totalEpisodes,
      latestAiredEpisode: season.latestAiredEpisode,
      qualityPreference: quality,
    })),
    categoryParentId: input.categoryParentId,
    resourceProvider: input.resourceProvider,
    storage: input.storage,
    deadLinkStore: input.repository,
    model: input.model,
    workflowRunId: input.workflowRun.id,
    now,
    onProgress: progressAndTraceSink({
      repository: input.repository,
      workflowRunId: input.workflowRun.id,
      neededHint: input.seasons.reduce(
        (sum, season) => sum + Math.min(season.latestAiredEpisode, season.totalEpisodes),
        0,
      ),
      storage: input.storage,
    }),
    ...passthrough(input),
    ...(await protectExistingOption(input)),
    ...rejectedLookupOption(input),
    ...linkHistoryOption({ ...input, workflowRunId: input.workflowRun.id, now }),
  });

  // Stamp completion AFTER the run; one finishedAt shared across all season
  // records (the title-level run finished once).
  const finishedAt = now();
  // One record per season under `${runId}_s${n}`, mirroring the old series
  // persistence: resource evidence + notifications ride on the first season
  // only (title-level), not duplicated across N season records.
  for (const [index, seasonResult] of bridged.seasons.entries()) {
    const seasonRunId = `${input.workflowRun.id}_s${seasonResult.season.seasonNumber}`;
    await input.repository.saveWorkflowRunSnapshot({
      ...(input.accountId ? { accountId: input.accountId } : {}),
      ...(input.connectedStorageId != null ? { connectedStorageId: input.connectedStorageId } : {}),
      title: input.title,
      season: seasonResult.season,
      workflowRun: {
        id: seasonRunId,
        kind: "type1_package_init",
        status: bridged.status,
        trackedSeasonId: seasonResult.season.id,
        startedAt: input.workflowRun.startedAt,
        finishedAt,
        auditEvents: index === 0 ? bridged.auditEvents : [],
      },
      episodes: seasonResult.episodes,
      resourceSnapshots: index === 0 ? bridged.resourceSnapshots : [],
      decisions: index === 0 ? bridged.decisions : [],
      transferAttempts:
        index === 0
          ? bridged.transferAttempts.map((attempt) => ({ ...attempt, workflowRunId: seasonRunId }))
          : [],
      notifications:
        index === 0
          ? bridged.notifications.map((notification) => ({
              ...notification,
              id: notification.id.replace(input.workflowRun.id, seasonRunId),
              workflowRunId: seasonRunId,
            }))
          : [],
    });
  }
  return bridged;
}

/**
 * A replace_request run on a show (user message): the same resource-sync workflow
 * over EVERY tracked season of the work on this drive, with the user's request
 * threaded to the agent. The episodes to replace stay obtained (the old files are
 * still there), gaps found on the way are filled too.
 *
 * Persistence: every other season gets a bare `${runId}_s${n}` record with its episode
 * states only; then the claimed lock run itself becomes the lock season's record and
 * carries the run's evidence + the replacement notification (so the activity page,
 * which follows the lock run id, sees it finish). With holdLockOpen the lock record is
 * saved `running` and the caller writes the terminal one last (see HeldLockRun).
 */
export async function runReplaceRequestV2AndPersist(
  input: TvV2Common & {
    seasons: Array<{ season: TrackedSeason; episodes: EpisodeState[] }>;
    /** The claimed lock run's season and audit trail (queued/claimed events are kept). */
    lockSeasonNumber: number;
    lockAuditEvents: AuditEvent[];
    // Declared, not spread: see the ⚠ above passthrough.
    userRequest: NonNullable<RunTvAcquisitionV2Request["userRequest"]>;
    /** How the replacement notification is pushed (see stampReplaceNotification). */
    notice?: ReplaceNotice;
    /** See HeldLockRun. */
    holdLockOpen?: boolean;
  },
): Promise<BridgedV2Result & Partial<HeldLockRun>> {
  const now = resolveNow(input);
  const priorObtained = input.seasons.flatMap((entry) =>
    entry.episodes.filter((episode) => episode.obtained).map((episode) => episode.episodeCode),
  );
  const missing = input.seasons.reduce(
    (sum, entry) => sum + entry.episodes.filter((episode) => episode.airStatus === "aired" && !episode.obtained).length,
    0,
  );
  const bridged = await runTvAcquisitionV2({
    title: input.title,
    mode: "replace",
    seasons: input.seasons.map(({ season }) => ({
      seasonNumber: season.seasonNumber,
      totalEpisodes: season.totalEpisodes,
      latestAiredEpisode: season.latestAiredEpisode,
      qualityPreference: season.qualityPreference,
      status: season.status,
    })),
    categoryParentId: input.categoryParentId,
    resourceProvider: input.resourceProvider,
    storage: input.storage,
    deadLinkStore: input.repository,
    model: input.model,
    workflowRunId: input.workflowRun.id,
    priorObtained,
    userRequest: input.userRequest,
    now,
    onProgress: progressAndTraceSink({
      repository: input.repository,
      workflowRunId: input.workflowRun.id,
      neededHint: Math.max(1, missing + input.userRequest.requestedEpisodes.length),
      storage: input.storage,
    }),
    ...passthrough(input),
    ...(await protectExistingOption(input)),
    ...rejectedLookupOption(input),
    ...linkHistoryOption({ ...input, workflowRunId: input.workflowRun.id, now }),
  });

  const lock = bridged.seasons.find((entry) => entry.season.seasonNumber === input.lockSeasonNumber);
  if (!lock) {
    // Without it the claimed run would never get a record of its own and stay running.
    throw new Error(`REPLACE_LOCK_SEASON_MISSING: season ${input.lockSeasonNumber} is not among the run's seasons`);
  }
  const owner = {
    ...(input.accountId ? { accountId: input.accountId } : {}),
    ...(input.connectedStorageId != null ? { connectedStorageId: input.connectedStorageId } : {}),
  };
  const finishedAt = now();
  for (const seasonResult of bridged.seasons) {
    if (seasonResult === lock) continue;
    const runId = `${input.workflowRun.id}_s${seasonResult.season.seasonNumber}`;
    await input.repository.saveWorkflowRunSnapshot({
      ...owner,
      title: input.title,
      season: seasonResult.season,
      workflowRun: {
        id: runId,
        kind: "replace_request",
        status: bridged.status,
        trackedSeasonId: seasonResult.season.id,
        startedAt: input.workflowRun.startedAt,
        finishedAt,
        auditEvents: [],
      },
      episodes: seasonResult.episodes,
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });
  }
  const held = await saveRunRecord(
    { ...input, now },
    bridged.status,
    stampNotifications(bridged.notifications, input.notice),
    (run, notifications) => ({
      ...owner,
      title: input.title,
      season: lock.season,
      workflowRun: {
        ...run,
        id: input.workflowRun.id,
        kind: "replace_request",
        trackedSeasonId: lock.season.id,
        startedAt: input.workflowRun.startedAt,
        auditEvents: [...input.lockAuditEvents, ...bridged.auditEvents],
      },
      episodes: lock.episodes,
      resourceSnapshots: bridged.resourceSnapshots,
      decisions: bridged.decisions,
      transferAttempts: bridged.transferAttempts,
      notifications,
    }),
  );
  return { ...bridged, ...held };
}

/**
 * A leftover staging dir, judged by the agent and persisted like any other TV run.
 * No notification. The lock season keeps the claimed run id; other seasons get a
 * sibling record so their obtained marks land. Each of those writes is skipped
 * when the season was untracked while this hidden run was going — the untrack wins.
 * Memory reflection is skipped inside the engine (`stagingRecovery`).
 */
export async function runStagingRecoveryV2AndPersist(
  input: TvV2Common & {
    seasons: Array<{ season: TrackedSeason; episodes: EpisodeState[] }>;
    lockSeasonNumber: number;
    lockAuditEvents: AuditEvent[];
    stagingRecovery: NonNullable<RunTvAcquisitionV2Request["stagingRecovery"]>;
  },
): Promise<BridgedV2Result> {
  const now = resolveNow(input);
  const priorObtained = input.seasons.flatMap((entry) =>
    entry.episodes.filter((episode) => episode.obtained).map((episode) => episode.episodeCode),
  );
  const bridged = await runTvAcquisitionV2({
    title: input.title,
    mode: "type3",
    seasons: input.seasons.map(({ season }) => ({
      seasonNumber: season.seasonNumber,
      totalEpisodes: season.totalEpisodes,
      latestAiredEpisode: season.latestAiredEpisode,
      qualityPreference: season.qualityPreference,
      status: season.status,
    })),
    categoryParentId: input.categoryParentId,
    resourceProvider: input.resourceProvider,
    storage: input.storage,
    deadLinkStore: input.repository,
    model: input.model,
    workflowRunId: input.workflowRun.id,
    priorObtained,
    stagingRecovery: input.stagingRecovery,
    now,
    onProgress: progressAndTraceSink({
      repository: input.repository,
      workflowRunId: input.workflowRun.id,
      neededHint: Math.max(1, input.seasons.reduce((sum, entry) => sum + entry.season.totalEpisodes, 0)),
      storage: input.storage,
    }),
    ...passthrough(input),
  });

  const lock = bridged.seasons.find((entry) => entry.season.seasonNumber === input.lockSeasonNumber);
  if (!lock) {
    throw new Error(`STAGING_RECOVERY_LOCK_SEASON_MISSING: season ${input.lockSeasonNumber} is not among the run's seasons`);
  }
  const owner = {
    ...(input.accountId ? { accountId: input.accountId } : {}),
    ...(input.connectedStorageId != null ? { connectedStorageId: input.connectedStorageId } : {}),
  };
  const finishedAt = now();
  for (const seasonResult of bridged.seasons) {
    if (seasonResult === lock) continue;
    const runId = `${input.workflowRun.id}_s${seasonResult.season.seasonNumber}`;
    await input.repository.saveWorkflowRunSnapshot({
      ...owner,
      title: input.title,
      season: seasonResult.season,
      workflowRun: {
        id: runId,
        kind: "staging_recovery",
        status: bridged.status,
        trackedSeasonId: seasonResult.season.id,
        startedAt: input.workflowRun.startedAt,
        finishedAt,
        auditEvents: [],
      },
      episodes: seasonResult.episodes,
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
      requireTrackedSeason: true,
    });
  }
  await input.repository.saveWorkflowRunSnapshot({
    ...owner,
    title: input.title,
    season: lock.season,
    workflowRun: {
      id: input.workflowRun.id,
      kind: "staging_recovery",
      status: bridged.status,
      trackedSeasonId: lock.season.id,
      startedAt: input.workflowRun.startedAt,
      finishedAt,
      auditEvents: [...input.lockAuditEvents, ...bridged.auditEvents],
    },
    episodes: lock.episodes,
    resourceSnapshots: bridged.resourceSnapshots,
    decisions: bridged.decisions,
    transferAttempts: bridged.transferAttempts,
    notifications: [],
    requireTrackedSeason: true,
  });
  return { ...bridged, notifications: [] };
}

/**
 * holdLockOpen (replace runs): the run's own record is saved with status `running` —
 * episodes and evidence written, no notification — and finishLockRun writes the
 * terminal record (status, finishedAt, notification). The caller makes that its very
 * last write, after the request bookkeeping: while a replace run is active, untracking
 * its work is refused (in_flight), so nothing the run still has to write can land on a
 * work the user has just untracked.
 */
export interface HeldLockRun {
  finishLockRun: () => Promise<void>;
}

/** The run fields a record builder fills in; the builder adds the run's identity. */
type RunRecordFields = Partial<WorkflowRun> & Pick<WorkflowRun, "status" | "finishedAt">;

/** Saves a run's own record: terminal now, or — holdLockOpen — `running`, with a
 *  finishLockRun for the terminal one (see HeldLockRun). */
async function saveRunRecord(
  input: {
    repository: WorkflowRepository;
    accountId?: string;
    connectedStorageId?: string | null;
    workflowRun: WorkflowRunMetadata;
    holdLockOpen?: boolean;
    now: () => string;
  },
  status: WorkflowStatus,
  notifications: NotificationEvent[],
  record: (run: RunRecordFields, notifications: NotificationEvent[]) => PersistWorkflowRunSnapshotInput,
): Promise<Partial<HeldLockRun>> {
  const terminal = () => input.repository.saveWorkflowRunSnapshot(record({ status, finishedAt: input.now() }, notifications));
  if (!input.holdLockOpen) {
    await terminal();
    return {};
  }
  // Saved over the live run: what the claim and the run left on it stay — the
  // crash-recovery count (the poison-run cap) and the progress the activity page shows.
  await input.repository.saveWorkflowRunSnapshot(record({ ...(await liveRun(input)), status: "running", finishedAt: null }, []));
  return { finishLockRun: terminal };
}

/** The run as stored now. Best-effort: a failed read only loses the fields it would keep. */
async function liveRun(input: {
  repository: WorkflowRepository;
  accountId?: string;
  connectedStorageId?: string | null;
  workflowRun: WorkflowRunMetadata;
}): Promise<Partial<WorkflowRun>> {
  try {
    const stored = await input.repository.getWorkflowRunSnapshot(input.workflowRun.id, {
      accountId: input.accountId ?? DEFAULT_ACCOUNT_ID,
      connectedStorageId: input.connectedStorageId ?? null,
    });
    return stored?.workflowRun ?? {};
  } catch (error) {
    console.error(`[user-message] run ${input.workflowRun.id} could not read its live record: ${String(error).slice(0, 300)}`);
    return {};
  }
}

/** See stampReplaceNotification. */
export type ReplaceNotice = Parameters<typeof stampReplaceNotification>[1];

function stampNotifications<T extends NotificationEvent>(notifications: T[], notice: ReplaceNotice | undefined): NotificationEvent[] {
  return notice ? notifications.map((n) => stampReplaceNotification(n, notice)) : notifications;
}

export async function runMovieAcquisitionV2AndPersist(input: {
  title: MediaTitle;
  categoryParentId: string;
  resourceProvider: ResourceProvider;
  storage: StorageExecutor;
  model: LanguageModel;
  repository: WorkflowRepository;
  /** §7: owning account for the persisted record (see TvV2Common.accountId). */
  accountId?: string;
  /** Tree model: owning connected storage (see TvV2Common.connectedStorageId). */
  connectedStorageId?: string | null;
  workflowRun: WorkflowRunMetadata;
  searchBudget?: number;
  maxSteps?: number;
  preferredLanguage?: string;
  /** Global quality preference ("high"/"medium"); undefined = 不限 (no guidance). */
  qualityPreference?: "high" | "medium";
  /** The run's drive brand ("pan115" | "quark") — selects brand-specific skill. */
  storageProvider?: string;
  /** assrt token (Settings → 字幕来源). Undefined = 字幕流程不触发。 */
  assrtToken?: string;
  /** Optional Jev candidate prefilter (Settings); resolved per account by the worker. */
  jevJudge?: JevJudge;
  /** See TvV2Common.agentMemory. */
  agentMemory?: boolean;
  /** A replace_request run (user message): persisted under kind replace_request. */
  userRequest?: RunMovieAcquisitionV2Request["userRequest"];
  /** Replace runs: whether the film was obtained before (see RunMovieAcquisitionV2Request). */
  priorObtained?: boolean;
  /** How the notification is pushed (see stampReplaceNotification): replace runs, and
   *  the patrol's film runs (scheduled, into the daily digest). */
  notice?: ReplaceNotice;
  /** Replace runs: see HeldLockRun. */
  holdLockOpen?: boolean;
  /** See TvV2Common.now — finishedAt is stamped post-run from this clock. */
  now?: () => string;
}): Promise<MovieAcquisitionV2Result & Partial<HeldLockRun>> {
  const now = resolveNow(input);
  const result = await runMovieAcquisitionV2({
    title: input.title,
    resourceProvider: input.resourceProvider,
    storage: input.storage,
    model: input.model,
    workflowRunId: input.workflowRun.id,
    moviesParentDirectoryId: input.categoryParentId,
    now,
    deadLinkStore: input.repository,
    onProgress: progressAndTraceSink({
      repository: input.repository,
      workflowRunId: input.workflowRun.id,
      neededHint: 1,
      storage: input.storage,
    }),
    ...(input.searchBudget === undefined ? {} : { searchBudget: input.searchBudget }),
    ...(input.maxSteps === undefined ? {} : { maxSteps: input.maxSteps }),
    ...(input.preferredLanguage === undefined ? {} : { preferredLanguage: input.preferredLanguage }),
    ...(input.qualityPreference === undefined ? {} : { qualityPreference: input.qualityPreference }),
    ...(input.storageProvider === undefined ? {} : { storageProvider: input.storageProvider }),
    ...(input.assrtToken === undefined ? {} : { assrtToken: input.assrtToken }),
    ...(input.jevJudge === undefined ? {} : { jevJudge: input.jevJudge }),
    ...(input.userRequest === undefined ? {} : { userRequest: input.userRequest }),
    ...(input.priorObtained === undefined ? {} : { priorObtained: input.priorObtained }),
    ...(await protectExistingOption(input)),
    ...rejectedLookupOption(input),
    ...linkHistoryOption({ ...input, workflowRunId: input.workflowRun.id, now }),
    ...memoryOption(input),
  });

  const held = await saveRunRecord({ ...input, now }, result.status, stampNotifications(result.notifications, input.notice), (run, notifications) => ({
    ...(input.accountId ? { accountId: input.accountId } : {}),
    ...(input.connectedStorageId != null ? { connectedStorageId: input.connectedStorageId } : {}),
    title: input.title,
    season: result.season,
    workflowRun: {
      ...run,
      id: input.workflowRun.id,
      kind: input.userRequest ? "replace_request" : "movie_init",
      trackedSeasonId: result.season.id,
      startedAt: input.workflowRun.startedAt,
      auditEvents: result.auditEvents,
    },
    episodes: result.episodes,
    resourceSnapshots: result.resourceSnapshots,
    decisions: result.decisions,
    transferAttempts: result.transferAttempts,
    notifications,
  }));
  return { ...result, ...held };
}
