import {
  createEpisodeStates,
  episodeCode,
  reconcileVerifiedFiles,
  type AcquisitionFailureEvidence,
  type AgentDecision,
  type AuditEvent,
  type EpisodeState,
  type MediaTitle,
  type NotificationEvent,
  type ResourceSnapshot,
  type TrackedSeason,
  type TransferAttempt,
  type VerifiedFile,
  type WorkflowStatus,
} from "./domain.js";
import { buildConfirmedDedupPlan } from "./dedup.js";
import { canonicalEpisodeFileName, episodeCodeFromFileName } from "./episode-code.js";
import {
  buildAgentAssistedPackageNormalizationPlan,
  type PackageMoveAction,
} from "./package-normalizer.js";
import {
  buildSeasonReport,
  buildSeriesReport,
  dominantQuality,
  formatReportPushText,
} from "./notification-report.js";
import {
  deriveAgentDecision,
  validateAcquisitionPlan,
  type SelectedTransferCandidate,
} from "./plan-validation.js";
import type {
  AcquisitionPlanningResult,
  AgentNodes,
  ResourceProvider,
  StorageExecutor,
} from "./ports.js";

const TYPE2_WORKFLOW_RUN_ID = "run_type2";
const TYPE3_WORKFLOW_RUN_ID = "run_type3";
const DEFAULT_MAX_PLANNING_PASSES = 2;

function defaultNowIso(): string {
  return new Date().toISOString();
}

export interface WorkflowResult {
  status: WorkflowStatus;
  /** The tracked season, updated when the workflow created its landing directory. */
  season: TrackedSeason;
  episodes: EpisodeState[];
  obtainedEpisodes: string[];
  providerAheadEpisodes: string[];
  resourceSnapshots: ResourceSnapshot[];
  transferAttempts: TransferAttempt[];
  decisions: AgentDecision[];
  notification: NotificationEvent;
  notifications: NotificationEvent[];
  auditEvents: AuditEvent[];
}

export async function runType2Initialization(input: {
  title: MediaTitle;
  season: TrackedSeason;
  keyword: string;
  resourceProvider: ResourceProvider;
  storage: StorageExecutor;
  agents: AgentNodes;
  workflowRunId?: string;
  maxPlanningPasses?: number;
  storageParentDirectoryId?: string;
  now?: () => string;
}): Promise<WorkflowResult> {
  const workflowRunId = input.workflowRunId ?? TYPE2_WORKFLOW_RUN_ID;
  const now = input.now ?? defaultNowIso;
  const auditEvents: AuditEvent[] = [];
  const landing = await ensureLandingDirectory({
    title: input.title,
    season: input.season,
    storage: input.storage,
    storageParentDirectoryId: input.storageParentDirectoryId,
    auditEvents,
  });
  const season = landing.season;
  const stagingParentDirectoryId = landing.showDirectoryId ?? input.storageParentDirectoryId;
  if (stagingParentDirectoryId === undefined) {
    throw new Error(
      "MEDIA_TRACK_STAGING_PARENT_REQUIRED: provide storageParentDirectoryId so staging directories can live outside the season directory",
    );
  }
  const freshEpisodes = createEpisodeStates({
    trackedSeasonId: season.id,
    seasonNumber: season.seasonNumber,
    totalEpisodes: season.totalEpisodes,
    latestAiredEpisode: season.latestAiredEpisode,
  });
  // The need set is what the season directory is actually missing, not the
  // full aired list: a re-run of an initialization that already landed files
  // must not re-transfer them.
  const existingFiles = await listSeasonVideoFilesWithRescue({
    storage: input.storage,
    agents: input.agents,
    title: input.title,
    seasonNumber: season.seasonNumber,
    directoryId: season.storageDirectoryId,
    auditEvents,
  });
  const episodes =
    existingFiles.length === 0
      ? freshEpisodes
      : reconcileVerifiedFiles({ season, episodes: freshEpisodes, files: existingFiles });
  const alreadyObtained = obtainedEpisodeCodes(episodes);
  if (alreadyObtained.length > 0) {
    auditEvents.push({
      type: "existing_content_reconciled",
      message: `${alreadyObtained.length} episodes already present in the season directory; excluded from the acquisition need set`,
      data: { seasonNumber: season.seasonNumber, episodes: alreadyObtained },
    });
  }
  const missingEpisodes = actionableMissingEpisodes(episodes);

  const outcome =
    missingEpisodes.length === 0
      ? emptyAcquisitionOutcome()
      : await acquireMissingEpisodes({
          title: input.title,
          seasons: [
            {
              seasonNumber: season.seasonNumber,
              totalEpisodes: season.totalEpisodes,
              latestAiredEpisode: season.latestAiredEpisode,
            },
          ],
          seasonDirectoryIds: { [season.seasonNumber]: season.storageDirectoryId },
          ...(landing.showDirectoryId === undefined ? {} : { showDirectoryId: landing.showDirectoryId }),
          stagingParentDirectoryId,
          qualityPreference: season.qualityPreference,
          keyword: input.keyword,
          missingEpisodes,
          resourceProvider: input.resourceProvider,
          storage: input.storage,
          agents: input.agents,
          workflowRunId,
          auditEvents,
          maxPlanningPasses: input.maxPlanningPasses ?? DEFAULT_MAX_PLANNING_PASSES,
        });

  const verifiedFiles = await dedupeLandingDirectory({
    storage: input.storage,
    directoryId: season.storageDirectoryId,
    auditEvents,
    title: input.title,
    seasonNumber: season.seasonNumber,
    agents: input.agents,
  });
  const reconciledEpisodes = reconcileVerifiedFiles({
    season,
    episodes,
    files: verifiedFiles,
  });
  const obtainedEpisodes = obtainedEpisodeCodes(reconciledEpisodes);
  const providerAheadEpisodes = collectProviderAheadEpisodes(reconciledEpisodes);
  const status = resolveAcquisitionStatus({
    missingBefore: missingEpisodes,
    stillMissingAfter: actionableMissingEpisodes(reconciledEpisodes),
  });
  const initQuality = dominantQuality(verifiedFiles.map((file) => file.name));
  const report = buildSeasonReport({
    titleName: input.title.title,
    season,
    episodes: reconciledEpisodes,
    noCoverage: status === "no_coverage",
    ...(initQuality ? { quality: initQuality } : {}),
  });
  const notification: NotificationEvent = {
    id: `notification_${workflowRunId}`,
    workflowRunId,
    kind: status === "no_coverage" ? "no_coverage" : "tracking_initialized",
    title: `${report.titleName} ${report.seasonLabel}`,
    body: formatReportPushText(report),
    createdAt: now(),
    trigger: "user",
    report,
  };

  return {
    status,
    season,
    episodes: reconciledEpisodes,
    obtainedEpisodes,
    providerAheadEpisodes,
    resourceSnapshots: outcome.resourceSnapshots,
    transferAttempts: outcome.transferAttempts,
    decisions: outcome.decisions,
    notification,
    notifications: [
      notification,
      ...foreignWorkNotificationsFromAudit({
        workflowRunId,
        titleName: input.title.title,
        auditEvents,
        now,
      }),
    ],
    auditEvents,
  };
}

