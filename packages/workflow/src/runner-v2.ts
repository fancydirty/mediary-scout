import {
  DEFAULT_ACCOUNT_ID,
  type AcquisitionSeasonScope,
  type AuditEvent,
  type EpisodeCopy,
  type EpisodeState,
  type MediaTitle,
  type NotificationEvent,
  type TrackedSeason,
  type WorkflowKind,
  type WorkflowRun,
  type WorkflowRunMetadata,
  type WorkflowStatus,
} from "./domain.js";
import type { AgentMemoryStore } from "./agent-memory.js";
import type { LanguageModel } from "ai";
import { runTvAcquisitionV2, type RunTvAcquisitionV2Request } from "./acquisition-v2/run-tv-v2.js";
import type { TitleResearchOptions } from "./acquisition-v2/title-research.js";
import type { BridgedV2Result } from "./acquisition-v2/workflow-v2-bridge.js";
import { makeProgressSink } from "./acquisition-v2/progress-sink.js";
import { makeAgentTraceSink, combineToolEventSinks } from "./acquisition-v2/agent-trace-sink.js";
import { runMovieAcquisitionV2, type MovieAcquisitionV2Result, type RunMovieAcquisitionV2Request } from "./movie-workflow-v2.js";
import type { JevJudge } from "./jev-judge.js";
import type { AcquisitionDriveContext, ResourceProvider, StorageExecutor } from "./ports.js";
import type { PersistWorkflowRunSnapshotInput, WorkflowRepository } from "./repository.js";
import { userMessageDrive } from "./user-requests.js";
import { formatReportPushText, stampReplaceNotification } from "./notification-report.js";
import { shortDriveLabel } from "./storage-brands.js";

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
  /** Web-reference tools (alternate titles, fan-season ↔ TMDB episode mapping). */
  titleResearch?: TitleResearchOptions;
  /** Ordered active drives for this account in unified multi-drive mode. */
  drives?: AcquisitionDriveContext[];
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
  titleResearch?: TitleResearchOptions;
  drives?: AcquisitionDriveContext[];
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
    ...(input.titleResearch === undefined ? {} : { titleResearch: input.titleResearch }),
    ...(input.drives === undefined ? {} : { drives: input.drives }),
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

/** Infer an episode code for a file already placed inside a known `Season NN`
 *  directory when `episodeCodeFromFileName` returned null (e.g. `1.mp4`..`8.mp4`
 *  or `EP03.mkv`). Used ONLY for attributing already-marked `obtainedEpisodes` to
 *  their storage drive and file IDs — never to decide whether an episode is obtained
 *  (that stays 100% the agent's `markObtained`). */
function inferSeasonFileEpisodeCode(
  fileName: string | undefined,
  seasonNumber: number,
  explicitCode: string | null,
): string | null {
  if (explicitCode) return explicitCode;
  if (!fileName) return null;
  const seasonPrefix = `S${String(seasonNumber).padStart(2, "0")}`;
  const stem = fileName.replace(/\.[A-Za-z0-9]+$/, "").trim();
  const bareDigits = /^0*(\d{1,4})$/.exec(stem);
  if (bareDigits?.[1]) {
    const epNum = Number(bareDigits[1]);
    if (epNum > 0) {
      return `${seasonPrefix}E${String(epNum).padStart(2, "0")}`;
    }
  }
  const epTag = /(?:^|[^A-Za-z0-9])(?:EP?|E)\s*0*(\d{1,4})(?:$|[^A-Za-z0-9])/i.exec(stem);
  if (epTag?.[1]) {
    const epNum = Number(epTag[1]);
    if (epNum > 0) {
      return `${seasonPrefix}E${String(epNum).padStart(2, "0")}`;
    }
  }
  return null;
}

interface TouchedSeasonDriveScan {
  drive: NonNullable<BridgedV2Result["touchedTargetDrives"]>[number];
  seasonDirId: string;
  videoFiles: Array<{ id: string; name?: string; sizeBytes: number; episodeCode: string | null }>;
  byEp: Map<string, { fileIds: string[]; sizeBytes: number }>;
}

async function scanTouchedSeasonDrives(
  touched: NonNullable<BridgedV2Result["touchedTargetDrives"]>,
  seasonNumber: number,
): Promise<TouchedSeasonDriveScan[]> {
  const results = await Promise.all(
    touched.map(async (drive): Promise<TouchedSeasonDriveScan | null> => {
      const seasonDirId = drive.seasonDirectoryIds[seasonNumber];
      if (!seasonDirId) return null;
      let videoFiles: Array<{ id: string; name?: string; sizeBytes: number; episodeCode: string | null }> = [];
      try {
        videoFiles = await drive.executor.listVideoFiles(seasonDirId);
      } catch {
        videoFiles = [];
      }
      const byEp = new Map<string, { fileIds: string[]; sizeBytes: number }>();
      for (const vf of videoFiles) {
        const code = inferSeasonFileEpisodeCode(vf.name, seasonNumber, vf.episodeCode);
        if (!code) continue;
        const cur = byEp.get(code) ?? { fileIds: [], sizeBytes: 0 };
        cur.fileIds.push(vf.id);
        cur.sizeBytes += vf.sizeBytes;
        byEp.set(code, cur);
      }
      return { drive, seasonDirId, videoFiles, byEp };
    }),
  );
  return results.filter((s): s is TouchedSeasonDriveScan => s !== null);
}

