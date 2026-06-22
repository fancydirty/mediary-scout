import {
  createEpisodeStates,
  episodeNumberFromCode,
  InMemoryWorkflowRepository,
  type EpisodeState,
  type MediaTitle,
  type NotificationReportStatus,
  type TrackedSeason,
  type WorkflowRepository,
  type WorkflowRun,
} from "@media-track/workflow";

/** Demo notification timestamps are relative to now so they always fall inside
 *  the 通知 page's 7-day window (fixed past dates would be filtered out → empty). */
const recentIso = (hoursAgo: number): string => new Date(Date.now() - hoursAgo * 3_600_000).toISOString();

const DEMO_ACCOUNT = "acct_default";
const DEMO_DRIVE_115 = "cs_demo_115";
const DEMO_DRIVE_QUARK = "cs_demo_quark";

export async function createDemoWorkflowRepository(): Promise<InMemoryWorkflowRepository> {
  const repository = new InMemoryWorkflowRepository();
  await seedDemoWorkflowRepository(repository);
  return repository;
}

type Drive = "pan115" | "quark";
const driveId = (d: Drive) => (d === "pan115" ? DEMO_DRIVE_115 : DEMO_DRIVE_QUARK);
const moviesDir = (d: Drive) => (d === "pan115" ? "demo_movies_115" : "demo_movies_q");
const tvDir = (d: Drive) => (d === "pan115" ? "demo_tv_115" : "demo_tv_q");

function episodesWithObtained(season: TrackedSeason, obtainedCount: number): EpisodeState[] {
  return createEpisodeStates({
    trackedSeasonId: season.id,
    seasonNumber: season.seasonNumber,
    totalEpisodes: season.totalEpisodes,
    latestAiredEpisode: season.latestAiredEpisode,
  }).map((episode) =>
    episodeNumberFromCode(episode.episodeCode) <= obtainedCount
      ? { ...episode, obtained: true, verifiedFileIds: [`file_${episode.episodeCode}`] }
      : episode,
  );
}

function movieFixture(input: {
  tmdbId: number;
  title: string;
  year: number;
  posterPath: string;
  backdropPath: string | null;
  storageDirectoryId: string;
  obtained?: boolean;
  releaseDate?: string;
}): { title: MediaTitle; season: TrackedSeason; episodes: EpisodeState[] } {
  const obtained = input.obtained ?? true;
  const title: MediaTitle = {
    id: `tmdb_movie_${input.tmdbId}`,
    tmdbId: input.tmdbId,
    type: "movie",
    title: input.title,
    originalTitle: input.title,
    year: input.year,
    aliases: [],
    posterPath: input.posterPath,
    backdropPath: input.backdropPath,
    ...(input.releaseDate ? { releaseDate: input.releaseDate } : {}),
  };
  const season: TrackedSeason = {
    id: `tmdb_movie_${input.tmdbId}_movie`,
    mediaTitleId: title.id,
    seasonNumber: 1,
    status: obtained ? "completed" : "active",
    qualityPreference: "4K",
    storageDirectoryId: input.storageDirectoryId,
    totalEpisodes: 1,
    latestAiredEpisode: 1,
    latestAiredSource: "manual",
  };
  return { title, season, episodes: episodesWithObtained(season, obtained ? 1 : 0) };
}

function seriesFixture(input: {
  tmdbId: number;
  title: string;
  year: number;
  type: "tv" | "anime";
  posterPath: string;
  backdropPath: string | null;
  storageDirectoryId: string;
  totalEpisodes: number;
  latestAired: number;
  obtainedCount: number;
  status: "active" | "completed";
}): { title: MediaTitle; season: TrackedSeason; episodes: EpisodeState[] } {
  const title: MediaTitle = {
    id: `tmdb_tv_${input.tmdbId}`,
    tmdbId: input.tmdbId,
    type: input.type,
    title: input.title,
    originalTitle: input.title,
    year: input.year,
    aliases: [],
    posterPath: input.posterPath,
    backdropPath: input.backdropPath,
  };
  const season: TrackedSeason = {
    id: `tmdb_tv_${input.tmdbId}_s1`,
    mediaTitleId: title.id,
    seasonNumber: 1,
    status: input.status,
    qualityPreference: "4K",
    storageDirectoryId: input.storageDirectoryId,
    totalEpisodes: input.totalEpisodes,
    latestAiredEpisode: input.latestAired,
    latestAiredSource: "metadata",
  };
  return { title, season, episodes: episodesWithObtained(season, input.obtainedCount) };
}

