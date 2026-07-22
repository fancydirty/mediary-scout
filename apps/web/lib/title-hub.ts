import {
  createTmdbMetadataProvider,
  getTrackedSeasonStatusView,
  isMovieUnreleased,
  prepareSeriesTarget,
  queueSeriesInitialization,
  queueTrackingInitialization,
  type EpisodeStatusCell,
  type MediaTitle,
  type PreparedSeriesTarget,
} from "@media-track/workflow";
import { findDemoCandidateByTmdbId } from "./demo-candidates";
import {
  aggregateAiring,
  aggregateStateFromSeasons,
  libraryWallAiring,
  libraryWallState,
  type LibraryWallStateValue,
  type TitleAggregateState,
} from "./title-aggregate";
import { InMemoryJsonCache, PostgresMediaSearchCache, type DurableJsonCache } from "./tmdb-cache";
import {
  ensureDemoSeeded,
  getAccountScopedSettings,
  getActiveWorkspaceScope,
  getCurrentAccountId,
  getTmdbAccesses,
  getWorkflowRepository,
  movieTargetFromTmdbId,
  postgresConnectionString,
  queueCandidateTracking,
  type CandidateTrackingRequestResult,
} from "./workflow-runtime";

export interface TitleHubSeason {
  seasonNumber: number;
  totalEpisodes: number;
  latestAiredEpisode: number;
  tracked: boolean;
  /** TrackedSeason status when tracked. */
  status: "active" | "completed" | null;
  obtainedCount: number;
  missingAiredCount: number;
  trackedSeasonId: string | null;
  episodes: EpisodeStatusCell[];
}

export type { TitleAggregateState };

export interface TitleHubView {
  kind: "tv";
  tmdbId: number;
  title: string;
  originalTitle: string;
  year: number;
  overview: string;
  posterPath: string | null;
  backdropPath: string | null;
  aggregate: TitleAggregateState;
  /** Orthogonal to `aggregate`: any tracked season still airing. A partial title
   *  that is also airing shows BOTH 部分入库 and 追更中. */
  airing: boolean;
  seasons: TitleHubSeason[];
  untrackedSeasonNumbers: number[];
  /** A queued/running acquisition for this title — disables all acquire buttons. */
  acquiring: boolean;
}

/** A movie has no seasons — its detail page is a single status, not a season grid. */
export interface MovieHubView {
  kind: "movie";
  tmdbId: number;
  title: string;
  originalTitle: string;
  year: number;
  overview: string;
  posterPath: string | null;
  backdropPath: string | null;
  releaseDate: string | null;
  /** acquired=已入库, reserved=未上映已预定, acquiring=获取中, missing=已上映未获取, untracked=未追踪. */
  state: "acquired" | "reserved" | "acquiring" | "missing" | "untracked";
  acquiring: boolean;
}

export type DetailView = TitleHubView | MovieHubView;

const SERIES_TARGET_TTL_MS = 6 * 60 * 60 * 1000;
// L1: per-process in-memory cache (fast, but resets on every restart — which is
// why a cold detail-page load paid a live TMDB round-trip every dev restart).
const seriesTargetCache = new Map<number, { value: PreparedSeriesTarget; expiresAt: number }>();
// L2: durable Postgres cache, so the season list + artwork survive restarts and
// the page renders from the DB instead of re-hitting TMDB on every cold load.
let durableTargetCache: DurableJsonCache | null = null;
function getDurableTargetCache(): DurableJsonCache {
  if (durableTargetCache) {
    return durableTargetCache;
  }
  // Desktop (SQLite) build has no Postgres — calling postgresConnectionString()
  // would throw, so the durable L2 degrades to an in-memory JSON cache (a lost
  // cache on restart is fine; L1 already resets per process).
  durableTargetCache = process.env.MEDIA_TRACK_SQLITE_PATH?.trim()
    ? new InMemoryJsonCache()
    : new PostgresMediaSearchCache({ connectionString: postgresConnectionString() });
  return durableTargetCache;
}

