import { describe, expect, it } from "vitest";
import {
  FakeAgentNodes,
  FakeResourceProvider,
  FakeStorageExecutor,
  InMemoryWorkflowRepository,
  queueSeriesInitialization,
  runQueuedSeriesInitialization,
  runSeriesInitialization,
  runSeriesInitializationAndPersist,
  type MediaTitle,
  type VerifiedFile,
} from "../src/index.js";

const theBoys: MediaTitle = {
  id: "tmdb_tv_76479",
  tmdbId: 76479,
  type: "tv",
  title: "黑袍纠察队",
  originalTitle: "The Boys",
  year: 2019,
  aliases: ["The Boys"],
};

function file(id: string, code: string, sizeBytes = 1_000_000_000): VerifiedFile {
  return {
    id,
    storageDirectoryId: "set_by_fake",
    name: `The.Boys.${code}.2160p.mkv`,
    sizeBytes,
    episodeCode: code,
    providerFileId: id,
  };
}

const seasons = [
  { seasonNumber: 1, totalEpisodes: 2, latestAiredEpisode: 2 },
  { seasonNumber: 2, totalEpisodes: 3, latestAiredEpisode: 2 },
];

describe("runSeriesInitialization", () => {
  it("absorbs mixed-coverage resources: completed season pack + ongoing season episodes", async () => {
    const storage = new FakeStorageExecutor({
      transferOutcomes: {
        // mixed pack: S1 complete + first episode of ongoing S2
        snapshot_1_candidate_1: {
          status: "succeeded",
          providerMessage: "",
          files: [file("f_s1e1", "S01E01"), file("f_s1e2", "S01E02"), file("f_s2e1", "S02E01")],
        },
        // single latest episode of S2
        snapshot_1_candidate_2: {
          status: "succeeded",
          providerMessage: "",
          files: [file("f_s2e2", "S02E02")],
        },
      },
    });
    const resourceProvider = new FakeResourceProvider({
      keywordResults: {
        "黑袍纠察队 4K": [
          {
            title: "黑袍纠察队 S01全集+S02E01 混合包 4K",
            episodeHints: ["S01E01", "S01E02", "S02E01"],
          },
          { title: "黑袍纠察队 S02E02 4K", episodeHints: ["S02E02"] },
        ],
      },
    });

    const result = await runSeriesInitialization({
      title: theBoys,
      seasons,
      keyword: "黑袍纠察队 4K",
      storageParentDirectoryId: "library_root",
      resourceProvider,
      storage,
      agents: new FakeAgentNodes(),
      workflowRunId: "run_series",
    });

    expect(result.status).toBe("succeeded");
    expect(result.seasons).toHaveLength(2);
    const s1 = result.seasons.find((entry) => entry.season.seasonNumber === 1)!;
    const s2 = result.seasons.find((entry) => entry.season.seasonNumber === 2)!;
    expect(s1.season.status).toBe("completed");
    expect(s1.obtainedEpisodes).toEqual(["S01E01", "S01E02"]);
    expect(s2.season.status).toBe("active");
    expect(s2.obtainedEpisodes).toEqual(["S02E01", "S02E02"]);
    expect(s1.season.storageDirectoryId).toContain("Season 1");
    expect(s2.season.storageDirectoryId).toContain("Season 2");

    const s1Files = await storage.listVideoFiles(s1.season.storageDirectoryId);
    expect(s1Files.map((item) => item.episodeCode).sort()).toEqual(["S01E01", "S01E02"]);
    const auditTypes = result.auditEvents.map((event) => event.type);
    expect(auditTypes).toContain("acquisition_plan_created");
    expect(result.notification.body).toContain("4");
  });

  it("persists one tracked season per season and keeps the airing season active for type3", async () => {
    const repository = new InMemoryWorkflowRepository();
    const storage = new FakeStorageExecutor({
      transferOutcomes: {
        snapshot_1_candidate_1: {
          status: "succeeded",
          providerMessage: "",
          files: [file("f_s1e1", "S01E01"), file("f_s1e2", "S01E02"), file("f_s2e1", "S02E01")],
        },
        snapshot_1_candidate_2: {
          status: "succeeded",
          providerMessage: "",
          files: [file("f_s2e2", "S02E02")],
        },
      },
    });
    const result = await runSeriesInitializationAndPersist({
      title: theBoys,
      seasons,
      keyword: "黑袍纠察队 4K",
      storageParentDirectoryId: "library_root",
      resourceProvider: new FakeResourceProvider({
        keywordResults: {
          "黑袍纠察队 4K": [
            { title: "混合包", episodeHints: ["S01E01", "S01E02", "S02E01"] },
            { title: "S02E02", episodeHints: ["S02E02"] },
          ],
        },
      }),
      storage,
      agents: new FakeAgentNodes(),
      repository,
      workflowRun: { id: "run_series", startedAt: "2026-06-13T00:00:00.000Z", finishedAt: "2026-06-13T00:01:00.000Z" },
    });

    expect(result.status).toBe("succeeded");
    const states = await repository.listTrackedSeasonStates();
    expect(states).toHaveLength(2);
    const active = states.find((state) => state.season.seasonNumber === 2);
    expect(active?.season.status).toBe("active");
    const saved = await repository.getWorkflowRunSnapshot("run_series_s1");
    expect(saved?.workflowRun.kind).toBe("type1_package_init");
  });

  it("keeps uncovered seasons tracked with missing episodes so type3 can retry", async () => {
    const storage = new FakeStorageExecutor({
      transferOutcomes: {
        snapshot_1_candidate_1: {
          status: "succeeded",
          providerMessage: "",
          files: [file("f_s1e1", "S01E01"), file("f_s1e2", "S01E02")],
        },
      },
    });
    const result = await runSeriesInitialization({
      title: theBoys,
      seasons,
      keyword: "黑袍纠察队 4K",
      storageParentDirectoryId: "library_root",
      resourceProvider: new FakeResourceProvider({
        keywordResults: {
          "黑袍纠察队 4K": [{ title: "S01 全集包", episodeHints: ["S01E01", "S01E02"] }],
        },
      }),
      storage,
      agents: new FakeAgentNodes(),
    });

    expect(result.status).toBe("partial");
    const s2 = result.seasons.find((entry) => entry.season.seasonNumber === 2)!;
    expect(s2.obtainedEpisodes).toEqual([]);
    expect(s2.season.storageDirectoryId).not.toBe("");
  });
});