/**
 * The canonical landing shape (`Title (Year)/Season N`) is created by the
 * workflow itself, never improvised by callers — the flatten safety rule
 * accepts exactly this shape.
 */
async function ensureLandingDirectory(input: {
  title: MediaTitle;
  season: TrackedSeason;
  storage: StorageExecutor;
  storageParentDirectoryId: string | undefined;
  auditEvents: AuditEvent[];
}): Promise<{ season: TrackedSeason; showDirectoryId?: string }> {
  if (input.season.storageDirectoryId !== "") {
    return { season: input.season };
  }
  if (!input.storageParentDirectoryId) {
    throw new Error(
      "MEDIA_TRACK_STORAGE_PARENT_REQUIRED: tracked season has no storage directory and no storageParentDirectoryId was provided",
    );
  }
  const showName = `${input.title.title} (${input.title.year})`;
  const showDirectoryId = await input.storage.createDirectory({
    name: showName,
    parentId: input.storageParentDirectoryId,
  });
  const seasonDirectoryId = await input.storage.createDirectory({
    name: `Season ${input.season.seasonNumber}`,
    parentId: showDirectoryId,
  });
  input.auditEvents.push({
    type: "landing_directory_created",
    message: `Created canonical landing directory ${showName}/Season ${input.season.seasonNumber}`,
    data: { showDirectoryId, seasonDirectoryId },
  });
  return { season: { ...input.season, storageDirectoryId: seasonDirectoryId }, showDirectoryId };
}