function createLazySeasonScans(
  touched: BridgedV2Result["touchedTargetDrives"],
  seasonNumber: number,
): () => Promise<TouchedSeasonDriveScan[]> {
  let promise: Promise<TouchedSeasonDriveScan[]> | undefined;
  return () => {
    promise ??= scanTouchedSeasonDrives(touched ?? [], seasonNumber);
    return promise;
  };
}

async function resolvePrimaryDriveSeasonEpisodes(input: {
  repository: WorkflowRepository;
  accountId: string;
  primaryStorageId: string | null;
  seasonResult: BridgedV2Result["seasons"][number];
  touchedTargetDrives: BridgedV2Result["touchedTargetDrives"];
  getScans?: () => Promise<TouchedSeasonDriveScan[]>;
}): Promise<EpisodeState[]> {
  const touched = input.touchedTargetDrives ?? [];
  if (touched.length === 0 || !input.primaryStorageId) {
    return input.seasonResult.episodes;
  }
  const scans = input.getScans
    ? await input.getScans()
    : await scanTouchedSeasonDrives(touched, input.seasonResult.season.seasonNumber);
  const nonEmptyScans = scans.filter((s) => s.videoFiles.length > 0);
  const primaryScan = scans.find((s) => s.drive.storageId === input.primaryStorageId);
  if (
    (touched.length === 1 && primaryScan) ||
    (nonEmptyScans.length === 1 && nonEmptyScans[0]!.drive.storageId === input.primaryStorageId)
  ) {
    return input.seasonResult.episodes;
  }
  const byEp = new Map<string, string[]>();
  if (primaryScan) {
    for (const [code, info] of primaryScan.byEp) {
      byEp.set(code, info.fileIds);
    }
  }
  const existingState = await input.repository.getTrackedSeasonState(
    input.seasonResult.season.id,
    { accountId: input.accountId, connectedStorageId: input.primaryStorageId },
  );
  const priorByCode = new Map(
    (existingState?.episodes ?? []).filter((e) => e.obtained).map((e) => [e.episodeCode, e.verifiedFileIds]),
  );
  return input.seasonResult.episodes.map((ep) => {
    const driveFiles = ep.obtained ? byEp.get(ep.episodeCode) : undefined;
    const priorFiles = priorByCode.get(ep.episodeCode);
    const hasDriveFiles = Boolean(driveFiles && driveFiles.length > 0);
    const obtainedOnPrimary = hasDriveFiles || priorFiles !== undefined;
    return {
      ...ep,
      obtained: obtainedOnPrimary,
      verifiedFileIds: hasDriveFiles ? driveFiles! : priorFiles ?? [],
    };
  });
}

