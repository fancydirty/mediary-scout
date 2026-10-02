import { describe, expect, it } from "vitest";
import {
  createEpisodeStates,
  episodeCode,
  syncSeasonAgainstMetadata,
  type EpisodeState,
  type TrackedSeason,
} from "../src/index.js";

function season(overrides: Partial<TrackedSeason> = {}): TrackedSeason {
  return {
    id: "tmdb_tv_1_s1",
    mediaTitleId: "tmdb_tv_1",
    seasonNumber: 1,
    status: "active",
    qualityPreference: "4K",
    storageDirectoryId: "dir",
    totalEpisodes: 16,
    latestAiredEpisode: 12,
    latestAiredSource: "metadata",
    ...overrides,
  };
}

function episodes(s: TrackedSeason, obtained: string[] = []): EpisodeState[] {
  const set = new Set(obtained);
  return createEpisodeStates({
    trackedSeasonId: s.id,
    seasonNumber: s.seasonNumber,
    totalEpisodes: s.totalEpisodes,
    latestAiredEpisode: s.latestAiredEpisode,
  }).map((episode) => ({ ...episode, obtained: set.has(episode.episodeCode) }));
}

describe("syncSeasonAgainstMetadata", () => {
  it("exposes newly aired episodes as missing when TMDB latest advances", () => {
    const s = season({ latestAiredEpisode: 12, totalEpisodes: 16 });
    const result = syncSeasonAgainstMetadata({
      season: s,
      episodes: episodes(s),
      latestAiredEpisode: 14,
      totalEpisodes: 16,
    });
    expect(result.changed).toBe(true);
    expect(result.season.latestAiredEpisode).toBe(14);
    const e13 = result.episodes.find((e) => e.episodeCode === episodeCode(1, 13));
    expect(e13?.airStatus).toBe("aired");
    expect(e13?.obtained).toBe(false);
    expect(result.episodes.find((e) => e.episodeCode === episodeCode(1, 15))?.airStatus).toBe("unaired");
  });

  it("preserves already-obtained episodes across a sync", () => {
    const s = season({ latestAiredEpisode: 12, totalEpisodes: 16 });
    const obtained = Array.from({ length: 12 }, (_, i) => episodeCode(1, i + 1));
    const result = syncSeasonAgainstMetadata({
      season: s,
      episodes: episodes(s, obtained),
      latestAiredEpisode: 14,
      totalEpisodes: 16,
    });
    for (let i = 1; i <= 12; i += 1) {
      expect(result.episodes.find((e) => e.episodeCode === episodeCode(1, i))?.obtained).toBe(true);
    }
    expect(result.episodes.find((e) => e.episodeCode === episodeCode(1, 13))?.obtained).toBe(false);
  });

  it("heals an inflated aired cursor while keeping obtained episodes", () => {
    const s = season({ latestAiredEpisode: 14, totalEpisodes: 14 });
    const result = syncSeasonAgainstMetadata({
      season: s,
      episodes: episodes(s, [episodeCode(1, 1)]),
      latestAiredEpisode: 1,
      totalEpisodes: 14,
    });

    expect(result.changed).toBe(true);
    expect(result.season.latestAiredEpisode).toBe(1);
    expect(result.episodes).toHaveLength(14);
    expect(result.episodes.find((e) => e.episodeCode === episodeCode(1, 1))).toMatchObject({
      airStatus: "aired",
      obtained: true,
    });
    for (let i = 2; i <= 14; i += 1) {
      expect(result.episodes.find((e) => e.episodeCode === episodeCode(1, i))).toMatchObject({
        airStatus: "unaired",
        obtained: false,
      });
    }
  });

  it("keeps an inflated cursor when every episode is already obtained", () => {
    const s = season({ latestAiredEpisode: 14, totalEpisodes: 14 });
    const obtained = Array.from({ length: 14 }, (_, i) => episodeCode(1, i + 1));
    const result = syncSeasonAgainstMetadata({
      season: s,
      episodes: episodes(s, obtained),
      latestAiredEpisode: 12,
      totalEpisodes: 14,
    });

    expect(result.changed).toBe(false);
    expect(result.season.latestAiredEpisode).toBe(14);
  });

  it("floors healing at the highest obtained episode without restoring the inflated tail", () => {
    const s = season({ latestAiredEpisode: 14, totalEpisodes: 14 });
    const obtained = Array.from({ length: 13 }, (_, i) => episodeCode(1, i + 1));
    const result = syncSeasonAgainstMetadata({
      season: s,
      episodes: episodes(s, obtained),
      latestAiredEpisode: 10,
      totalEpisodes: 14,
    });

    expect(result.changed).toBe(true);
    expect(result.season.latestAiredEpisode).toBe(13);
    expect(result.episodes.find((e) => e.episodeCode === episodeCode(1, 14))).toMatchObject({
      airStatus: "unaired",
      obtained: false,
    });
    for (let i = 11; i <= 13; i += 1) {
      expect(result.episodes.find((e) => e.episodeCode === episodeCode(1, i))).toMatchObject({
        airStatus: "aired",
        obtained: true,
      });
    }
  });

  it("keeps provider-ahead obtained episodes ahead without raising the stored cursor", () => {
    const s = season({ latestAiredEpisode: 3, totalEpisodes: 12 });
    const obtained = Array.from({ length: 5 }, (_, i) => episodeCode(1, i + 1));
    const result = syncSeasonAgainstMetadata({
      season: s,
      episodes: episodes(s, obtained),
      latestAiredEpisode: 3,
      totalEpisodes: 12,
    });

    expect(result.changed).toBe(false);
    expect(result.season.latestAiredEpisode).toBe(3);
  });

  it("grows the episode list when total episodes increase", () => {
    const s = season({ latestAiredEpisode: 16, totalEpisodes: 16 });
    const result = syncSeasonAgainstMetadata({
      season: s,
      episodes: episodes(s),
      latestAiredEpisode: 18,
      totalEpisodes: 20,
    });
    expect(result.season.totalEpisodes).toBe(20);
    expect(result.episodes).toHaveLength(20);
    expect(result.episodes.find((e) => e.episodeCode === episodeCode(1, 20))).toBeDefined();
  });

  it("heals a stored cursor when fresh TMDB metadata is lower", () => {
    const s = season({ latestAiredEpisode: 14, totalEpisodes: 16 });
    const result = syncSeasonAgainstMetadata({
      season: s,
      episodes: episodes(s),
      latestAiredEpisode: 12,
      totalEpisodes: 16,
    });
    expect(result.changed).toBe(true);
    expect(result.season.latestAiredEpisode).toBe(12);
    expect(result.episodes).toHaveLength(16);
  });

  it("never shrinks total episodes while healing the aired cursor", () => {
    const s = season({ latestAiredEpisode: 12, totalEpisodes: 16 });
    const result = syncSeasonAgainstMetadata({
      season: s,
      episodes: episodes(s),
      latestAiredEpisode: 14,
      totalEpisodes: 14,
    });

    expect(result.season.totalEpisodes).toBe(16);
    expect(result.season.latestAiredEpisode).toBe(14);
    expect(result.episodes).toHaveLength(16);
  });

  it("leaves season.status untouched so the sweep keeps processing until fully obtained", () => {
    const s = season({ latestAiredEpisode: 12, totalEpisodes: 16, status: "active" });
    const result = syncSeasonAgainstMetadata({
      season: s,
      episodes: episodes(s),
      latestAiredEpisode: 16,
      totalEpisodes: 16,
    });
    // Even though latest === total now, status stays active: episodes still
    // need acquiring; only the finale (all obtained) graduates it.
    expect(result.season.status).toBe("active");
  });
});
