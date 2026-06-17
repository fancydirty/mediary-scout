import type { LanguageModel } from "ai";
import type {
  AcquisitionSeasonScope,
  EpisodeState,
  MediaTitle,
  MovieWorkflowResult,
  TrackedSeason,
  WorkflowKind,
  WorkflowRunMetadata,
} from "./domain.js";
import { runTvAcquisitionV2 } from "./acquisition-v2/run-tv-v2.js";
import type { BridgedV2Result } from "./acquisition-v2/workflow-v2-bridge.js";
import { makeProgressSink } from "./acquisition-v2/progress-sink.js";
import { runMovieAcquisitionV2 } from "./movie-workflow-v2.js";
import type { ResourceProvider, StorageExecutor } from "./ports.js";
import type { WorkflowRepository } from "./repository.js";

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
  workflowRun: WorkflowRunMetadata;
  searchBudget?: number;
  maxSteps?: number;
  preferredLanguage?: string;
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

function passthrough(input: TvV2Common): {
  searchBudget?: number;
  maxSteps?: number;
  preferredLanguage?: string;
} {
  return {
    ...(input.searchBudget === undefined ? {} : { searchBudget: input.searchBudget }),
    ...(input.maxSteps === undefined ? {} : { maxSteps: input.maxSteps }),
    ...(input.preferredLanguage === undefined ? {} : { preferredLanguage: input.preferredLanguage }),
  };
}

async function persistSingleSeason(input: {
  kind: WorkflowKind;
  title: MediaTitle;
  bridged: BridgedV2Result;
  workflowRun: WorkflowRunMetadata;
  repository: WorkflowRepository;
}): Promise<void> {
  const seasonResult = input.bridged.seasons[0]!;
  await input.repository.saveWorkflowRunSnapshot({
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
    onProgress: makeProgressSink({
      repository: input.repository,
      workflowRunId: input.workflowRun.id,
      neededHint: Math.min(input.season.latestAiredEpisode, input.season.totalEpisodes),
    }),
    ...passthrough(input),
  });

  await persistSingleSeason({
    kind: "type2_init",
    title: input.title,
    bridged,
    // Stamp finishedAt AFTER the run — it (and the notification createdAt) must
    // be the real completion time, not the claim time.
    workflowRun: { ...input.workflowRun, finishedAt: now() },
    repository: input.repository,
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
    onProgress: makeProgressSink({
      repository: input.repository,
      workflowRunId: input.workflowRun.id,
      neededHint: input.episodes.filter((episode) => episode.airStatus === "aired" && !episode.obtained).length,
    }),
    ...passthrough(input),
  });

  await persistSingleSeason({
    kind: "type3_monitor",
    title: input.title,
    bridged,
    workflowRun: { ...input.workflowRun, finishedAt: now() },
    repository: input.repository,
  });
  return bridged;
}

export async function runSeriesInitializationV2AndPersist(
  input: TvV2Common & { seasons: AcquisitionSeasonScope[]; qualityPreference?: string },
): Promise<BridgedV2Result> {
  const quality = input.qualityPreference ?? "4K";
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
    onProgress: makeProgressSink({
      repository: input.repository,
      workflowRunId: input.workflowRun.id,
      neededHint: input.seasons.reduce(
        (sum, season) => sum + Math.min(season.latestAiredEpisode, season.totalEpisodes),
        0,
      ),
    }),
    ...passthrough(input),
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

export async function runMovieAcquisitionV2AndPersist(input: {
  title: MediaTitle;
  categoryParentId: string;
  resourceProvider: ResourceProvider;
  storage: StorageExecutor;
  model: LanguageModel;
  repository: WorkflowRepository;
  workflowRun: WorkflowRunMetadata;
  searchBudget?: number;
  maxSteps?: number;
  preferredLanguage?: string;
  /** See TvV2Common.now — finishedAt is stamped post-run from this clock. */
  now?: () => string;
}): Promise<MovieWorkflowResult> {
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
    onProgress: makeProgressSink({
      repository: input.repository,
      workflowRunId: input.workflowRun.id,
      neededHint: 1,
    }),
    ...(input.searchBudget === undefined ? {} : { searchBudget: input.searchBudget }),
    ...(input.maxSteps === undefined ? {} : { maxSteps: input.maxSteps }),
    ...(input.preferredLanguage === undefined ? {} : { preferredLanguage: input.preferredLanguage }),
  });

  await input.repository.saveWorkflowRunSnapshot({
    title: input.title,
    season: result.season,
    workflowRun: {
      id: input.workflowRun.id,
      kind: "movie_init",
      status: result.status,
      trackedSeasonId: result.season.id,
      startedAt: input.workflowRun.startedAt,
      finishedAt: now(),
      auditEvents: result.auditEvents,
    },
    episodes: result.episodes,
    resourceSnapshots: result.resourceSnapshots,
    decisions: result.decisions,
    transferAttempts: result.transferAttempts,
    notifications: result.notifications,
  });
  return result;
}