/**
 * Season metadata + artwork for a title, independent of tracking state.
 * Live TMDB when configured (cached 6h per title), demo candidates otherwise,
 * null when the title is unknown to both.
 */
async function seriesTargetFor(tmdbId: number): Promise<PreparedSeriesTarget | null> {
  if (process.env.MEDIA_TRACK_SEARCH_PROVIDER === "tmdb") {
    const cached = seriesTargetCache.get(tmdbId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }
    const durable = getDurableTargetCache();
    const fromDb = await durable.getJson<PreparedSeriesTarget>(`series-target:${tmdbId}`);
    if (fromDb) {
      // DB hit — warm L1 and skip the TMDB round-trip (this is the cold-load fix).
      seriesTargetCache.set(tmdbId, { value: fromDb, expiresAt: Date.now() + SERIES_TARGET_TTL_MS });
      return fromDb;
    }
    try {
      const value = await prepareSeriesTarget({
        tmdbId,
        qualityPreference: process.env.MEDIA_TRACK_DEFAULT_QUALITY ?? "4K",
        metadataProvider: createTmdbMetadataProvider(await getTmdbAccesses(getAccountScopedSettings(await getCurrentAccountId()))),
      });
      seriesTargetCache.set(tmdbId, { value, expiresAt: Date.now() + SERIES_TARGET_TTL_MS });
      await durable.setJson(`series-target:${tmdbId}`, value, SERIES_TARGET_TTL_MS);
      return value;
    } catch {
      return seriesTargetCache.get(tmdbId)?.value ?? null;
    }
  }

  const candidate = findDemoCandidateByTmdbId(tmdbId);
  if (!candidate || candidate.mediaType !== "tv") {
    return null;
  }
  const title: MediaTitle = {
    id: `tmdb_tv_${candidate.tmdbId}`,
    tmdbId: candidate.tmdbId,
    type: "tv",
    title: candidate.title,
    originalTitle: candidate.originalTitle,
    year: candidate.year,
    aliases:
      candidate.originalTitle && candidate.originalTitle !== candidate.title
        ? [candidate.originalTitle]
        : [],
    posterPath: candidate.posterPath,
    backdropPath: candidate.backdropPath,
    overview: candidate.overview,
  };
  return {
    title,
    seasons: candidate.seasons.map((season) => ({
      seasonNumber: season.seasonNumber,
      totalEpisodes: season.episodeCount,
      latestAiredEpisode: season.latestAiredEpisode,
    })),
    keyword: `${candidate.title} ${process.env.MEDIA_TRACK_DEFAULT_QUALITY ?? "4K"}`.trim(),
  };
}

