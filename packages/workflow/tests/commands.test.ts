import { describe, expect, it } from "vitest";
import {
  createEpisodeStates,
  episodeCode,
  FakeAgentNodes,
  FakeResourceProvider,
  FakeStorageExecutor,
  importForeignWorkAsMovie,
  InMemoryWorkflowRepository,
  queueTrackingInitialization,
  requestTrackingInitialization,
  type EpisodeState,
  type MediaTitle,
  type TrackedSeason,
  type VerifiedFile,
  type WorkflowRun,
} from "../src/index.js";

describe("requestTrackingInitialization", () => {
  it("queues a type2 initialization without searching resources or touching storage", async () => {
    const repository = new InMemoryWorkflowRepository();
    const { title, season } = trackedFixture();

    const result = await queueTrackingInitialization({
      title,
      season,
      keyword: "Show 4K",
      repository,
      createWorkflowRunId: () => "run_queued_type2",
      now: fixedNow,
    });

    expect(result).toMatchObject({
      status: "queued",
      workflowRunId: "run_queued_type2",
      workflowStatus: "queued",
      progress: {
        totalEpisodes: 2,
        latestAiredEpisode: 1,
        obtainedEpisodes: [],
        missingAiredEpisodes: ["S01E01"],
      },
    });
    await expect(repository.getWorkflowRunSnapshot("run_queued_type2")).resolves.toMatchObject({
      workflowRun: {
        id: "run_queued_type2",
        status: "queued",
        auditEvents: [
          { type: "workflow_reserved" },
          {
            type: "tracking_request_queued",
            data: { keyword: "Show 4K" },
          },
        ],
      },
    });
  });

  it("returns an existing active workflow without searching again", async () => {
    const repository = new InMemoryWorkflowRepository();
    const { title, season } = trackedFixture();
    const episodes = episodeStates(season);
    await repository.saveWorkflowRunSnapshot({
      title,
      season,
      workflowRun: workflowRun(season, {
        id: "run_active",
        status: "running",
        finishedAt: null,
      }),
      episodes,
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });

    const result = await requestTrackingInitialization({
      title,
      season,
      keyword: "Show 4K",
      storageParentDirectoryId: "library_root",
      resourceProvider: new FakeResourceProvider({
        keywordResults: {},
        keywordErrors: { "Show 4K": "provider should not be searched when a run is active" },
      }),
      storage: new FakeStorageExecutor(),
      agents: new FakeAgentNodes(),
      repository,
      createWorkflowRunId: () => "run_should_not_be_created",
      now: fixedNow,
    });

    expect(result).toMatchObject({
      status: "already_running",
      workflowRunId: "run_active",
      workflowStatus: "running",
      progress: {
        totalEpisodes: 2,
        latestAiredEpisode: 1,
        obtainedEpisodes: [],
        missingAiredEpisodes: ["S01E01"],
      },
    });
    await expect(repository.getWorkflowRunSnapshot("run_should_not_be_created")).resolves.toBeNull();
  });

  it("expires stale active workflow runs and starts a replacement request", async () => {
    const repository = new InMemoryWorkflowRepository();
    const { title, season } = trackedFixture();
    await repository.saveWorkflowRunSnapshot({
      title,
      season,
      workflowRun: workflowRun(season, {
        id: "run_stale",
        status: "running",
        startedAt: "2026-06-10T23:00:00.000Z",
        finishedAt: null,
      }),
      episodes: episodeStates(season),
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });

    const result = await requestTrackingInitialization({
      title,
      season,
      keyword: "Show 4K",
      storageParentDirectoryId: "library_root",
      resourceProvider: new FakeResourceProvider({
        keywordResults: {
          "Show 4K": [{ title: "Show S01E01 4K", episodeHints: ["S01E01"] }],
        },
      }),
      storage: new FakeStorageExecutor({
        directories: { [season.storageDirectoryId]: [] },
        transferOutcomes: {
          snapshot_1_candidate_1: {
            status: "succeeded",
            providerMessage: "",
            files: [verifiedFile(season, "replacement_S01E01", "S01E01")],
          },
        },
      }),
      agents: new FakeAgentNodes(),
      repository,
      createWorkflowRunId: () => "run_replacement_type2",
      now: fixedNow,
      staleActiveRunTimeoutMs: 30 * 60 * 1000,
    });

    expect(result).toMatchObject({
      status: "completed",
      workflowRunId: "run_replacement_type2",
      progress: {
        obtainedEpisodes: ["S01E01"],
      },
    });
    await expect(repository.getWorkflowRunSnapshot("run_stale")).resolves.toMatchObject({
      workflowRun: {
        status: "failed",
        auditEvents: [
          { type: "workflow_expired" },
        ],
      },
      episodes: [],
    });
  });

  it("returns already tracked state without triggering a new workflow", async () => {
    const repository = new InMemoryWorkflowRepository();
    const { title, season } = trackedFixture();
    const episodes = episodeStates(season).map((episode) =>
      episode.episodeCode === "S01E01"
        ? {
            ...episode,
            obtained: true,
            verifiedFileIds: ["file_S01E01"],
          }
        : episode,
    );
    await repository.saveWorkflowRunSnapshot({
      title,
      season,
      workflowRun: workflowRun(season, {
        id: "run_previous_success",
        status: "succeeded",
      }),
      episodes,
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });

    const result = await requestTrackingInitialization({
      title,
      season,
      keyword: "Show 4K",
      storageParentDirectoryId: "library_root",
      resourceProvider: new FakeResourceProvider({
        keywordResults: {},
        keywordErrors: { "Show 4K": "provider should not be searched for tracked state" },
      }),
      storage: new FakeStorageExecutor(),
      agents: new FakeAgentNodes(),
      repository,
      createWorkflowRunId: () => "run_should_not_be_created",
      now: fixedNow,
    });

    expect(result).toMatchObject({
      status: "already_tracked",
      workflowRunId: null,
      workflowStatus: null,
      progress: {
        obtainedEpisodes: ["S01E01"],
        missingAiredEpisodes: [],
      },
    });
    await expect(repository.getWorkflowRunSnapshot("run_should_not_be_created")).resolves.toBeNull();
  });

  it("creates a workflow run, executes type2, persists the result, and returns a UI summary", async () => {
    const repository = new InMemoryWorkflowRepository();
    const { title, season } = trackedFixture();
    const storage = new FakeStorageExecutor({
      directories: { [season.storageDirectoryId]: [] },
      transferOutcomes: {
        snapshot_1_candidate_1: {
          status: "succeeded",
          providerMessage: "",
          files: [verifiedFile(season, "file_S01E01", "S01E01")],
        },
      },
    });

    const result = await requestTrackingInitialization({
      title,
      season,
      keyword: "Show 4K",
      storageParentDirectoryId: "library_root",
      resourceProvider: new FakeResourceProvider({
        keywordResults: {
          "Show 4K": [
            {
              title: "Show S01E01 4K",
              episodeHints: ["S01E01"],
              qualityHints: ["4K"],
            },
          ],
        },
      }),
      storage,
      agents: new FakeAgentNodes(),
      repository,
      createWorkflowRunId: () => "run_new_type2",
      now: fixedNow,
    });

    expect(result).toMatchObject({
      status: "completed",
      workflowRunId: "run_new_type2",
      workflowStatus: "succeeded",
      notification: {
        kind: "tracking_initialized",
      },
      progress: {
        totalEpisodes: 2,
        latestAiredEpisode: 1,
        obtainedEpisodes: ["S01E01"],
        missingAiredEpisodes: [],
      },
    });

    const saved = await repository.getWorkflowRunSnapshot("run_new_type2");
    expect(saved).toMatchObject({
      workflowRun: {
        id: "run_new_type2",
        kind: "type2_init",
        status: "succeeded",
      },
      obtainedEpisodes: ["S01E01"],
    });
    expect(saved?.resourceSnapshots).toHaveLength(1);
    expect(saved?.transferAttempts[0]?.workflowRunId).toBe("run_new_type2");
  });

  it("does not treat a failed reservation as tracked on the next request", async () => {
    const repository = new InMemoryWorkflowRepository();
    const { title, season } = trackedFixture();

    await expect(
      requestTrackingInitialization({
        title,
        season,
        keyword: "Show 4K",
        storageParentDirectoryId: "library_root",
        resourceProvider: new FakeResourceProvider({
          keywordResults: {},
          keywordErrors: { "Show 4K": "provider unavailable" },
        }),
        storage: new FakeStorageExecutor(),
        agents: new FakeAgentNodes(),
        repository,
        createWorkflowRunId: () => "run_failed_type2",
        now: fixedNow,
      }),
    ).rejects.toThrow("provider unavailable");

    await expect(repository.listEpisodeStates(season.id)).resolves.toEqual([]);

    const retryResult = await requestTrackingInitialization({
      title,
      season,
      keyword: "Show 4K",
      storageParentDirectoryId: "library_root",
      resourceProvider: new FakeResourceProvider({
        keywordResults: {
          "Show 4K": [{ title: "Show S01E01 4K", episodeHints: ["S01E01"] }],
        },
      }),
      storage: new FakeStorageExecutor({
        directories: { [season.storageDirectoryId]: [] },
        transferOutcomes: {
          snapshot_1_candidate_1: {
            status: "succeeded",
            providerMessage: "",
            files: [verifiedFile(season, "retry_S01E01", "S01E01")],
          },
        },
      }),
      agents: new FakeAgentNodes(),
      repository,
      createWorkflowRunId: () => "run_retry_type2",
      now: fixedNow,
    });

    expect(retryResult).toMatchObject({
      status: "completed",
      workflowRunId: "run_retry_type2",
      progress: {
        obtainedEpisodes: ["S01E01"],
      },
    });
  });
});