function runFor(kind: WorkflowRun["kind"], tmdbId: number, trackedSeasonId: string): WorkflowRun {
  return {
    id: `run_demo_${tmdbId}`,
    kind,
    status: "succeeded",
    trackedSeasonId,
    startedAt: "2026-06-12T07:58:00.000Z",
    finishedAt: "2026-06-12T08:00:00.000Z",
    auditEvents: [],
  };
}

type CuratedMovie = {
  kind: "movie";
  drive: Drive;
  tmdbId: number;
  title: string;
  year: number;
  posterPath: string;
  backdropPath: string | null;
  obtained?: boolean;
  releaseDate?: string;
};
type CuratedSeries = {
  kind: "series";
  drive: Drive;
  type: "tv" | "anime";
  tmdbId: number;
  title: string;
  year: number;
  posterPath: string;
  backdropPath: string | null;
  totalEpisodes: number;
  latestAired: number;
  obtainedCount: number;
  status: "active" | "completed";
};
type Curated = CuratedMovie | CuratedSeries;

const CURATED: Curated[] = [
  // ---- 115 drive ----
  { kind: "movie", drive: "pan115", tmdbId: 37165, title: "楚门的世界", year: 1998, posterPath: "/nAnzFcqORitpwvRQPceIt4mcm8G.jpg", backdropPath: "/aCHn2TXYJfzPXQKA6r9mKPbMlUB.jpg" },
  { kind: "movie", drive: "pan115", tmdbId: 27205, title: "盗梦空间", year: 2010, posterPath: "/89W962aAnPS3N3BdKgy2BvUhnCh.jpg", backdropPath: "/8ZTVqvKDQ8emSGUEMjsS4yHAwrp.jpg" },
  { kind: "movie", drive: "pan115", tmdbId: 157336, title: "星际穿越", year: 2014, posterPath: "/c35Vwd9rmMQfaEJuUrJRF3LZWJX.jpg", backdropPath: "/2ssWTSVklAEc98frZUQhgtGHx7s.jpg" },
  { kind: "movie", drive: "pan115", tmdbId: 842675, title: "流浪地球2", year: 2023, posterPath: "/cAS2e9hUwu6Ydsx7byXj16H00Ai.jpg", backdropPath: "/94cS0mzODEoNIXFT7nhPcI8V4IJ.jpg" },
  { kind: "movie", drive: "pan115", tmdbId: 76600, title: "阿凡达：水之道", year: 2022, posterPath: "/az6FndKaR11uuxnRQucKJ2mmglg.jpg", backdropPath: "/kJsPVzdyBrYHLomuNv5SJDXUQ2f.jpg" },
  { kind: "movie", drive: "pan115", tmdbId: 1003596, title: "复仇者联盟5", year: 2026, posterPath: "/2UnOGhrwaDLyhlbYrSDDQWci4UC.jpg", backdropPath: null, obtained: false, releaseDate: "2026-12-16" },
  { kind: "series", drive: "pan115", type: "tv", tmdbId: 87108, title: "切尔诺贝利", year: 2019, posterPath: "/2kjMfJSwwQqOq4o4idiZxbNxoYz.jpg", backdropPath: "/3URK0z9PzpVNJrGE7XOuyy6KFzk.jpg", totalEpisodes: 5, latestAired: 5, obtainedCount: 5, status: "completed" },
  { kind: "series", drive: "pan115", type: "tv", tmdbId: 66732, title: "怪奇物语", year: 2016, posterPath: "/98pJM1e8S5SbPt7V5H9b1ZLrQdj.jpg", backdropPath: "/56v2KjBlU4XaOv9rVYEQypROD7P.jpg", totalEpisodes: 9, latestAired: 9, obtainedCount: 6, status: "completed" },
  { kind: "series", drive: "pan115", type: "tv", tmdbId: 204541, title: "三体", year: 2023, posterPath: "/q2sNliRi4j0ncXKUO1x0MldR20A.jpg", backdropPath: "/zxfBtHz5UmSTfIEC4O4GngyjHwa.jpg", totalEpisodes: 30, latestAired: 30, obtainedCount: 30, status: "completed" },
  { kind: "series", drive: "pan115", type: "anime", tmdbId: 1429, title: "进击的巨人", year: 2013, posterPath: "/1j3s19nko8OtGhCRwRMDGmr0m5O.jpg", backdropPath: "/rqbCbjB19amtOtFQbb3K2lgm2zv.jpg", totalEpisodes: 28, latestAired: 28, obtainedCount: 28, status: "completed" },
  { kind: "series", drive: "pan115", type: "anime", tmdbId: 120089, title: "间谍过家家", year: 2022, posterPath: "/xkEGd9GF3oty89xDiXMGJm6pGQL.jpg", backdropPath: "/lysUnU6V0VfcthDbviuVlIqgHOR.jpg", totalEpisodes: 12, latestAired: 8, obtainedCount: 8, status: "active" },
  { kind: "series", drive: "pan115", type: "anime", tmdbId: 85937, title: "鬼灭之刃", year: 2019, posterPath: "/tZ0yGfG4EIox7bYJTxAtqUhoOmR.jpg", backdropPath: "/3GQKYh6Trm8pxd2AypovoYQf4Ay.jpg", totalEpisodes: 11, latestAired: 11, obtainedCount: 7, status: "completed" },
  // ---- quark drive ----
  { kind: "movie", drive: "quark", tmdbId: 278, title: "肖申克的救赎", year: 1994, posterPath: "/Aqo8yM5S5ZEdlcyeBBxj7s0vkTf.jpg", backdropPath: "/zfbjgQE1uSd9wiPTX4VzsLi0rGG.jpg" },
  { kind: "movie", drive: "quark", tmdbId: 13, title: "阿甘正传", year: 1994, posterPath: "/pplybKImR7LKzSVzRylK6Cl4dzm.jpg", backdropPath: "/66Kn4XWhkuPkJxOJyPEx4U2CUfN.jpg" },
  { kind: "movie", drive: "quark", tmdbId: 155, title: "蝙蝠侠：黑暗骑士", year: 2008, posterPath: "/xUX0sVHmukGTYLTyqmSF5hpktOU.jpg", backdropPath: "/cfT29Im5VDvjE0RpyKOSdCKZal7.jpg" },
  { kind: "series", drive: "quark", type: "tv", tmdbId: 1396, title: "绝命毒师", year: 2008, posterPath: "/rqliuvX7NdknSHu5qaSDfESplQi.jpg", backdropPath: "/tsRy63Mu5cu8etL1X7ZLyf7UP1M.jpg", totalEpisodes: 16, latestAired: 16, obtainedCount: 16, status: "completed" },
  { kind: "series", drive: "quark", type: "tv", tmdbId: 1399, title: "权力的游戏", year: 2011, posterPath: "/6fJ7Gql9rD4C3X1uW2zinlkNwvw.jpg", backdropPath: "/2OMB0ynKlyIenMJWI2Dy9IWT4c.jpg", totalEpisodes: 6, latestAired: 6, obtainedCount: 6, status: "completed" },
  { kind: "series", drive: "quark", type: "tv", tmdbId: 100088, title: "最后生还者", year: 2023, posterPath: "/ydyTjqxZsPlcFSTBNY2INYrmEvk.jpg", backdropPath: "/acevLdSl5I2MK5RYAm7gwAndt1w.jpg", totalEpisodes: 7, latestAired: 5, obtainedCount: 5, status: "active" },
  { kind: "series", drive: "quark", type: "anime", tmdbId: 95479, title: "咒术回战", year: 2020, posterPath: "/kdE1ALF5G6DFMyDU67AyyUklEtn.jpg", backdropPath: "/qpin8cASXEVtwhzNsprHYFiOAGk.jpg", totalEpisodes: 23, latestAired: 23, obtainedCount: 23, status: "completed" },
  { kind: "series", drive: "quark", type: "anime", tmdbId: 209867, title: "葬送的芙莉莲", year: 2023, posterPath: "/1TtrtRIwXz5BB0gXEl8zgBypl9c.jpg", backdropPath: "/rBOnrVlck7BIlGeWVlzYiZeg4l2.jpg", totalEpisodes: 28, latestAired: 20, obtainedCount: 20, status: "active" },
];