export async function getTitleHubView(tmdbId: number, storageId?: string): Promise<TitleHubView | null> {
  const repository = getWorkflowRepository();
  const scope = await getActiveWorkspaceScope(storageId);
  await ensureDemoSeeded(repository);
  const trackedStates = (await repository.listTrackedSeasonStates(scope)).filter(
    // tv AND anime are season-shaped detail pages; only movies are excluded.
    (state) => state.title.tmdbId === tmdbId && state.title.type !== "movie",
  );
  const target = await seriesTargetFor(tmdbId);
  if (trackedStates.length === 0 && target === null) {
    return null;
  }

  const dbTitle = trackedStates[0]?.title;
  const meta = {
    title: dbTitle?.title ?? target?.title.title ?? `TMDB ${tmdbId}`,
    originalTitle: dbTitle?.originalTitle ?? target?.title.originalTitle ?? "",
    year: dbTitle?.year ?? target?.title.year ?? 0,
    overview: dbTitle?.overview ?? target?.title.overview ?? "",
    posterPath: dbTitle?.posterPath ?? target?.title.posterPath ?? null,
    backdropPath: dbTitle?.backdropPath ?? target?.title.backdropPath ?? null,
  };

  const trackedBySeason = new Map(trackedStates.map((state) => [state.season.seasonNumber, state]));
  const seasonNumbers = [
    ...new Set([
      ...(target?.seasons.map((season) => season.seasonNumber) ?? []),
      ...trackedStates.map((state) => state.season.seasonNumber),
    ]),
  ].sort((a, b) => a - b);

  const seasons: TitleHubSeason[] = [];
  for (const seasonNumber of seasonNumbers) {
    const tracked = trackedBySeason.get(seasonNumber);
    const targetSeason = target?.seasons.find((season) => season.seasonNumber === seasonNumber);
    if (tracked) {
      const view = await getTrackedSeasonStatusView({
        repository,
        trackedSeasonId: tracked.season.id,
      });
      seasons.push({
        seasonNumber,
        totalEpisodes: tracked.season.totalEpisodes,
        latestAiredEpisode: tracked.season.latestAiredEpisode,
        tracked: true,
        status: tracked.season.status === "completed" ? "completed" : "active",
        obtainedCount: view?.obtainedCount ?? 0,
        missingAiredCount: view?.missingAiredCount ?? 0,
        trackedSeasonId: tracked.season.id,
        episodes: view?.episodes ?? [],
      });
    } else if (targetSeason) {
      seasons.push({
        seasonNumber,
        totalEpisodes: targetSeason.totalEpisodes,
        latestAiredEpisode: targetSeason.latestAiredEpisode,
        tracked: false,
        status: null,
        obtainedCount: 0,
        missingAiredCount: 0,
        trackedSeasonId: null,
        episodes: [],
      });
    }
  }

  const untrackedSeasonNumbers = seasons
    .filter((season) => !season.tracked)
    .map((season) => season.seasonNumber);
  const aggregate = aggregateStateFromSeasons(seasons);
  const airing = aggregateAiring(seasons);

  const acquiring = (await repository.listActiveWorkflowRuns(scope)).some(
    (snapshot) => snapshot.title.tmdbId === tmdbId,
  );

  return {
    kind: "tv",
    tmdbId,
    ...meta,
    aggregate,
    airing,
    seasons,
    untrackedSeasonNumbers,
    acquiring,
  };
}

/**
 * The detail entry the title page calls: a movie returns a single-status
 * MovieHubView (fixing the "没有找到这部剧" dead end for films), everything else
 * the season-shaped TitleHubView. Tracked movies resolve from the DB with no
 * TMDB round-trip; an untracked title falls through to the TV hub, then to a
 * TMDB movie lookup.
 */
export async function getDetailView(
  tmdbId: number,
  storageId?: string,
  typeHint?: "movie" | "tv" | "anime",
): Promise<DetailView | null> {
  const repository = getWorkflowRepository();
  const scope = await getActiveWorkspaceScope(storageId);
  await ensureDemoSeeded(repository);
  const now = new Date().toISOString();

  const trackedForTitle = (await repository.listTrackedSeasonStates(scope)).filter(
    (state) => state.title.tmdbId === tmdbId,
  );
  const movieState = trackedForTitle.find((state) => state.title.type === "movie");
  if (movieState) {
    const acquiring = (await repository.listActiveWorkflowRuns(scope)).some(
      (snapshot) => snapshot.title.tmdbId === tmdbId,
    );
    const obtained = movieState.episodes.some((episode) => episode.obtained);
    const reserved = isMovieUnreleased(movieState.title.releaseDate, now);
    const state = acquiring ? "acquiring" : reserved ? "reserved" : obtained ? "acquired" : "missing";
    return movieHubViewFromTitle(movieState.title, state, acquiring);
  }

  // Untracked title: TMDB's movie/tv id namespaces collide (movie 278 ≠ tv 278).
  // The detail page can't guess which; the card carries `typeHint`. When it says
  // movie, resolve the MOVIE namespace FIRST — otherwise the season-shaped hub's
  // TMDB tv lookup spuriously matches an unrelated show with the same numeric id.
  const untrackedMovie = async (): Promise<DetailView | null> => {
    const movieTarget = await movieTargetFromTmdbId(tmdbId);
    if (!movieTarget) {
      return null;
    }
    // Untracked stays untracked even if unreleased — `reserved` means tracked + waiting.
    return movieHubViewFromTitle(movieTarget.title, "untracked", false);
  };

  if (typeHint === "movie") {
    const movie = await untrackedMovie();
    if (movie) {
      return movie;
    }
  }

  // Season-shaped (tv/anime) hub — same drive scope. Covers tracked tv + TMDB tv target.
  const tv = await getTitleHubView(tmdbId, storageId);
  if (tv) {
    return tv;
  }

  // Last resort: a movie known to TMDB (e.g. no typeHint).
  return untrackedMovie();
}

