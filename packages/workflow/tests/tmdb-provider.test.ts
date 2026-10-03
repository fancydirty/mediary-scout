import { describe, expect, it, vi } from "vitest";
import {
  createTmdbMetadataProvider,
  createTmdbSearchProvider,
  prepareMovieTarget,
  prepareTrackingTarget,
  TmdbMetadataProvider,
  TmdbHttpError,
  TmdbNotFoundError,
  TmdbSearchProvider,
} from "../src/index.js";

describe("TmdbMetadataProvider", () => {
  it("prepares a TV tracking target from TMDB details and season metadata", async () => {
    const requests: string[] = [];
    const provider = new TmdbMetadataProvider({
      readToken: "token",
      fetchJson: async (url, init) => {
        requests.push(url);
        expect(init.headers.Authorization).toBe("Bearer token");
        if (url.includes("/tv/289271?")) {
          return {
            id: 289271,
            name: "翘楚",
            original_name: "翘楚",
            first_air_date: "2026-06-01",
            number_of_episodes: 24,
            overview: "一部很好看的剧。",
            poster_path: "/qiaochu-poster.jpg",
            backdrop_path: "/qiaochu-backdrop.jpg",
            last_episode_to_air: {
              season_number: 1,
              episode_number: 14,
            },
            seasons: [
              {
                season_number: 1,
                episode_count: 24,
              },
            ],
          };
        }
        if (url.includes("/tv/289271/season/1?")) {
          return {
            id: 987,
            season_number: 1,
            episodes: Array.from({ length: 24 }, (_, index) => ({
              episode_number: index + 1,
              name: `Episode ${index + 1}`,
              air_date: index < 14 ? `2026-06-${String(index + 1).padStart(2, "0")}` : null,
            })),
          };
        }
        throw new Error(`Unexpected URL ${url}`);
      },
    });

    const target = await prepareTrackingTarget({
      tmdbId: 289271,
      mediaType: "tv",
      seasonNumber: 1,
      qualityPreference: "4K",
      storageDirectoryId: "dir_qiaochu_s1",
      metadataProvider: provider,
      now: new Date("2026-10-02T00:00:00Z"),
    });

    expect(requests).toEqual([
      "https://api.themoviedb.org/3/tv/289271?language=zh-CN",
      "https://api.themoviedb.org/3/tv/289271/season/1?language=zh-CN",
    ]);
    expect(target).toEqual({
      title: {
        id: "tmdb_tv_289271",
        tmdbId: 289271,
        type: "tv",
        title: "翘楚",
        originalTitle: "翘楚",
        year: 2026,
        aliases: [],
        originCountries: [],
        posterPath: "/qiaochu-poster.jpg",
        backdropPath: "/qiaochu-backdrop.jpg",
        overview: "一部很好看的剧。",
      },
      season: {
        id: "tmdb_tv_289271_s1",
        mediaTitleId: "tmdb_tv_289271",
        seasonNumber: 1,
        status: "active",
        qualityPreference: "4K",
        storageDirectoryId: "dir_qiaochu_s1",
        totalEpisodes: 24,
        latestAiredEpisode: 14,
        latestAiredSource: "metadata",
      },
      keyword: "翘楚",
    });
  });

  // 完结剧缺集 bug (2026-09-04): a freshly-tracked season has obtained NOTHING, so
  // it must start "active" — even for a fully-aired (完结) show. Marking it
  // "completed" at track time (aired >= total) makes the patrol skip it forever
  // when the initial acquisition leaves gaps.
  it("prepares a fully-aired (完结) TV target as active — nothing obtained yet", async () => {
    const provider = new TmdbMetadataProvider({
      readToken: "token",
      fetchJson: async (url) => {
        if (url.includes("/tv/240001?")) {
          return {
            id: 240001,
            name: "醒来",
            original_name: "醒来",
            first_air_date: "2026-08-01",
            number_of_episodes: 22,
            overview: "",
            poster_path: null,
            backdrop_path: null,
            last_episode_to_air: { season_number: 1, episode_number: 22 },
            seasons: [{ season_number: 1, episode_count: 22 }],
          };
        }
        if (url.includes("/tv/240001/season/1?")) {
          return {
            id: 1,
            season_number: 1,
            episodes: Array.from({ length: 22 }, (_, index) => ({
              episode_number: index + 1,
              name: `Episode ${index + 1}`,
              air_date: `2026-08-${String(index + 1).padStart(2, "0")}`,
            })),
          };
        }
        throw new Error(`Unexpected URL ${url}`);
      },
    });

    const target = await prepareTrackingTarget({
      tmdbId: 240001,
      mediaType: "tv",
      seasonNumber: 1,
      qualityPreference: "4K",
      metadataProvider: provider,
      now: new Date("2026-10-02T00:00:00Z"),
    });

    expect(target.season.latestAiredEpisode).toBe(22);
    expect(target.season.totalEpisodes).toBe(22);
    expect(target.season.status).toBe("active");
  });

  it("uses aired season episodes when last_episode_to_air is absent or from another season", async () => {
    const provider = new TmdbMetadataProvider({
      readToken: "token",
      fetchJson: async (url) => {
        if (url.includes("/tv/1?")) {
          return {
            id: 1,
            name: "Show",
            original_name: "Original Show",
            first_air_date: "",
            number_of_episodes: 10,
            last_episode_to_air: {
              season_number: 2,
              episode_number: 3,
            },
            seasons: [
              {
                season_number: 1,
                episode_count: 8,
              },
            ],
          };
        }
        if (url.includes("/tv/1/season/1?")) {
          return {
            season_number: 1,
            episodes: [
              { episode_number: 1, air_date: "2026-01-01" },
              { episode_number: 2, air_date: "2026-01-08" },
              { episode_number: 3, air_date: "" },
              { episode_number: 4, air_date: null },
            ],
          };
        }
        throw new Error(`Unexpected URL ${url}`);
      },
    });

    const target = await prepareTrackingTarget({
      tmdbId: 1,
      mediaType: "tv",
      seasonNumber: 1,
      qualityPreference: "1080p",
      storageDirectoryId: "dir_show_s1",
      metadataProvider: provider,
      now: new Date("2026-01-10T00:00:00Z"),
    });

    expect(target.title).toMatchObject({
      id: "tmdb_tv_1",
      title: "Show",
      originalTitle: "Original Show",
      year: 0,
    });
    expect(target.season).toMatchObject({
      id: "tmdb_tv_1_s1",
      totalEpisodes: 8,
      latestAiredEpisode: 2,
      latestAiredSource: "metadata",
    });
    expect(target.keyword).toBe("Show"); // quality preference must NOT pollute the keyword
  });

  it("counts only aired dates when a season-premiere summary still points at the prior season", async () => {
    const episodes = Array.from({ length: 14 }, (_, index) => {
      const date = new Date(Date.UTC(2026, 9, 1 + index * 7));
      return { episode_number: index + 1, air_date: date.toISOString().slice(0, 10) };
    });
    const provider = new TmdbMetadataProvider({
      readToken: "token",
      fetchJson: async (url) => {
        if (url.includes("/tv/283428?")) {
          return {
            id: 283428,
            name: "冰之城墙",
            original_name: "冰之城墙",
            first_air_date: "2026-01-01",
            number_of_episodes: 28,
            overview: "",
            poster_path: null,
            backdrop_path: null,
            last_episode_to_air: { season_number: 1, episode_number: 14 },
            seasons: [
              { season_number: 1, episode_count: 14 },
              { season_number: 2, episode_count: 14 },
            ],
          };
        }
        if (url.includes("/tv/283428/season/2?")) {
          return { season_number: 2, episodes };
        }
        throw new Error(`Unexpected URL ${url}`);
      },
    });

    for (const [now, latestAiredEpisode] of [
      ["2026-09-30T22:00:00Z", 0],
      ["2026-10-01T22:00:00Z", 1],
      ["2026-10-08T22:00:00Z", 2],
      ["2027-01-01T00:00:00Z", 14],
    ] as const) {
      const target = await prepareTrackingTarget({
        tmdbId: 283428,
        mediaType: "tv",
        seasonNumber: 2,
        qualityPreference: "4K",
        metadataProvider: provider,
        now: new Date(now),
      });
      expect(target.season.latestAiredEpisode).toBe(latestAiredEpisode);
      expect(target.season.totalEpisodes).toBe(14);
    }
  });

  it("falls back to a uniquely matching episode-group season when TMDB deleted the season", async () => {
    const requests: string[] = [];
    const groupEpisodes = Array.from({ length: 14 }, (_, index) => ({
      episode_number: index + 15,
      order: index,
      air_date: new Date(Date.UTC(2026, 9, 1 + index * 7)).toISOString().slice(0, 10),
    }));
    const provider = new TmdbMetadataProvider({
      readToken: "token",
      fetchJson: async (url) => {
        requests.push(url);
        if (url.includes("/tv/283428?")) {
          return {
            id: 283428,
            name: "冰之城墙",
            original_name: "冰之城墙",
            first_air_date: "2026-04-02",
            number_of_episodes: 28,
            overview: "",
            poster_path: null,
            backdrop_path: null,
            last_episode_to_air: { season_number: 1, episode_number: 15 },
            seasons: [{ season_number: 1, episode_count: 28 }],
          };
        }
        if (url.includes("/tv/283428/season/2?")) {
          throw new TmdbHttpError("TMDB request failed with HTTP 404", 404);
        }
        if (url.includes("/tv/283428/episode_groups?")) {
          return {
            id: 283428,
            results: [{ id: "group-seasons", name: "Seasons", type: 1, episode_count: 28, group_count: 2 }],
          };
        }
        if (url.includes("/tv/episode_group/group-seasons?")) {
          return {
            id: "group-seasons",
            name: "Seasons",
            type: 1,
            groups: [
              { id: "group-s1", name: "Season 1", order: 1, episodes: [] },
              { id: "group-s2", name: "Season 2", order: 2, episodes: groupEpisodes },
            ],
          };
        }
        throw new Error(`Unexpected URL ${url}`);
      },
    });

    const beforeSecondEpisode = await prepareTrackingTarget({
      tmdbId: 283428,
      mediaType: "tv",
      seasonNumber: 2,
      qualityPreference: "4K",
      metadataProvider: provider,
      now: new Date("2026-10-02T22:00:04Z"),
    });
    const afterSecondEpisode = await prepareTrackingTarget({
      tmdbId: 283428,
      mediaType: "tv",
      seasonNumber: 2,
      qualityPreference: "4K",
      metadataProvider: provider,
      now: new Date("2026-10-08T23:00:00Z"),
    });

    expect(beforeSecondEpisode.season).toMatchObject({ totalEpisodes: 14, latestAiredEpisode: 1 });
    expect(afterSecondEpisode.season).toMatchObject({ totalEpisodes: 14, latestAiredEpisode: 2 });
    expect(requests.some((url) => url.includes("/tv/283428/episode_groups?"))).toBe(true);
    expect(requests.some((url) => url.includes("/tv/episode_group/group-seasons?"))).toBe(true);
  });

  it.each([
    ["has no episode groups", { results: [] }],
    ["has no matching subgroup", { results: [{ id: "group", type: 1, groups: [{ name: "Bonus", order: 9, episodes: [] }] }] }],
    ["has two matching subgroups", { results: [{ id: "group", type: 1, groups: [{ name: "Season 2", order: 2, episodes: [] }, { name: "第 2 季", order: 2, episodes: [] }] }] }],
    // A subgroup's order is its position in the group, not a season number (a Specials subgroup shifts it).
    ["only has an order that equals the season", { results: [{ id: "group", type: 1, groups: [{ name: "Part 1", order: 1, episodes: [] }, { name: "Part 2", order: 2, episodes: [] }] }] }],
  ])("rethrows the original not-found error when the episode-group fallback %s", async (_label, groups) => {
    const provider = new TmdbMetadataProvider({
      readToken: "token",
      fetchJson: async (url) => {
        if (url.includes("/tv/283428?")) {
          return {
            id: 283428,
            name: "冰之城墙",
            original_name: "冰之城墙",
            first_air_date: "2026-04-02",
            number_of_episodes: 28,
            overview: "",
            poster_path: null,
            backdrop_path: null,
            last_episode_to_air: null,
            seasons: [{ season_number: 1, episode_count: 28 }],
          };
        }
        if (url.includes("/tv/283428/season/2?")) {
          throw new TmdbHttpError("TMDB request failed with HTTP 404", 404);
        }
        if (url.includes("/tv/283428/episode_groups?")) return { id: 283428, results: groups.results.map(({ groups: _groups, ...summary }) => summary) };
        if (url.includes("/tv/episode_group/group?")) return groups.results[0];
        throw new Error(`Unexpected URL ${url}`);
      },
    });

    await expect(
      prepareTrackingTarget({
        tmdbId: 283428,
        mediaType: "tv",
        seasonNumber: 2,
        qualityPreference: "4K",
        metadataProvider: provider,
      }),
    ).rejects.toBeInstanceOf(TmdbNotFoundError);
  });

  it("surfaces an episode-group fetch failure instead of disguising it as a deleted season", async () => {
    const provider = new TmdbMetadataProvider({
      readToken: "token",
      fetchJson: async (url) => {
        if (url.includes("/tv/283428?")) {
          return {
            id: 283428, name: "冰之城墙", original_name: "冰之城墙", first_air_date: "2026-04-02", number_of_episodes: 28,
            overview: "", poster_path: null, backdrop_path: null, last_episode_to_air: null,
            seasons: [{ season_number: 1, episode_count: 28 }],
          };
        }
        if (url.includes("/tv/283428/season/2?")) throw new TmdbHttpError("TMDB request failed with HTTP 404", 404);
        if (url.includes("/tv/283428/episode_groups?")) throw new TmdbHttpError("TMDB request failed with HTTP 503", 503);
        throw new Error(`Unexpected URL ${url}`);
      },
    });
    const attempt = prepareTrackingTarget({ tmdbId: 283428, mediaType: "tv", seasonNumber: 2, qualityPreference: "4K", metadataProvider: provider });
    await expect(attempt).rejects.toThrow(/failed/i);
    await expect(
      prepareTrackingTarget({ tmdbId: 283428, mediaType: "tv", seasonNumber: 2, qualityPreference: "4K", metadataProvider: provider }),
    ).rejects.not.toBeInstanceOf(TmdbNotFoundError);
  });

  it("does not try episode groups when the requested season still exists", async () => {
    const requests: string[] = [];
    const provider = new TmdbMetadataProvider({
      readToken: "token",
      fetchJson: async (url) => {
        requests.push(url);
        if (url.includes("/tv/100?")) {
          return {
            id: 100,
            name: "Existing season",
            original_name: "Existing season",
            first_air_date: "2026-01-01",
            number_of_episodes: 2,
            overview: "",
            poster_path: null,
            backdrop_path: null,
            last_episode_to_air: { season_number: 1, episode_number: 1 },
            seasons: [{ season_number: 1, episode_count: 2 }],
          };
        }
        if (url.includes("/tv/100/season/1?")) return { season_number: 1, episodes: [{ episode_number: 1, air_date: "2026-01-01" }, { episode_number: 2, air_date: "2026-01-08" }] };
        throw new Error(`Unexpected URL ${url}`);
      },
    });

    await prepareTrackingTarget({ tmdbId: 100, mediaType: "tv", seasonNumber: 1, qualityPreference: "4K", metadataProvider: provider });
    expect(requests.some((url) => url.includes("episode_groups"))).toBe(false);
    expect(requests.some((url) => url.includes("episode_group/"))).toBe(false);
  });

  it("does not treat a season timeout as a deleted season", async () => {
    const requests: string[] = [];
    const provider = new TmdbMetadataProvider({
      readToken: "token",
      fetchJson: async (url) => {
        requests.push(url);
        if (url.includes("/tv/100?")) {
          return {
            id: 100,
            name: "Timeout season",
            original_name: "Timeout season",
            first_air_date: "2026-01-01",
            number_of_episodes: 2,
            overview: "",
            poster_path: null,
            backdrop_path: null,
            last_episode_to_air: null,
            seasons: [{ season_number: 1, episode_count: 2 }],
          };
        }
        if (url.includes("/tv/100/season/2?")) {
          const error = new Error("TMDB timeout");
          error.name = "TimeoutError";
          throw error;
        }
        throw new Error(`Unexpected URL ${url}`);
      },
    });

    await expect(
      prepareTrackingTarget({ tmdbId: 100, mediaType: "tv", seasonNumber: 2, qualityPreference: "4K", metadataProvider: provider }),
    ).rejects.toThrow(/failed/i);
    await expect(
      prepareTrackingTarget({ tmdbId: 100, mediaType: "tv", seasonNumber: 2, qualityPreference: "4K", metadataProvider: provider }),
    ).rejects.not.toBeInstanceOf(TmdbNotFoundError);
    expect(requests.some((url) => url.includes("episode_groups"))).toBe(false);
  });

  it("exposes the HTTP status on a default-fetch not-found error", async () => {
    const fetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status_code: 34 }), { status: 404 })));
    try {
      const provider = new TmdbMetadataProvider({ readToken: "token" });
      await expect(provider.getTvSeason(283428, 2)).rejects.toMatchObject({ status: 404 });
      await expect(provider.getTvSeason(283428, 2)).rejects.toBeInstanceOf(TmdbNotFoundError);
    } finally {
      vi.stubGlobal("fetch", fetch);
    }
  });

  it("counts a brand-new show's first episode after its UTC air date", async () => {
    const provider = new TmdbMetadataProvider({
      readToken: "token",
      fetchJson: async (url) => {
        if (url.includes("/tv/311842?")) {
          return {
            id: 311842,
            name: "FX战士久留美",
            original_name: "FX战士久留美",
            first_air_date: "2026-10-01",
            number_of_episodes: 12,
            overview: "",
            poster_path: null,
            backdrop_path: null,
            last_episode_to_air: null,
            seasons: [{ season_number: 1, episode_count: 12 }],
          };
        }
        if (url.includes("/tv/311842/season/1?")) {
          return {
            season_number: 1,
            episodes: Array.from({ length: 12 }, (_, index) => ({
              episode_number: index + 1,
              air_date: new Date(Date.UTC(2026, 9, 1 + index * 7)).toISOString().slice(0, 10),
            })),
          };
        }
        throw new Error(`Unexpected URL ${url}`);
      },
    });

    const target = await prepareTrackingTarget({
      tmdbId: 311842,
      mediaType: "tv",
      seasonNumber: 1,
      qualityPreference: "4K",
      metadataProvider: provider,
      now: new Date("2026-10-01T22:00:00Z"),
    });

    expect(target.season.latestAiredEpisode).toBe(1);
    expect(target.season.totalEpisodes).toBe(12);
  });

  it("uses the UTC calendar date at the day boundary", async () => {
    const provider = new TmdbMetadataProvider({
      readToken: "token",
      fetchJson: async (url) => {
        if (url.includes("/tv/99?")) {
          return {
            id: 99,
            name: "Boundary",
            original_name: "Boundary",
            first_air_date: "2026-10-01",
            number_of_episodes: 1,
            overview: "",
            poster_path: null,
            backdrop_path: null,
            last_episode_to_air: null,
            seasons: [{ season_number: 1, episode_count: 1 }],
          };
        }
        if (url.includes("/tv/99/season/1?")) {
          return { season_number: 1, episodes: [{ episode_number: 1, air_date: "2026-10-02" }] };
        }
        throw new Error(`Unexpected URL ${url}`);
      },
    });

    const beforeMidnight = await prepareTrackingTarget({
      tmdbId: 99,
      mediaType: "tv",
      seasonNumber: 1,
      qualityPreference: "4K",
      metadataProvider: provider,
      now: new Date("2026-10-01T23:59:59Z"),
    });
    const atMidnight = await prepareTrackingTarget({
      tmdbId: 99,
      mediaType: "tv",
      seasonNumber: 1,
      qualityPreference: "4K",
      metadataProvider: provider,
      now: new Date("2026-10-02T00:00:00Z"),
    });

    expect(beforeMidnight.season.latestAiredEpisode).toBe(0);
    expect(atMidnight.season.latestAiredEpisode).toBe(1);
  });

  it("keeps TMDB's season-local last_episode_to_air as the main path", async () => {
    const provider = new TmdbMetadataProvider({
      readToken: "token",
      fetchJson: async (url) => {
        if (url.includes("/tv/100?")) {
          return {
            id: 100,
            name: "Main path",
            original_name: "Main path",
            first_air_date: "2026-01-01",
            number_of_episodes: 5,
            overview: "",
            poster_path: null,
            backdrop_path: null,
            last_episode_to_air: { season_number: 1, episode_number: 3 },
            seasons: [{ season_number: 1, episode_count: 5 }],
          };
        }
        if (url.includes("/tv/100/season/1?")) {
          return {
            season_number: 1,
            episodes: [
              { episode_number: 1, air_date: "2026-01-01" },
              { episode_number: 2, air_date: "2026-01-08" },
              { episode_number: 3, air_date: "2026-01-15" },
              { episode_number: 4, air_date: "2026-01-22" },
              { episode_number: 5, air_date: "2026-01-29" },
            ],
          };
        }
        throw new Error(`Unexpected URL ${url}`);
      },
    });

    const target = await prepareTrackingTarget({
      tmdbId: 100,
      mediaType: "tv",
      seasonNumber: 1,
      qualityPreference: "4K",
      metadataProvider: provider,
      now: new Date("2026-02-01T00:00:00Z"),
    });

    expect(target.season.latestAiredEpisode).toBe(3);
    expect(target.season.totalEpisodes).toBe(5);
  });
});

