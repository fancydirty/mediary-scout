import { describe, expect, it } from "vitest";
import {
  prepareTrackingTarget,
  TmdbMetadataProvider,
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
      keyword: "翘楚 4K",
    });
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
    expect(target.keyword).toBe("Show 1080p");
  });
});