export async function runType3Monitoring(input: {
  title: MediaTitle;
  season: TrackedSeason;
  episodes: EpisodeState[];
  keyword: string;
  resourceProvider: ResourceProvider;
  storage: StorageExecutor;
  agents: AgentNodes;
  workflowRunId?: string;
  maxPlanningPasses?: number;
  storageParentDirectoryId?: string;
  now?: () => string;
}): Promise<WorkflowResult> {
  const workflowRunId = input.workflowRunId ?? TYPE3_WORKFLOW_RUN_ID;
  const now = input.now ?? defaultNowIso;
  if (input.season.storageDirectoryId === "") {
    throw new Error(
      "MEDIA_TRACK_TRACKING_NOT_INITIALIZED: tracked season has no storage directory; run Type 2 initialization first",
    );
  }
  const auditEvents: AuditEvent[] = [];
  const currentFiles = await listSeasonVideoFilesWithRescue({
    storage: input.storage,
    agents: input.agents,
    title: input.title,
    seasonNumber: input.season.seasonNumber,
    directoryId: input.season.storageDirectoryId,
    auditEvents,
  });
  let episodes = reconcileVerifiedFiles({
    season: input.season,
    episodes: input.episodes.map((episode) => {
      const matchingFiles = currentFiles.filter((file) => file.episodeCode === episode.episodeCode);
      return {
        ...episode,
        obtained: matchingFiles.length > 0,
        verifiedFileIds: matchingFiles.map((file) => file.id),
      };
    }),
    files: currentFiles,
  });
  const missingBefore = actionableMissingEpisodes(episodes);

  if (missingBefore.length === 0) {
    const noopQuality = dominantQuality(currentFiles.map((file) => file.name));
    const report = buildSeasonReport({
      titleName: input.title.title,
      season: input.season,
      episodes,
      ...(noopQuality ? { quality: noopQuality } : {}),
    });
    // A finished, fully-obtained season GRADUATES to Type 1: flip its status to
    // "completed" so the next sweep stops monitoring it and the library/search
    // read it as 已获取 instead of perpetually 追更中. (Provider-ahead seasons
    // stay active — more episodes are coming.)
    const graduated = report.status === "complete";
    const finalSeason = graduated
      ? { ...input.season, status: "completed" as const }
      : input.season;
    const notification: NotificationEvent = {
      id: `notification_${workflowRunId}_noop`,
      workflowRunId,
      kind: graduated ? "tracking_completed" : "already_current",
      title: `${report.titleName} ${report.seasonLabel}`,
      body: formatReportPushText(report),
      createdAt: now(),
      trigger: "scheduled",
      report,
    };
    return {
      status: "succeeded",
      season: finalSeason,
      episodes,
      obtainedEpisodes: obtainedEpisodeCodes(episodes),
      providerAheadEpisodes: collectProviderAheadEpisodes(episodes),
      resourceSnapshots: [],
      transferAttempts: [],
      decisions: [],
      notification,
      notifications: [notification],
      auditEvents,
    };
  }

  if (input.storageParentDirectoryId === undefined) {
    throw new Error(
      "MEDIA_TRACK_STAGING_PARENT_REQUIRED: provide storageParentDirectoryId so staging directories can live outside the season directory",
    );
  }
  const outcome = await acquireMissingEpisodes({
    title: input.title,
    seasons: [
      {
        seasonNumber: input.season.seasonNumber,
        totalEpisodes: input.season.totalEpisodes,
        latestAiredEpisode: input.season.latestAiredEpisode,
      },
    ],
    seasonDirectoryIds: { [input.season.seasonNumber]: input.season.storageDirectoryId },
    stagingParentDirectoryId: input.storageParentDirectoryId,
    qualityPreference: input.season.qualityPreference,
    keyword: input.keyword,
    missingEpisodes: missingBefore,
    resourceProvider: input.resourceProvider,
    storage: input.storage,
    agents: input.agents,
    workflowRunId,
    auditEvents,
    maxPlanningPasses: input.maxPlanningPasses ?? DEFAULT_MAX_PLANNING_PASSES,
  });

  const finalFiles = await dedupeLandingDirectory({
    storage: input.storage,
    directoryId: input.season.storageDirectoryId,
    auditEvents,
    title: input.title,
    seasonNumber: input.season.seasonNumber,
    agents: input.agents,
  });
  episodes = reconcileVerifiedFiles({
    season: input.season,
    // Rebuild from the post-dedup listing: verifiedFileIds reflect current
    // storage truth, not the history of files that once existed.
    episodes: episodes.map((episode) => {
      const matchingFiles = finalFiles.filter((file) => file.episodeCode === episode.episodeCode);
      return {
        ...episode,
        obtained: matchingFiles.length > 0,
        verifiedFileIds: matchingFiles.map((file) => file.id),
      };
    }),
    files: finalFiles,
  });
  const obtainedEpisodes = obtainedEpisodeCodes(episodes);
  const providerAheadEpisodes = collectProviderAheadEpisodes(episodes);
  const stillMissingAfter = actionableMissingEpisodes(episodes);
  const missingBeforeCodes = new Set(missingBefore);
  const newlyObtained = episodes.filter((ep) => ep.obtained && missingBeforeCodes.has(ep.episodeCode));
  const status = resolveAcquisitionStatus({ missingBefore, stillMissingAfter });
  const sweepQuality = dominantQuality(finalFiles.map((file) => file.name));
  const report = buildSeasonReport({
    titleName: input.title.title,
    season: input.season,
    episodes,
    newlyObtained: newlyObtained.map((ep) => ep.episodeCode),
    noCoverage: status === "no_coverage",
    ...(sweepQuality ? { quality: sweepQuality } : {}),
  });
  const notification: NotificationEvent = {
    id: `notification_${workflowRunId}`,
    workflowRunId,
    kind:
      status === "no_coverage"
        ? "no_coverage"
        : report.status === "complete"
          ? "tracking_completed"
          : "episodes_restored",
    title: `${report.titleName} ${report.seasonLabel}`,
    body: formatReportPushText(report),
    createdAt: now(),
    trigger: "scheduled",
    report,
  };

  return {
    status,
    season: input.season,
    episodes,
    obtainedEpisodes,
    providerAheadEpisodes,
    resourceSnapshots: outcome.resourceSnapshots,
    transferAttempts: outcome.transferAttempts,
    decisions: outcome.decisions,
    notification,
    notifications: [
      notification,
      ...foreignWorkNotificationsFromAudit({
        workflowRunId,
        titleName: input.title.title,
        auditEvents,
        now,
      }),
    ],
    auditEvents,
  };
}

export interface SeriesInitializationSeasonResult {
  season: TrackedSeason;
  episodes: EpisodeState[];
  obtainedEpisodes: string[];
  providerAheadEpisodes: string[];
}

export interface SeriesInitializationResult {
  status: WorkflowStatus;
  showDirectoryId: string;
  seasons: SeriesInitializationSeasonResult[];
  resourceSnapshots: ResourceSnapshot[];
  transferAttempts: TransferAttempt[];
  decisions: AgentDecision[];
  notification: NotificationEvent;
  notifications: NotificationEvent[];
  auditEvents: AuditEvent[];
}

/**
 * Title-level initialization ("获取全剧"): one acquisition over the need set
 * of every season — completed and airing alike. The planning agent sees the
 * full multi-season missing list and may compose season packs, complete
 * packs, mixed packs, and single episodes; the staging pipeline distributes
 * whatever actually lands. Every season ends up tracked: completed seasons
 * as `completed`, the airing season as `active` so Type 3 keeps monitoring,
 * and uncovered seasons keep their missing episodes visible for retry.
 */