function trackedFixture(): { title: MediaTitle; season: TrackedSeason } {
  const title: MediaTitle = {
    id: "title_show",
    tmdbId: 123,
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
      totalEpisodes: 2,
      latestAiredEpisode: 1,
      latestAiredSource: "metadata",
    },
  };
}

function episodeStates(season: TrackedSeason): EpisodeState[] {
  return createEpisodeStates({
    trackedSeasonId: season.id,
    seasonNumber: season.seasonNumber,
    totalEpisodes: season.totalEpisodes,
    latestAiredEpisode: season.latestAiredEpisode,
  });
}

function workflowRun(
  season: TrackedSeason,
  overrides: Partial<WorkflowRun> & Pick<WorkflowRun, "id" | "status">,
): WorkflowRun {
  return {
    id: overrides.id,
    kind: overrides.kind ?? "type2_init",
    status: overrides.status,
    trackedSeasonId: overrides.trackedSeasonId ?? season.id,
    startedAt: overrides.startedAt ?? "2026-06-11T00:00:00.000Z",
    finishedAt: overrides.finishedAt ?? "2026-06-11T00:01:00.000Z",
    auditEvents: overrides.auditEvents ?? [],
  };
}

function fixedNow(): string {
  return "2026-06-11T00:00:00.000Z";
}

