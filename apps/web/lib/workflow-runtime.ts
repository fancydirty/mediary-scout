import {
  createPanSouResourceProviderFromEnv,
  createProtectedPan115CookieStorageExecutorFromEnv,
  createTmdbMetadataProviderFromEnv,
  episodeCode,
  FakeResourceProvider,
  FakeStorageExecutor,
  createNotifyChannelsFromEnv,
  createAgentModelFromEnv,
  createStubAcquisitionModel,
  dispatchNotifications,
  formatDailyDigestPushText,
  getTrackedSeasonStatusView,
  importForeignWorkAsMovie,
  assertWorkflowAgentAdapterPolicy,
  prepareMovieTarget,
  prepareSeriesTarget,
  prepareTrackingTarget,
  queueMovieAcquisition,
  queueSeriesInitialization,
  queueTrackingInitialization,
  reserveMovie,
  runQueuedMovieAcquisition,
  runQueuedSeriesInitialization,
  runQueuedType2Workflow,
  runScheduledType3Monitoring,
  sendPushNotifications,
  createPostgresWorkflowRepositorySync,
  type MediaSearchCandidate,
  type MediaTitle,
  type NotificationEvent,
  type ResourceProvider,
  type SeasonMetadataSync,
  type StorageExecutor,
  type TrackedSeason,
  type TrackedSeasonStatusView,
  type VerifiedFile,
  type WorkflowRepository,
} from "@media-track/workflow";
import { findDemoCandidateById, findDemoCandidateByTmdbId } from "./demo-candidates";
import { seedDemoWorkflowRepository } from "./demo-workflow";

export type CandidateTrackingRequestResult =
  | {
      status: "queued" | "already_running" | "already_tracked";
      workflowRunId: string | null;
      trackedSeasonId: string;
    }
  | {
      status: "unsupported";
      message: string;
    };

let repository: WorkflowRepository | null = null;
let demoSeedPromise: Promise<void> | null = null;
let fakeResourceProvider: ResourceProvider | null = null;
let fakeStorageExecutor: StorageExecutor | null = null;
let agentModel:
  | { adapter: "fake" | "vercel-ai"; model: ReturnType<typeof createAgentModelFromEnv> }
  | null = null;

/** The Postgres connection string for durable dev/prod state. SQLite has been
 *  retired — dev runs on OrbStack Postgres. */
export function postgresConnectionString(): string {
  const url = process.env.MEDIA_TRACK_POSTGRES_URL?.trim();
  if (!url) {
    throw new Error("MEDIA_TRACK_POSTGRES_URL is required (the SQLite dev DB has been retired)");
  }
  return url;
}

export function getWorkflowRepository(): WorkflowRepository {
  if (!repository) {
    repository = createPostgresWorkflowRepositorySync({ connectionString: postgresConnectionString() });
  }
  return repository;
}

export async function ensureDemoSeeded(targetRepository: WorkflowRepository): Promise<void> {
  if (process.env.MEDIA_TRACK_DEMO_SEED === "0") {
    return;
  }
  demoSeedPromise ??= seedDemoIfEmpty(targetRepository);
  await demoSeedPromise;
}

export async function getWorkflowStatusView(
  targetRepository: WorkflowRepository,
): Promise<TrackedSeasonStatusView | null> {
  const trackedStates = await targetRepository.listTrackedSeasonStates();
  // The spotlight is the season that still needs attention: prefer an
  // actively-airing season over completed ones.
  const firstTracked =
    trackedStates.find((state) => state.season.status === "active") ?? trackedStates[0];
  if (!firstTracked) {
    return null;
  }
  return getTrackedSeasonStatusView({
    repository: targetRepository,
    trackedSeasonId: firstTracked.season.id,
  });
}