async function recordTouchedSeasonCopies(input: {
  repository: WorkflowRepository;
  accountId: string;
  primaryStorageId: string | null;
  title: MediaTitle;
  seasonResult: BridgedV2Result["seasons"][number];
  touchedTargetDrives: BridgedV2Result["touchedTargetDrives"];
  runId: string;
  recordedAt: string;
  getScans?: () => Promise<TouchedSeasonDriveScan[]>;
  /** Episodes the primary drive already held before this run. Their copies were
   *  recorded when they landed; this run carries no file ids for them, so it must not
   *  record them again, nor hand them to another drive. */
  priorObtained?: ReadonlySet<string>;
}): Promise<EpisodeCopy[]> {
  if (!input.repository.upsertEpisodeCopies) {
    return [];
  }
  const touched = input.touchedTargetDrives ?? [];
  const obtainedEpisodes = input.seasonResult.episodes.filter((ep) => ep.obtained);
  if (obtainedEpisodes.length === 0) {
    return [];
  }
  const prior = input.priorObtained ?? new Set<string>();
  const landedThisRun = obtainedEpisodes.filter((ep) => !prior.has(ep.episodeCode));

  // If no multi-drive coordinator ran (or only the primary drive was touched),
  // record episode_copies against the primary drive when known — only for what
  // landed this run: an already-current patrol has nothing to record (issue #369).
  if (touched.length === 0) {
    if (!input.primaryStorageId || landedThisRun.length === 0) return [];
    const copies: EpisodeCopy[] = landedThisRun.map((ep) => ({
      trackedSeasonId: input.seasonResult.season.id,
      episodeCode: ep.episodeCode,
      storageId: input.primaryStorageId!,
      fileIds: [...ep.verifiedFileIds],
      sizeBytes: null,
      quality: null,
      runId: input.runId,
      recordedAt: input.recordedAt,
    }));
    await input.repository.upsertEpisodeCopies(copies);
    return copies;
  }

  // Inspect each touched drive's season directory to attribute episodes and file sizes
  // to the exact storageId where they landed (C8 single source of truth).
  // An empty directory created during a read-only probe on another drive (0 videoFiles)
  // must not prevent single-drive attribution when only one drive actually holds files.
  const scans = input.getScans
    ? await input.getScans()
    : await scanTouchedSeasonDrives(touched, input.seasonResult.season.seasonNumber);
  const nonEmptyScans = scans.filter((s) => s.videoFiles.length > 0);
  let singleNonEmptyDriveId: string | null = null;
  if (nonEmptyScans.length === 1) {
    singleNonEmptyDriveId = nonEmptyScans[0]!.drive.storageId;
  } else if (scans.length === 1) {
    singleNonEmptyDriveId = scans[0]!.drive.storageId;
  }

  const copies: EpisodeCopy[] = [];
  const verifiedByCode = new Map(
    obtainedEpisodes.map((e) => [e.episodeCode, e.verifiedFileIds]),
  );
  for (const scan of scans) {
    const { drive, seasonDirId, videoFiles, byEp } = scan;
    let driveCodes: string[] = [];
    if (singleNonEmptyDriveId === drive.storageId) {
      // Only this drive received video files for the season → what the agent marked
      // obtained this run belongs to this drive (even if filenames are opaque). The
      // primary's earlier episodes were recorded when they landed.
      driveCodes = landedThisRun.map((e) => e.episodeCode);
    } else if (byEp.size > 0) {
      driveCodes = [...byEp.keys()].filter((code) => verifiedByCode.has(code));
    }
    // What a secondary drive already held: kept in its snapshot below, and a reason
    // not to share its directory's bytes among this run's episodes.
    const existingDriveState =
      drive.storageId !== input.primaryStorageId && driveCodes.length > 0
        ? await input.repository.getTrackedSeasonState(input.seasonResult.season.id, {
            accountId: input.accountId,
            connectedStorageId: drive.storageId,
          })
        : null;
    const driveHeldBefore =
      drive.storageId === input.primaryStorageId
        ? prior.size > 0
        : (existingDriveState?.episodes ?? []).some((e) => e.obtained);
    // Opaque names: share the directory's bytes among the episodes — only when the
    // directory holds nothing but this run's files (no episode the drive held before).
    const dirHoldsOnlyThisRun = !driveHeldBefore;
    const perFileFallbackBytes =
      byEp.size === 0 && videoFiles.length > 0 && driveCodes.length > 0 && dirHoldsOnlyThisRun
        ? Math.round(videoFiles.reduce((sum, vf) => sum + vf.sizeBytes, 0) / driveCodes.length)
        : null;
    for (const code of driveCodes) {
      const info = byEp.get(code);
      const fallbackFileIds = verifiedByCode.get(code) ?? [];
      copies.push({
        trackedSeasonId: input.seasonResult.season.id,
        episodeCode: code,
        storageId: drive.storageId,
        fileIds: info && info.fileIds.length > 0 ? info.fileIds : [...fallbackFileIds],
        sizeBytes: info ? info.sizeBytes : perFileFallbackBytes,
        quality: null,
        runId: input.runId,
        recordedAt: input.recordedAt,
      });
    }

    // If episodes landed on a secondary drive (different from primaryStorageId),
    // also persist/update that drive's (tracked_season_id, connected_storage_id) bucket
    // so `episode_states` and `episode_copies` stay 100% consistent across all drives.
    if (drive.storageId !== input.primaryStorageId && driveCodes.length > 0) {
      const driveCodeSet = new Set(driveCodes);
      const priorByCode = new Map(
        (existingDriveState?.episodes ?? []).filter((e) => e.obtained).map((e) => [e.episodeCode, e.verifiedFileIds]),
      );
      const driveEpisodes = input.seasonResult.episodes.map((ep) => {
        const inDriveSet = driveCodeSet.has(ep.episodeCode);
        const info = inDriveSet ? byEp.get(ep.episodeCode) : undefined;
        const priorFiles = priorByCode.get(ep.episodeCode);
        const isObtained = inDriveSet || priorFiles !== undefined;
        let verifiedFileIds: string[] = [];
        if (info && info.fileIds.length > 0) {
          verifiedFileIds = info.fileIds;
        } else if (priorFiles !== undefined) {
          verifiedFileIds = priorFiles;
        } else if (inDriveSet) {
          verifiedFileIds = ep.verifiedFileIds;
        }
        return {
          ...ep,
          obtained: isObtained,
          verifiedFileIds,
        };
      });
      // The snapshot replaces this drive's records: an episode it held that the run's
      // result has no row for (a provider-ahead episode past the season's range) stays.
      const resultCodes = new Set(input.seasonResult.episodes.map((ep) => ep.episodeCode));
      for (const held of existingDriveState?.episodes ?? []) {
        if (held.obtained && !resultCodes.has(held.episodeCode)) driveEpisodes.push(held);
      }
      const sideRunId = `${input.runId}_drv_${drive.storageId.slice(-8)}`;
      await input.repository.saveWorkflowRunSnapshot({
        accountId: input.accountId,
        connectedStorageId: drive.storageId,
        title: input.title,
        season: {
          ...input.seasonResult.season,
          storageDirectoryId: seasonDirId,
        },
        workflowRun: {
          id: sideRunId,
          kind: "type2_init",
          status: "succeeded",
          trackedSeasonId: input.seasonResult.season.id,
          startedAt: input.recordedAt,
          finishedAt: input.recordedAt,
          auditEvents: [],
        },
        episodes: driveEpisodes,
        resourceSnapshots: [],
        decisions: [],
        transferAttempts: [],
        notifications: [],
      });
    }
  }
  if (copies.length > 0) {
    await input.repository.upsertEpisodeCopies(copies);
  }
  return copies;
}

