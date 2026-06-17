import type { LanguageModel } from "ai";
import type {
  AcquisitionSeasonScope,
  EpisodeState,
  MediaTitle,
  MediaType,
  TrackedSeason,
  WorkflowStatus,
} from "./domain.js";
import type { ResourceProvider, StorageExecutor } from "./ports.js";
import type { WorkflowRepository } from "./repository.js";
import { isMovieUnreleased } from "./domain.js";
import {
  runMovieAcquisitionV2AndPersist,
  runSeriesInitializationV2AndPersist,
  runType2InitializationV2AndPersist,
  runType3MonitoringV2AndPersist,
} from "./runner-v2.js";
import { syncSeasonAgainstMetadata } from "./season-sync.js";

/**
 * Pick the 115 landing parent for a title. Anime lands under its own parent
 * (when configured) so the 动漫 library shelf is a physically separate tree,
 * never intermixed with TV shows; everything else uses the default parent.
 */
function storageParentForTitle(
  title: { type: MediaType },
  storageParentDirectoryId: string | undefined,
  animeStorageParentDirectoryId: string | undefined,
): string | undefined {
  if (title.type === "anime" && animeStorageParentDirectoryId !== undefined) {
    return animeStorageParentDirectoryId;
  }
  return storageParentDirectoryId;
}

/**
 * Refresh a tracked season's aired/total counts from TMDB. Returning null (or
 * throwing) leaves the season on its stored counts — the sweep still runs, it
 * just won't discover episodes aired since tracking began.
 */
export type SeasonMetadataSync = (input: {
  tmdbId: number;
  seasonNumber: number;
}) => Promise<{ latestAiredEpisode: number; totalEpisodes: number } | null>;

export type QueuedType2WorkerResult =
  | {
      status: "idle";
    }
  | {
    status: "ran";
    workflowRunId: string;
    workflowStatus: WorkflowStatus;
  }
  | {
      status: "failed";
      workflowRunId: string;
      errorMessage: string;
    };