export async function runSeriesInitialization(input: {
  title: MediaTitle;
  seasons: AcquisitionSeasonScope[];
  keyword: string;
  storageParentDirectoryId: string;
  resourceProvider: ResourceProvider;
  storage: StorageExecutor;
  agents: AgentNodes;
  qualityPreference?: string;
  workflowRunId?: string;
  maxPlanningPasses?: number;
  now?: () => string;
}): Promise<SeriesInitializationResult> {
  const workflowRunId = input.workflowRunId ?? "run_series_init";
  const now = input.now ?? defaultNowIso;
  const qualityPreference = input.qualityPreference ?? "4K";
  const auditEvents: AuditEvent[] = [];

  const showName = `${input.title.title} (${input.title.year})`;
  const showDirectoryId = await input.storage.createDirectory({
    name: showName,
    parentId: input.storageParentDirectoryId,
  });
  auditEvents.push({
    type: "landing_directory_created",
    message: `Created canonical show directory ${showName}`,
    data: { showDirectoryId },
  });

  // Every season in a series-initialization intent becomes tracked: ensure a
  // canonical directory exists even when this run obtains nothing for it, so
  // Type 3 can monitor and retry. This is standing tracking intent, not
  // speculative pre-creation. Find-or-create also makes re-runs see what
  // previous runs already landed.
  const seasonDirectoryIds: Record<number, string> = {};
  const trackedSeasons = new Map<number, TrackedSeason>();
  for (const seasonMeta of input.seasons) {
    const storageDirectoryId = await input.storage.createDirectory({
      name: `Season ${seasonMeta.seasonNumber}`,
      parentId: showDirectoryId,
    });
    seasonDirectoryIds[seasonMeta.seasonNumber] = storageDirectoryId;
    trackedSeasons.set(seasonMeta.seasonNumber, {
      id: `${input.title.id}_s${seasonMeta.seasonNumber}`,
      mediaTitleId: input.title.id,
      seasonNumber: seasonMeta.seasonNumber,
      status: seasonMeta.latestAiredEpisode >= seasonMeta.totalEpisodes ? "completed" : "active",
      qualityPreference,
      storageDirectoryId,
      totalEpisodes: seasonMeta.totalEpisodes,
      latestAiredEpisode: seasonMeta.latestAiredEpisode,
      latestAiredSource: "metadata",
    });
  }

  const episodesBySeason = new Map<number, EpisodeState[]>();
  for (const seasonMeta of input.seasons) {
    const season = trackedSeasons.get(seasonMeta.seasonNumber)!;
    const freshEpisodes = createEpisodeStates({
      trackedSeasonId: season.id,
      seasonNumber: seasonMeta.seasonNumber,
      totalEpisodes: seasonMeta.totalEpisodes,
      latestAiredEpisode: seasonMeta.latestAiredEpisode,
    });
    // The need set is what each canonical season directory is actually
    // missing: a re-run never re-transfers episodes a previous run landed.
    const existingFiles = await listSeasonVideoFilesWithRescue({
      storage: input.storage,
      agents: input.agents,
      title: input.title,
      seasonNumber: seasonMeta.seasonNumber,
      directoryId: season.storageDirectoryId,
      auditEvents,
    });
    const episodes =
      existingFiles.length === 0
        ? freshEpisodes
        : reconcileVerifiedFiles({ season, episodes: freshEpisodes, files: existingFiles });
    const alreadyObtained = obtainedEpisodeCodes(episodes);
    if (alreadyObtained.length > 0) {
      auditEvents.push({
        type: "existing_content_reconciled",
        message: `Season ${seasonMeta.seasonNumber}: ${alreadyObtained.length} episodes already present; excluded from the acquisition need set`,
        data: { seasonNumber: seasonMeta.seasonNumber, episodes: alreadyObtained },
      });
    }
    episodesBySeason.set(seasonMeta.seasonNumber, episodes);
  }
  const missingEpisodes = [...episodesBySeason.values()].flatMap((episodes) =>
    actionableMissingEpisodes(episodes),
  );

  const outcome =
    missingEpisodes.length === 0
      ? emptyAcquisitionOutcome()
      : await acquireMissingEpisodes({
          title: input.title,
          seasons: input.seasons,
          seasonDirectoryIds,
          showDirectoryId,
          stagingParentDirectoryId: showDirectoryId,
          qualityPreference,
          keyword: input.keyword,
          missingEpisodes,
          resourceProvider: input.resourceProvider,
          storage: input.storage,
          agents: input.agents,
          workflowRunId,
          auditEvents,
          maxPlanningPasses: input.maxPlanningPasses ?? DEFAULT_MAX_PLANNING_PASSES,
        });

  const seasonResults: SeriesInitializationSeasonResult[] = [];
  for (const seasonMeta of input.seasons) {
    const season = trackedSeasons.get(seasonMeta.seasonNumber)!;
    const storageDirectoryId = season.storageDirectoryId;
    const verifiedFiles = await dedupeLandingDirectory({
      storage: input.storage,
      directoryId: storageDirectoryId,
      auditEvents,
      title: input.title,
      seasonNumber: seasonMeta.seasonNumber,
      agents: input.agents,
    });
    const episodes = reconcileVerifiedFiles({
      season,
      episodes: episodesBySeason.get(seasonMeta.seasonNumber) ?? [],
      files: verifiedFiles,
    });
    seasonResults.push({
      season,
      episodes,
      obtainedEpisodes: obtainedEpisodeCodes(episodes),
      providerAheadEpisodes: collectProviderAheadEpisodes(episodes),
    });
  }

  const stillMissingAfter = seasonResults.flatMap((entry) => actionableMissingEpisodes(entry.episodes));
  const status = resolveAcquisitionStatus({ missingBefore: missingEpisodes, stillMissingAfter });
  const report = buildSeriesReport({
    titleName: input.title.title,
    seasons: seasonResults.map((entry) => ({ season: entry.season, episodes: entry.episodes })),
    noCoverage: status === "no_coverage",
  });
  const notification: NotificationEvent = {
    id: `notification_${workflowRunId}`,
    workflowRunId,
    kind: status === "no_coverage" ? "no_coverage" : "series_initialized",
    title: report.titleName,
    body: formatReportPushText(report),
    createdAt: now(),
    trigger: "user",
    report,
  };

  return {
    status,
    showDirectoryId,
    seasons: seasonResults,
    resourceSnapshots: outcome.resourceSnapshots,
    transferAttempts: outcome.transferAttempts,
    decisions: outcome.decisions,
    notification,
    notifications: [
      notification,
      ...foreignWorkNotificationsFromAudit({
        workflowRunId,
        titleName: input.title.title,
        auditEvents,
        now,
      }),
    ],
    auditEvents,
  };
}