export async function queueCandidateTracking(candidateId: string): Promise<CandidateTrackingRequestResult> {
  const movieTmdbId = parseMovieCandidateId(candidateId);
  if (movieTmdbId !== null) {
    const movie = await movieTargetFromTmdbId(movieTmdbId);
    if (!movie) {
      return { status: "unsupported", message: "无法获取该电影的信息。" };
    }
    const request = await queueMovieAcquisition({
      title: movie.title,
      keyword: movie.keyword,
      repository: getWorkflowRepository(),
    });
    return {
      status: request.status === "queued" ? "queued" : request.status,
      workflowRunId: request.workflowRunId,
      trackedSeasonId: `${movie.title.id}_movie`,
    };
  }

  const target = await trackingTargetFromCandidateId(candidateId);
  if (!target) {
    return {
      status: "unsupported",
      message: "暂时只支持剧集第 1 季的后台获取。",
    };
  }

  const request = await queueTrackingInitialization({
    title: target.title,
    season: target.season,
    keyword: target.keyword,
    repository: getWorkflowRepository(),
  });
  const status = request.status === "completed" ? "queued" : request.status;

  return {
    status,
    workflowRunId: request.workflowRunId,
    trackedSeasonId: request.trackedSeasonId,
  };
}

/**
 * Crash recovery for the single-instance in-process worker: any run still
 * "running" when the server (re)starts is orphaned by a dead worker (only this
 * process executes runs), so requeue it to be claimed again. Returns the count.
 */
export async function recoverOrphanedRuns(): Promise<number> {
  return getWorkflowRepository().requeueRunningWorkflowRuns();
}

export async function runNextQueuedWorkflow() {
  const repository = getWorkflowRepository();
  await hydratePan115CookieFromDb();
  // The user's language preference is standing context baked into the agent
  // instance (one global preference), so every workflow — movie, series, type2,
  // anime — searches with it. No per-workflow plumbing.
  const { model, preferredLanguage, qualityPreference } = await getAgentModel(repository);
  const language = preferredLanguage === undefined ? {} : { preferredLanguage };
  const quality = qualityPreference === undefined ? {} : { qualityPreference };
  const startedAt = new Date().toISOString();
  const type2 = await runQueuedType2Workflow({
    repository,
    resourceProvider: getWorkerResourceProvider(),
    storage: getWorkerStorageExecutor(),
    model,
    ...language,
    ...quality,
    storageParentDirectoryId: storageParentDirectoryId(),
    animeStorageParentDirectoryId: animeParentDirectoryId(),
  });
  if (type2.status !== "idle") {
    await pushNotificationsSince(repository, startedAt);
    return type2;
  }
  const series = await runQueuedSeriesInitialization({
    repository,
    resourceProvider: getWorkerResourceProvider(),
    storage: getWorkerStorageExecutor(),
    model,
    ...language,
    ...quality,
    storageParentDirectoryId: storageParentDirectoryId(),
    animeStorageParentDirectoryId: animeParentDirectoryId(),
  });
  if (series.status !== "idle") {
    await pushNotificationsSince(repository, startedAt);
    return series;
  }
  const movie = await runQueuedMovieAcquisition({
    repository,
    resourceProvider: getWorkerResourceProvider(),
    storage: getWorkerStorageExecutor(),
    model,
    ...language,
    ...quality,
    moviesParentDirectoryId: moviesParentDirectoryId(),
  });
  if (movie.status !== "idle") {
    await pushNotificationsSince(repository, startedAt);
  }
  return movie;
}

/** The user's preferred subtitle language for acquisition search, or undefined
 *  when unset / "any" (agent searches broadly). */
export async function getPreferredLanguage(
  repository: { getSetting(key: string): Promise<string | null> },
): Promise<string | undefined> {
  const value = (await repository.getSetting(PREFERRED_LANGUAGE_SETTING_KEY))?.trim();
  // Explicit "不限" → no preference. Unset → the product default the Settings UI
  // shows as selected ("中文（默认）"), so a fresh install actually prefers Chinese
  // subtitles instead of silently searching broadly.
  if (value === "any") {
    return undefined;
  }
  return value || "中文";
}

export const PREFERRED_LANGUAGE_SETTING_KEY = "preferred_language";

export const QUALITY_PREFERENCE_SETTING_KEY = "quality_preference";

/** The user's acquisition quality preference, or undefined when 不限/unset
 *  (the default). undefined → inject NO quality guidance (coverage-only, current
 *  behavior). Only "high"/"medium" are honored; anything else (incl. the legacy
 *  "4K" value) is treated as 不限. */