function verifiedFile(season: TrackedSeason, id: string, code: string): VerifiedFile {
  return {
    id,
    storageDirectoryId: season.storageDirectoryId,
    name: `Show.${episodeCode(season.seasonNumber, Number(code.slice(-2)))}.mkv`,
    sizeBytes: 1_000_000_000,
    episodeCode: code,
    providerFileId: `provider_${id}`,
  };
}

describe("importForeignWorkAsMovie", () => {
  it("moves user-confirmed foreign files into the Title (Year) directory keeping their original name", async () => {
    const storage = new FakeStorageExecutor({
      unparsedFiles: {
        staging_pack: [
          { providerFileId: "el_camino", name: "El.Camino.2019.2160p.mkv", sizeBytes: 30_000_000_000 },
        ],
      },
    });

    const result = await importForeignWorkAsMovie({
      storage,
      providerFileIds: ["el_camino"],
      movieTitle: "续命之徒：绝命毒师电影",
      year: 2019,
      moviesParentDirectoryId: "movies_root",
    });

    expect(result.movedFileIds).toEqual(["el_camino"]);
    // No rename — the identity is the `Title (Year)` wrapper directory, so the
    // video keeps its original filename (and avoids `(1)` collisions).
    const stagingLeft = await storage.listUnparsedVideoFiles("staging_pack");
    expect(stagingLeft).toEqual([]);
    const landedUnparsed = await storage.listUnparsedVideoFiles(result.movieDirectoryId);
    expect(landedUnparsed.map((file) => file.name)).toEqual(["El.Camino.2019.2160p.mkv"]);
  });

  it("throws when no files were given", async () => {
    await expect(
      importForeignWorkAsMovie({
        storage: new FakeStorageExecutor(),
        providerFileIds: [],
        movieTitle: "Movie",
        year: 2020,
        moviesParentDirectoryId: "movies_root",
      }),
    ).rejects.toThrow("FOREIGN_WORK_IMPORT_EMPTY");
  });
});