// A few notifications so the 通知 page isn't empty (keyed by tmdbId). Report-bearing
// so they render as rich poster + status-pill cards (the redesign's L2 card), with
// recent timestamps + a spread of statuses (incl. the longer 4-char 暂无资源 pill).
const NOTIFS: Record<
  number,
  {
    kind: string;
    status: NotificationReportStatus;
    seasonLabel: string | null;
    lines: string[];
    newlyObtained?: string[];
    realMissing?: string[];
    fileCount?: number;
    totalBytes?: number;
    hoursAgo: number;
  }
> = {
  37165: { kind: "package_initialized", status: "acquired", seasonLabel: null, lines: [], fileCount: 1, totalBytes: 10_200_000_000, hoursAgo: 2 },
  842675: { kind: "package_initialized", status: "acquired", seasonLabel: null, lines: [], fileCount: 1, totalBytes: 38_400_000_000, hoursAgo: 6 },
  87108: { kind: "tracking_completed", status: "partial", seasonLabel: "第 1 季", lines: ["已获取 3/5 集 · 2 集缺失，等待每日巡检补齐"], realMissing: ["S01E04", "S01E05"], hoursAgo: 28 },
  120089: { kind: "no_coverage", status: "no_coverage", seasonLabel: "第 2 季", lines: ["本次巡检暂未找到合适资源，明日继续尝试"], hoursAgo: 52 },
};

