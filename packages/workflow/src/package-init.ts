import {
  createEpisodeStates,
  reconcileVerifiedFiles,
  type AuditEvent,
  type EpisodeState,
  type MediaTitle,
  type NotificationEvent,
  type TrackedSeason,
  type WorkflowStatus,
} from "./domain.js";
import {
  buildAgentAssistedPackageNormalizationPlan,
  type PackageMoveAction,
  type PackageRejectedFile,
} from "./package-normalizer.js";
import type { AgentNodes, StorageExecutor } from "./ports.js";
import type { WorkflowRepository } from "./repository.js";

const FIXED_CREATED_AT = "2026-01-01T00:00:00.000Z";

export interface SeasonMetadataInput {
  seasonNumber: number;
  totalEpisodes: number;
  latestAiredEpisode: number;
}

export interface SeriesPackageSeasonResult {
  season: TrackedSeason;
  episodes: EpisodeState[];
  obtainedEpisodes: string[];
}

export interface SeriesPackageInitializationResult {
  status: WorkflowStatus;
  seasons: SeriesPackageSeasonResult[];
  rejectedFiles: PackageRejectedFile[];
  warnings: string[];
  notification: NotificationEvent;
  auditEvents: AuditEvent[];
}

/**
 * Type 1 initialization for complete-series packages.
 *
 * The pack lands in a staging directory as-is. The workflow snapshots the
 * tree, builds a normalization plan (deterministic parse first; the
 * recognition agent only when the plan is low-confidence), creates the
 * canonical `Title (Year)/Season N` shape, moves planned files per season,
 * and verifies each season by re-reading it. Files the plan rejects
 * (documentaries, bundled movies, posters, unparseable names) are NEVER
 * moved or deleted — they stay in staging and are reported.
 */
