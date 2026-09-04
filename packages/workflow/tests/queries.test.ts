import { describe, expect, it } from "vitest";
import {
  createEpisodeStates,
  getTrackedSeasonStatusView,
  InMemoryWorkflowRepository,
  type EpisodeState,
  type MediaTitle,
  type TrackedSeason,
  type WorkflowRun,
} from "../src/index.js";

describe("getTrackedSeasonStatusView", () => {
  it("projects repository state into episode grid statuses for the GUI", async () => {
    const repository = new InMemoryWorkflowRepository();
    const { title, season } = fixture();
    const episodes = [
      ...createEpisodeStates({
        trackedSeasonId: season.id,
        seasonNumber: season.seasonNumber,
        totalEpisodes: season.totalEpisodes,
        latestAiredEpisode: season.latestAiredEpisode,
      }).map((episode) =>
        episode.episodeCode === "S01E01"
          ? {
              ...episode,
              obtained: true,
              verifiedFileIds: ["file_1"],
            }
          : episode,
      ),
      providerAheadEpisode(season.id),
    ];
    await repository.saveWorkflowRunSnapshot({
      title,
      season,
      workflowRun: workflowRun(season),
      episodes,
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });

    const view = await getTrackedSeasonStatusView({
      repository,
      trackedSeasonId: season.id,
    });

    expect(view).toMatchObject({
      titleId: "title_show",
      title: "Show",
      trackedSeasonId: "season_show_1",
      seasonNumber: 1,
      totalEpisodes: 3,
      latestAiredEpisode: 2,
      obtainedEpisodes: ["S01E01", "S01E04"],
      missingAiredEpisodes: ["S01E02"],
      providerAheadEpisodes: ["S01E04"],
      obtainedCount: 2,
      missingAiredCount: 1,
    });
    expect(view?.episodes.map((episode) => [episode.episodeCode, episode.displayState])).toEqual([
      ["S01E01", "obtained"],
      ["S01E02", "missing_aired"],
      ["S01E03", "unaired"],
      ["S01E04", "provider_ahead"],
    ]);
  });

  // 123 醒来 bug (2026-09-04): the same season tracked on two drives. The detail
  // page must show THAT drive's episodes — passing only accountId drops the
  // storage filter, and the unfiltered lookup lands on whichever drive's row
  // comes first (the 115 copy at 0/22) while the library card correctly said
  // 21/22 for the 123 copy.
  it("scopes the view to the requested drive when the season is tracked on multiple drives", async () => {
    const repository = new InMemoryWorkflowRepository();
    const { title, season } = fixture();
    const emptyEpisodes = createEpisodeStates({
      trackedSeasonId: season.id,
      seasonNumber: season.seasonNumber,
      totalEpisodes: season.totalEpisodes,
      latestAiredEpisode: season.latestAiredEpisode,
    });
    const snapshot = (storageId: string, runId: string, startedAt: string, obtained: boolean) => ({
      accountId: "acct_1",
      connectedStorageId: storageId,
      title,
      season,
      workflowRun: { ...workflowRun(season), id: runId, startedAt },
      episodes: emptyEpisodes.map((episode) =>
        episode.airStatus === "aired" ? { ...episode, obtained } : episode,
      ),
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });
    // The drive with NOTHING has the more recent run, so an unscoped "latest
    // snapshot wins" lookup would pick it and report 0 obtained.
    await repository.saveWorkflowRunSnapshot(snapshot("cs_pan123", "run_123", "2026-09-01T00:00:00.000Z", true));
    await repository.saveWorkflowRunSnapshot(snapshot("cs_115", "run_115", "2026-09-02T00:00:00.000Z", false));

    const view123 = await getTrackedSeasonStatusView({
      repository,
      trackedSeasonId: season.id,
      scope: { accountId: "acct_1", connectedStorageId: "cs_pan123" },
    });
    expect(view123?.obtainedCount).toBe(2);
    expect(view123?.missingAiredCount).toBe(0);

    const view115 = await getTrackedSeasonStatusView({
      repository,
      trackedSeasonId: season.id,
      scope: { accountId: "acct_1", connectedStorageId: "cs_115" },
    });
    expect(view115?.obtainedCount).toBe(0);
    expect(view115?.missingAiredCount).toBe(2);
  });

  it("returns null when the tracked season does not exist", async () => {
    const view = await getTrackedSeasonStatusView({
      repository: new InMemoryWorkflowRepository(),
      trackedSeasonId: "missing",
    });

    expect(view).toBeNull();
  });
});

function fixture(): { title: MediaTitle; season: TrackedSeason } {
  const title: MediaTitle = {
    id: "title_show",
    tmdbId: 1,
    type: "tv",
    title: "Show",
    originalTitle: "Show",
    year: 2026,
    aliases: [],
  };
  return {
    title,
    season: {
      id: "season_show_1",
      mediaTitleId: title.id,
      seasonNumber: 1,
      status: "active",
      qualityPreference: "4K",
      storageDirectoryId: "dir_show_s1",
      totalEpisodes: 3,
      latestAiredEpisode: 2,
      latestAiredSource: "metadata",
    },
  };
}

function workflowRun(season: TrackedSeason): WorkflowRun {
  return {
    id: "run_1",
    kind: "type2_init",
    status: "succeeded",
    trackedSeasonId: season.id,
    startedAt: "2026-06-11T00:00:00.000Z",
    finishedAt: "2026-06-11T00:01:00.000Z",
    auditEvents: [],
  };
}

function providerAheadEpisode(trackedSeasonId: string): EpisodeState {
  return {
    trackedSeasonId,
    episodeCode: "S01E04",
    airDate: null,
    title: "S01E04",
    airStatus: "unknown",
    obtained: true,
    metadataStatus: "provider_ahead",
    verifiedFileIds: ["file_4"],
  };
}