describe("TmdbSearchProvider", () => {
  it("maps TMDB multi-search results into media search candidates and enriches TV seasons", async () => {
    const requests: string[] = [];
    const provider = new TmdbSearchProvider({
      readToken: "token",
      baseURL: "https://tmdb.test/3",
      fetchJson: async (url, init) => {
        requests.push(url);
        expect(init.headers.Authorization).toBe("Bearer token");
        if (url.includes("/search/multi?")) {
          return {
            results: [
              {
                id: 289271,
                media_type: "tv",
                name: "翘楚",
                original_name: "翘楚",
                first_air_date: "2026-06-01",
                overview: "国产剧",
                poster_path: "/qiaochu.jpg",
                backdrop_path: "/qiaochu-bg.jpg",
              },
              {
                id: 1311031,
                media_type: "movie",
                title: "我的僵尸女儿",
                original_title: "My Zombie Daughter",
                release_date: "2025-10-31",
                overview: "电影",
                poster_path: null,
                backdrop_path: "/zombie-bg.jpg",
              },
              {
                id: 42,
                media_type: "person",
                name: "not a media candidate",
              },
            ],
          };
        }
        if (url.includes("/tv/289271?")) {
          return {
            id: 289271,
            name: "翘楚",
            original_name: "翘楚",
            first_air_date: "2026-06-01",
            number_of_episodes: 24,
            last_episode_to_air: {
              season_number: 1,
              episode_number: 14,
            },
            seasons: [
              {
                season_number: 0,
                episode_count: 1,
              },
              {
                season_number: 1,
                episode_count: 24,
              },
            ],
          };
        }
        throw new Error(`Unexpected URL ${url}`);
      },
    });

    const candidates = await provider.searchMedia({ query: "翘楚" });

    expect(requests).toEqual([
      "https://tmdb.test/3/search/multi?query=%E7%BF%98%E6%A5%9A&include_adult=false&language=zh-CN&page=1",
      "https://tmdb.test/3/tv/289271?language=zh-CN",
    ]);
    expect(candidates).toEqual([
      {
        tmdbId: 289271,
        mediaType: "tv",
        title: "翘楚",
        originalTitle: "翘楚",
        year: 2026,
        overview: "国产剧",
        posterPath: "/qiaochu.jpg",
        backdropPath: "/qiaochu-bg.jpg",
        seasons: [
          {
            seasonNumber: 1,
            episodeCount: 24,
            latestAiredEpisode: 14,
          },
        ],
      },
      {
        tmdbId: 1311031,
        mediaType: "movie",
        title: "我的僵尸女儿",
        originalTitle: "My Zombie Daughter",
        year: 2025,
        releaseDate: "2025-10-31",
        overview: "电影",
        posterPath: null,
        backdropPath: "/zombie-bg.jpg",
        seasons: [],
      },
    ]);
  });

  it("excludes announced-but-empty seasons (episode_count 0) from a search candidate", async () => {
    // Bug: the card showed 孤独摇滚 as 共 2 季 (offering an announced Season 2 with
    // no episodes), while the detail page showed 1. A season with no episodes is
    // only ever no_coverage — it must not be offered until it actually has them.
    const provider = new TmdbSearchProvider({
      readToken: "token",
      baseURL: "https://tmdb.test/3",
      fetchJson: async (url) => {
        if (url.includes("/search/multi?")) {
          return {
            results: [
              { id: 119100, media_type: "tv", name: "孤独摇滚", original_name: "ぼっち・ざ・ろっく！", first_air_date: "2022-10-08", overview: "" },
            ],
          };
        }
        if (url.includes("/tv/119100?")) {
          return {
            id: 119100,
            name: "孤独摇滚",
            original_name: "ぼっち・ざ・ろっく！",
            first_air_date: "2022-10-08",
            last_episode_to_air: { season_number: 1, episode_number: 12 },
            seasons: [
              { season_number: 0, episode_count: 5 },
              { season_number: 1, episode_count: 12 },
              { season_number: 2, episode_count: 0 },
            ],
          };
        }
        throw new Error(`Unexpected URL ${url}`);
      },
    });

    const [candidate] = await provider.searchMedia({ query: "孤独摇滚" });

    // Only the real, non-empty season 1 survives — not specials (0) nor the
    // empty season 2.
    expect(candidate?.seasons.map((season) => season.seasonNumber)).toEqual([1]);
  });

  it("classifies a Japanese animation as anime while keeping the tmdb_tv id for routing", async () => {
    const provider = new TmdbMetadataProvider({
      readToken: "token",
      fetchJson: async (url) => {
        if (url.includes("/tv/240411?")) {
          return {
            id: 240411,
            name: "葬送的芙莉莲",
            original_name: "葬送のフリーレン",
            first_air_date: "2023-09-29",
            number_of_episodes: 28,
            overview: "",
            poster_path: null,
            backdrop_path: null,
            last_episode_to_air: { season_number: 1, episode_number: 28 },
            seasons: [{ season_number: 1, episode_count: 28 }],
            genres: [{ id: 16, name: "动画" }, { id: 10765, name: "Sci-Fi & Fantasy" }],
            origin_country: ["JP"],
          };
        }
        if (url.includes("/tv/240411/season/1?")) {
          return {
            id: 1,
            season_number: 1,
            episodes: Array.from({ length: 28 }, (_, index) => ({
              episode_number: index + 1,
              air_date: "2023-09-29",
            })),
          };
        }
        throw new Error(`Unexpected URL ${url}`);
      },
    });

    const target = await prepareTrackingTarget({
      tmdbId: 240411,
      mediaType: "tv",
      seasonNumber: 1,
      qualityPreference: "4K",
      metadataProvider: provider,
      now: new Date("2026-10-02T00:00:00Z"),
    });

    expect(target.title.type).toBe("anime");
    expect(target.title.id).toBe("tmdb_tv_240411");
  });

  it("prepares a movie target and keeps a Japanese animated film as a movie (a film is a film)", async () => {
    const provider = new TmdbMetadataProvider({
      readToken: "token",
      fetchJson: async (url) => {
        if (url.includes("/movie/129?")) {
          return {
            id: 129,
            title: "千与千寻",
            original_title: "千と千尋の神隠し",
            release_date: "2001-07-20",
            overview: "",
            poster_path: "/p.jpg",
            backdrop_path: null,
            genres: [{ id: 16, name: "动画" }],
            production_countries: [{ iso_3166_1: "JP", name: "Japan" }],
          };
        }
        throw new Error(`Unexpected URL ${url}`);
      },
    });

    const target = await prepareMovieTarget({ tmdbId: 129, qualityPreference: "4K", metadataProvider: provider });
    expect(target.title.id).toBe("tmdb_movie_129");
    expect(target.title.type).toBe("movie"); // an animated film stays a movie — 电影 shelf + movie agent

    expect(target.title.year).toBe(2001);
    expect(target.title.releaseDate).toBe("2001-07-20"); // full date kept for the reserve air-time gate
    // origin_country (mapped from production_countries) is carried so the movie agent
    // can skip the 中文 subtitle floor for 国产片 (a CN movie would carry ["CN"]).
    expect(target.title.originCountries).toEqual(["JP"]);
    expect(target.keyword).toBe("千与千寻"); // bare title — no quality token in the keyword
  });
});

