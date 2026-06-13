import { describe, expect, it } from "vitest";
import {
  createEpisodeStates,
  getSearchPageView,
  InMemoryMediaSearchCache,
  InMemoryWorkflowRepository,
  type MediaSearchCandidate,
  type MediaSearchProvider,
  type MediaTitle,
  type TrackedSeason,
} from "../src/index.js";

describe("getSearchPageView", () => {
  it("returns an empty search state without calling the provider when query is blank", async () => {
    const provider = countingSearchProvider([]);

    const view = await getSearchPageView({
      query: "   ",
      provider,
      cache: new InMemoryMediaSearchCache(),
      repository: new InMemoryWorkflowRepository(),
    });

    expect(provider.calls).toBe(0);
    expect(view).toMatchObject({
      query: "",
      state: "empty",
      cacheStatus: "none",
      candidates: [],
    });
  });

  it("maps provider candidates into UI cards with requestable action state", async () => {
    const provider = countingSearchProvider([qiaochuCandidate()]);

    const view = await getSearchPageView({
      query: "翘楚",
      provider,
      cache: new InMemoryMediaSearchCache(),
      repository: new InMemoryWorkflowRepository(),
    });

    expect(provider.calls).toBe(1);
    expect(view.state).toBe("ready");
    expect(view.cacheStatus).toBe("miss");
    expect(view.candidates).toMatchObject([
      {
        id: "tmdb_tv_289271_s1",
        tmdbId: 289271,
        mediaType: "tv",
        title: "翘楚",
        year: 2026,
        selectedSeasonNumber: 1,
        action: {
          state: "can_request",
          label: "获取",
          disabled: false,
        },
      },
    ]);
  });

  it("marks a season as already tracked when repository has episode state", async () => {
    const repository = new InMemoryWorkflowRepository();
    const { title, season } = trackedFixture();
    await repository.saveWorkflowRunSnapshot({
      title,
      season,
      workflowRun: workflowRun(season, "succeeded"),
      episodes: createEpisodeStates({
        trackedSeasonId: season.id,
        seasonNumber: season.seasonNumber,
        totalEpisodes: season.totalEpisodes,
        latestAiredEpisode: season.latestAiredEpisode,
      }),
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });

    const view = await getSearchPageView({
      query: "翘楚",
      provider: countingSearchProvider([qiaochuCandidate()]),
      cache: new InMemoryMediaSearchCache(),
      repository,
    });

    expect(view.candidates[0]?.action).toMatchObject({
      state: "already_tracked",
      label: "已追踪",
      disabled: true,
    });
  });

  it("marks an already-acquired movie as tracked so it cannot be re-requested in search", async () => {
    const repository = new InMemoryWorkflowRepository();
    const title: MediaTitle = {
      id: "tmdb_movie_872585",
      tmdbId: 872585,
      type: "movie",
      title: "奥本海默",
      originalTitle: "Oppenheimer",
      year: 2023,
      aliases: [],
    };
    const season: TrackedSeason = {
      id: "tmdb_movie_872585_movie",
      mediaTitleId: title.id,
      seasonNumber: 1,
      status: "active",
      qualityPreference: "4K",
      storageDirectoryId: "115_dir_movie",
      totalEpisodes: 1,
      latestAiredEpisode: 1,
      latestAiredSource: "metadata",
    };
    await repository.saveWorkflowRunSnapshot({
      title,
      season,
      workflowRun: {
        id: "run_movie",
        kind: "movie_init",
        status: "succeeded",
        trackedSeasonId: season.id,
        startedAt: "2026-06-12T00:00:00.000Z",
        finishedAt: "2026-06-12T00:02:00.000Z",
        auditEvents: [],
      },
      // An acquired movie: its single anchor episode is obtained.
      episodes: createEpisodeStates({
        trackedSeasonId: season.id,
        seasonNumber: 1,
        totalEpisodes: 1,
        latestAiredEpisode: 1,
      }).map((episode) => ({ ...episode, obtained: true })),
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });

    const view = await getSearchPageView({
      query: "奥本海默",
      provider: countingSearchProvider([oppenheimerCandidate()]),
      cache: new InMemoryMediaSearchCache(),
      repository,
    });

    // A finished, fully-obtained film reads as 已获取 (not 已追踪) — and is still
    // disabled so it can't be re-requested.
    expect(view.candidates[0]).toMatchObject({
      id: "tmdb_movie_872585",
      mediaType: "movie",
      action: { state: "already_tracked", label: "已获取", disabled: true },
    });
  });

  it("returns active workflow state before allowing duplicate requests", async () => {
    const repository = new InMemoryWorkflowRepository();
    const { title, season } = trackedFixture();
    await repository.saveWorkflowRunSnapshot({
      title,
      season,
      workflowRun: workflowRun(season, "running"),
      episodes: [],
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });

    const view = await getSearchPageView({
      query: "翘楚",
      provider: countingSearchProvider([qiaochuCandidate()]),
      cache: new InMemoryMediaSearchCache(),
      repository,
    });

    expect(view.candidates[0]?.action).toMatchObject({
      state: "active_workflow",
      label: "获取中",
      disabled: true,
      workflowRunId: "run_qiaochu",
    });
  });

  it("serves repeated searches from cache instead of calling the provider again", async () => {
    const cache = new InMemoryMediaSearchCache();
    const provider = countingSearchProvider([qiaochuCandidate()]);
    const repository = new InMemoryWorkflowRepository();

    const first = await getSearchPageView({
      query: " 翘楚 ",
      provider,
      cache,
      repository,
    });
    const second = await getSearchPageView({
      query: "翘楚",
      provider,
      cache,
      repository,
    });

    expect(provider.calls).toBe(1);
    expect(first.cacheStatus).toBe("miss");
    expect(second.cacheStatus).toBe("hit");
    expect(second.candidates[0]?.title).toBe("翘楚");
  });
});