export async function getQualityPreference(
  repository: { getSetting(key: string): Promise<string | null> },
): Promise<"high" | "medium" | undefined> {
  const value = (await repository.getSetting(QUALITY_PREFERENCE_SETTING_KEY))?.trim();
  return value === "high" || value === "medium" ? value : undefined;
}

export const DAILY_SWEEP_TIME_SETTING_KEY = "daily_sweep_time";
/** Default daily 巡检 time (Beijing) when the user hasn't configured one. */
export const DEFAULT_DAILY_SWEEP_TIME = "06:00";

/** The configured daily-sweep time as "HH:MM" (Beijing), or the 06:00 default
 *  when unset/malformed. The self-hosted scheduler fires run-type3 at this time. */
export async function getDailySweepTime(
  repository: { getSetting(key: string): Promise<string | null> },
): Promise<string> {
  const value = (await repository.getSetting(DAILY_SWEEP_TIME_SETTING_KEY))?.trim();
  return value && /^\d{2}:\d{2}$/.test(value) ? value : DEFAULT_DAILY_SWEEP_TIME;
}

function parseMovieCandidateId(candidateId: string): number | null {
  const match = /^tmdb_movie_(\d+)$/.exec(candidateId);
  return match ? Number(match[1]) : null;
}

export async function movieTargetFromTmdbId(
  tmdbId: number,
): Promise<{ title: MediaTitle; keyword: string } | null> {
  if (process.env.MEDIA_TRACK_SEARCH_PROVIDER === "tmdb" && process.env.TMDB_READ_TOKEN) {
    return prepareMovieTarget({
      tmdbId,
      qualityPreference: defaultQuality(),
      metadataProvider: createTmdbMetadataProviderFromEnv(),
    });
  }
  const candidate = findDemoCandidateByTmdbId(tmdbId);
  if (!candidate || candidate.mediaType !== "movie") {
    return null;
  }
  const title: MediaTitle = {
    id: `tmdb_movie_${candidate.tmdbId}`,
    tmdbId: candidate.tmdbId,
    type: "movie",
    title: candidate.title,
    originalTitle: candidate.originalTitle,
    year: candidate.year,
    releaseDate: candidate.releaseDate ?? null,
    aliases:
      candidate.originalTitle && candidate.originalTitle !== candidate.title ? [candidate.originalTitle] : [],
    posterPath: candidate.posterPath,
    backdropPath: candidate.backdropPath,
    overview: candidate.overview,
  };
  return { title, keyword: candidate.title };
}

export type CandidateReserveRequestResult =
  | { status: "reserved" | "already_running" | "already_tracked"; trackedSeasonId: string }
  | { status: "unsupported"; message: string };

/**
 * 预定 an unreleased film: track it (carrying its release date) WITHOUT running
 * the agent. The daily patrol's air-time gate acquires it once it releases.
 * Movies only (TV/anime have no reserve concept).
 */
export async function reserveCandidate(candidateId: string): Promise<CandidateReserveRequestResult> {
  const movieTmdbId = parseMovieCandidateId(candidateId);
  if (movieTmdbId === null) {
    return { status: "unsupported", message: "只有电影可以预定。" };
  }
  const movie = await movieTargetFromTmdbId(movieTmdbId);
  if (!movie) {
    return { status: "unsupported", message: "无法获取该电影的信息。" };
  }
  const request = await reserveMovie({ title: movie.title, repository: getWorkflowRepository() });
  return { status: request.status, trackedSeasonId: `${movie.title.id}_movie` };
}

/**
 * Outbound push rides on the feed: whatever notifications a run persisted
 * are delivered to every user-configured channel (DB config > env). Delivery
 * failures are logged, never thrown — the run already succeeded.
 */