export async function runSeriesPackageInitialization(input: {
  title: MediaTitle;
  seasons: SeasonMetadataInput[];
  stagingDirectoryId: string;
  storageParentDirectoryId: string;
  storage: StorageExecutor;
  agents: AgentNodes;
  qualityPreference?: string;
  workflowRunId?: string;
}): Promise<SeriesPackageInitializationResult> {
  const workflowRunId = input.workflowRunId ?? "run_package_init";
  const auditEvents: AuditEvent[] = [];
  const qualityPreference = input.qualityPreference ?? "4K";

  const tree = await input.storage.listTree({ directoryId: input.stagingDirectoryId });
  const plan = await buildAgentAssistedPackageNormalizationPlan({
    title: input.title.title,
    year: input.title.year,
    files: tree,
    totalSeasons: input.seasons.length,
    agents: input.agents,
  });
  auditEvents.push({
    type: "package_plan_created",
    message: `Package plan: ${plan.actions.length} files planned, ${plan.rejectedFiles.length} rejected`,
    data: {
      coverage: plan.coverage,
      confidence: plan.confidence,
      actionCount: plan.actions.length,
      rejectedFiles: plan.rejectedFiles,
      warnings: plan.warnings,
    },
  });

  const actionsBySeason = new Map<number, PackageMoveAction[]>();
  for (const action of plan.actions) {
    const group = actionsBySeason.get(action.targetSeasonNumber) ?? [];
    group.push(action);
    actionsBySeason.set(action.targetSeasonNumber, group);
  }

  const seasonResults: SeriesPackageSeasonResult[] = [];
  if (actionsBySeason.size > 0) {
    const showName = `${input.title.title} (${input.title.year})`;
    const showDirectoryId = await input.storage.createDirectory({
      name: showName,
      parentId: input.storageParentDirectoryId,
    });

    for (const seasonMeta of input.seasons) {
      const actions = actionsBySeason.get(seasonMeta.seasonNumber);
      if (actions === undefined || actions.length === 0) {
        continue;
      }
      const seasonDirectoryId = await input.storage.createDirectory({
        name: `Season ${seasonMeta.seasonNumber}`,
        parentId: showDirectoryId,
      });
      auditEvents.push({
        type: "landing_directory_created",
        message: `Created canonical landing directory ${showName}/Season ${seasonMeta.seasonNumber}`,
        data: { showDirectoryId, seasonDirectoryId },
      });

      await input.storage.moveFiles({
        fileIds: actions.map((action) => action.providerFileId),
        targetDirectoryId: seasonDirectoryId,
      });

      const verifiedFiles = await input.storage.listVideoFiles(seasonDirectoryId);
      const season: TrackedSeason = {
        id: `${input.title.id}_s${seasonMeta.seasonNumber}`,
        mediaTitleId: input.title.id,
        seasonNumber: seasonMeta.seasonNumber,
        status: seasonMeta.latestAiredEpisode >= seasonMeta.totalEpisodes ? "completed" : "active",
        qualityPreference,
        storageDirectoryId: seasonDirectoryId,
        totalEpisodes: seasonMeta.totalEpisodes,
        latestAiredEpisode: seasonMeta.latestAiredEpisode,
        latestAiredSource: "metadata",
      };
      const episodes = reconcileVerifiedFiles({
        season,
        episodes: createEpisodeStates({
          trackedSeasonId: season.id,
          seasonNumber: season.seasonNumber,
          totalEpisodes: season.totalEpisodes,
          latestAiredEpisode: season.latestAiredEpisode,
        }),
        files: verifiedFiles,
      });
      const obtainedEpisodes = episodes
        .filter((episode) => episode.obtained)
        .map((episode) => episode.episodeCode);
      auditEvents.push({
        type: "package_season_verified",
        message: `Season ${seasonMeta.seasonNumber}: ${obtainedEpisodes.length}/${seasonMeta.totalEpisodes} episodes verified`,
        data: {
          seasonNumber: seasonMeta.seasonNumber,
          obtainedCount: obtainedEpisodes.length,
          plannedCount: actions.length,
        },
      });
      seasonResults.push({ season, episodes, obtainedEpisodes });
    }
  }

  const totalObtained = seasonResults.reduce((sum, result) => sum + result.obtainedEpisodes.length, 0);
  const totalAired = input.seasons.reduce((sum, season) => sum + season.latestAiredEpisode, 0);
  const status: WorkflowStatus =
    totalObtained >= totalAired && seasonResults.length === input.seasons.length
      ? "succeeded"
      : totalObtained > 0
        ? "partial"
        : "no_coverage";
  const notification: NotificationEvent = {
    id: `notification_${workflowRunId}`,
    workflowRunId,
    kind: status === "no_coverage" ? "no_coverage" : "package_initialized",
    title: `${input.title.title} ${status === "no_coverage" ? "package not normalized" : "package initialized"}`,
    body: `${totalObtained} episodes obtained across ${seasonResults.length} seasons; ${plan.rejectedFiles.length} files left in staging`,
    createdAt: FIXED_CREATED_AT,
  };

  return {
    status,
    seasons: seasonResults,
    rejectedFiles: plan.rejectedFiles,
    warnings: plan.warnings,
    notification,
    auditEvents,
  };
}

export async function runSeriesPackageInitializationAndPersist(input: {
  title: MediaTitle;
  seasons: SeasonMetadataInput[];
  stagingDirectoryId: string;
  storageParentDirectoryId: string;
  storage: StorageExecutor;
  agents: AgentNodes;
  repository: WorkflowRepository;
  workflowRun: { id: string; startedAt: string; finishedAt: string | null };
  qualityPreference?: string;
}): Promise<SeriesPackageInitializationResult> {
  const result = await runSeriesPackageInitialization({
    title: input.title,
    seasons: input.seasons,
    stagingDirectoryId: input.stagingDirectoryId,
    storageParentDirectoryId: input.storageParentDirectoryId,
    storage: input.storage,
    agents: input.agents,
    workflowRunId: input.workflowRun.id,
    ...(input.qualityPreference === undefined ? {} : { qualityPreference: input.qualityPreference }),
  });

  for (const seasonResult of result.seasons) {
    const seasonRunId = `${input.workflowRun.id}_s${seasonResult.season.seasonNumber}`;
    await input.repository.saveWorkflowRunSnapshot({
      title: input.title,
      season: seasonResult.season,
      workflowRun: {
        id: seasonRunId,
        kind: "type1_package_init",
        status: result.status,
        trackedSeasonId: seasonResult.season.id,
        startedAt: input.workflowRun.startedAt,
        finishedAt: input.workflowRun.finishedAt,
        auditEvents: result.auditEvents,
      },
      episodes: seasonResult.episodes,
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [
        {
          ...result.notification,
          id: `notification_${seasonRunId}`,
          workflowRunId: seasonRunId,
        },
      ],
    });
  }

  return result;
}