const movieJson = (id: number) => ({
  id,
  title: "x",
  original_title: "x",
  release_date: "1994-01-01",
  overview: "",
  poster_path: null,
  backdrop_path: null,
  genres: [],
  origin_country: [],
});

describe("TmdbMetadataProvider multi-access fallback", () => {
  it("uses the first access and skips the rest on success", async () => {
    const calls: string[] = [];
    const provider = new TmdbMetadataProvider({
      accesses: [
        { baseURL: "https://primary.example/3", readToken: "userkey" },
        { baseURL: "https://proxy.example", readToken: "proxykey" },
      ],
      fetchJson: async (url) => {
        calls.push(url);
        return movieJson(278);
      },
    });
    await provider.getMovieDetails(278);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("https://primary.example/3/movie/278");
  });

  it("falls back to the next access when the first throws", async () => {
    const calls: string[] = [];
    const provider = new TmdbMetadataProvider({
      accesses: [
        { baseURL: "https://primary.example/3", readToken: "badkey" },
        { baseURL: "https://proxy.example" },
      ],
      fetchJson: async (url) => {
        calls.push(url);
        if (url.startsWith("https://primary.example")) throw new Error("HTTP 401");
        return movieJson(278);
      },
    });
    const details = await provider.getMovieDetails(278);
    expect(details.id).toBe(278);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("https://proxy.example/movie/278");
  });

  it("throws when every access fails", async () => {
    const provider = new TmdbMetadataProvider({
      accesses: [
        { baseURL: "https://a.example/3", readToken: "k" },
        { baseURL: "https://b.example" },
      ],
      fetchJson: async () => {
        throw new Error("boom");
      },
    });
    await expect(provider.getMovieDetails(278)).rejects.toThrow(/access/i);
  });

  it("remembers a dead access and skips it on later calls within the same provider (issue #68)", async () => {
    // The #68 repro: a user TMDB token makes api.themoviedb.org the first access.
    // When that endpoint is unreachable (blocked network) it fails per call. A
    // search fires ~11 TMDB calls; without memo, EVERY call re-pays the dead
    // direct hop → cumulative timeout → "A server error occurred". The provider
    // must probe the dead access once, then go straight to the working proxy.
    const calls: string[] = [];
    const provider = new TmdbMetadataProvider({
      accesses: [
        { baseURL: "https://primary.example/3", readToken: "userkey" },
        { baseURL: "https://proxy.example" },
      ],
      fetchJson: async (url) => {
        calls.push(url);
        if (url.startsWith("https://primary.example")) throw new Error("ETIMEDOUT");
        return movieJson(278);
      },
    });
    await provider.getMovieDetails(278);
    await provider.getMovieDetails(550);
    await provider.getMovieDetails(155);
    const primaryCalls = calls.filter((u) => u.startsWith("https://primary.example"));
    const proxyCalls = calls.filter((u) => u.startsWith("https://proxy.example"));
    expect(primaryCalls).toHaveLength(1); // probed once, then remembered as dead
    expect(proxyCalls).toHaveLength(3); // every call still resolves via the proxy
  });

  it("keys the dead set by baseURL + token, so a failing user key does not poison a working env key on the same host (Copilot #69)", async () => {
    // getTmdbAccesses produces two accesses with the SAME baseURL (TMDB direct)
    // but different tokens: the user key, then the env token. A bad user key must
    // not make later calls skip the env-token access (same host) — only the exact
    // failing access should be remembered as dead.
    const tokensTried: string[] = [];
    const provider = new TmdbMetadataProvider({
      accesses: [
        { baseURL: "https://api.themoviedb.org/3", readToken: "bad-user-key" },
        { baseURL: "https://api.themoviedb.org/3", readToken: "good-env-key" },
        { baseURL: "https://proxy.example" },
      ],
      fetchJson: async (_url, init) => {
        const auth = init.headers.Authorization ?? "(none)";
        tokensTried.push(auth);
        if (auth === "Bearer bad-user-key") throw new Error("HTTP 401");
        return movieJson(278);
      },
    });
    await provider.getMovieDetails(278);
    await provider.getMovieDetails(550);
    await provider.getMovieDetails(155);
    // The good env key is used on every call; the proxy is never needed.
    expect(tokensTried.filter((a) => a === "Bearer good-env-key")).toHaveLength(3);
    expect(tokensTried.filter((a) => a === "(none)")).toHaveLength(0); // proxy never hit
    // The bad user key is probed once, then remembered as dead (not retried).
    expect(tokensTried.filter((a) => a === "Bearer bad-user-key")).toHaveLength(1);
  });

  it("the dead key keeps readToken undefined distinct from an empty-string token (Copilot #70)", async () => {
    // `readToken: ""` (Authorization "Bearer ") and `readToken: undefined` (no
    // Authorization) are different accesses; the dead-access key must not conflate
    // them via `?? ""`, else a failing "" access on a host would also disable the
    // undefined-token access there. (Defensive: getTmdbAccesses never emits "".)
    let proxyHits = 0;
    const provider = new TmdbMetadataProvider({
      accesses: [
        { baseURL: "https://same.example/3", readToken: "" }, // Authorization "Bearer " → fails
        { baseURL: "https://same.example/3" }, // undefined token, same host → must stay live
        { baseURL: "https://proxy.example" },
      ],
      fetchJson: async (url, init) => {
        if (url.startsWith("https://proxy.example")) {
          proxyHits += 1;
          return movieJson(278);
        }
        if (init.headers.Authorization === "Bearer ") throw new Error("HTTP 401");
        return movieJson(278); // the undefined-token same-host access succeeds
      },
    });
    await provider.getMovieDetails(278);
    await provider.getMovieDetails(550);
    // The undefined-token direct access serves every call; the proxy is never needed.
    expect(proxyHits).toBe(0);
  });

  it("does not remember a 404 as a dead access — the access answered, only the resource is missing (Copilot #306)", async () => {
    // A deleted season 404s on every access, and the episode-group fallback then
    // makes more calls through the same provider. Remembering those 404s as dead
    // left only the first access to answer marked alive, so a later transient
    // failure on it skipped the still-healthy proxy.
    const provider = new TmdbMetadataProvider({
      accesses: [
        { baseURL: "https://primary.example/3", readToken: "userkey" },
        { baseURL: "https://proxy.example" },
      ],
      fetchJson: async (url) => {
        if (url.includes("movie/404?")) throw new TmdbNotFoundError("TMDB HTTP 404");
        if (url.includes("movie/503?") && url.startsWith("https://primary.example")) {
          throw new TmdbHttpError("TMDB HTTP 503", 503);
        }
        return movieJson(278);
      },
    });
    await expect(provider.getMovieDetails(404)).rejects.toBeInstanceOf(TmdbNotFoundError);
    await provider.getMovieDetails(550);
    // The primary hiccups; the proxy must still be in the chain.
    await expect(provider.getMovieDetails(503)).resolves.toMatchObject({ id: 278 });
  });

  it("sends Authorization only when the access has a readToken", async () => {
    const seen: Array<Record<string, string>> = [];
    const provider = new TmdbMetadataProvider({
      accesses: [{ baseURL: "https://proxy.example" }],
      fetchJson: async (_url, init) => {
        seen.push(init.headers);
        return movieJson(1);
      },
    });
    await provider.getMovieDetails(1);
    expect(seen[0]?.Authorization).toBeUndefined();
  });

  it("still supports the legacy single readToken option", async () => {
    const seen: Array<Record<string, string>> = [];
    const provider = new TmdbMetadataProvider({
      readToken: "legacy",
      fetchJson: async (_url, init) => {
        seen.push(init.headers);
        return movieJson(1);
      },
    });
    await provider.getMovieDetails(1);
    expect(seen[0]?.Authorization).toBe("Bearer legacy");
  });
});