interface AcquisitionOutcome {
  resourceSnapshots: ResourceSnapshot[];
  decisions: AgentDecision[];
  transferAttempts: TransferAttempt[];
}

export interface AcquisitionSeasonScope {
  seasonNumber: number;
  totalEpisodes: number;
  latestAiredEpisode: number;
}

function emptyAcquisitionOutcome(): AcquisitionOutcome {
  return { resourceSnapshots: [], decisions: [], transferAttempts: [] };
}

/**
 * The deterministic acquisition harness. The planning agent owns every
 * semantic choice (keywords, target matching, episode mapping, selection);
 * this loop owns every side effect and every verification.
 *
 * Unified staging path: every selected candidate transfers into its own
 * staging directory first — never directly into a season directory — then
 * package normalization distributes the materialized tree into canonical
 * per-season directories. A candidate's claimed coverage is evidence; the
 * landed tree is the truth. Files the normalization plan rejects stay
 * quarantined in staging. Recovery from a transfer that materializes nothing
 * is a fresh agent pass that sees the failure evidence — never mechanical
 * iteration over provider candidates.
 */
async function acquireMissingEpisodes(input: {
  title: MediaTitle;
  seasons: AcquisitionSeasonScope[];
  /** seasonNumber -> existing season directory id; missing entries are find-or-created under showDirectoryId. */
  seasonDirectoryIds: Record<number, string>;
  showDirectoryId?: string;
  stagingParentDirectoryId: string;
  qualityPreference: string;
  keyword: string;
  missingEpisodes: string[];
  resourceProvider: ResourceProvider;
  storage: StorageExecutor;
  agents: AgentNodes;
  workflowRunId: string;
  auditEvents: AuditEvent[];
  maxPlanningPasses: number;
}): Promise<AcquisitionOutcome> {
  const resourceSnapshots: ResourceSnapshot[] = [];
  const decisions: AgentDecision[] = [];
  const transferAttempts: TransferAttempt[] = [];
  const seasonNumbers = input.seasons.map((season) => season.seasonNumber);
  const latestAiredBySeason = Object.fromEntries(
    input.seasons.map((season) => [season.seasonNumber, season.latestAiredEpisode]),
  );
  let stillMissing = [...input.missingEpisodes];
  let failureEvidence: AcquisitionFailureEvidence[] = [];

  for (let pass = 1; pass <= input.maxPlanningPasses && stillMissing.length > 0; pass += 1) {
    const planning = await input.agents.planAcquisition({
      title: input.title.title,
      aliases: input.title.aliases,
      seasons: input.seasons,
      qualityPreference: input.qualityPreference,
      missingEpisodes: stillMissing,
      initialKeyword: input.keyword,
      failureEvidence,
      searchResources: async ({ keyword }) => input.resourceProvider.search({ keyword }),
    });
    // Content-hashing providers (PanSou) can return the SAME snapshot id for
    // identical result sets across searches; persist each id once.
    const knownSnapshotIds = new Set(resourceSnapshots.map((snapshot) => snapshot.id));
    for (const snapshot of planning.snapshots) {
      if (!knownSnapshotIds.has(snapshot.id)) {
        knownSnapshotIds.add(snapshot.id);
        resourceSnapshots.push(snapshot);
      }
    }
    recordPlanningAudit({ auditEvents: input.auditEvents, planning, pass });

    const validated = validateAcquisitionPlan({
      plan: planning.plan,
      snapshots: planning.snapshots,
      missingEpisodes: stillMissing,
      seasonNumbers,
    });

    if (validated.selectedSnapshot === null || validated.selectedCandidates.length === 0) {
      // "No coverage" is an honest conclusion only when the agent saw real
      // provider evidence. If searches errored and the successful ones all
      // came back empty, the evidence is incomplete — that is an
      // infrastructure failure to retry later, not a "no resource" verdict.
      const searchErrors = planning.trace
        .filter((event) => event.type === "tool_result" && isSearchErrorOutput(event.output))
        .map((event) => (event as { output: { error: string } }).output.error);
      const observedCandidateCount = planning.snapshots.reduce(
        (count, snapshot) => count + snapshot.candidates.length,
        0,
      );
      if (planning.snapshots.length === 0 || (searchErrors.length > 0 && observedCandidateCount === 0)) {
        throw new Error(searchErrors[0] ?? "Planning agent produced no search observations");
      }
      input.auditEvents.push({
        type: "acquisition_no_coverage",
        message: `Planning pass ${pass} found no covering resource`,
        data: { pass, reason: planning.plan.reason, stillMissing },
      });
      break;
    }

    decisions.push(
      deriveAgentDecision({
        plan: planning.plan,
        missingEpisodes: stillMissing,
        latestAiredBySeason,
      }),
    );

    const passAttempts: TransferAttempt[] = [];
    for (const [index, selected] of validated.selectedCandidates.entries()) {
      const stagingDirectoryId = await input.storage.createDirectory({
        name: `staging-${input.workflowRunId}-p${pass}-c${index + 1}`,
        parentId: input.stagingParentDirectoryId,
      });
      const attempt = await input.storage.transfer({
        workflowRunId: input.workflowRunId,
        directoryId: stagingDirectoryId,
        candidate: selected.candidate,
      });
      passAttempts.push(attempt);
      transferAttempts.push(attempt);
      await normalizeStagingDirectory({
        title: input.title,
        seasons: input.seasons,
        seasonDirectoryIds: input.seasonDirectoryIds,
        showDirectoryId: input.showDirectoryId,
        stagingDirectoryId,
        storage: input.storage,
        agents: input.agents,
        auditEvents: input.auditEvents,
      });
      // Remove the staging dir only when normalization left it empty. A staging
      // dir that still holds files is quarantined foreign-work awaiting user
      // review (see importForeignWorkAsMovie) — never delete that.
      try {
        const leftover = await input.storage.listTree({ directoryId: stagingDirectoryId });
        if (leftover.length === 0) {
          await input.storage.removeDirectory(stagingDirectoryId);
        }
      } catch {
        // best-effort cleanup
      }
    }

    stillMissing = await stillMissingAcrossSeasons({
      missingEpisodes: stillMissing,
      seasonDirectoryIds: input.seasonDirectoryIds,
      storage: input.storage,
    });

    if (stillMissing.length > 0) {
      failureEvidence = buildFailureEvidence({
        selectedCandidates: validated.selectedCandidates,
        attempts: passAttempts,
        stillMissing,
      });
      input.auditEvents.push({
        type: "acquisition_pass_incomplete",
        message: `Planning pass ${pass} left ${stillMissing.length} episodes missing`,
        data: { pass, stillMissing, failureEvidence },
      });
    }
  }

  return { resourceSnapshots, decisions, transferAttempts };
}