function appendMultiDriveBreakdownToNotifications(
  notifications: readonly NotificationEvent[],
  touchedTargetDrives: BridgedV2Result["touchedTargetDrives"],
  copies: readonly EpisodeCopy[],
): NotificationEvent[] {
  const touched = touchedTargetDrives ?? [];
  if (touched.length === 0) {
    return [...notifications];
  }
  const storageIdsWithCopies = new Set(copies.map((c) => c.storageId));
  const drivesWithFiles =
    storageIdsWithCopies.size > 0
      ? touched.filter((d) => storageIdsWithCopies.has(d.storageId))
      : [];
  const labelById = new Map(
    touched.map((d) => [d.storageId, shortDriveLabel(d.label)]),
  );
  const driveLabels = [...new Set(drivesWithFiles.map((d) => shortDriveLabel(d.label)))];
  const countByStorage = new Map<string, Set<string>>();
  for (const c of copies) {
    let set = countByStorage.get(c.storageId);
    if (!set) {
      set = new Set();
      countByStorage.set(c.storageId, set);
    }
    set.add(`${c.trackedSeasonId}:${c.episodeCode}`);
  }
  let breakdownLine: string | null = null;
  if (touched.length > 1 && countByStorage.size > 1) {
    const parts: string[] = [];
    for (const [storageId, codes] of countByStorage) {
      const label = labelById.get(storageId) ?? storageId;
      parts.push(`${label} ${codes.size} 集`);
    }
    breakdownLine = `跨盘分布：${parts.join(" · ")}`;
  }
  return notifications.map((n) => {
    if (!n.report) return n;
    const nextReport = {
      ...n.report,
      ...(driveLabels.length > 0 ? { driveLabels } : {}),
      ...(breakdownLine ? { lines: [...n.report.lines, breakdownLine] } : {}),
    };
    return {
      ...n,
      report: nextReport,
      body: breakdownLine ? formatReportPushText(nextReport) : n.body,
    };
  });
}

async function persistSingleSeason(input: {
  kind: WorkflowKind;
  title: MediaTitle;
  bridged: BridgedV2Result;
  workflowRun: WorkflowRunMetadata;
  repository: WorkflowRepository;
  accountId?: string;
  connectedStorageId?: string | null;
  /** See recordTouchedSeasonCopies. */
  priorObtained?: ReadonlySet<string>;
}): Promise<void> {
  const seasonResult = input.bridged.seasons[0]!;
  const accountId = input.accountId ?? DEFAULT_ACCOUNT_ID;
  const primaryStorageId =
    input.connectedStorageId ?? input.bridged.touchedTargetDrives?.[0]?.storageId ?? null;
  const getScans = createLazySeasonScans(
    input.bridged.touchedTargetDrives,
    seasonResult.season.seasonNumber,
  );
  const primaryEpisodes = await resolvePrimaryDriveSeasonEpisodes({
    repository: input.repository,
    accountId,
    primaryStorageId,
    seasonResult,
    touchedTargetDrives: input.bridged.touchedTargetDrives,
    getScans,
  });
  const copies = await recordTouchedSeasonCopies({
    repository: input.repository,
    accountId,
    primaryStorageId,
    title: input.title,
    seasonResult,
    touchedTargetDrives: input.bridged.touchedTargetDrives,
    runId: input.workflowRun.id,
    recordedAt: input.workflowRun.finishedAt ?? input.workflowRun.startedAt,
    getScans,
    ...(input.priorObtained ? { priorObtained: input.priorObtained } : {}),
  });
  const notifications = appendMultiDriveBreakdownToNotifications(
    input.bridged.notifications,
    input.bridged.touchedTargetDrives,
    copies,
  );
  await input.repository.saveWorkflowRunSnapshot({
    ...(input.accountId ? { accountId: input.accountId } : {}),
    ...(input.connectedStorageId !== undefined ? { connectedStorageId: input.connectedStorageId } : {}),
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
    episodes: primaryEpisodes,
    resourceSnapshots: input.bridged.resourceSnapshots,
    decisions: input.bridged.decisions,
    transferAttempts: input.bridged.transferAttempts,
    notifications,
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
  input: TvV2Common & {
    season: TrackedSeason;
    /** This drive's own episode records. */
    episodes: EpisodeState[];
    /** Episodes obtained on any of the account's drives. They count as had when the
     *  need is worked out, but are never written into this drive's records. */
    crossDriveObtained?: string[];
  },
): Promise<BridgedV2Result> {
  const now = resolveNow(input);
  const localObtained = new Set(input.episodes.filter((episode) => episode.obtained).map((episode) => episode.episodeCode));
  const obtainedAnywhere = new Set([...localObtained, ...(input.crossDriveObtained ?? [])]);
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
    priorObtained: [...obtainedAnywhere],
    now,
    onProgress: progressAndTraceSink({
      repository: input.repository,
      workflowRunId: input.workflowRun.id,
      neededHint: input.episodes.filter((episode) => episode.airStatus === "aired" && !obtainedAnywhere.has(episode.episodeCode)).length,
      storage: input.storage,
    }),
    ...passthrough(input),
    ...(await protectExistingOption(input)),
    ...rejectedLookupOption(input),
    ...linkHistoryOption({ ...input, workflowRunId: input.workflowRun.id, now }),
  });

  const elsewhereOnly = new Set([...obtainedAnywhere].filter((code) => !localObtained.has(code)));
  await persistSingleSeason({
    kind: "type3_monitor",
    title: input.title,
    bridged: {
      ...bridged,
      seasons: bridged.seasons.map((seasonResult) => keepDriveLocalRecords(seasonResult, input.episodes, elsewhereOnly)),
    },
    workflowRun: { ...input.workflowRun, finishedAt: now() },
    repository: input.repository,
    ...(input.accountId ? { accountId: input.accountId } : {}),
    ...(input.connectedStorageId != null ? { connectedStorageId: input.connectedStorageId } : {}),
    priorObtained: localObtained,
  });
  return bridged;
}