function countingSearchProvider(results: MediaSearchCandidate[]): MediaSearchProvider & { calls: number } {
  return {
    calls: 0,
    async searchMedia() {
      this.calls += 1;
      return results;
    },
  };
}

function qiaochuCandidate(): MediaSearchCandidate {
  return {
    tmdbId: 289271,
    mediaType: "tv",
    title: "翘楚",
    originalTitle: "翘楚",
    year: 2026,
    overview: "国产剧更新中。",
    posterPath: "/qiaochu.jpg",
    backdropPath: "/qiaochu-backdrop.jpg",
    seasons: [
      {
        seasonNumber: 1,
        episodeCount: 24,
        latestAiredEpisode: 14,
      },
    ],
  };
}

function oppenheimerCandidate(): MediaSearchCandidate {
  return {
    tmdbId: 872585,
    mediaType: "movie",
    title: "奥本海默",
    originalTitle: "Oppenheimer",
    year: 2023,
    overview: "原子弹之父的传记片。",
    posterPath: "/oppenheimer.jpg",
    backdropPath: "/oppenheimer-backdrop.jpg",
    seasons: [],
  };
}

function trackedFixture(): { title: MediaTitle; season: TrackedSeason } {
  const title: MediaTitle = {
    id: "tmdb_tv_289271",
    tmdbId: 289271,
    type: "tv",
    title: "翘楚",
    originalTitle: "翘楚",
    year: 2026,
    aliases: [],
  };
  return {
    title,
    season: {
      id: "tmdb_tv_289271_s1",
      mediaTitleId: title.id,
      seasonNumber: 1,
      status: "active",
      qualityPreference: "4K",
      storageDirectoryId: "115_dir_qiaochu_s1",
      totalEpisodes: 24,
      latestAiredEpisode: 14,
      latestAiredSource: "metadata",
    },
  };
}

function workflowRun(season: TrackedSeason, status: "running" | "succeeded") {
  return {
    id: "run_qiaochu",
    kind: "type2_init" as const,
    status,
    trackedSeasonId: season.id,
    startedAt: "2026-06-12T00:00:00.000Z",
    finishedAt: status === "succeeded" ? "2026-06-12T00:02:00.000Z" : null,
    auditEvents: [],
  };
}