/**
 * Distribute one staging directory's landed tree into canonical season
 * directories. Out-of-scope seasons and plan-rejected files stay quarantined
 * in staging — never moved, never deleted.
 */
async function normalizeStagingDirectory(input: {
  title: MediaTitle;
  seasons: AcquisitionSeasonScope[];
  seasonDirectoryIds: Record<number, string>;
  showDirectoryId: string | undefined;
  stagingDirectoryId: string;
  storage: StorageExecutor;
  agents: AgentNodes;
  auditEvents: AuditEvent[];
}): Promise<void> {
  const tree = await input.storage.listTree({ directoryId: input.stagingDirectoryId });
  if (tree.length === 0) {
    return;
  }
  const plan = await buildAgentAssistedPackageNormalizationPlan({
    title: input.title.title,
    year: input.title.year,
    files: tree,
    totalSeasons: input.seasons.length,
    agents: input.agents,
  });
  if (plan.rejectedFiles.length > 0) {
    input.auditEvents.push({
      type: "package_files_rejected",
      message: `${plan.rejectedFiles.length} files stay quarantined in staging ${input.stagingDirectoryId}`,
      data: { stagingDirectoryId: input.stagingDirectoryId, rejectedFiles: plan.rejectedFiles },
    });
  }
  if (plan.foreignWorkFiles.length > 0) {
    input.auditEvents.push({
      type: "foreign_work_detected",
      message: `${plan.foreignWorkFiles.length} files in staging ${input.stagingDirectoryId} may belong to a different title; awaiting user confirmation`,
      data: { stagingDirectoryId: input.stagingDirectoryId, files: plan.foreignWorkFiles },
    });
  }

  const inScope = new Set(input.seasons.map((season) => season.seasonNumber));
  const actionsBySeason = new Map<number, PackageMoveAction[]>();
  for (const action of plan.actions) {
    const group = actionsBySeason.get(action.targetSeasonNumber) ?? [];
    group.push(action);
    actionsBySeason.set(action.targetSeasonNumber, group);
  }

  for (const [seasonNumber, actions] of actionsBySeason) {
    if (!inScope.has(seasonNumber)) {
      input.auditEvents.push({
        type: "package_out_of_scope_season",
        message: `Staging ${input.stagingDirectoryId} contains season ${seasonNumber} files outside this acquisition's scope; left in staging`,
        data: { stagingDirectoryId: input.stagingDirectoryId, seasonNumber, fileCount: actions.length },
      });
      continue;
    }
    let seasonDirectoryId = input.seasonDirectoryIds[seasonNumber];
    if (seasonDirectoryId === undefined) {
      if (input.showDirectoryId === undefined) {
        input.auditEvents.push({
          type: "package_out_of_scope_season",
          message: `No directory known for season ${seasonNumber} and no show directory to create one; files left in staging`,
          data: { stagingDirectoryId: input.stagingDirectoryId, seasonNumber, fileCount: actions.length },
        });
        continue;
      }
      seasonDirectoryId = await input.storage.createDirectory({
        name: `Season ${seasonNumber}`,
        parentId: input.showDirectoryId,
      });
      input.seasonDirectoryIds[seasonNumber] = seasonDirectoryId;
      input.auditEvents.push({
        type: "landing_directory_created",
        message: `Created canonical landing directory ${input.title.title} (${input.title.year})/Season ${seasonNumber}`,
        data: { showDirectoryId: input.showDirectoryId, seasonDirectoryId },
      });
    }
    await input.storage.moveFiles({
      fileIds: actions.map((action) => action.providerFileId),
      targetDirectoryId: seasonDirectoryId,
    });

    // Path context dies with the move: a landed file is an episode only if
    // its NAME alone says so. Files whose names disagree with the plan's
    // mapping (agent-recognized names, season-blind "第N集" names) are
    // renamed to the canonical form the plan computed.
    for (const action of actions) {
      const sourceName = action.sourcePath.split("/").at(-1) ?? action.sourcePath;
      if (episodeCodeFromFileName(sourceName) === action.episodeCode) {
        continue;
      }
      const newName = action.targetRelativePath.split("/").at(-1) ?? action.targetRelativePath;
      try {
        await input.storage.renameFile({
          directoryId: seasonDirectoryId,
          fileId: action.providerFileId,
          newName,
        });
      } catch (error) {
        input.auditEvents.push({
          type: "landed_file_rename_failed",
          message: `Rename of landed file ${sourceName} failed; it stays invisible until rescued`,
          data: { providerFileId: action.providerFileId, error: String(error) },
        });
        continue;
      }
      input.auditEvents.push({
        type: "landed_file_renamed",
        message: `Landed file ${sourceName} renamed to canonical ${newName}`,
        data: { providerFileId: action.providerFileId, episodeCode: action.episodeCode, newName },
      });
    }
  }
}