export async function seedDemoWorkflowRepository(repository: WorkflowRepository): Promise<void> {
  // Two drives → the workspace switcher (≥2) + brand icons + per-drive scoping show.
  await repository.upsertConnectedStorage({
    id: DEMO_DRIVE_115,
    accountId: DEMO_ACCOUNT,
    provider: "pan115",
    providerUid: "demo115",
    label: null,
    payload: { meta: { connectedAt: "2026-06-01T00:00:00.000Z" } },
    rootCid: "demo_root_115",
    moviesCid: "demo_movies_115",
    tvCid: "demo_tv_115",
    animeCid: "demo_anime_115",
    createdAt: "2026-06-01T00:00:00.000Z",
  });
  await repository.upsertConnectedStorage({
    id: DEMO_DRIVE_QUARK,
    accountId: DEMO_ACCOUNT,
    provider: "quark",
    providerUid: "demoquark",
    label: null,
    payload: { meta: { connectedAt: "2026-06-05T00:00:00.000Z" } },
    rootCid: "demo_root_q",
    moviesCid: "demo_movies_q",
    tvCid: "demo_tv_q",
    animeCid: "demo_anime_q",
    createdAt: "2026-06-05T00:00:00.000Z",
  });

  for (const item of CURATED) {
    const fixture =
      item.kind === "movie"
        ? movieFixture({
            tmdbId: item.tmdbId,
            title: item.title,
            year: item.year,
            posterPath: item.posterPath,
            backdropPath: item.backdropPath,
            storageDirectoryId: moviesDir(item.drive),
            ...(item.obtained === undefined ? {} : { obtained: item.obtained }),
            ...(item.releaseDate ? { releaseDate: item.releaseDate } : {}),
          })
        : seriesFixture({
            tmdbId: item.tmdbId,
            title: item.title,
            year: item.year,
            type: item.type,
            posterPath: item.posterPath,
            backdropPath: item.backdropPath,
            storageDirectoryId: tvDir(item.drive),
            totalEpisodes: item.totalEpisodes,
            latestAired: item.latestAired,
            obtainedCount: item.obtainedCount,
            status: item.status,
          });
    const run = runFor(item.kind === "movie" ? "movie_init" : "type2_init", item.tmdbId, fixture.season.id);
    const notif = NOTIFS[item.tmdbId];
    await repository.saveWorkflowRunSnapshot({
      accountId: DEMO_ACCOUNT,
      connectedStorageId: driveId(item.drive),
      title: fixture.title,
      season: fixture.season,
      workflowRun: run,
      episodes: fixture.episodes,
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: notif
        ? [
            {
              id: `demo_notif_${item.tmdbId}`,
              workflowRunId: run.id,
              kind: notif.kind,
              title: `${fixture.title.title}${notif.seasonLabel ? ` ${notif.seasonLabel}` : ""}`,
              body: notif.lines[0] ?? "",
              createdAt: recentIso(notif.hoursAgo),
              report: {
                titleName: fixture.title.title,
                seasonLabel: notif.seasonLabel,
                status: notif.status,
                lines: notif.lines,
                newlyObtained: notif.newlyObtained ?? [],
                realMissing: notif.realMissing ?? [],
                posterPath: fixture.title.posterPath ?? null,
                tmdbId: item.tmdbId,
                mediaType: fixture.title.type,
                year: fixture.title.year,
                ...(notif.fileCount !== undefined ? { fileCount: notif.fileCount } : {}),
                ...(notif.totalBytes !== undefined ? { totalBytes: notif.totalBytes } : {}),
              },
            },
          ]
        : [],
    });
  }
}
