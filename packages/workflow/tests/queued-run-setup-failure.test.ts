import { describe, expect, it } from "vitest";
import {
  InMemoryWorkflowRepository,
  queueMovieAcquisition,
  queueSeriesInitialization,
  queueTrackingInitialization,
  runQueuedMovieAcquisition,
  runQueuedSeriesInitialization,
  runQueuedType2Workflow,
  type MediaTitle,
  type TrackedSeason,
} from "../src/index.js";

/**
 * A queued run is claimed (status "running") before the worker resolves the run's
 * per-account dependencies (drive client, model, landing dirs). If that resolution
 * throws — the drive was removed while the run waited, the model settings were
 * cleared after the click, a database hiccup — the run must still end through the
 * failure handler: failed with the reason, or requeued when the error is transient.
 * Otherwise it stays "running" and the page shows 获取中 until the process restarts.
 */

const now = () => "2026-10-05T01:00:00.000Z";
const unused = {} as never;

const film: MediaTitle = {
  id: "tmdb_movie_1377237",
  tmdbId: 1377237,
  type: "movie",
  title: "护肝人",
  originalTitle: "Liver Man",
  year: 2025,
  aliases: [],
};

const show: MediaTitle = {
  id: "tmdb_tv_100",
  tmdbId: 100,
  type: "tv",
  title: "示例剧",
  originalTitle: "Example Show",
  year: 2024,
  aliases: [],
};

const showSeason: TrackedSeason = {
  id: "tmdb_tv_100_s1",
  mediaTitleId: show.id,
  seasonNumber: 1,
  status: "active",
  qualityPreference: "4K",
  storageDirectoryId: "",
  totalEpisodes: 2,
  latestAiredEpisode: 1,
  latestAiredSource: "metadata",
};

const throwing = (message: string) => async () => {
  throw new Error(message);
};

type Case = {
  name: string;
  queue: (repository: InMemoryWorkflowRepository, runId: string) => Promise<unknown>;
  run: (
    repository: InMemoryWorkflowRepository,
    resolveAccountContext: () => Promise<never>,
  ) => Promise<unknown>;
};

const cases: Case[] = [
  {
    name: "type2 (单季获取)",
    queue: (repository, runId) =>
      queueTrackingInitialization({
        title: show,
        season: showSeason,
        keyword: "示例剧",
        repository,
        connectedStorageId: "cs_115",
        createWorkflowRunId: () => runId,
        now,
      }),
    run: (repository, resolveAccountContext) =>
      runQueuedType2Workflow({
        repository,
        resourceProvider: unused,
        storage: unused,
        model: unused,
        storageParentDirectoryId: "tv_root",
        resolveAccountContext,
        now,
      }),
  },
  {
    name: "movie (电影获取)",
    queue: (repository, runId) =>
      queueMovieAcquisition({
        title: film,
        keyword: "护肝人",
        repository,
        connectedStorageId: "cs_115",
        createWorkflowRunId: () => runId,
        now,
      }),
    run: (repository, resolveAccountContext) =>
      runQueuedMovieAcquisition({
        repository,
        resourceProvider: unused,
        storage: unused,
        model: unused,
        moviesParentDirectoryId: "movies_root",
        resolveAccountContext,
        now,
      }),
  },
  {
    name: "series (整剧获取)",
    queue: (repository, runId) =>
      queueSeriesInitialization({
        title: show,
        seasons: [{ seasonNumber: 1, totalEpisodes: 2, latestAiredEpisode: 1 }],
        keyword: "示例剧",
        repository,
        connectedStorageId: "cs_115",
        createWorkflowRunId: () => runId,
        now,
      }),
    run: (repository, resolveAccountContext) =>
      runQueuedSeriesInitialization({
        repository,
        resourceProvider: unused,
        storage: unused,
        model: unused,
        storageParentDirectoryId: "tv_root",
        resolveAccountContext,
        now,
      }),
  },
];

describe("a queued run whose dependencies fail to resolve after the claim", () => {
  it.each(cases)("$name: ends failed with the reason instead of staying running", async ({ queue, run }) => {
    const repository = new InMemoryWorkflowRepository();
    await queue(repository, "run_setup_fail");

    const result = await run(repository, throwing("这个网盘已经解绑"));

    expect(result).toMatchObject({
      status: "failed",
      workflowRunId: "run_setup_fail",
      errorMessage: expect.stringContaining("这个网盘已经解绑"),
    });
    const saved = await repository.getWorkflowRunSnapshot("run_setup_fail");
    expect(saved?.workflowRun.status).toBe("failed");
    expect(await repository.listActiveWorkflowRuns()).toHaveLength(0);
  });

  it("a transient error while resolving is retried later, like any other transient failure", async () => {
    const repository = new InMemoryWorkflowRepository();
    await cases[1]!.queue(repository, "run_setup_blip");

    const result = await cases[1]!.run(repository, throwing("Cannot connect to API: socket disconnected"));

    expect(result).toMatchObject({ status: "ran", workflowRunId: "run_setup_blip", workflowStatus: "queued" });
    const saved = await repository.getWorkflowRunSnapshot("run_setup_blip");
    expect(saved?.workflowRun.status).toBe("queued");
    expect(saved?.workflowRun.autoRequeueCount).toBe(1);
  });
});