/**
 * Foreign-work findings become first-class feed entries: the user must see
 * "this pack carried what looks like a different title" without digging
 * through audit logs, because the next step (import it as its own movie) is
 * a user decision the workflow must never make on its own.
 */
export function foreignWorkNotificationsFromAudit(input: {
  workflowRunId: string;
  titleName: string;
  auditEvents: AuditEvent[];
  now: () => string;
}): NotificationEvent[] {
  return input.auditEvents
    .filter((event) => event.type === "foreign_work_detected")
    .map((event, index) => {
      const files =
        (event.data as { files?: Array<{ sourcePath: string }> } | undefined)?.files ?? [];
      return {
        id: `notification_${input.workflowRunId}_foreign_${index + 1}`,
        workflowRunId: input.workflowRunId,
        kind: "foreign_work_detected",
        title: `${input.titleName} 资源包内发现疑似其他作品`,
        body: `${files.length} 个文件已隔离在 staging，待确认是否单独入库：${files
          .map((file) => file.sourcePath)
          .join("、")}`,
        createdAt: input.now(),
      };
    });
}

/**
 * Season-directory listing with rescue. Video files whose names expose no
 * episode code are invisible to verification, marking, and dedup — silent
 * holes that trigger wasteful re-acquisition. When any exist, the package
 * recognition agent judges their episode identity; confirmed files are
 * renamed to the canonical parseable form (one agent confirmation, then
 * deterministic forever). Unconfirmed files stay untouched and are surfaced
 * as audit warnings — never guessed, never deleted.
 */
async function listSeasonVideoFilesWithRescue(input: {
  storage: StorageExecutor;
  agents: AgentNodes;
  title: MediaTitle;
  seasonNumber: number;
  directoryId: string;
  auditEvents: AuditEvent[];
}): Promise<VerifiedFile[]> {
  const unparsed = await input.storage.listUnparsedVideoFiles(input.directoryId);
  if (unparsed.length > 0) {
    const decision = await input.agents.recognizePackage({
      title: input.title.title,
      year: input.title.year,
      files: unparsed.map((file) => ({
        path: file.name,
        providerFileId: file.providerFileId,
        sizeBytes: file.sizeBytes,
      })),
      parserEvidence: unparsed.map((file) => ({
        providerFileId: file.providerFileId,
        path: file.name,
        parsedSeasonNumber: null,
        parsedEpisodeNumber: null,
        confidence: "low",
        evidence: ["file name exposes no episode identity"],
      })),
    });
    const rescuedIds = new Set<string>();
    if (decision.confidence !== "low") {
      for (const mapping of decision.fileMappings) {
        if (mapping.confidence === "low") {
          continue;
        }
        const source = unparsed.find((file) => file.providerFileId === mapping.providerFileId);
        if (source === undefined) {
          continue;
        }
        if (mapping.seasonNumber !== input.seasonNumber) {
          input.auditEvents.push({
            type: "unparsed_file_out_of_scope",
            message: `${source.name} maps to season ${mapping.seasonNumber}, not season ${input.seasonNumber}; left untouched`,
            data: { providerFileId: source.providerFileId, mapping },
          });
          continue;
        }
        const code = episodeCode(mapping.seasonNumber, mapping.episodeNumber);
        const newName = canonicalEpisodeFileName({
          title: input.title.title,
          episodeCode: code,
          sourceName: source.name,
        });
        try {
          await input.storage.renameFile({
            directoryId: input.directoryId,
            fileId: source.providerFileId,
            newName,
          });
        } catch (error) {
          input.auditEvents.push({
            type: "unparsed_file_rename_failed",
            message: `Rename of ${source.name} failed; file stays unparsed`,
            data: { providerFileId: source.providerFileId, error: String(error) },
          });
          continue;
        }
        rescuedIds.add(source.providerFileId);
        input.auditEvents.push({
          type: "unparsed_file_rescued",
          message: `${source.name} agent-confirmed as ${code}; renamed to ${newName}`,
          data: { providerFileId: source.providerFileId, episodeCode: code, newName, reason: mapping.reason },
        });
      }
    }
    const remaining = unparsed.filter((file) => !rescuedIds.has(file.providerFileId));
    if (remaining.length > 0) {
      input.auditEvents.push({
        type: "unparsed_files_present",
        message: `${remaining.length} video files in directory ${input.directoryId} expose no episode identity and were not agent-confirmed; they are invisible to verification`,
        data: {
          directoryId: input.directoryId,
          files: remaining.map((file) => ({ providerFileId: file.providerFileId, name: file.name })),
        },
      });
    }
  }
  return input.storage.listVideoFiles(input.directoryId);
}

async function stillMissingAcrossSeasons(input: {
  missingEpisodes: string[];
  seasonDirectoryIds: Record<number, string>;
  storage: StorageExecutor;
}): Promise<string[]> {
  const obtained = new Set<string>();
  for (const directoryId of Object.values(input.seasonDirectoryIds)) {
    for (const file of await input.storage.listVideoFiles(directoryId)) {
      if (file.episodeCode !== null) {
        obtained.add(file.episodeCode);
      }
    }
  }
  return input.missingEpisodes.filter((code) => !obtained.has(code));
}