async function pushNotificationsSince(
  targetRepository: WorkflowRepository,
  sinceIso: string,
): Promise<void> {
  try {
    const recent = (await targetRepository.listNotifications({ limit: 50 })).filter(
      (notification) => notification.createdAt >= sinceIso,
    );
    if (recent.length === 0) {
      return;
    }

    // A scheduled sweep touches many shows; collapse its notifications into one
    // digest push instead of one message per show. User-triggered events stay
    // per-resource — each is its own message.
    const scheduled = recent.filter((notification) => notification.trigger === "scheduled");
    const individual = recent.filter((notification) => notification.trigger !== "scheduled");

    for (const notification of individual) {
      try {
        await sendPushNotifications({ repository: targetRepository, notification });
      } catch (error) {
        console.error(
          `[media-track] push for ${notification.id} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (scheduled.length > 0) {
      const digest: NotificationEvent = {
        id: `digest_${sinceIso}`,
        workflowRunId: scheduled[0]!.workflowRunId,
        kind: "daily_digest",
        title: "每日巡检",
        body: formatDailyDigestPushText(scheduled),
        createdAt: new Date().toISOString(),
        trigger: "scheduled",
      };
      try {
        await sendPushNotifications({ repository: targetRepository, notification: digest });
      } catch (error) {
        console.error(
          `[media-track] digest push failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  } catch (error) {
    console.error(`[media-track] notification push batch failed: ${String(error)}`);
  }
}

export async function queueCandidateSeries(candidateId: string): Promise<CandidateTrackingRequestResult> {
  const parsed = parseTvCandidateId(candidateId);
  if (!parsed) {
    return { status: "unsupported", message: "暂时只支持剧集的全剧获取。" };
  }
  if (process.env.MEDIA_TRACK_SEARCH_PROVIDER === "tmdb" && process.env.TMDB_READ_TOKEN) {
    const target = await prepareSeriesTarget({
      tmdbId: parsed.tmdbId,
      qualityPreference: defaultQuality(),
      metadataProvider: createTmdbMetadataProviderFromEnv(),
    });
    const request = await queueSeriesInitialization({
      title: target.title,
      seasons: target.seasons,
      keyword: target.keyword,
      repository: getWorkflowRepository(),
    });
    return {
      status: request.status === "queued" ? "queued" : request.status,
      workflowRunId: request.workflowRunId,
      trackedSeasonId: `${target.title.id}_s${target.seasons[0]?.seasonNumber ?? 1}`,
    };
  }

  const candidate = findDemoCandidateById(candidateId);
  if (!candidate || candidate.mediaType !== "tv") {
    return { status: "unsupported", message: "暂时只支持剧集的全剧获取。" };
  }
  const request = await queueSeriesInitialization({
    title: {
      id: `tmdb_tv_${candidate.tmdbId}`,
      tmdbId: candidate.tmdbId,
      type: "tv",
      title: candidate.title,
      originalTitle: candidate.originalTitle,
      year: candidate.year,
      aliases:
        candidate.originalTitle && candidate.originalTitle !== candidate.title ? [candidate.originalTitle] : [],
    },
    seasons: candidate.seasons.map((season) => ({
      seasonNumber: season.seasonNumber,
      totalEpisodes: season.episodeCount,
      latestAiredEpisode: season.latestAiredEpisode,
    })),
    keyword: candidate.title.trim(), // quality NEVER in the keyword (search-methodology law)
    repository: getWorkflowRepository(),
  });
  return {
    status: request.status === "queued" ? "queued" : request.status,
    workflowRunId: request.workflowRunId,
    trackedSeasonId: `tmdb_tv_${candidate.tmdbId}_s1`,
  };
}

export const LAST_SWEEP_DATE_SETTING_KEY = "last_sweep_date";

/** Beijing wall-clock "date" (YYYY-MM-DD) and "HH:MM" right now. */
function beijingDateTime(): { date: string; hhmm: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hhmm: `${get("hour")}:${get("minute")}` };
}

/**
 * The daily 巡检. The configured sweep time is the single source of truth: any
 * trigger (Vercel cron, self-hosted scheduler, manual) just pings this, and the
 * gate runs the sweep at most once per Beijing day, only once the clock has
 * reached the user-configured time — so the Settings time is authoritative
 * regardless of how often the trigger fires. `force` bypasses the gate for
 * on-demand "sweep now".
 */
export async function runScheduledType3(options?: { force?: boolean }): Promise<{
  outcomes: Awaited<ReturnType<typeof runScheduledType3Monitoring>>;
  skipped?: "already_swept_today" | "before_scheduled_time";
  scheduledFor?: string;
}> {
  const repository = getWorkflowRepository();
  let claimedDay = false;
  if (!options?.force) {
    const target = await getDailySweepTime(repository);
    const { date, hhmm } = beijingDateTime();
    const lastDate = (await repository.getSetting(LAST_SWEEP_DATE_SETTING_KEY))?.trim();
    if (date === lastDate) {
      return { skipped: "already_swept_today", outcomes: [] };
    }
    if (hhmm < target) {
      return { skipped: "before_scheduled_time", scheduledFor: target, outcomes: [] };
    }
    // Claim the day BEFORE running, so a second near-simultaneous trigger no-ops
    // instead of launching a duplicate sweep. If the sweep then fails wholesale
    // (cookie hydration, agent-node init, infra), we RELEASE the claim below so
    // the next ping retries today rather than skipping until tomorrow.
    await repository.setSetting(LAST_SWEEP_DATE_SETTING_KEY, date);
    claimedDay = true;
  }
  const startedAt = new Date().toISOString();
  let result: Awaited<ReturnType<typeof runScheduledType3Monitoring>>;
  try {
    await hydratePan115CookieFromDb();
    const sync = tmdbSeasonMetadataSync();
    const { model, preferredLanguage, qualityPreference } = await getAgentModel(repository);
    result = await runScheduledType3Monitoring({
      repository,
      resourceProvider: getWorkerResourceProvider(),
      storage: getWorkerStorageExecutor(),
      model,
      ...(preferredLanguage === undefined ? {} : { preferredLanguage }),
      ...(qualityPreference === undefined ? {} : { qualityPreference }),
      storageParentDirectoryId: storageParentDirectoryId(),
      animeStorageParentDirectoryId: animeParentDirectoryId(),
      moviesParentDirectoryId: moviesParentDirectoryId(),
      staleActiveRunTimeoutMs: 30 * 60 * 1000,
      ...(sync ? { syncSeasonMetadata: sync } : {}),
    });
    await pushNotificationsSince(repository, startedAt);
    return { outcomes: result };
  } catch (error) {
    // The sweep failed before completing — release today's claim so the next
    // ping retries instead of skipping until tomorrow. Per-season failures are
    // swallowed inside the monitor, so this only fires on infra-level errors.
    if (claimedDay) {
      try {
        await repository.setSetting(LAST_SWEEP_DATE_SETTING_KEY, "");
      } catch {
        // best-effort release; nothing else to do
      }
    }
    throw error;
  }
}

/**
 * The Type 3 sweep's TMDB re-sync (the GUI's `sync_all`): refresh each tracked
 * season's aired/total from TMDB so the sweep discovers episodes that aired
 * after tracking began. Returns undefined when TMDB isn't configured, leaving
 * the sweep on stored counts.
 */
function tmdbSeasonMetadataSync(): SeasonMetadataSync | undefined {
  if (!(process.env.MEDIA_TRACK_SEARCH_PROVIDER === "tmdb" && process.env.TMDB_READ_TOKEN)) {
    return undefined;
  }
  return async ({ tmdbId, seasonNumber }) => {
    const target = await prepareTrackingTarget({
      tmdbId,
      mediaType: "tv",
      seasonNumber,
      qualityPreference: defaultQuality(),
      metadataProvider: createTmdbMetadataProviderFromEnv(),
    });
    return {
      latestAiredEpisode: target.season.latestAiredEpisode,
      totalEpisodes: target.season.totalEpisodes,
    };
  };
}

async function seedDemoIfEmpty(targetRepository: WorkflowRepository): Promise<void> {
  const tracked = await targetRepository.listTrackedSeasonStates();
  if (tracked.length > 0) {
    return;
  }
  await seedDemoWorkflowRepository(targetRepository);
}

async function trackingTargetFromCandidateId(candidateId: string): Promise<{
  title: MediaTitle;
  season: TrackedSeason;
  keyword: string;
} | null> {
  const parsed = parseTvCandidateId(candidateId);
  if (!parsed) {
    return null;
  }

  if (process.env.MEDIA_TRACK_SEARCH_PROVIDER === "tmdb" && process.env.TMDB_READ_TOKEN) {
    return prepareTrackingTarget({
      tmdbId: parsed.tmdbId,
      mediaType: "tv",
      seasonNumber: parsed.seasonNumber,
      qualityPreference: defaultQuality(),
      storageDirectoryId: storageDirectoryIdForCandidate(candidateId),
      metadataProvider: createTmdbMetadataProviderFromEnv(),
    });
  }

  const candidate = findDemoCandidateById(candidateId);
  if (!candidate || candidate.mediaType !== "tv") {
    return null;
  }
  return targetFromSearchCandidate(candidate, parsed.seasonNumber, candidateId);
}

function targetFromSearchCandidate(
  candidate: MediaSearchCandidate,
  seasonNumber: number,
  candidateId: string,
): {
  title: MediaTitle;
  season: TrackedSeason;
  keyword: string;
} | null {
  const season = candidate.seasons.find((item) => item.seasonNumber === seasonNumber);
  if (!season) {
    return null;
  }
  const titleId = `tmdb_tv_${candidate.tmdbId}`;
  const title: MediaTitle = {
    id: titleId,
    tmdbId: candidate.tmdbId,
    type: "tv",
    title: candidate.title,
    originalTitle: candidate.originalTitle,
    year: candidate.year,
    aliases: candidate.originalTitle && candidate.originalTitle !== candidate.title ? [candidate.originalTitle] : [],
  };
  const trackedSeason: TrackedSeason = {
    id: candidateId,
    mediaTitleId: title.id,
    seasonNumber,
    status: season.latestAiredEpisode >= season.episodeCount ? "completed" : "active",
    qualityPreference: defaultQuality(),
    storageDirectoryId: storageDirectoryIdForCandidate(candidateId),
    totalEpisodes: season.episodeCount,
    latestAiredEpisode: season.latestAiredEpisode,
    latestAiredSource: "metadata",
  };
  return {
    title,
    season: trackedSeason,
    keyword: candidate.title.trim(), // quality NEVER in the keyword (search-methodology law)
  };
}

function parseTvCandidateId(candidateId: string): { tmdbId: number; seasonNumber: number } | null {
  const match = /^tmdb_tv_(\d+)_s(\d+)$/.exec(candidateId);
  if (!match) {
    return null;
  }
  return {
    tmdbId: Number(match[1]),
    seasonNumber: Number(match[2]),
  };
}

function getWorkerResourceProvider(): ResourceProvider {
  if (process.env.MEDIA_TRACK_WORKFLOW_ADAPTER === "pansou") {
    return createPanSouResourceProviderFromEnv();
  }
  fakeResourceProvider ??= new FakeResourceProvider({
    keywordResults: {
      "翘楚 4K": [
        {
          title: "翘楚 S01E01-S01E12 4K",
          episodeHints: episodeCodes(1, 12),
          qualityHints: ["4K"],
        },
      ],
      "绝命毒师 4K": [
        {
          title: "绝命毒师 S01E01-S01E07 4K",
          episodeHints: episodeCodes(1, 7),
          qualityHints: ["4K"],
        },
      ],
    },
  });
  return fakeResourceProvider;
}

function getWorkerStorageExecutor(): StorageExecutor {
  const adapter = process.env.MEDIA_TRACK_STORAGE_ADAPTER ?? "fake";
  if (adapter === "115") {
    return createProtectedPan115CookieStorageExecutorFromEnv({ env: process.env });
  }
  if (adapter !== "fake") {
    throw new Error(`MEDIA_TRACK_STORAGE_ADAPTER_UNSUPPORTED: ${adapter}`);
  }
  fakeStorageExecutor ??= new FakeStorageExecutor({
    transferOutcomes: fakeTransferOutcomes(),
  });
  return fakeStorageExecutor;
}

/**
 * The V2 acquisition agent is a bare LanguageModel driving the sandbox tool-loop
 * (not the old AgentNodes). The adapter policy forces vercel-ai whenever the live
 * PanSou provider or 115 storage is in use; the fake adapter gets a no-op stub so
 * dev/demo runs complete without a real model. The preferred subtitle language is
 * passed to each workflow as standing context, not baked into the model instance.
 */
async function getAgentModel(repository: {
  getSetting(key: string): Promise<string | null>;
}): Promise<{
  model: ReturnType<typeof createAgentModelFromEnv>;
  preferredLanguage: string | undefined;
  qualityPreference: "high" | "medium" | undefined;
}> {
  assertWorkflowAgentAdapterPolicy(process.env);
  const adapter = process.env.MEDIA_TRACK_AGENT_ADAPTER === "vercel-ai" ? "vercel-ai" : "fake";
  const preferredLanguage = await getPreferredLanguage(repository);
  const qualityPreference = await getQualityPreference(repository);
  if (agentModel?.adapter !== adapter) {
    agentModel = {
      adapter,
      model: adapter === "vercel-ai" ? createAgentModelFromEnv(process.env) : createStubAcquisitionModel(),
    };
  }
  return { model: agentModel.model, preferredLanguage, qualityPreference };
}

function fakeTransferOutcomes() {
  const outcomes: Record<string, { status: "succeeded"; providerMessage: string; files: VerifiedFile[] }> = {};
  for (let snapshotNumber = 1; snapshotNumber <= 20; snapshotNumber += 1) {
    const candidateId = `snapshot_${snapshotNumber}_candidate_1`;
    outcomes[candidateId] = {
      status: "succeeded",
      providerMessage: "fake transfer completed",
      files: episodeCodes(1, 24).map((code) => fakeVerifiedFile(candidateId, code)),
    };
  }
  return outcomes;
}

function fakeVerifiedFile(candidateId: string, code: string): VerifiedFile {
  return {
    id: `${candidateId}_${code}`,
    storageDirectoryId: "assigned_by_fake_storage",
    name: `Demo.${code}.mkv`,
    sizeBytes: 1_000_000_000,
    episodeCode: code,
    providerFileId: `provider_${candidateId}_${code}`,
  };
}

function episodeCodes(seasonNumber: number, count: number): string[] {
  return Array.from({ length: count }, (_, index) => episodeCode(seasonNumber, index + 1));
}

function storageDirectoryIdForCandidate(_candidateId: string): string {
  // Empty means "let the Type 2 workflow create the canonical
  // `Title (Year)/Season N` directory under the configured parent".
  return process.env.MEDIA_TRACK_DEFAULT_TV_STORAGE_DIRECTORY_ID ?? "";
}

function storageParentDirectoryId(): string {
  return (
    process.env.MEDIA_TRACK_TV_PARENT_CID ??
    process.env.MEDIA_TRACK_115_TEST_ROOT_CID ??
    "fake_library_root"
  );
}

/**
 * Separate 115 landing parent for anime. Falls back to the TV parent when
 * MEDIA_TRACK_ANIME_PARENT_CID is unset, so anime simply co-locates with TV
 * until a dedicated Anime directory is configured.
 */
function animeParentDirectoryId(): string {
  return process.env.MEDIA_TRACK_ANIME_PARENT_CID ?? storageParentDirectoryId();
}

function defaultQuality(): string {
  return process.env.MEDIA_TRACK_DEFAULT_QUALITY ?? "4K";
}

export interface ForeignWorkFinding {
  stagingDirectoryId: string;
  files: Array<{ providerFileId: string; sourcePath: string }>;
}

export interface ForeignWorkReview {
  workflowRunId: string;
  titleName: string;
  findings: ForeignWorkFinding[];
}

/** Foreign-work findings recorded by a run, for the user-confirmation page. */
export async function getForeignWorkReview(workflowRunId: string): Promise<ForeignWorkReview | null> {
  const repository = getWorkflowRepository();
  const snapshot = await repository.getWorkflowRunSnapshot(workflowRunId);
  if (!snapshot) {
    return null;
  }
  const findings = snapshot.workflowRun.auditEvents
    .filter((event) => event.type === "foreign_work_detected")
    .map((event) => event.data as unknown as ForeignWorkFinding)
    .filter((finding) => Array.isArray(finding?.files) && finding.files.length > 0);
  return { workflowRunId, titleName: snapshot.title.title, findings };
}

export async function importForeignWorkFiles(input: {
  providerFileIds: string[];
  movieTitle: string;
  year: number;
}): Promise<{ movieDirectoryId: string; movedFileIds: string[] }> {
  return importForeignWorkAsMovie({
    storage: getWorkerStorageExecutor(),
    providerFileIds: input.providerFileIds,
    movieTitle: input.movieTitle,
    year: input.year,
    moviesParentDirectoryId: moviesParentDirectoryId(),
  });
}

function moviesParentDirectoryId(): string {
  return (
    process.env.MEDIA_TRACK_MOVIES_PARENT_CID ??
    process.env.MEDIA_TRACK_115_TEST_ROOT_CID ??
    "fake_movies_root"
  );
}

// ---------------------------------------------------------------------------
// 115 connection (QR login) — cookie lives in the DB once connected; the
// repo-root .env PAN115_COOKIE remains the bootstrap fallback.

const PAN115_COOKIE_KEY = "pan115.cookie";
const PAN115_META_KEY = "pan115.cookieMeta";

let pan115CookieHydrated = false;

/** DB cookie (newer truth from QR connect) wins over the .env bootstrap. */
export async function hydratePan115CookieFromDb(): Promise<void> {
  if (pan115CookieHydrated) {
    return;
  }
  pan115CookieHydrated = true;
  try {
    const cookie = await getWorkflowRepository().getSetting(PAN115_COOKIE_KEY);
    if (cookie) {
      process.env.PAN115_COOKIE = cookie;
    }
  } catch (error) {
    console.error(`[media-track] failed to hydrate 115 cookie from DB: ${String(error)}`);
  }
}

export interface Pan115ConnectionStatus {
  connected: boolean;
  source: "qr" | "env" | "none";
  userName: string | null;
  app: string | null;
  connectedAt: string | null;
}

export async function getPan115ConnectionStatus(): Promise<Pan115ConnectionStatus> {
  const repository = getWorkflowRepository();
  const cookie = await repository.getSetting(PAN115_COOKIE_KEY);
  if (cookie) {
    const metaRaw = await repository.getSetting(PAN115_META_KEY);
    let meta: { userName?: string; app?: string; connectedAt?: string } = {};
    try {
      meta = metaRaw ? (JSON.parse(metaRaw) as typeof meta) : {};
    } catch {
      meta = {};
    }
    return {
      connected: true,
      source: "qr",
      userName: meta.userName ?? null,
      app: meta.app ?? null,
      connectedAt: meta.connectedAt ?? null,
    };
  }
  if (process.env.PAN115_COOKIE) {
    return { connected: true, source: "env", userName: null, app: null, connectedAt: null };
  }
  return { connected: false, source: "none", userName: null, app: null, connectedAt: null };
}

export async function completePan115QrLogin(input: {
  session: { uid: string; time: number; sign: string; qrcodeContent: string };
  app?: string;
}): Promise<{ userName: string; app: string }> {
  const { Pan115QrLoginClient, PAN115_QR_LOGIN_APPS } = await import("@media-track/workflow");
  const app = (PAN115_QR_LOGIN_APPS as readonly string[]).includes(input.app ?? "")
    ? (input.app as (typeof PAN115_QR_LOGIN_APPS)[number])
    : "alipaymini";
  const client = new Pan115QrLoginClient();
  const result = await client.exchangeCookie(input.session, app);
  const repository = getWorkflowRepository();
  await repository.setSetting(PAN115_COOKIE_KEY, result.cookie);
  await repository.setSetting(
    PAN115_META_KEY,
    JSON.stringify({
      userName: result.userName,
      app: result.app,
      connectedAt: new Date().toISOString(),
    }),
  );
  // Take effect immediately: the 115 executor is built from process.env per call.
  process.env.PAN115_COOKIE = result.cookie;
  pan115CookieHydrated = true;
  return { userName: result.userName, app: result.app };
}