function movieHubViewFromTitle(
  title: MediaTitle,
  state: MovieHubView["state"],
  acquiring: boolean,
): MovieHubView {
  return {
    kind: "movie",
    tmdbId: title.tmdbId,
    title: title.title,
    originalTitle: title.originalTitle,
    year: title.year,
    overview: title.overview ?? "",
    posterPath: title.posterPath ?? null,
    backdropPath: title.backdropPath ?? null,
    releaseDate: title.releaseDate ?? null,
    state,
    acquiring,
  };
}

export async function queueSeasonTracking(
  tmdbId: number,
  seasonNumber: number,
  storageId?: string,
): Promise<CandidateTrackingRequestResult> {
  const scope = await getActiveWorkspaceScope(storageId);
  return queueCandidateTracking(`tmdb_tv_${tmdbId}_s${seasonNumber}`, scope.connectedStorageId);
}

/**
 * "获取剩余": series initialization scoped to the seasons that have no
 * tracking state yet. Already-tracked seasons stay owned by their own
 * lifecycle (Type 3 for active ones); the reconcile step makes any
 * resource overlap harmless.
 */
export async function queueRemainingSeasons(
  tmdbId: number,
  storageId?: string,
): Promise<CandidateTrackingRequestResult> {
  const repository = getWorkflowRepository();
  const scope = await getActiveWorkspaceScope(storageId);
  await ensureDemoSeeded(repository);
  const target = await seriesTargetFor(tmdbId);
  if (!target) {
    return { status: "unsupported", message: "无法获取该剧的季信息。" };
  }
  const trackedSeasonNumbers = new Set(
    (await repository.listTrackedSeasonStates(scope))
      .filter((state) => state.title.tmdbId === tmdbId && state.title.type !== "movie")
      .map((state) => state.season.seasonNumber),
  );
  const remaining = target.seasons.filter(
    (season) => !trackedSeasonNumbers.has(season.seasonNumber),
  );
  if (remaining.length === 0) {
    return {
      status: "already_tracked",
      workflowRunId: null,
      trackedSeasonId: `tmdb_tv_${tmdbId}_s${target.seasons[0]?.seasonNumber ?? 1}`,
    };
  }
  const request = await queueSeriesInitialization({
    title: target.title,
    seasons: remaining,
    keyword: target.keyword,
    repository,
    accountId: scope.accountId,
    connectedStorageId: scope.connectedStorageId,
  });
  return {
    status: request.status === "queued" ? "queued" : request.status,
    workflowRunId: request.workflowRunId,
    trackedSeasonId: `tmdb_tv_${tmdbId}_s${remaining[0]?.seasonNumber ?? 1}`,
  };
}

export interface LibraryWallEntry {
  tmdbId: number;
  title: string;
  year: number;
  type: "movie" | "tv" | "anime";
  posterPath: string | null;
  seasonCount: number;
  obtainedEpisodes: number;
  totalAiredEpisodes: number;
  /** Full season episode count (sum across seasons) — the "9" in 已获取/已播/共 6/6/9. */
  totalEpisodes: number;
  /** Set for an unreleased (reserved) movie; drives the 预定 badge + air date. */
  releaseDate: string | null;
  state: LibraryWallStateValue;
  /** Orthogonal to `state`: still releasing. A `partial` + `airing` card shows
   *  both ⚠️有缺集 and 追更中. */
  airing: boolean;
}

export interface LibraryTypeCounts {
  movie: number;
  tv: number;
  anime: number;
}

