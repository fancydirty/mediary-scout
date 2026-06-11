import { describe, expect, it } from "vitest";
import {
  createEpisodeStates,
  episodeCode,
  reconcileVerifiedFiles,
  type TrackedSeason,
  type VerifiedFile,
} from "../src/index.js";

describe("episode state semantics", () => {
  it("creates visible future episodes without making them obtained", () => {
    const episodes = createEpisodeStates({
      trackedSeasonId: "season_1",
      seasonNumber: 1,
      totalEpisodes: 24,
      latestAiredEpisode: 14,
    });

    expect(episodes).toHaveLength(24);
    expect(episodes.every((episode) => episode.obtained === false)).toBe(true);
    expect(episodes.every((episode) => episode.metadataStatus === "confirmed")).toBe(true);
    expect(episodes[0]).toMatchObject({
      episodeCode: "S01E01",
      airStatus: "aired",
      obtained: false,
      metadataStatus: "confirmed",
    });
    expect(episodes[13]).toMatchObject({
      episodeCode: "S01E14",
      airStatus: "aired",
      obtained: false,
      metadataStatus: "confirmed",
    });
    expect(episodes[14]).toMatchObject({
      episodeCode: "S01E15",
      airStatus: "unaired",
      obtained: false,
      metadataStatus: "confirmed",
    });
  });

  it("records verified files ahead of TMDB as provider ahead", () => {
    const season: TrackedSeason = {
      id: "season_1",
      mediaTitleId: "title_1",
      seasonNumber: 1,
      status: "active",
      qualityPreference: "4K",
      storageDirectoryId: "dir_1",
      totalEpisodes: 24,
      latestAiredEpisode: 20,
      latestAiredSource: "metadata",
    };
    const episodes = createEpisodeStates({
      trackedSeasonId: season.id,
      seasonNumber: season.seasonNumber,
      totalEpisodes: season.totalEpisodes,
      latestAiredEpisode: season.latestAiredEpisode,
    });
    const files: VerifiedFile[] = [
      {
        id: "file_21",
        storageDirectoryId: "dir_1",
        name: "Show.S01E21.mkv",
        sizeBytes: 100,
        episodeCode: "S01E21",
        providerFileId: "provider_21",
      },
    ];

    const reconciled = reconcileVerifiedFiles({
      season,
      episodes,
      files,
    });

    expect(reconciled.find((episode) => episode.episodeCode === "S01E21")).toMatchObject({
      obtained: true,
      metadataStatus: "provider_ahead",
      verifiedFileIds: ["file_21"],
    });
  });

  it("formats episode codes consistently", () => {
    expect(episodeCode(1, 1)).toBe("S01E01");
    expect(episodeCode(12, 34)).toBe("S12E34");
  });
});