describe("TmdbSearchProvider multi-access fallback", () => {
  it("falls back to the proxy access when the user key fails", async () => {
    const calls: string[] = [];
    const provider = new TmdbSearchProvider({
      accesses: [
        { baseURL: "https://primary.example/3", readToken: "badkey" },
        { baseURL: "https://proxy.example" },
      ],
      fetchJson: async (url) => {
        calls.push(url);
        if (url.startsWith("https://primary.example")) throw new Error("HTTP 429");
        return { results: [] };
      },
    });
    const out = await provider.searchMedia({ query: "matrix" });
    expect(out).toEqual([]);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("https://proxy.example/search/multi");
  });
});

describe("createTmdbMetadataProvider / createTmdbSearchProvider", () => {
  it("builds a metadata provider from an access list", async () => {
    const provider = createTmdbMetadataProvider([{ baseURL: "https://proxy.example" }], {
      fetchJson: async () => movieJson(9),
    });
    expect((await provider.getMovieDetails(9)).id).toBe(9);
  });

  it("builds a search provider from an access list", async () => {
    const provider = createTmdbSearchProvider([{ baseURL: "https://proxy.example" }], {
      fetchJson: async () => ({ results: [] }),
    });
    expect(await provider.searchMedia({ query: "x" })).toEqual([]);
  });
});