/**
 * The engine's season result as THIS drive's records (issue #369). The engine sees
 * every episode obtained on any drive as had and returns them obtained with no file
 * ids. Written as-is, a patrol would mark another drive's episodes obtained on this
 * one and empty the file ids this drive recorded. So an episode only another drive
 * has stays as this drive had it, and one this drive had keeps its file ids.
 */
function keepDriveLocalRecords(
  seasonResult: BridgedV2Result["seasons"][number],
  localEpisodes: readonly EpisodeState[],
  elsewhereOnly: ReadonlySet<string>,
): BridgedV2Result["seasons"][number] {
  const local = new Map(localEpisodes.map((episode) => [episode.episodeCode, episode]));
  const episodes: EpisodeState[] = [];
  for (const episode of seasonResult.episodes) {
    const mine = local.get(episode.episodeCode);
    if (episode.obtained && elsewhereOnly.has(episode.episodeCode)) {
      // A provider-ahead row past the season's range exists only because it was had.
      if (!mine && episode.metadataStatus === "provider_ahead") continue;
      episodes.push({ ...episode, obtained: false, metadataStatus: mine?.metadataStatus ?? "confirmed", verifiedFileIds: [] });
    } else if (episode.obtained && mine?.obtained && episode.verifiedFileIds.length === 0) {
      episodes.push({ ...episode, verifiedFileIds: [...mine.verifiedFileIds] });
    } else {
      episodes.push(episode);
    }
  }
  return { ...seasonResult, episodes };
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
  const accountId = input.accountId ?? DEFAULT_ACCOUNT_ID;
  const primaryStorageId =
    input.connectedStorageId ?? bridged.touchedTargetDrives?.[0]?.storageId ?? null;
  // One record per season under `${runId}_s${n}`, mirroring the old series
  // persistence: resource evidence + notifications ride on the first season
  // only (title-level), not duplicated across N season records.
  const allCopies: EpisodeCopy[] = [];
  const preparedSeasons: Array<{
    seasonResult: BridgedV2Result["seasons"][number];
    seasonRunId: string;
    primaryEpisodes: EpisodeState[];
  }> = [];
  for (const seasonResult of bridged.seasons) {
    const seasonRunId = `${input.workflowRun.id}_s${seasonResult.season.seasonNumber}`;
    const getScans = createLazySeasonScans(
      bridged.touchedTargetDrives,
      seasonResult.season.seasonNumber,
    );
    const primaryEpisodes = await resolvePrimaryDriveSeasonEpisodes({
      repository: input.repository,
      accountId,
      primaryStorageId,
      seasonResult,
      touchedTargetDrives: bridged.touchedTargetDrives,
      getScans,
    });
    const copies = await recordTouchedSeasonCopies({
      repository: input.repository,
      accountId,
      primaryStorageId,
      title: input.title,
      seasonResult,
      touchedTargetDrives: bridged.touchedTargetDrives,
      runId: seasonRunId,
      recordedAt: finishedAt,
      getScans,
    });
    allCopies.push(...copies);
    preparedSeasons.push({ seasonResult, seasonRunId, primaryEpisodes });
  }
  const enrichedNotifications = appendMultiDriveBreakdownToNotifications(
    bridged.notifications,
    bridged.touchedTargetDrives,
    allCopies,
  );
  for (const [index, { seasonResult, seasonRunId, primaryEpisodes }] of preparedSeasons.entries()) {
    await input.repository.saveWorkflowRunSnapshot({
      ...(input.accountId ? { accountId: input.accountId } : {}),
      ...(input.connectedStorageId !== undefined ? { connectedStorageId: input.connectedStorageId } : {}),
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
      episodes: primaryEpisodes,
      resourceSnapshots: index === 0 ? bridged.resourceSnapshots : [],
      decisions: index === 0 ? bridged.decisions : [],
      transferAttempts:
        index === 0
          ? bridged.transferAttempts.map((attempt) => ({ ...attempt, workflowRunId: seasonRunId }))
          : [],
      notifications:
        index === 0
          ? enrichedNotifications.map((notification) => ({
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
  const accountId = input.accountId ?? DEFAULT_ACCOUNT_ID;
  const primaryStorageId =
    input.connectedStorageId ?? bridged.touchedTargetDrives?.[0]?.storageId ?? null;
  const owner = {
    ...(input.accountId ? { accountId: input.accountId } : {}),
    ...(input.connectedStorageId !== undefined ? { connectedStorageId: input.connectedStorageId } : {}),
  };
  const finishedAt = now();
  const allReplaceCopies: EpisodeCopy[] = [];
  for (const seasonResult of bridged.seasons) {
    if (seasonResult === lock) continue;
    const runId = `${input.workflowRun.id}_s${seasonResult.season.seasonNumber}`;
    const getScans = createLazySeasonScans(
      bridged.touchedTargetDrives,
      seasonResult.season.seasonNumber,
    );
    const primaryEpisodes = await resolvePrimaryDriveSeasonEpisodes({
      repository: input.repository,
      accountId,
      primaryStorageId,
      seasonResult,
      touchedTargetDrives: bridged.touchedTargetDrives,
      getScans,
    });
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
      episodes: primaryEpisodes,
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });
    const copies = await recordTouchedSeasonCopies({
      repository: input.repository,
      accountId,
      primaryStorageId,
      title: input.title,
      seasonResult,
      touchedTargetDrives: bridged.touchedTargetDrives,
      runId,
      recordedAt: finishedAt,
      getScans,
    });
    allReplaceCopies.push(...copies);
  }
  const getLockScans = createLazySeasonScans(
    bridged.touchedTargetDrives,
    lock.season.seasonNumber,
  );
  const lockPrimaryEpisodes = await resolvePrimaryDriveSeasonEpisodes({
    repository: input.repository,
    accountId,
    primaryStorageId,
    seasonResult: lock,
    touchedTargetDrives: bridged.touchedTargetDrives,
    getScans: getLockScans,
  });
  const lockCopies = await recordTouchedSeasonCopies({
    repository: input.repository,
    accountId,
    primaryStorageId,
    title: input.title,
    seasonResult: lock,
    touchedTargetDrives: bridged.touchedTargetDrives,
    runId: input.workflowRun.id,
    recordedAt: finishedAt,
    getScans: getLockScans,
  });
  allReplaceCopies.push(...lockCopies);
  const enrichedReplaceNotifications = appendMultiDriveBreakdownToNotifications(
    stampNotifications(bridged.notifications, input.notice),
    bridged.touchedTargetDrives,
    allReplaceCopies,
  );
  const held = await saveRunRecord(
    { ...input, now },
    bridged.status,
    enrichedReplaceNotifications,
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
      episodes: lockPrimaryEpisodes,
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
    ...(input.connectedStorageId !== undefined ? { connectedStorageId: input.connectedStorageId } : {}),
  };
  const finishedAt = now();
  const accountId = input.accountId ?? DEFAULT_ACCOUNT_ID;
  const primaryStorageId =
    input.connectedStorageId ?? bridged.touchedTargetDrives?.[0]?.storageId ?? null;
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
    await recordTouchedSeasonCopies({
      repository: input.repository,
      accountId,
      primaryStorageId,
      title: input.title,
      seasonResult,
      touchedTargetDrives: bridged.touchedTargetDrives,
      runId,
      recordedAt: finishedAt,
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
  await recordTouchedSeasonCopies({
    repository: input.repository,
    accountId,
    primaryStorageId,
    title: input.title,
    seasonResult: lock,
    touchedTargetDrives: bridged.touchedTargetDrives,
    runId: input.workflowRun.id,
    recordedAt: finishedAt,
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
  /** Web-reference tools (alternate titles). */
  titleResearch?: TitleResearchOptions;
  /** Ordered active drives for this account in unified multi-drive mode. */
  drives?: AcquisitionDriveContext[];
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
    ...(input.titleResearch === undefined ? {} : { titleResearch: input.titleResearch }),
    ...(input.drives === undefined ? {} : { drives: input.drives }),
  });

  const accountId = input.accountId ?? DEFAULT_ACCOUNT_ID;
  const effectiveStorageId =
    input.connectedStorageId ?? result.touchedTargetDrives?.[0]?.storageId ?? null;
  const touchedMovieDrives = result.touchedTargetDrives ?? [];
  const movieDriveScans = await Promise.all(
    touchedMovieDrives.map(async (drive) => {
      const movieDirId = drive.directoryIds[0];
      if (!movieDirId) {
        return { drive, movieDirId: undefined, scanOk: false, videoFiles: [] as Array<{ id: string; sizeBytes: number }> };
      }
      try {
        const videoFiles = await drive.executor.listVideoFiles(movieDirId);
        return { drive, movieDirId, scanOk: true, videoFiles };
      } catch {
        return { drive, movieDirId, scanOk: false, videoFiles: [] as Array<{ id: string; sizeBytes: number }> };
      }
    }),
  );
  const isReplaceRun = Boolean(input.userRequest || result.replacement);
  const replacedMovieResult = (result.replacement?.results ?? []).find(
    (r) => r.outcome === "replaced" && r.episode === "MOVIE",
  );
  const replacedMovieDriveIds = new Set(
    (result.replacement?.results ?? [])
      .filter((r) => r.outcome === "replaced" && r.driveId)
      .map((r) => r.driveId!),
  );
  let activeMovieScans = movieDriveScans;
  if (replacedMovieDriveIds.size > 0) {
    activeMovieScans = movieDriveScans.filter((s) => replacedMovieDriveIds.has(s.drive.storageId));
  } else if (isReplaceRun && !replacedMovieResult) {
    activeMovieScans = [];
  } else {
    const nonEmpty = movieDriveScans.filter((s) => s.videoFiles.length > 0);
    activeMovieScans = nonEmpty.length > 0 ? nonEmpty : movieDriveScans.slice(0, 1);
  }
  let movieDrive = activeMovieScans[0]?.drive;
  if (!movieDrive && replacedMovieDriveIds.size === 0 && !(isReplaceRun && !replacedMovieResult)) {
    movieDrive = touchedMovieDrives[0];
  }
  const primaryScan = input.connectedStorageId
    ? movieDriveScans.find((s) => s.drive.storageId === input.connectedStorageId)
    : undefined;
  const primaryGotNewMovie =
    input.connectedStorageId !== null &&
    input.connectedStorageId !== undefined &&
    (activeMovieScans.some((s) => s.drive.storageId === input.connectedStorageId && s.videoFiles.length > 0) ||
      (touchedMovieDrives.length === 1 && movieDrive?.storageId === input.connectedStorageId));
  let primaryMovieEpisodes = result.episodes;
  if (
    input.connectedStorageId &&
    !primaryGotNewMovie &&
    (movieDrive || replacedMovieDriveIds.size > 0 || isReplaceRun)
  ) {
    const existingPrimary = await input.repository.getTrackedSeasonState(result.season.id, {
      accountId,
      connectedStorageId: input.connectedStorageId,
    });
    const priorByCode = new Map(
      (existingPrimary?.episodes ?? []).filter((e) => e.obtained).map((e) => [e.episodeCode, e.verifiedFileIds]),
    );
    const primaryDiskFiles = primaryScan && primaryScan.scanOk ? primaryScan.videoFiles.map((f) => f.id) : undefined;
    primaryMovieEpisodes = result.episodes.map((ep) => {
      const priorFiles = priorByCode.get(ep.episodeCode);
      const effectiveFiles = primaryDiskFiles !== undefined && primaryDiskFiles.length > 0 ? primaryDiskFiles : priorFiles;
      const hadPriorOnPrimary = (primaryDiskFiles !== undefined && primaryDiskFiles.length > 0) || priorFiles !== undefined;
      return {
        ...ep,
        obtained: hadPriorOnPrimary,
        verifiedFileIds: effectiveFiles ?? [],
      };
    });
  }
  const obtainedMovie = result.episodes.filter((ep) => ep.obtained);
  let movieDriveLabels: string[] = [];
  if (obtainedMovie.length > 0) {
    if (activeMovieScans.length > 0) {
      movieDriveLabels = activeMovieScans.map((s) => shortDriveLabel(s.drive.label));
    } else if (replacedMovieResult?.driveLabel) {
      movieDriveLabels = [replacedMovieResult.driveLabel];
    }
  }
  const movieNotifications = stampNotifications(result.notifications, input.notice).map((n) => {
    if (!n.report) return n;
    const nextLines =
      n.report.status === "replaced" && replacedMovieResult?.label
        ? ["已换成新版本", replacedMovieResult.label]
        : n.report.lines;
    const nextSize =
      n.report.status === "replaced" &&
      typeof replacedMovieResult?.sizeBytes === "number" &&
      replacedMovieResult.sizeBytes > 0
        ? { fileCount: 1, totalBytes: replacedMovieResult.sizeBytes }
        : {};
    const nextReport = {
      ...n.report,
      lines: nextLines,
      ...nextSize,
      ...(movieDriveLabels.length > 0 ? { driveLabels: [...new Set(movieDriveLabels)] } : {}),
    };
    return {
      ...n,
      report: nextReport,
      body: n.report.status === "replaced" ? formatReportPushText(nextReport) : n.body,
    };
  });
  const persistSecondaryMovieAndCopies = async () => {
    if (!input.repository.upsertEpisodeCopies || !effectiveStorageId) return;
    if (obtainedMovie.length === 0) return;
    if (isReplaceRun && replacedMovieDriveIds.size === 0 && !replacedMovieResult) return;
    const finishedAt = now();
    let targetScans = activeMovieScans;
    if (targetScans.length === 0 && movieDrive) {
      targetScans = [{ drive: movieDrive, movieDirId: movieDrive.directoryIds[0], scanOk: false, videoFiles: [] as Array<{ id: string; sizeBytes: number }> }];
    }
    if (targetScans.length === 0) {
      const fallbackStorageId = replacedMovieResult?.driveId ?? effectiveStorageId;
      if (input.connectedStorageId && fallbackStorageId !== input.connectedStorageId) {
        const sideRunId = `${input.workflowRun.id}_drv_${fallbackStorageId.slice(-8)}`;
        await input.repository.saveWorkflowRunSnapshot({
          accountId,
          connectedStorageId: fallbackStorageId,
          title: input.title,
          season: result.season,
          workflowRun: {
            id: sideRunId,
            kind: input.userRequest ? "replace_request" : "movie_init",
            status: "succeeded",
            trackedSeasonId: result.season.id,
            startedAt: finishedAt,
            finishedAt,
            auditEvents: [],
          },
          episodes: result.episodes,
          resourceSnapshots: [],
          decisions: [],
          transferAttempts: [],
          notifications: [],
        });
      }
      await input.repository.upsertEpisodeCopies(
        obtainedMovie.map((ep) => ({
          trackedSeasonId: result.season.id,
          episodeCode: ep.episodeCode,
          storageId: fallbackStorageId,
          fileIds: [...ep.verifiedFileIds],
          sizeBytes: replacedMovieResult?.sizeBytes ?? null,
          quality: null,
          runId: input.workflowRun.id,
          recordedAt: finishedAt,
        })),
      );
      return;
    }
    const copiesToUpsert: EpisodeCopy[] = [];
    const secondaryWrites: Array<Promise<void>> = [];
    for (const scan of targetScans) {
      const { drive, movieDirId, videoFiles } = scan;
      const fileIds = videoFiles.map((f) => f.id);
      const sizeBytes =
        videoFiles.reduce((sum, f) => sum + f.sizeBytes, 0) ||
        (replacedMovieDriveIds.has(drive.storageId) && typeof replacedMovieResult?.sizeBytes === "number"
          ? replacedMovieResult.sizeBytes
          : null);
      if (input.connectedStorageId && drive.storageId !== input.connectedStorageId) {
        const sideRunId = `${input.workflowRun.id}_drv_${drive.storageId.slice(-8)}`;
        secondaryWrites.push(
          input.repository.saveWorkflowRunSnapshot({
            accountId,
            connectedStorageId: drive.storageId,
            title: input.title,
            season: {
              ...result.season,
              ...(movieDirId ? { storageDirectoryId: movieDirId } : {}),
            },
            workflowRun: {
              id: sideRunId,
              kind: input.userRequest ? "replace_request" : "movie_init",
              status: "succeeded",
              trackedSeasonId: result.season.id,
              startedAt: finishedAt,
              finishedAt,
              auditEvents: [],
            },
            episodes: result.episodes,
            resourceSnapshots: [],
            decisions: [],
            transferAttempts: [],
            notifications: [],
          }),
        );
      }
      for (const ep of obtainedMovie) {
        copiesToUpsert.push({
          trackedSeasonId: result.season.id,
          episodeCode: ep.episodeCode,
          storageId: drive.storageId,
          fileIds: fileIds.length > 0 ? fileIds : [...ep.verifiedFileIds],
          sizeBytes,
          quality: null,
          runId: input.workflowRun.id,
          recordedAt: finishedAt,
        });
      }
    }
    await Promise.all(secondaryWrites);
    if (copiesToUpsert.length > 0) {
      await input.repository.upsertEpisodeCopies(copiesToUpsert);
    }
  };
  await persistSecondaryMovieAndCopies();
  const held = await saveRunRecord({ ...input, now }, result.status, movieNotifications, (run, notifications) => ({
    ...(input.accountId ? { accountId: input.accountId } : {}),
    ...(input.connectedStorageId !== undefined ? { connectedStorageId: input.connectedStorageId } : {}),
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
    episodes: primaryMovieEpisodes,
    resourceSnapshots: result.resourceSnapshots,
    decisions: result.decisions,
    transferAttempts: result.transferAttempts,
    notifications,
  }));
  return { ...result, ...held };
}