/** Poster-wall view of every tracked title. */
export async function getLibraryWall(storageId?: string): Promise<LibraryWallEntry[]> {
  const repository = getWorkflowRepository();
  const scope = await getActiveWorkspaceScope(storageId);
  await ensureDemoSeeded(repository);
  const now = new Date().toISOString();
  const states = await repository.listTrackedSeasonStates(scope);
  const byTitle = new Map<number, typeof states>();
  for (const state of states) {
    const list = byTitle.get(state.title.tmdbId) ?? [];
    list.push(state);
    byTitle.set(state.title.tmdbId, list);
  }

  const entries: LibraryWallEntry[] = [];
  for (const [tmdbId, titleStates] of byTitle) {
    const title = titleStates[0]!.title;
    let posterPath = title.posterPath ?? null;
    if (posterPath === null) {
      // Titles tracked before artwork persistence landed: enrich lazily
      // (cached 6h); future runs persist the poster with the title itself.
      // Movies and series resolve through different TMDB endpoints — routing a
      // movie id through the series resolver 404s, leaving the card blank.
      posterPath =
        title.type === "movie"
          ? (await movieTargetFromTmdbId(tmdbId))?.title.posterPath ?? null
          : (await seriesTargetFor(tmdbId))?.title.posterPath ?? null;
    }
    let obtained = 0;
    let aired = 0;
    let total = 0;
    let anyActive = false;
    for (const state of titleStates) {
      aired += Math.min(state.season.latestAiredEpisode, state.season.totalEpisodes);
      total += state.season.totalEpisodes;
      obtained += state.episodes.filter((episode) => episode.obtained).length;
      if (state.season.status === "active") {
        anyActive = true;
      }
    }
    // An unreleased movie is 预定 (reserved), not 有缺集 — its anchor reads aired=1
    // but it simply hasn't come out yet.
    const unreleased = title.type === "movie" && isMovieUnreleased(title.releaseDate, now);
    entries.push({
      tmdbId,
      title: title.title,
      year: title.year,
      type: title.type,
      posterPath,
      seasonCount: titleStates.length,
      obtainedEpisodes: obtained,
      totalAiredEpisodes: aired,
      totalEpisodes: total,
      releaseDate: title.releaseDate ?? null,
      state: libraryWallState({ obtained, aired, anyActive, unreleased }),
      airing: libraryWallAiring({ anyActive, unreleased }),
    });
  }
  return entries.sort((a, b) => a.title.localeCompare(b.title, "zh-Hans-CN"));
}

export interface InProgressTitle {
  tmdbId: number;
  title: string;
  year: number;
  type: "movie" | "tv" | "anime";
  posterPath: string | null;
}

/**
 * Titles with an acquisition run still queued/running — they surface in the
 * library as non-clickable "获取中" poster placeholders until the run finishes
 * and the title materializes as a real card.
 */
export async function getInProgressTitles(storageId?: string): Promise<InProgressTitle[]> {
  const repository = getWorkflowRepository();
  const scope = await getActiveWorkspaceScope(storageId);
  const active = await repository.listActiveWorkflowRuns(scope);
  const byTmdb = new Map<number, InProgressTitle>();
  for (const snapshot of active) {
    const title = snapshot.title;
    if (byTmdb.has(title.tmdbId)) {
      continue;
    }
    let posterPath = title.posterPath ?? null;
    if (posterPath === null) {
      posterPath =
        title.type === "movie"
          ? (await movieTargetFromTmdbId(title.tmdbId))?.title.posterPath ?? null
          : (await seriesTargetFor(title.tmdbId))?.title.posterPath ?? null;
    }
    byTmdb.set(title.tmdbId, {
      tmdbId: title.tmdbId,
      title: title.title,
      year: title.year,
      type: title.type,
      posterPath,
    });
  }
  return [...byTmdb.values()];
}

/** Get count of each media type in the library. */
export function getLibraryTypeCounts(entries: LibraryWallEntry[]): LibraryTypeCounts {
  return {
    movie: entries.filter((entry) => entry.type === "movie").length,
    tv: entries.filter((entry) => entry.type === "tv").length,
    anime: entries.filter((entry) => entry.type === "anime").length,
  };
}