describe("per-access timeout + timeout retry (2026-07-02 压测发现:软路由→CF Worker 基线 2.4s,4.5s 死限抖动即崩)", () => {
  it("direct api.themoviedb.org hop keeps the fail-fast timeout; other hops (proxy) get the patient one", async () => {
    const timeouts: Array<number | undefined> = [];
    const provider = new TmdbMetadataProvider({
      accesses: [
        { baseURL: "https://api.themoviedb.org/3", readToken: "userkey" },
        { baseURL: "https://proxy.example" },
      ],
      fetchJson: async (url, init) => {
        timeouts.push(init.timeoutMs);
        if (url.startsWith("https://api.themoviedb.org")) throw new Error("TMDB request failed with HTTP 500");
        return movieJson(278);
      },
    });
    await provider.getMovieDetails(278);
    expect(timeouts).toEqual([4500, 12000]);
  });

  it("retries the WHOLE chain once when every access failed and at least one failure was a timeout", async () => {
    let calls = 0;
    const provider = new TmdbMetadataProvider({
      accesses: [{ baseURL: "https://proxy.example" }],
      fetchJson: async () => {
        calls += 1;
        if (calls === 1) {
          throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
        }
        return movieJson(278);
      },
    });
    const details = await provider.getMovieDetails(278);
    expect(details.id).toBe(278);
    expect(calls).toBe(2); // first pass timed out, single retry pass succeeded
  });

  it("does NOT retry when the failures were not timeouts (401s keep failing fast)", async () => {
    let calls = 0;
    const provider = new TmdbMetadataProvider({
      accesses: [{ baseURL: "https://proxy.example", readToken: "k" }],
      fetchJson: async () => {
        calls += 1;
        throw new Error("TMDB request failed with HTTP 401");
      },
    });
    await expect(provider.getMovieDetails(278)).rejects.toThrow(/access/i);
    expect(calls).toBe(1);
  });

  it("a retry-pass success HEALS the dead-access memo — the next call goes straight through", async () => {
    let calls = 0;
    const provider = new TmdbMetadataProvider({
      accesses: [{ baseURL: "https://proxy.example" }],
      fetchJson: async () => {
        calls += 1;
        if (calls === 1) {
          throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
        }
        return movieJson(278);
      },
    });
    await provider.getMovieDetails(278); // timeout → retry → success (2 calls), memo healed
    await provider.getMovieDetails(278); // healed memo → single straight call
    expect(calls).toBe(3);
  });
});