/**
 * Verification-first duplicate cleanup. The plan is built from one verified
 * snapshot, deletion is the only side effect, and the directory is re-read
 * afterwards: a dedup is complete only when the re-read shows one file per
 * episode.
 */
async function dedupeLandingDirectory(input: {
  storage: StorageExecutor;
  directoryId: string;
  auditEvents: AuditEvent[];
  title: MediaTitle;
  seasonNumber: number;
  agents: AgentNodes;
}): Promise<VerifiedFile[]> {
  const files = await input.storage.listVideoFiles(input.directoryId);
  const plan = await buildConfirmedDedupPlan({
    title: input.title,
    seasonNumber: input.seasonNumber,
    files,
    agents: input.agents,
  });
  if (plan.unconfirmedFileIds.length > 0) {
    input.auditEvents.push({
      type: "dedup_unconfirmed_kept",
      message: `Kept ${plan.unconfirmedFileIds.length} files whose episode mapping was not agent-confirmed`,
      data: { unconfirmedFileIds: plan.unconfirmedFileIds },
    });
  }
  if (plan.deleteFileIds.length === 0) {
    return files;
  }

  input.auditEvents.push({
    type: "dedup_plan_created",
    message: `Deleting ${plan.deleteFileIds.length} smaller duplicate files (agent-confirmed groups only)`,
    data: {
      duplicateGroups: plan.duplicateGroups,
      deleteFileIds: plan.deleteFileIds,
      keepFileIds: plan.keepFileIds,
      unconfirmedFileIds: plan.unconfirmedFileIds,
    },
  });
  await input.storage.deleteFiles({ directoryId: input.directoryId, fileIds: plan.deleteFileIds });

  const filesAfter = await input.storage.listVideoFiles(input.directoryId);
  const remaining = new Set(filesAfter.map((file) => file.id));
  const undeleted = plan.deleteFileIds.filter((fileId) => remaining.has(fileId));
  if (undeleted.length > 0) {
    input.auditEvents.push({
      type: "dedup_verification_failed",
      message: `Files scheduled for deletion still exist: ${undeleted.join(", ")}`,
      data: { undeleted },
    });
  } else {
    input.auditEvents.push({
      type: "dedup_verified",
      message: "Agent-confirmed duplicates removed and verified by re-read",
      data: { deletedCount: plan.deleteFileIds.length },
    });
  }
  return filesAfter;
}

function buildFailureEvidence(input: {
  selectedCandidates: SelectedTransferCandidate[];
  attempts: TransferAttempt[];
  stillMissing: string[];
}): AcquisitionFailureEvidence[] {
  const stillMissing = new Set(input.stillMissing);
  return input.selectedCandidates.flatMap((selected, index) => {
    const attempt = input.attempts[index];
    if (attempt === undefined) {
      return [];
    }
    const episodesStillMissing = selected.episodes.filter((code) => stillMissing.has(code));
    if (episodesStillMissing.length === 0) {
      return [];
    }
    return [
      {
        candidateId: selected.candidate.id,
        candidateTitle: selected.candidate.title,
        transferStatus: attempt.status,
        providerMessage: attempt.providerMessage,
        episodesStillMissing,
      },
    ];
  });
}

function recordPlanningAudit(input: {
  auditEvents: AuditEvent[];
  planning: AcquisitionPlanningResult;
  pass: number;
}): void {
  input.auditEvents.push({
    type: "acquisition_plan_created",
    message: `Planning pass ${input.pass} produced plan from ${input.planning.plan.node}`,
    data: {
      pass: input.pass,
      plan: input.planning.plan,
      trace: input.planning.trace,
    },
  });
  for (const event of input.planning.trace) {
    if (event.type !== "tool_result" || !isSearchErrorOutput(event.output)) {
      continue;
    }
    input.auditEvents.push({
      type: "keyword_search_failed",
      message: `Search keyword failed: ${event.output.keyword}`,
      data: { keyword: event.output.keyword, error: event.output.error },
    });
  }
  for (const snapshot of input.planning.snapshots) {
    input.auditEvents.push({
      type: "resource_snapshot_created",
      message: `Created resource snapshot ${snapshot.id}`,
      data: {
        snapshotId: snapshot.id,
        keyword: snapshot.keyword,
        candidateCount: snapshot.candidates.length,
      },
    });
    if (snapshot.candidates.length === 0) {
      input.auditEvents.push({
        type: "keyword_search_empty",
        message: `Search keyword returned no candidates: ${snapshot.keyword}`,
        data: { keyword: snapshot.keyword },
      });
    }
  }
}

function isSearchErrorOutput(output: unknown): output is { keyword: string; error: string } {
  return (
    typeof output === "object" &&
    output !== null &&
    "keyword" in output &&
    "error" in output &&
    typeof output.keyword === "string" &&
    typeof output.error === "string"
  );
}

function resolveAcquisitionStatus(input: {
  missingBefore: string[];
  stillMissingAfter: string[];
}): WorkflowStatus {
  if (input.stillMissingAfter.length === 0) {
    return "succeeded";
  }
  if (input.stillMissingAfter.length < input.missingBefore.length) {
    return "partial";
  }
  return "no_coverage";
}

function actionableMissingEpisodes(episodes: EpisodeState[]): string[] {
  return episodes
    .filter((episode) => episode.airStatus === "aired" && !episode.obtained)
    .map((episode) => episode.episodeCode);
}

function obtainedEpisodeCodes(episodes: EpisodeState[]): string[] {
  return episodes.filter((episode) => episode.obtained).map((episode) => episode.episodeCode);
}

function collectProviderAheadEpisodes(episodes: EpisodeState[]): string[] {
  return episodes
    .filter((episode) => episode.obtained && episode.metadataStatus === "provider_ahead")
    .map((episode) => episode.episodeCode);
}