describe("queueSeriesInitialization + runQueuedSeriesInitialization", () => {
  it("queues once, runs the whole series, and dedupes repeat requests", async () => {
    const repository = new InMemoryWorkflowRepository();
    const queued = await queueSeriesInitialization({
      title: theBoys,
      seasons,
      keyword: "黑袍纠察队 4K",
      repository,
      createWorkflowRunId: () => "run_series_q",
      now: () => "2026-06-13T00:00:00.000Z",
    });
    expect(queued).toEqual({ status: "queued", titleId: theBoys.id, workflowRunId: "run_series_q" });

    const again = await queueSeriesInitialization({
      title: theBoys,
      seasons,
      keyword: "黑袍纠察队 4K",
      repository,
      createWorkflowRunId: () => "run_series_dup",
      now: () => "2026-06-13T00:00:01.000Z",
    });
    expect(again.status).toBe("already_running");

    const storage = new FakeStorageExecutor({
      transferOutcomes: {
        snapshot_1_candidate_1: {
          status: "succeeded",
          providerMessage: "",
          files: [file("f_s1e1", "S01E01"), file("f_s1e2", "S01E02"), file("f_s2e1", "S02E01"), file("f_s2e2", "S02E02")],
        },
      },
    });
    const workerResult = await runQueuedSeriesInitialization({
      repository,
      resourceProvider: new FakeResourceProvider({
        keywordResults: {
          "黑袍纠察队 4K": [
            { title: "黑袍纠察队 S1-S2 混合包", episodeHints: ["S01E01", "S01E02", "S02E01", "S02E02"] },
          ],
        },
      }),
      storage,
      agents: new FakeAgentNodes(),
      storageParentDirectoryId: "library_root",
      now: () => "2026-06-13T00:05:00.000Z",
    });

    expect(workerResult).toMatchObject({ status: "ran", workflowStatus: "succeeded" });
    const states = await repository.listTrackedSeasonStates();
    expect(states).toHaveLength(2);

    const afterRun = await queueSeriesInitialization({
      title: theBoys,
      seasons,
      keyword: "黑袍纠察队 4K",
      repository,
      createWorkflowRunId: () => "run_series_again",
      now: () => "2026-06-13T01:00:00.000Z",
    });
    expect(afterRun.status).toBe("already_tracked");
  });
});