export async function runQueuedType2Workflow(input: {
  repository: WorkflowRepository;
  resourceProvider: ResourceProvider;
  storage: StorageExecutor;
  model: LanguageModel;
  preferredLanguage?: string;
  qualityPreference?: "high" | "medium";
  now?: () => string;
  storageParentDirectoryId?: string;
  /** Separate landing parent for anime (see runQueuedSeriesInitialization). */
  animeStorageParentDirectoryId?: string;
}): Promise<QueuedType2WorkerResult> {
  const now = input.now ?? (() => new Date().toISOString());
  const claimed = await input.repository.claimNextQueuedWorkflowRun({
    kind: "type2_init",
    now: now(),
  });
  if (!claimed) {
    return { status: "idle" };
  }

  try {
    const result = await runType2InitializationV2AndPersist({
      title: claimed.title,
      season: claimed.season,
      categoryParentId: requireCategoryParent(
        storageParentForTitle(claimed.title, input.storageParentDirectoryId, input.animeStorageParentDirectoryId),
      ),
      resourceProvider: input.resourceProvider,
      storage: input.storage,
      model: input.model,
      repository: input.repository,
      ...(input.preferredLanguage === undefined ? {} : { preferredLanguage: input.preferredLanguage }),
      ...(input.qualityPreference === undefined ? {} : { qualityPreference: input.qualityPreference }),
      // finishedAt is stamped post-run inside the persist step (see runner-v2),
      // so it reflects actual completion, not the claim time.
      workflowRun: {
        id: claimed.workflowRun.id,
        startedAt: claimed.workflowRun.startedAt,
        finishedAt: null,
      },
      now,
    });

    return {
      status: "ran",
      workflowRunId: claimed.workflowRun.id,
      workflowStatus: result.status,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Workflow failed";
    await input.repository.saveWorkflowRunSnapshot({
      title: claimed.title,
      season: claimed.season,
      workflowRun: {
        ...claimed.workflowRun,
        status: "failed",
        finishedAt: now(),
        auditEvents: [
          ...claimed.workflowRun.auditEvents,
          {
            type: "workflow_failed",
            message: errorMessage,
          },
        ],
      },
      episodes: [],
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });

    return {
      status: "failed",
      workflowRunId: claimed.workflowRun.id,
      errorMessage,
    };
  }
}

export type ScheduledType3Outcome =
  | {
      trackedSeasonId: string;
      status: "skipped_active";
    }
  | {
      trackedSeasonId: string;
      status: "ran";
      workflowRunId: string;
      workflowStatus: WorkflowStatus;
    }
  | {
      trackedSeasonId: string;
      status: "failed";
      workflowRunId: string;
      errorMessage: string;
    };

/**
 * Unattended Type 3 sweep: one reservation-guarded monitoring run per active
 * tracked season. One season's failure never blocks the rest, and a failed
 * run preserves the season's episode state (unlike a failed Type 2 init,
 * which clears it).
 */
export async function runScheduledType3Monitoring(input: {
  repository: WorkflowRepository;
  resourceProvider: ResourceProvider;
  storage: StorageExecutor;
  model: LanguageModel;
  preferredLanguage?: string;
  qualityPreference?: "high" | "medium";
  storageParentDirectoryId: string;
  /** Separate landing parent for anime, so anime patrol verify-or-creates under
   *  its own tree (see runQueuedSeriesInitialization). */
  animeStorageParentDirectoryId?: string;
  /** Movies category parent. When set, the sweep also patrols tracked-but-
   *  unobtained films, dispatching the MOVIE agent (by title.type) — 已上映无源
   *  films get retried until covered. Unset → movies are left alone. */
  moviesParentDirectoryId?: string;
  now?: () => string;
  createWorkflowRunId?: () => string;
  staleActiveRunTimeoutMs?: number;
  syncSeasonMetadata?: SeasonMetadataSync;
}): Promise<ScheduledType3Outcome[]> {
  const now = input.now ?? (() => new Date().toISOString());
  const outcomes: ScheduledType3Outcome[] = [];
  const trackedStates = await input.repository.listTrackedSeasonStates();

  for (const state of trackedStates) {
    // Patrol dispatches by title.type: a film needs the MOVIE agent, not the
    // TV/anime agent (different semantics). (未上映/reserved films aren't tracked
    // yet; the air-time gate lands with that product state.)
    if (state.title.type === "movie") {
      const outcome = await patrolMovie({ input, state, now });
      if (outcome) {
        outcomes.push(outcome);
      }
      continue;
    }

    if (state.season.status !== "active" || state.episodes.length === 0) {
      continue;
    }

    // sync_all equivalent: refresh aired/total from TMDB so episodes that aired
    // after tracking began surface as real gaps this sweep can acquire.
    let season = state.season;
    let episodes = state.episodes;
    if (input.syncSeasonMetadata) {
      try {
        const meta = await input.syncSeasonMetadata({
          tmdbId: state.title.tmdbId,
          seasonNumber: state.season.seasonNumber,
        });
        if (meta) {
          const synced = syncSeasonAgainstMetadata({
            season,
            episodes,
            latestAiredEpisode: meta.latestAiredEpisode,
            totalEpisodes: meta.totalEpisodes,
          });
          season = synced.season;
          episodes = synced.episodes;
        }
      } catch {
        // Metadata sync is best-effort; fall back to stored counts.
      }
    }

    const workflowRunId = input.createWorkflowRunId?.() ?? crypto.randomUUID();
    const startedAt = now();
    const staleActiveRunStartedBefore = staleStartedBefore(startedAt, input.staleActiveRunTimeoutMs);

    const reservation = await input.repository.reserveWorkflowRun({
      title: state.title,
      season,
      workflowRun: {
        id: workflowRunId,
        kind: "type3_monitor",
        status: "running",
        trackedSeasonId: season.id,
        startedAt,
        finishedAt: null,
        auditEvents: [
          {
            type: "type3_scheduled",
            message: "Scheduled Type 3 monitoring reserved",
          },
        ],
      },
      episodes,
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
      ...(staleActiveRunStartedBefore === null
        ? {}
        : { staleActiveRunStartedBefore, staleFinishedAt: startedAt }),
    });
    if (reservation.status !== "reserved") {
      outcomes.push({ trackedSeasonId: season.id, status: "skipped_active" });
      continue;
    }

    try {
      const result = await runType3MonitoringV2AndPersist({
        title: state.title,
        season,
        episodes,
        categoryParentId: requireCategoryParent(
          storageParentForTitle(state.title, input.storageParentDirectoryId, input.animeStorageParentDirectoryId),
        ),
        resourceProvider: input.resourceProvider,
        storage: input.storage,
        model: input.model,
        repository: input.repository,
        ...(input.preferredLanguage === undefined ? {} : { preferredLanguage: input.preferredLanguage }),
        ...(input.qualityPreference === undefined ? {} : { qualityPreference: input.qualityPreference }),
        workflowRun: { id: workflowRunId, startedAt, finishedAt: null },
        now,
      });
      outcomes.push({
        trackedSeasonId: state.season.id,
        status: "ran",
        workflowRunId,
        workflowStatus: result.status,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Workflow failed";
      await input.repository.saveWorkflowRunSnapshot({
        title: state.title,
        season: state.season,
        workflowRun: {
          id: workflowRunId,
          kind: "type3_monitor",
          status: "failed",
          trackedSeasonId: state.season.id,
          startedAt,
          finishedAt: now(),
          auditEvents: [
            { type: "type3_scheduled", message: "Scheduled Type 3 monitoring reserved" },
            { type: "workflow_failed", message: errorMessage },
          ],
        },
        episodes: state.episodes,
        resourceSnapshots: [],
        decisions: [],
        transferAttempts: [],
        notifications: [],
      });
      outcomes.push({
        trackedSeasonId: state.season.id,
        status: "failed",
        workflowRunId,
        errorMessage,
      });
    }
  }

  return outcomes;
}

/**
 * Patrol one tracked film: a 已上映无源 movie (anchor episode not obtained) is
 * retried by the MOVIE agent. Returns null when nothing to do (already obtained,
 * or no movies parent configured). A reservation guards against a concurrent run.
 */
async function patrolMovie(args: {
  input: {
    repository: WorkflowRepository;
    resourceProvider: ResourceProvider;
    storage: StorageExecutor;
    model: LanguageModel;
    preferredLanguage?: string;
    qualityPreference?: "high" | "medium";
    moviesParentDirectoryId?: string;
    createWorkflowRunId?: () => string;
    staleActiveRunTimeoutMs?: number;
  };
  state: { title: MediaTitle; season: TrackedSeason; episodes: EpisodeState[] };
  now: () => string;
}): Promise<ScheduledType3Outcome | null> {
  const { input, state, now } = args;
  const moviesParent = input.moviesParentDirectoryId;
  if (moviesParent === undefined) {
    return null;
  }
  const obtained = state.episodes.some((episode) => episode.obtained);
  if (obtained) {
    return null;
  }
  // Air-time gate: a reserved (未上映) film whose release date is still in the
  // future stays reserved — the agent must NOT run before release. Once the date
  // arrives this gate opens and the patrol collects it (点预定 → 上映后自然收).
  if (isMovieUnreleased(state.title.releaseDate, now())) {
    return null;
  }

  const workflowRunId = input.createWorkflowRunId?.() ?? crypto.randomUUID();
  const startedAt = now();
  const staleActiveRunStartedBefore = staleStartedBefore(startedAt, input.staleActiveRunTimeoutMs);
  const reservation = await input.repository.reserveWorkflowRun({
    title: state.title,
    season: state.season,
    workflowRun: {
      id: workflowRunId,
      kind: "movie_init",
      status: "running",
      trackedSeasonId: state.season.id,
      startedAt,
      finishedAt: null,
      auditEvents: [{ type: "movie_patrol_scheduled", message: "Scheduled movie patrol reserved" }],
    },
    episodes: state.episodes,
    resourceSnapshots: [],
    decisions: [],
    transferAttempts: [],
    notifications: [],
    ...(staleActiveRunStartedBefore === null
      ? {}
      : { staleActiveRunStartedBefore, staleFinishedAt: startedAt }),
  });
  if (reservation.status !== "reserved") {
    return { trackedSeasonId: state.season.id, status: "skipped_active" };
  }

  try {
    const result = await runMovieAcquisitionV2AndPersist({
      title: state.title,
      categoryParentId: moviesParent,
      resourceProvider: input.resourceProvider,
      storage: input.storage,
      model: input.model,
      repository: input.repository,
      ...(input.preferredLanguage === undefined ? {} : { preferredLanguage: input.preferredLanguage }),
      ...(input.qualityPreference === undefined ? {} : { qualityPreference: input.qualityPreference }),
      workflowRun: { id: workflowRunId, startedAt, finishedAt: null },
      now,
    });
    return { trackedSeasonId: state.season.id, status: "ran", workflowRunId, workflowStatus: result.status };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Workflow failed";
    await input.repository.saveWorkflowRunSnapshot({
      title: state.title,
      season: state.season,
      workflowRun: {
        id: workflowRunId,
        kind: "movie_init",
        status: "failed",
        trackedSeasonId: state.season.id,
        startedAt,
        finishedAt: now(),
        auditEvents: [
          { type: "movie_patrol_scheduled", message: "Scheduled movie patrol reserved" },
          { type: "workflow_failed", message: errorMessage },
        ],
      },
      episodes: state.episodes,
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });
    return { trackedSeasonId: state.season.id, status: "failed", workflowRunId, errorMessage };
  }
}

function staleStartedBefore(nowIso: string, timeoutMs: number | undefined): string | null {
  if (timeoutMs === undefined) {
    return null;
  }
  if (timeoutMs <= 0) {
    throw new Error("staleActiveRunTimeoutMs must be positive");
  }
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(nowMs)) {
    throw new Error(`Invalid now timestamp: ${nowIso}`);
  }
  return new Date(nowMs - timeoutMs).toISOString();
}

/**
 * The V2 directory lifecycle must verify-or-create the library category parent
 * (Movies/TV/Anime); a missing parent is a misconfiguration, not a silent
 * account-root fallback (fail loud — see acquisition-hard-details).
 */
function requireCategoryParent(parent: string | undefined): string {
  if (parent === undefined || parent === "") {
    throw new Error(
      "MEDIA_TRACK_CATEGORY_PARENT_REQUIRED: a library category parent (Movies/TV/Anime) is required for directory verify-or-create",
    );
  }
  return parent;
}

export async function runQueuedMovieAcquisition(input: {
  repository: WorkflowRepository;
  resourceProvider: ResourceProvider;
  storage: StorageExecutor;
  model: LanguageModel;
  preferredLanguage?: string;
  qualityPreference?: "high" | "medium";
  moviesParentDirectoryId: string;
  now?: () => string;
}): Promise<QueuedType2WorkerResult> {
  const now = input.now ?? (() => new Date().toISOString());
  const claimed = await input.repository.claimNextQueuedWorkflowRun({ kind: "movie_init", now: now() });
  if (!claimed) {
    return { status: "idle" };
  }

  try {
    const result = await runMovieAcquisitionV2AndPersist({
      title: claimed.title,
      categoryParentId: input.moviesParentDirectoryId,
      resourceProvider: input.resourceProvider,
      storage: input.storage,
      model: input.model,
      repository: input.repository,
      ...(input.preferredLanguage === undefined ? {} : { preferredLanguage: input.preferredLanguage }),
      ...(input.qualityPreference === undefined ? {} : { qualityPreference: input.qualityPreference }),
      workflowRun: { id: claimed.workflowRun.id, startedAt: claimed.workflowRun.startedAt, finishedAt: null },
      now,
    });
    return { status: "ran", workflowRunId: claimed.workflowRun.id, workflowStatus: result.status };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Workflow failed";
    await input.repository.saveWorkflowRunSnapshot({
      title: claimed.title,
      season: claimed.season,
      workflowRun: {
        ...claimed.workflowRun,
        status: "failed",
        finishedAt: now(),
        auditEvents: [...claimed.workflowRun.auditEvents, { type: "workflow_failed", message: errorMessage }],
      },
      episodes: [],
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });
    return { status: "failed", workflowRunId: claimed.workflowRun.id, errorMessage };
  }
}

export async function runQueuedSeriesInitialization(input: {
  repository: WorkflowRepository;
  resourceProvider: ResourceProvider;
  storage: StorageExecutor;
  model: LanguageModel;
  preferredLanguage?: string;
  qualityPreference?: "high" | "medium";
  storageParentDirectoryId: string;
  /** Separate landing parent for anime, so the 动漫 shelf is physically its own
   *  tree on 115 and never mixed into the TV shows directory. */
  animeStorageParentDirectoryId?: string;
  now?: () => string;
}): Promise<QueuedType2WorkerResult> {
  const now = input.now ?? (() => new Date().toISOString());
  const claimed = await input.repository.claimNextQueuedWorkflowRun({
    kind: "type1_package_init",
    now: now(),
  });
  if (!claimed) {
    return { status: "idle" };
  }

  const queuedEvent = claimed.workflowRun.auditEvents.find((event) => event.type === "series_init_queued");
  const seasons = (queuedEvent?.data?.["seasons"] ?? []) as AcquisitionSeasonScope[];

  try {
    if (seasons.length === 0) {
      throw new Error("Queued series initialization run is missing its season metadata");
    }
    const result = await runSeriesInitializationV2AndPersist({
      title: claimed.title,
      seasons,
      categoryParentId: requireCategoryParent(
        storageParentForTitle(claimed.title, input.storageParentDirectoryId, input.animeStorageParentDirectoryId),
      ),
      seasonQualityRecord: claimed.season.qualityPreference,
      resourceProvider: input.resourceProvider,
      storage: input.storage,
      model: input.model,
      repository: input.repository,
      ...(input.preferredLanguage === undefined ? {} : { preferredLanguage: input.preferredLanguage }),
      ...(input.qualityPreference === undefined ? {} : { qualityPreference: input.qualityPreference }),
      workflowRun: {
        id: claimed.workflowRun.id,
        startedAt: claimed.workflowRun.startedAt,
        finishedAt: null,
      },
      now,
    });
    // Finalize the claimed lock run itself; it doubles as season 1's summary
    // record (same tracked season and episode state as the persisted _s1 run).
    const firstSeason = result.seasons[0];
    await input.repository.saveWorkflowRunSnapshot({
      title: claimed.title,
      season: firstSeason?.season ?? claimed.season,
      workflowRun: {
        ...claimed.workflowRun,
        status: result.status,
        finishedAt: now(),
        auditEvents: [...claimed.workflowRun.auditEvents, ...result.auditEvents],
      },
      episodes: firstSeason?.episodes ?? [],
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });
    return {
      status: "ran",
      workflowRunId: claimed.workflowRun.id,
      workflowStatus: result.status,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Workflow failed";
    await input.repository.saveWorkflowRunSnapshot({
      title: claimed.title,
      season: claimed.season,
      workflowRun: {
        ...claimed.workflowRun,
        status: "failed",
        finishedAt: now(),
        auditEvents: [
          ...claimed.workflowRun.auditEvents,
          { type: "workflow_failed", message: errorMessage },
        ],
      },
      episodes: [],
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });
    return { status: "failed", workflowRunId: claimed.workflowRun.id, errorMessage };
  }
}
