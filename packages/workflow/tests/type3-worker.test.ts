import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import {
  createEpisodeStates,
  FakeResourceProvider,
  FakeStorageExecutor,
  InMemoryWorkflowRepository,
  reconcileVerifiedFiles,
  reserveMovie,
  runScheduledType3Monitoring,
  type JevJudge,
  type JevJudgeInput,
  type MediaTitle,
  type TrackedSeason,
  type VerifiedFile,
} from "../src/index.js";

const fixedNow = () => "2026-06-12T00:00:00.000Z";

const USAGE = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
} as const;

/** Searches once, honestly reports no coverage. */
function noCoverageModel() {
  let i = 0;
  const tool = (name: string, input: unknown) => ({
    content: [{ type: "tool-call" as const, toolCallId: `c${i}`, toolName: name, input: JSON.stringify(input) }],
    finishReason: { unified: "tool-calls" as const, raw: "tool-calls" as const },
    usage: USAGE,
    warnings: [],
  });
  return new MockLanguageModelV3({
    doGenerate: async () => {
      i += 1;
      if (i === 1) return tool("searchResources", { keyword: "show" });
      if (i === 2) return tool("reportNoCoverage", { reason: "no candidates" });
      return { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" as const }, usage: USAGE, warnings: [] };
    },
  });
}

/** Throws on any call — a model whose API is down, and a guard the no-op path
 *  must never invoke. */
function throwingModel() {
  return new MockLanguageModelV3({
    doGenerate: async () => {
      throw new Error("agent model unavailable");
    },
  });
}

function emptyProvider() {
  return new FakeResourceProvider({ keywordResults: {} });
}

function trackedFixture(suffix = "show") {
  const title: MediaTitle = {
    id: `title_${suffix}`,
    tmdbId: 1,
    type: "tv",
    title: `Show ${suffix}`,
    originalTitle: `Show ${suffix}`,
    year: 2026,
    aliases: [],
  };
  const season: TrackedSeason = {
    id: `season_${suffix}_1`,
    mediaTitleId: title.id,
    seasonNumber: 1,
    status: "active",
    qualityPreference: "4K",
    storageDirectoryId: `dir_${suffix}_s1`,
    totalEpisodes: 2,
    latestAiredEpisode: 2,
    latestAiredSource: "metadata",
  };
  return { title, season };
}

function verifiedFile(directoryId: string, id: string, code: string): VerifiedFile {
  return {
    id,
    storageDirectoryId: directoryId,
    name: `Show.${code}.mkv`,
    sizeBytes: 1_000_000_000,
    episodeCode: code,
    providerFileId: `provider_${id}`,
  };
}

async function seedTrackedSeason(input: {
  repository: InMemoryWorkflowRepository;
  title: MediaTitle;
  season: TrackedSeason;
  obtainedCodes: string[];
}) {
  const files = input.obtainedCodes.map((code, index) =>
    verifiedFile(input.season.storageDirectoryId, `seed_${index}`, code),
  );
  const episodes = reconcileVerifiedFiles({
    season: input.season,
    episodes: createEpisodeStates({
      trackedSeasonId: input.season.id,
      seasonNumber: input.season.seasonNumber,
      totalEpisodes: input.season.totalEpisodes,
      latestAiredEpisode: input.season.latestAiredEpisode,
    }),
    files,
  });
  await input.repository.saveWorkflowRunSnapshot({
    title: input.title,
    season: input.season,
    workflowRun: {
      id: `seed_${input.season.id}`,
      kind: "type2_init",
      status: "succeeded",
      trackedSeasonId: input.season.id,
      startedAt: fixedNow(),
      finishedAt: fixedNow(),
      auditEvents: [],
    },
    episodes,
    resourceSnapshots: [],
    decisions: [],
    transferAttempts: [],
    notifications: [],
  });
}

/**
 * Pre-create the canonical V2 directory tree (`Title (Year)/Season NN`) under
 * the category parent and seed the season directory with the files a previous
 * run already landed — the V2 workflow verify-or-creates this same tree and
 * syncs against it, ignoring the tracked season's stored storageDirectoryId.
 */
async function seedV2Season(
  storage: FakeStorageExecutor,
  title: MediaTitle,
  season: TrackedSeason,
  presentCodes: string[],
): Promise<string> {
  const showDir = await storage.createDirectory({ name: `${title.title} (${title.year})`, parentId: "library_root" });
  const seasonDir = await storage.createDirectory({
    name: `Season ${String(season.seasonNumber).padStart(2, "0")}`,
    parentId: showDir,
  });
  storage.seedDirectoryFiles(
    seasonDir,
    presentCodes.map((code, index) => verifiedFile(seasonDir, `present_${code}_${index}`, code)),
  );
  return seasonDir;
}

describe("runScheduledType3Monitoring (V2 engine)", () => {
  it("returns an empty outcome list when nothing is tracked", async () => {
    const outcomes = await runScheduledType3Monitoring({
      repository: new InMemoryWorkflowRepository(),
      resourceProvider: emptyProvider(),
      storage: new FakeStorageExecutor(),
      model: throwingModel(),
      storageParentDirectoryId: "library_root",
      now: fixedNow,
    });

    expect(outcomes).toEqual([]);
  });

  it("detects a real gap, runs the agent over the sandbox, and persists a type3_monitor run", async () => {
    const repository = new InMemoryWorkflowRepository();
    const { title, season } = trackedFixture();
    await seedTrackedSeason({ repository, title, season, obtainedCodes: ["S01E01", "S01E02"] });
    const storage = new FakeStorageExecutor();
    await seedV2Season(storage, title, season, ["S01E01"]); // external mutation: E02 gone

    const outcomes = await runScheduledType3Monitoring({
      repository,
      resourceProvider: emptyProvider(),
      storage,
      model: noCoverageModel(),
      storageParentDirectoryId: "library_root",
      now: fixedNow,
      createWorkflowRunId: () => "run_sched_type3",
    });

    expect(outcomes[0]).toMatchObject({ trackedSeasonId: season.id, status: "ran", workflowRunId: "run_sched_type3" });
    const saved = await repository.getWorkflowRunSnapshot("run_sched_type3");
    expect(saved?.workflowRun.kind).toBe("type3_monitor");
  });

  it("reserves nothing once mayStartRun says no, even if it said yes when the sweep began", async () => {
    const repository = new InMemoryWorkflowRepository();
    const { title, season } = trackedFixture();
    await seedTrackedSeason({ repository, title, season, obtainedCodes: ["S01E01", "S01E02"] });
    const storage = new FakeStorageExecutor();
    await seedV2Season(storage, title, season, ["S01E01"]);
    // The hold is taken while the sweep is still setting up: only the check right
    // before the reservation sees it.
    let calls = 0;
    const outcomes = await runScheduledType3Monitoring({
      repository,
      resourceProvider: emptyProvider(),
      storage,
      model: noCoverageModel(),
      storageParentDirectoryId: "library_root",
      now: fixedNow,
      createWorkflowRunId: () => "run_held_patrol",
      mayStartRun: () => {
        calls += 1;
        return false;
      },
    });

    expect(calls).toBeGreaterThan(0);
    expect(outcomes).toEqual([{ trackedSeasonId: season.id, status: "skipped_active" }]);
    expect(await repository.getWorkflowRunSnapshot("run_held_patrol")).toBeNull();
  });

  it("persists staging_leaked on the FAILED type3 run when the agent dies and the staging dir survives cleanup", async () => {
    // The patrol's inline catch builds the failed run's audit events by hand; a
    // leak carried on the error must land there too (Copilot #260 r1).
    class SilentNoopDeleteExecutor extends FakeStorageExecutor {
      override async removeDirectory(): Promise<{ removed: boolean }> {
        return { removed: true };
      }
    }
    const repository = new InMemoryWorkflowRepository();
    const { title, season } = trackedFixture();
    // 实有 = the DB marks: E01 only → E02 is a real gap → the agent runs → it throws.
    await seedTrackedSeason({ repository, title, season, obtainedCodes: ["S01E01"] });
    const storage = new SilentNoopDeleteExecutor();
    await seedV2Season(storage, title, season, ["S01E01"]);

    const outcomes = await runScheduledType3Monitoring({
      repository,
      resourceProvider: emptyProvider(),
      storage,
      model: throwingModel(),
      storageParentDirectoryId: "library_root",
      now: fixedNow,
      createWorkflowRunId: () => "run_leak_type3",
    });

    expect(outcomes[0]).toMatchObject({ status: "failed", workflowRunId: "run_leak_type3" });
    const saved = await repository.getWorkflowRunSnapshot("run_leak_type3");
    expect(saved?.workflowRun.status).toBe("failed");
    const leak = saved?.workflowRun.auditEvents.find((event) => event.type === "staging_leaked");
    expect(leak).toBeDefined();
    expect(String(leak?.data?.stagingDirectoryId)).toContain("staging-run_leak_type3");
    expect(leak?.data?.showDirectoryId).toBeTruthy(); // same shape as the success path
  });

  it("syncs against fresh TMDB metadata so episodes that aired after tracking began become the need", async () => {
    const repository = new InMemoryWorkflowRepository();
    const { title } = trackedFixture("airing");
    const season: TrackedSeason = { ...trackedFixture("airing").season, totalEpisodes: 4, latestAiredEpisode: 2 };
    await seedTrackedSeason({ repository, title, season, obtainedCodes: ["S01E01", "S01E02"] });
    const storage = new FakeStorageExecutor();
    await seedV2Season(storage, title, season, ["S01E01", "S01E02"]);

    const outcomes = await runScheduledType3Monitoring({
      repository,
      resourceProvider: emptyProvider(),
      storage,
      model: noCoverageModel(),
      storageParentDirectoryId: "library_root",
      now: fixedNow,
      createWorkflowRunId: () => "run_sync_type3",
      // TMDB now reports episode 4 as the latest aired.
      syncSeasonMetadata: async () => ({ latestAiredEpisode: 4, totalEpisodes: 4 }),
    });

    expect(outcomes[0]).toMatchObject({ trackedSeasonId: season.id, status: "ran" });
    const saved = await repository.getWorkflowRunSnapshot("run_sync_type3");
    // The sync refreshed the season's aired cursor so E03/E04 became the need.
    expect(saved?.season.latestAiredEpisode).toBe(4);
  });

  it("records a no-op run when a tracked season is already current — the agent model is never invoked", async () => {
    const repository = new InMemoryWorkflowRepository();
    const { title, season } = trackedFixture();
    await seedTrackedSeason({ repository, title, season, obtainedCodes: ["S01E01", "S01E02"] });
    const storage = new FakeStorageExecutor();
    await seedV2Season(storage, title, season, ["S01E01", "S01E02"]); // all aired present

    const outcomes = await runScheduledType3Monitoring({
      repository,
      resourceProvider: emptyProvider(),
      storage,
      model: throwingModel(), // must NOT be invoked on a no-op
      storageParentDirectoryId: "library_root",
      now: fixedNow,
      createWorkflowRunId: () => "run_noop_type3",
    });

    expect(outcomes).toEqual([
      { trackedSeasonId: season.id, status: "ran", workflowRunId: "run_noop_type3", workflowStatus: "succeeded" },
    ]);
  });

  it("no-op patrol of a still-airing season persists an already_current notification (routine, folds in UI)", async () => {
    const repository = new InMemoryWorkflowRepository();
    const { title, season } = trackedFixture();
    // Still airing: 2 of 3 episodes aired, both already obtained — nothing to do.
    season.totalEpisodes = 3;
    season.latestAiredEpisode = 2;
    await seedTrackedSeason({ repository, title, season, obtainedCodes: ["S01E01", "S01E02"] });
    const storage = new FakeStorageExecutor();
    await seedV2Season(storage, title, season, ["S01E01", "S01E02"]);

    await runScheduledType3Monitoring({
      repository,
      resourceProvider: emptyProvider(),
      storage,
      model: throwingModel(), // no gap → the agent must never be invoked
      storageParentDirectoryId: "library_root",
      now: fixedNow,
      createWorkflowRunId: () => "run_airing_noop",
    });

    const notifications = await repository.listNotifications();
    const patrol = notifications.filter((notification) => notification.workflowRunId === "run_airing_noop");
    expect(patrol).toHaveLength(1);
    expect(patrol[0]!.kind).toBe("already_current");
    expect(patrol[0]!.trigger).toBe("scheduled");
    expect(patrol[0]!.report?.status).toBe("airing");
  });

  it("skips a season that already has an active workflow run", async () => {
    const repository = new InMemoryWorkflowRepository();
    const { title, season } = trackedFixture();
    await seedTrackedSeason({ repository, title, season, obtainedCodes: [] });
    await repository.saveWorkflowRunSnapshot({
      title,
      season,
      workflowRun: {
        id: "active_run",
        kind: "type3_monitor",
        status: "running",
        trackedSeasonId: season.id,
        startedAt: fixedNow(),
        finishedAt: null,
        auditEvents: [],
      },
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

    const outcomes = await runScheduledType3Monitoring({
      repository,
      resourceProvider: emptyProvider(),
      storage: new FakeStorageExecutor(),
      model: throwingModel(),
      storageParentDirectoryId: "library_root",
      now: fixedNow,
    });

    expect(outcomes).toEqual([{ trackedSeasonId: season.id, status: "skipped_active" }]);
  });

  it("patrols a tracked-but-unobtained movie by dispatching the movie agent (by title.type)", async () => {
    const repository = new InMemoryWorkflowRepository();
    const movie: MediaTitle = {
      id: "tmdb_movie_872585",
      tmdbId: 872585,
      type: "movie",
      title: "奥本海默",
      originalTitle: "Oppenheimer",
      year: 2023,
      aliases: ["Oppenheimer"],
    };
    // A movie tracked via 获取 that found no resource (已上映无源): one unobtained
    // anchor episode, season status completed (movie convention).
    await repository.saveWorkflowRunSnapshot({
      title: movie,
      season: {
        id: `${movie.id}_movie`,
        mediaTitleId: movie.id,
        seasonNumber: 1,
        status: "completed",
        qualityPreference: "4K",
        storageDirectoryId: "",
        totalEpisodes: 1,
        latestAiredEpisode: 1,
        latestAiredSource: "manual",
      },
      workflowRun: {
        id: "seed_movie",
        kind: "movie_init",
        status: "no_coverage",
        trackedSeasonId: `${movie.id}_movie`,
        startedAt: fixedNow(),
        finishedAt: fixedNow(),
        auditEvents: [],
      },
      episodes: createEpisodeStates({ trackedSeasonId: `${movie.id}_movie`, seasonNumber: 1, totalEpisodes: 1, latestAiredEpisode: 1 }),
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });

    const outcomes = await runScheduledType3Monitoring({
      repository,
      resourceProvider: emptyProvider(),
      storage: new FakeStorageExecutor(),
      model: noCoverageModel(),
      storageParentDirectoryId: "tv_root",
      moviesParentDirectoryId: "movies_root",
      now: fixedNow,
      createWorkflowRunId: () => "run_movie_patrol",
    });

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ trackedSeasonId: `${movie.id}_movie`, status: "ran", workflowRunId: "run_movie_patrol" });
    const saved = await repository.getWorkflowRunSnapshot("run_movie_patrol");
    expect(saved?.workflowRun.kind).toBe("movie_init");

    const held = await runScheduledType3Monitoring({
      repository,
      resourceProvider: emptyProvider(),
      storage: new FakeStorageExecutor(),
      model: noCoverageModel(),
      storageParentDirectoryId: "tv_root",
      moviesParentDirectoryId: "movies_root",
      now: fixedNow,
      createWorkflowRunId: () => "run_movie_held",
      mayStartRun: () => false,
    });
    expect(held).toEqual([{ trackedSeasonId: `${movie.id}_movie`, status: "skipped_active" }]);
    expect(await repository.getWorkflowRunSnapshot("run_movie_held")).toBeNull();
  });

  it("a movie patrol is skipped_active when a replace_request for the film is reserved after the sweep's filter", async () => {
    const repository = new InMemoryWorkflowRepository();
    const movie: MediaTitle = {
      id: "tmdb_movie_872585", tmdbId: 872585, type: "movie", title: "奥本海默", originalTitle: "Oppenheimer", year: 2023, aliases: [],
    };
    const season = {
      id: `${movie.id}_movie`, mediaTitleId: movie.id, seasonNumber: 1, status: "completed" as const, qualityPreference: "4K" as const,
      storageDirectoryId: "", totalEpisodes: 1, latestAiredEpisode: 1, latestAiredSource: "manual" as const,
    };
    const episodes = createEpisodeStates({ trackedSeasonId: season.id, seasonNumber: 1, totalEpisodes: 1, latestAiredEpisode: 1 });
    const empty = { resourceSnapshots: [], decisions: [], transferAttempts: [], notifications: [] };
    await repository.saveWorkflowRunSnapshot({
      title: movie, season, episodes, ...empty,
      workflowRun: { id: "seed_movie", kind: "movie_init", status: "no_coverage", trackedSeasonId: season.id, startedAt: fixedNow(), finishedAt: fixedNow(), auditEvents: [] },
    });
    const reserve = repository.reserveWorkflowRun.bind(repository);
    repository.reserveWorkflowRun = async (input) => {
      if (input.workflowRun.kind === "movie_init") {
        await reserve({
          title: movie, season, episodes, ...empty, blockIfTitleHasActiveRun: true,
          workflowRun: { id: "run_replace_late", kind: "replace_request", status: "queued", trackedSeasonId: season.id, startedAt: fixedNow(), finishedAt: null, auditEvents: [] },
        });
      }
      return reserve(input);
    };

    const outcomes = await runScheduledType3Monitoring({
      repository,
      resourceProvider: emptyProvider(),
      storage: new FakeStorageExecutor(),
      model: noCoverageModel(),
      storageParentDirectoryId: "tv_root",
      moviesParentDirectoryId: "movies_root",
      now: fixedNow,
      createWorkflowRunId: () => "run_movie_patrol",
    });

    expect(outcomes).toEqual([{ trackedSeasonId: season.id, status: "skipped_active" }]);
    expect(await repository.getWorkflowRunSnapshot("run_movie_patrol")).toBeNull();
  });

  it("a movie patrol is skipped_active when a staging_recovery for the film is reserved after the sweep's filter", async () => {
    const repository = new InMemoryWorkflowRepository();
    const movie: MediaTitle = {
      id: "tmdb_movie_872585", tmdbId: 872585, type: "movie", title: "奥本海默", originalTitle: "Oppenheimer", year: 2023, aliases: [],
    };
    const season = {
      id: `${movie.id}_movie`, mediaTitleId: movie.id, seasonNumber: 1, status: "completed" as const, qualityPreference: "4K" as const,
      storageDirectoryId: "", totalEpisodes: 1, latestAiredEpisode: 1, latestAiredSource: "manual" as const,
    };
    const episodes = createEpisodeStates({ trackedSeasonId: season.id, seasonNumber: 1, totalEpisodes: 1, latestAiredEpisode: 1 });
    const empty = { resourceSnapshots: [], decisions: [], transferAttempts: [], notifications: [] };
    await repository.saveWorkflowRunSnapshot({
      title: movie, season, episodes, ...empty,
      workflowRun: { id: "seed_movie", kind: "movie_init", status: "no_coverage", trackedSeasonId: season.id, startedAt: fixedNow(), finishedAt: fixedNow(), auditEvents: [] },
    });
    const reserve = repository.reserveWorkflowRun.bind(repository);
    repository.reserveWorkflowRun = async (input) => {
      if (input.workflowRun.kind === "movie_init") {
        await reserve({
          title: movie, season, episodes, ...empty,
          workflowRun: {
            id: "run_recovery_late",
            kind: "staging_recovery",
            status: "queued",
            trackedSeasonId: season.id,
            startedAt: fixedNow(),
            finishedAt: null,
            auditEvents: [
              {
                type: "staging_recovery_queued",
                message: "queued",
                data: { stagingDirectoryId: "stg-film", showDirectoryId: "film-dir", seasonNumbers: [1] },
              },
            ],
          },
        });
      }
      return reserve(input);
    };

    const outcomes = await runScheduledType3Monitoring({
      repository,
      resourceProvider: emptyProvider(),
      storage: new FakeStorageExecutor(),
      model: noCoverageModel(),
      storageParentDirectoryId: "tv_root",
      moviesParentDirectoryId: "movies_root",
      now: fixedNow,
      createWorkflowRunId: () => "run_movie_patrol",
    });

    expect(outcomes).toEqual([{ trackedSeasonId: season.id, status: "skipped_active" }]);
    expect(await repository.getWorkflowRunSnapshot("run_movie_patrol")).toBeNull();
    expect((await repository.listActiveWorkflowRuns()).map((run) => run.workflowRun.id)).toEqual(["run_recovery_late"]);
  });

  it("a show untracked after the sweep read it (before its patrol reservation) stays untracked: the patrol skips it", async () => {
    const repository = new InMemoryWorkflowRepository();
    const { title, season } = trackedFixture();
    // E02 is a real gap, so the patrol would run the agent.
    await seedTrackedSeason({ repository, title, season, obtainedCodes: ["S01E01"] });
    const untracked: unknown[] = [];
    const reserve = repository.reserveWorkflowRun.bind(repository);
    repository.reserveWorkflowRun = async (input) => {
      if (input.workflowRun.kind === "type3_monitor") {
        // The user untracks it while the sweep resolves the drive and syncs TMDB.
        untracked.push(await repository.untrackTitle(title.tmdbId, { accountId: "acct_default", connectedStorageId: null }, "tv"));
      }
      return reserve(input);
    };

    const outcomes = await runScheduledType3Monitoring({
      repository,
      resourceProvider: emptyProvider(),
      storage: new FakeStorageExecutor(),
      model: throwingModel(),
      storageParentDirectoryId: "library_root",
      now: fixedNow,
      createWorkflowRunId: () => "run_patrol_untracked",
    });

    expect(untracked).toEqual([{ status: "untracked", removedSeasons: 1 }]);
    expect(outcomes).toEqual([{ trackedSeasonId: season.id, status: "skipped_untracked" }]);
    expect(await repository.listAllTrackedSeasonStates()).toEqual([]);
    expect(await repository.getWorkflowRunSnapshot("run_patrol_untracked")).toBeNull();
  });

  it("a film untracked after the sweep read it (before its patrol reservation) stays untracked: the patrol skips it", async () => {
    const repository = new InMemoryWorkflowRepository();
    const movie: MediaTitle = {
      id: "tmdb_movie_872585", tmdbId: 872585, type: "movie", title: "奥本海默", originalTitle: "Oppenheimer", year: 2023, aliases: [],
    };
    const season = {
      id: `${movie.id}_movie`, mediaTitleId: movie.id, seasonNumber: 1, status: "completed" as const, qualityPreference: "4K" as const,
      storageDirectoryId: "", totalEpisodes: 1, latestAiredEpisode: 1, latestAiredSource: "manual" as const,
    };
    await repository.saveWorkflowRunSnapshot({
      title: movie,
      season,
      episodes: createEpisodeStates({ trackedSeasonId: season.id, seasonNumber: 1, totalEpisodes: 1, latestAiredEpisode: 1 }),
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
      workflowRun: { id: "seed_movie", kind: "movie_init", status: "no_coverage", trackedSeasonId: season.id, startedAt: fixedNow(), finishedAt: fixedNow(), auditEvents: [] },
    });
    const untracked: unknown[] = [];
    const reserve = repository.reserveWorkflowRun.bind(repository);
    repository.reserveWorkflowRun = async (input) => {
      if (input.workflowRun.kind === "movie_init") {
        untracked.push(await repository.untrackTitle(movie.tmdbId, { accountId: "acct_default", connectedStorageId: null }, "movie"));
      }
      return reserve(input);
    };

    const outcomes = await runScheduledType3Monitoring({
      repository,
      resourceProvider: emptyProvider(),
      storage: new FakeStorageExecutor(),
      model: throwingModel(),
      storageParentDirectoryId: "tv_root",
      moviesParentDirectoryId: "movies_root",
      now: fixedNow,
      createWorkflowRunId: () => "run_movie_patrol_untracked",
    });

    expect(untracked).toEqual([{ status: "untracked", removedSeasons: 1 }]);
    expect(outcomes).toEqual([{ trackedSeasonId: season.id, status: "skipped_untracked" }]);
    expect(await repository.listAllTrackedSeasonStates()).toEqual([]);
    expect(await repository.getWorkflowRunSnapshot("run_movie_patrol_untracked")).toBeNull();
  });

  it("does NOT patrol a reserved film whose release date is still in the future (air-time gate)", async () => {
    const repository = new InMemoryWorkflowRepository();
    await reserveMovie({
      title: {
        id: "tmdb_movie_999",
        tmdbId: 999,
        type: "movie",
        title: "未上映大片",
        originalTitle: "Future Blockbuster",
        year: 2026,
        releaseDate: "2026-12-25", // after fixedNow (2026-06-12) → unreleased
        aliases: [],
      },
      repository,
      createWorkflowRunId: () => "run_reserved",
      now: fixedNow,
    });

    const outcomes = await runScheduledType3Monitoring({
      repository,
      resourceProvider: emptyProvider(),
      storage: new FakeStorageExecutor(),
      model: noCoverageModel(),
      storageParentDirectoryId: "tv_root",
      moviesParentDirectoryId: "movies_root",
      now: fixedNow,
      createWorkflowRunId: () => "run_should_not_exist",
    });

    expect(outcomes).toEqual([]); // skipped — the agent never runs before release
    expect(await repository.getWorkflowRunSnapshot("run_should_not_exist")).toBeNull();
  });

  it("patrols a reserved film ONCE its release date has arrived (auto-collect at release)", async () => {
    const repository = new InMemoryWorkflowRepository();
    await reserveMovie({
      title: {
        id: "tmdb_movie_998",
        tmdbId: 998,
        type: "movie",
        title: "刚上映",
        originalTitle: "Just Released",
        year: 2026,
        releaseDate: "2026-01-01", // before fixedNow (2026-06-12) → released, collect it
        aliases: [],
      },
      repository,
      createWorkflowRunId: () => "run_reserved",
      now: fixedNow,
    });

    const outcomes = await runScheduledType3Monitoring({
      repository,
      resourceProvider: emptyProvider(),
      storage: new FakeStorageExecutor(),
      model: noCoverageModel(),
      storageParentDirectoryId: "tv_root",
      moviesParentDirectoryId: "movies_root",
      now: fixedNow,
      createWorkflowRunId: () => "run_release_patrol",
    });

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ status: "ran", workflowRunId: "run_release_patrol" });
  });

  it("does not patrol an already-obtained movie", async () => {
    const repository = new InMemoryWorkflowRepository();
    const movie: MediaTitle = {
      id: "tmdb_movie_1",
      tmdbId: 1,
      type: "movie",
      title: "Done Movie",
      originalTitle: "Done Movie",
      year: 2020,
      aliases: [],
    };
    const obtainedEpisode = createEpisodeStates({ trackedSeasonId: `${movie.id}_movie`, seasonNumber: 1, totalEpisodes: 1, latestAiredEpisode: 1 }).map(
      (episode) => ({ ...episode, obtained: true }),
    );
    await repository.saveWorkflowRunSnapshot({
      title: movie,
      season: {
        id: `${movie.id}_movie`,
        mediaTitleId: movie.id,
        seasonNumber: 1,
        status: "completed",
        qualityPreference: "4K",
        storageDirectoryId: "movies_root_done",
        totalEpisodes: 1,
        latestAiredEpisode: 1,
        latestAiredSource: "manual",
      },
      workflowRun: {
        id: "seed_done_movie",
        kind: "movie_init",
        status: "succeeded",
        trackedSeasonId: `${movie.id}_movie`,
        startedAt: fixedNow(),
        finishedAt: fixedNow(),
        auditEvents: [],
      },
      episodes: obtainedEpisode,
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });

    const outcomes = await runScheduledType3Monitoring({
      repository,
      resourceProvider: emptyProvider(),
      storage: new FakeStorageExecutor(),
      model: throwingModel(), // must not run for an already-obtained movie
      storageParentDirectoryId: "tv_root",
      moviesParentDirectoryId: "movies_root",
      now: fixedNow,
    });

    expect(outcomes).toEqual([]);
  });

  it("isolates one season's failure and continues with the next", async () => {
    const repository = new InMemoryWorkflowRepository();
    const broken = trackedFixture("broken");
    const healthy = trackedFixture("healthy");
    await seedTrackedSeason({ repository, title: broken.title, season: broken.season, obtainedCodes: ["S01E01"] });
    // Healthy season's DB marks cover all aired (实有 = aired) → a true no-op, the
    // agent is never invoked. (实有 is the DB marks now, not a 115 scan.)
    await seedTrackedSeason({ repository, title: healthy.title, season: healthy.season, obtainedCodes: ["S01E01", "S01E02"] });
    const storage = new FakeStorageExecutor();
    await seedV2Season(storage, broken.title, broken.season, []); // gap → agent runs → model dies
    await seedV2Season(storage, healthy.title, healthy.season, ["S01E01", "S01E02"]); // current → no-op
    let counter = 0;

    const outcomes = await runScheduledType3Monitoring({
      repository,
      resourceProvider: emptyProvider(),
      storage,
      model: throwingModel(),
      storageParentDirectoryId: "library_root",
      now: fixedNow,
      createWorkflowRunId: () => `run_multi_${(counter += 1)}`,
    });

    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]).toMatchObject({
      trackedSeasonId: broken.season.id,
      status: "failed",
      errorMessage: "agent model unavailable",
    });
    expect(outcomes[1]).toMatchObject({ trackedSeasonId: healthy.season.id, status: "ran", workflowStatus: "succeeded" });
    const failed = await repository.getWorkflowRunSnapshot("run_multi_1");
    expect(failed?.workflowRun.status).toBe("failed");
  });
});

describe("runScheduledType3Monitoring — maxConcurrentRuns", () => {
  /** Three gapped shows: two on drive A, one on drive B. The model holds every call
   *  until the test counts who is in flight, so overlap is observed, not inferred. */
  async function threeShowsOnTwoDrives(drives: Array<string | null> = ["drive_A", "drive_A", "drive_B"]) {
    const repository = new InMemoryWorkflowRepository();
    const storage = new FakeStorageExecutor();
    const shows = [
      { ...trackedFixture("a1"), drive: drives[0]! },
      { ...trackedFixture("a2"), drive: drives[1]! },
      { ...trackedFixture("b1"), drive: drives[2]! },
    ];
    for (const show of shows) {
      await repository.saveWorkflowRunSnapshot({
        ...(show.drive === null ? {} : { connectedStorageId: show.drive }),
        title: show.title,
        season: show.season,
        workflowRun: {
          id: `seed_${show.season.id}`,
          kind: "type2_init",
          status: "succeeded",
          trackedSeasonId: show.season.id,
          startedAt: fixedNow(),
          finishedAt: fixedNow(),
          auditEvents: [],
        },
        episodes: createEpisodeStates({ trackedSeasonId: show.season.id, seasonNumber: 1, totalEpisodes: 2, latestAiredEpisode: 2 }),
        resourceSnapshots: [],
        decisions: [],
        transferAttempts: [],
        notifications: [],
      });
      await seedV2Season(storage, show.title, show.season, []);
    }
    return { repository, storage, shows };
  }

  /** Every call fails after a short wait; records the peak number of calls in flight
   *  and which titles overlapped. */
  function slowFailingModel() {
    let inFlight = 0;
    const seen = { peak: 0, pairs: new Set<string>() };
    const active = new Set<string>();
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        const prompt = JSON.stringify(options.prompt);
        const title = /Show (a1|a2|b1)/.exec(prompt)?.[1] ?? "?";
        inFlight += 1;
        active.add(title);
        seen.peak = Math.max(seen.peak, inFlight);
        for (const other of active) if (other !== title) seen.pairs.add([title, other].sort().join("+"));
        await new Promise((resolve) => setTimeout(resolve, 20));
        active.delete(title);
        inFlight -= 1;
        throw new Error("agent model unavailable");
      },
    });
    return { model, seen };
  }

  it("runs different drives side by side but keeps one drive's shows one after another", async () => {
    const { repository, storage } = await threeShowsOnTwoDrives();
    const { model, seen } = slowFailingModel();
    let counter = 0;
    const outcomes = await runScheduledType3Monitoring({
      repository, resourceProvider: emptyProvider(), storage, model,
      storageParentDirectoryId: "library_root", now: fixedNow,
      createWorkflowRunId: () => `run_par_${(counter += 1)}`,
      maxConcurrentRuns: 3,
    });
    expect(outcomes.map((o) => o.status)).toEqual(["failed", "failed", "failed"]);
    // Limit 3, but a1 and a2 share drive A: at most two shows at once, and a1/a2 never together.
    expect(seen.peak).toBe(2);
    expect(seen.pairs.has("a1+a2")).toBe(false);
    expect([...seen.pairs].some((pair) => pair.includes("b1"))).toBe(true);
  });

  it("an unbound show shares its account's default drive with shows bound to that drive", async () => {
    // a1 has no drive and lands on the account default (drive_A) — it must not run
    // beside a2, which is bound to drive_A explicitly.
    const { repository, storage } = await threeShowsOnTwoDrives([null, "drive_A", "drive_B"]);
    const { model, seen } = slowFailingModel();
    let counter = 0;
    await runScheduledType3Monitoring({
      repository, resourceProvider: emptyProvider(), storage, model,
      storageParentDirectoryId: "library_root", now: fixedNow,
      createWorkflowRunId: () => `run_def_${(counter += 1)}`,
      maxConcurrentRuns: 3,
      resolveDriveId: async () => "drive_A",
    });
    expect(seen.pairs.has("a1+a2")).toBe(false);
    expect([...seen.pairs].some((pair) => pair.includes("b1"))).toBe(true);
  });

  it("accounts with no drive at all share the one fallback drive", async () => {
    const { repository, storage, shows } = await threeShowsOnTwoDrives([null, null, "drive_B"]);
    // Move a2 to a second account; both a1 and a2 have no drive anywhere.
    const listAll = repository.listAllTrackedSeasonStates.bind(repository);
    repository.listAllTrackedSeasonStates = async () =>
      (await listAll()).map((state) => (state.title.id === shows[1]!.title.id ? { ...state, accountId: "acct_other" } : state));
    const { model, seen } = slowFailingModel();
    let counter = 0;
    await runScheduledType3Monitoring({
      repository, resourceProvider: emptyProvider(), storage, model,
      storageParentDirectoryId: "library_root", now: fixedNow,
      createWorkflowRunId: () => `run_nod_${(counter += 1)}`,
      maxConcurrentRuns: 3,
      resolveDriveId: async () => null,
    });
    expect(seen.pairs.has("a1+a2")).toBe(false);
  });

  it("defaults to one show at a time", async () => {
    const { repository, storage } = await threeShowsOnTwoDrives();
    const { model, seen } = slowFailingModel();
    let counter = 0;
    await runScheduledType3Monitoring({
      repository, resourceProvider: emptyProvider(), storage, model,
      storageParentDirectoryId: "library_root", now: fixedNow,
      createWorkflowRunId: () => `run_ser_${(counter += 1)}`,
    });
    expect(seen.peak).toBe(1);
  });
});

/**
 * Chain guard (2026-09-20). The live A/B ran with the prefilter ON and still
 * persisted `prefilter: null`: worker.ts spreads `jevJudge` into runner-v2's
 * persist input, whose type never declared it — TypeScript does not
 * excess-property-check spread expressions, so the judge was silently dropped
 * one hop below the worker. These tests therefore enter at the WORKER entry
 * point (not at runAcquisitionV2Workflow) so every hop is covered.
 */
describe("runScheduledType3Monitoring — the Jev prefilter reaches the engine", () => {
  it("runs the per-account judge over the patrol's candidates (worker → runner-v2 → run-tv-v2 → workflow)", async () => {
    const repository = new InMemoryWorkflowRepository();
    const { title, season } = trackedFixture();
    // A REAL need (E02 aired, never obtained) — a patrol with nothing to fetch
    // short-circuits before the engine searches, and would never reach a judge.
    await seedTrackedSeason({ repository, title, season, obtainedCodes: ["S01E01"] });
    const storage = new FakeStorageExecutor();
    await seedV2Season(storage, title, season, ["S01E01"]);

    const seen: JevJudgeInput[] = [];
    const jevJudge: JevJudge = {
      judgeCandidates: async (input) => {
        seen.push(input);
        return { scores: {}, model: "m" };
      },
    };

    await runScheduledType3Monitoring({
      repository,
      // Keyed on the bare title: that is the keyword the engine pre-warms with.
      resourceProvider: new FakeResourceProvider({
        keywordResults: { [title.title]: [{ title: `${title.title} S01 2160p WEB-DL` }] },
      }),
      storage,
      model: noCoverageModel(),
      storageParentDirectoryId: "library_root",
      now: fixedNow,
      createWorkflowRunId: () => "run_jev_type3",
      resolveAccountContext: async () => ({ jevJudge }),
    });

    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]!.target.kind).toBe("tv");
  });
});

describe("runScheduledType3Monitoring — agent memory reaches the engine", () => {
  it("injects the show's title memory under tmdb_tv_<id> (worker → runner-v2 → run-tv-v2 → workflow)", async () => {
    const repository = new InMemoryWorkflowRepository();
    const { title, season } = trackedFixture();
    await seedTrackedSeason({ repository, title, season, obtainedCodes: ["S01E01"] });
    await repository.upsertAgentMemory({
      accountId: "acct_default",
      titleKey: `tmdb_tv_${title.tmdbId}`,
      entry: { scope: "title", name: "prior-lesson", description: "上次的经验", kind: "search", body: "TV-MEMORY-SENTINEL" },
      now: fixedNow(),
    });
    const storage = new FakeStorageExecutor();
    await seedV2Season(storage, title, season, ["S01E01"]);
    const systems: string[] = [];
    const inner = noCoverageModel();
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        systems.push(JSON.stringify(options.prompt.find((m) => m.role === "system") ?? ""));
        return inner.doGenerate(options);
      },
    });
    await runScheduledType3Monitoring({
      repository,
      resourceProvider: new FakeResourceProvider({ keywordResults: { [title.title]: [{ title: `${title.title} S01 2160p WEB-DL` }] } }),
      storage,
      model,
      storageParentDirectoryId: "library_root",
      now: fixedNow,
      createWorkflowRunId: () => "run_mem_type3",
    });
    expect(systems[0]).toContain("TV-MEMORY-SENTINEL");
  });
});

describe("runScheduledType3Monitoring — user requests", () => {
  // seedTrackedSeason saves under the default account with no bound drive.
  const WORK = { accountId: "acct_default", drive: "", titleKey: "title_show" };

  async function completeShow() {
    const repository = new InMemoryWorkflowRepository();
    const { title, season } = trackedFixture();
    await seedTrackedSeason({ repository, title, season, obtainedCodes: ["S01E01", "S01E02"] });
    const storage = new FakeStorageExecutor();
    await seedV2Season(storage, title, season, ["S01E01", "S01E02"]);
    return { repository, storage, season };
  }

  async function patrol(repository: InMemoryWorkflowRepository, storage: FakeStorageExecutor) {
    let n = 0;
    return runScheduledType3Monitoring({
      repository,
      resourceProvider: emptyProvider(),
      storage,
      model: throwingModel(),
      storageParentDirectoryId: "library_root",
      now: fixedNow,
      createWorkflowRunId: () => `run_patrol_${(n += 1)}`,
    });
  }

  it("a pending (non-urgent) message queues a replace_request and skips the work's ordinary patrol", async () => {
    const { repository, storage, season } = await completeShow();
    await repository.createUserMessage({ ...WORK, body: "第 1 集发蓝", episodeTags: ["S01E01"], now: fixedNow() });

    const outcomes = await patrol(repository, storage);

    expect(outcomes.filter((o) => o.trackedSeasonId === season.id)).toEqual([]);
    const active = await repository.listActiveWorkflowRuns();
    expect(active.map((run) => [run.workflowRun.kind, run.workflowRun.status, run.title.id])).toEqual([
      ["replace_request", "queued", "title_show"],
    ]);
    expect(await repository.getWorkflowRunSnapshot("run_patrol_2")).toBeNull();
    // The message itself waits for the run; the patrol does not claim it.
    expect((await repository.listUserMessages(WORK))[0]?.status).toBe("pending");
  });

  it("an episode still 待换 from an earlier run (no message) queues a replace_request too", async () => {
    const { repository, storage, season } = await completeShow();
    await repository.addPendingReplacements({ ...WORK, episodes: ["S01E02"], messageId: "msg_old", now: fixedNow() });

    const outcomes = await patrol(repository, storage);

    expect(outcomes.filter((o) => o.trackedSeasonId === season.id)).toEqual([]);
    expect((await repository.listActiveWorkflowRuns()).map((run) => run.workflowRun.kind)).toEqual(["replace_request"]);
  });

  it("no message and nothing 待换 → the patrol is unchanged (no replace_request)", async () => {
    const { repository, storage, season } = await completeShow();

    const outcomes = await patrol(repository, storage);

    expect(outcomes).toEqual([
      expect.objectContaining({ trackedSeasonId: season.id, status: "ran", workflowRunId: "run_patrol_1" }),
    ]);
    expect((await repository.getWorkflowRunSnapshot("run_patrol_1"))?.workflowRun.kind).toBe("type3_monitor");
    expect(await repository.listActiveWorkflowRuns()).toEqual([]);
  });

  it("a work whose replace run is in flight (messages processing) is not patrolled alongside it", async () => {
    const { repository, storage, season } = await completeShow();
    await repository.createUserMessage({ ...WORK, body: "第 1 集发蓝", episodeTags: ["S01E01"], now: fixedNow() });
    // A replace run already claimed the message and is running right now.
    await repository.claimUserMessages({ ...WORK, runId: "run_replace_live", now: fixedNow() });

    const outcomes = await patrol(repository, storage);

    expect(outcomes.filter((o) => o.trackedSeasonId === season.id)).toEqual([]);
    expect(await repository.getWorkflowRunSnapshot("run_patrol_1")).toBeNull();
  });

  it("a work with a queued replace_request (messages withdrawn meanwhile) is not patrolled alongside it", async () => {
    const { repository, storage, season } = await completeShow();
    const { title } = trackedFixture();
    await repository.reserveWorkflowRun({
      title,
      season,
      workflowRun: { id: "run_replace_queued", kind: "replace_request", status: "queued", trackedSeasonId: season.id, startedAt: fixedNow(), finishedAt: null, auditEvents: [] },
      episodes: (await repository.getTrackedSeasonState(season.id))!.episodes,
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });

    const outcomes = await patrol(repository, storage);

    expect(outcomes.filter((o) => o.trackedSeasonId === season.id)).toEqual([]);
    expect((await repository.listActiveWorkflowRuns()).map((r) => r.workflowRun.id)).toEqual(["run_replace_queued"]);
  });

  it("a replace_request reserved after the patrol's pre-filter still keeps the patrol out (skipped_active)", async () => {
    const { repository, storage, season } = await completeShow();
    const { title } = trackedFixture();
    const reserve = repository.reserveWorkflowRun.bind(repository);
    repository.reserveWorkflowRun = async (input) => {
      if (input.workflowRun.kind === "type3_monitor") {
        // "现在处理" lands between the sweep's busy-work check and this reservation.
        await reserve({
          title,
          season,
          workflowRun: { id: "run_replace_late", kind: "replace_request", status: "queued", trackedSeasonId: season.id, startedAt: fixedNow(), finishedAt: null, auditEvents: [] },
          episodes: (await repository.getTrackedSeasonState(season.id))!.episodes,
          resourceSnapshots: [],
          decisions: [],
          transferAttempts: [],
          notifications: [],
          blockIfTitleHasActiveRun: true,
        });
      }
      return reserve(input);
    };

    const outcomes = await patrol(repository, storage);

    expect(outcomes).toEqual([{ trackedSeasonId: season.id, status: "skipped_active" }]);
    expect((await repository.listActiveWorkflowRuns()).map((r) => r.workflowRun.id)).toEqual(["run_replace_late"]);
  });

  it("a staging_recovery reserved after the patrol's pre-filter still keeps the patrol out (skipped_active)", async () => {
    const { repository, storage, season } = await completeShow();
    const { title } = trackedFixture();
    const reserve = repository.reserveWorkflowRun.bind(repository);
    repository.reserveWorkflowRun = async (input) => {
      if (input.workflowRun.kind === "type3_monitor") {
        await reserve({
          title,
          season,
          workflowRun: {
            id: "run_recovery_late",
            kind: "staging_recovery",
            status: "queued",
            trackedSeasonId: season.id,
            startedAt: fixedNow(),
            finishedAt: null,
            auditEvents: [
              {
                type: "staging_recovery_queued",
                message: "queued",
                data: { stagingDirectoryId: "stg-late", showDirectoryId: "show", seasonNumbers: [1] },
              },
            ],
          },
          episodes: (await repository.getTrackedSeasonState(season.id))!.episodes,
          resourceSnapshots: [],
          decisions: [],
          transferAttempts: [],
          notifications: [],
        });
      }
      return reserve(input);
    };

    const outcomes = await patrol(repository, storage);

    expect(outcomes).toEqual([{ trackedSeasonId: season.id, status: "skipped_active" }]);
    expect((await repository.listActiveWorkflowRuns()).map((r) => r.workflowRun.id)).toEqual(["run_recovery_late"]);
  });

  it("one work whose replace request cannot be queued does not abort the sweep", async () => {
    const { repository, storage } = await completeShow();
    const other = trackedFixture("other");
    await seedTrackedSeason({ repository, title: other.title, season: other.season, obtainedCodes: ["S01E01", "S01E02"] });
    await seedV2Season(storage, other.title, other.season, ["S01E01", "S01E02"]);
    await repository.createUserMessage({ ...WORK, body: "换", episodeTags: [], now: fixedNow() });
    const reserve = repository.reserveWorkflowRun.bind(repository);
    repository.reserveWorkflowRun = async (input) => {
      if (input.workflowRun.kind === "replace_request") throw new Error("db hiccup");
      return reserve(input);
    };

    const outcomes = await patrol(repository, storage);

    expect(outcomes.map((o) => o.trackedSeasonId)).toEqual([other.season.id]);
  });

  it("a work with replaced episodes (old + new copies kept) protects its existing files from the patrol's dedup", async () => {
    const run = async (withSource: boolean) => {
      const repository = new InMemoryWorkflowRepository();
      const { title, season } = trackedFixture();
      // E02 is a real gap, so the patrol runs the agent.
      await seedTrackedSeason({ repository, title, season, obtainedCodes: ["S01E01"] });
      const storage = new FakeStorageExecutor();
      const seasonDir = await seedV2Season(storage, title, season, ["S01E01"]);
      if (withSource) {
        await repository.upsertEpisodeSource({ ...WORK, episode: "S01E01", linkKey: null, label: "new", sizeBytes: null, runId: "run_old", recordedAt: fixedNow() });
      }
      let system = "";
      let deleteResult: unknown;
      let i = 0;
      const model = new MockLanguageModelV3({
        doGenerate: async (options) => {
          i += 1;
          if (i === 1) {
            system = JSON.stringify(options.prompt.find((m) => m.role === "system") ?? "");
            return {
              content: [{ type: "tool-call" as const, toolCallId: "c1", toolName: "deleteFiles", input: JSON.stringify({ directory: "season", season: 1, fileIds: ["present_S01E01_0"] }) }],
              finishReason: { unified: "tool-calls" as const, raw: "tool-calls" as const },
              usage: USAGE,
              warnings: [],
            };
          }
          const messages = options.prompt as Array<{ role: string; content: Array<{ type: string; output?: { value?: unknown } }> }>;
          // Once: the memory reflection turn calls the model again afterwards.
          if (i === 2) deleteResult = messages.filter((m) => m.role === "tool").at(-1)?.content[0]?.output?.value;
          return { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" as const }, usage: USAGE, warnings: [] };
        },
      });
      await runScheduledType3Monitoring({ repository, resourceProvider: emptyProvider(), storage, model, storageParentDirectoryId: "library_root", now: fixedNow });
      return { system, deleteResult, left: (await storage.listTree({ directoryId: seasonDir })).map((f) => f.providerFileId) };
    };

    const kept = await run(true);
    expect(kept.system).toContain("S01E01");
    expect(kept.system).toMatch(/intentionally kept duplicates/);
    expect(kept.deleteResult).toEqual({ error: expect.stringContaining("SANDBOX_FILE_PROTECTED") });
    expect(kept.left).toEqual(["present_S01E01_0"]);

    const plain = await run(false);
    expect(plain.system).not.toMatch(/intentionally kept duplicates/);
    expect(plain.deleteResult).not.toHaveProperty("error");
    expect(plain.left).toEqual([]);
  });

  it("a failing episode-source read does not fail the patrol run, and its existing files stay protected (fail closed)", async () => {
    const repository = new InMemoryWorkflowRepository();
    const { title, season } = trackedFixture();
    // E02 is a real gap, so the patrol runs the agent (and would read episode sources).
    await seedTrackedSeason({ repository, title, season, obtainedCodes: ["S01E01"] });
    const storage = new FakeStorageExecutor();
    const seasonDir = await seedV2Season(storage, title, season, ["S01E01"]);
    repository.listEpisodeSources = async () => {
      throw new Error("episode_sources table missing");
    };
    let system = "";
    let deleteResult: unknown;
    let i = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        i += 1;
        if (i === 1) {
          system = JSON.stringify(options.prompt.find((m) => m.role === "system") ?? "");
          return {
            content: [{ type: "tool-call" as const, toolCallId: "c1", toolName: "deleteFiles", input: JSON.stringify({ directory: "season", season: 1, fileIds: ["present_S01E01_0"] }) }],
            finishReason: { unified: "tool-calls" as const, raw: "tool-calls" as const },
            usage: USAGE,
            warnings: [],
          };
        }
        const messages = options.prompt as Array<{ role: string; content: Array<{ type: string; output?: { value?: unknown } }> }>;
        if (i === 2) deleteResult = messages.filter((m) => m.role === "tool").at(-1)?.content[0]?.output?.value;
        return { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" as const }, usage: USAGE, warnings: [] };
      },
    });

    const outcomes = await runScheduledType3Monitoring({
      repository,
      resourceProvider: emptyProvider(),
      storage,
      model,
      storageParentDirectoryId: "library_root",
      now: fixedNow,
      createWorkflowRunId: () => "run_sources_down",
    });

    expect(outcomes).toEqual([expect.objectContaining({ trackedSeasonId: season.id, status: "ran" })]);
    expect((await repository.getWorkflowRunSnapshot("run_sources_down"))?.workflowRun.status).not.toBe("failed");
    // Protection is on without naming episodes …
    expect(system).toMatch(/files already in the target folders .* are protected this run — do not delete or move them/);
    expect(system).not.toMatch(/intentionally kept duplicates/);
    // … and the old file really survives the agent's delete.
    expect(deleteResult).toEqual({ error: expect.stringContaining("SANDBOX_FILE_PROTECTED") });
    expect((await storage.listTree({ directoryId: seasonDir })).map((f) => f.providerFileId)).toEqual(["present_S01E01_0"]);
  });

  it("only the work with a request is taken out of the sweep; another show is patrolled as before", async () => {
    const { repository, storage, season } = await completeShow();
    const other = trackedFixture("other");
    await seedTrackedSeason({ repository, title: other.title, season: other.season, obtainedCodes: ["S01E01", "S01E02"] });
    await seedV2Season(storage, other.title, other.season, ["S01E01", "S01E02"]);
    await repository.createUserMessage({ ...WORK, body: "换", episodeTags: [], now: fixedNow() });

    const outcomes = await patrol(repository, storage);

    expect(outcomes.map((o) => o.trackedSeasonId)).toEqual([other.season.id]);
    expect(outcomes.map((o) => o.trackedSeasonId)).not.toContain(season.id);
    expect((await repository.listActiveWorkflowRuns()).map((run) => run.title.id)).toEqual(["title_show"]);
  });
});

describe("runScheduledType3Monitoring — the user's rejected list applies to ordinary runs", () => {
  const ACCOUNT = "acct_default";
  const OLD_TITLE = "Show show S01E02 [OldGroup] [1.3G]";
  const NEW_TITLE = "Show show S01E02 [NewGroup] [1.1G]";
  const OLD_LINK = `magnet:?xt=urn:btih:${"a".repeat(40)}`;

  function provider() {
    return new FakeResourceProvider({
      keywordResults: {
        "Show show": [
          { title: OLD_TITLE, providerPayload: { url: OLD_LINK } },
          { title: NEW_TITLE, providerPayload: { url: `magnet:?xt=urn:btih:${"b".repeat(40)}` } },
        ],
      },
    });
  }

  function lastToolOutput(prompt: unknown, toolName: string): any {
    const messages = prompt as Array<{ role: string; content: unknown }>;
    for (let m = messages.length - 1; m >= 0; m--) {
      const message = messages[m]!;
      if (message.role !== "tool" || !Array.isArray(message.content)) continue;
      for (const part of message.content as Array<{ type: string; toolName?: string; output?: { value?: unknown } }>) {
        if (part.type === "tool-result" && part.toolName === toolName) return part.output?.value;
      }
    }
    return undefined;
  }

  const step = (name: string, input: unknown, i: number) => ({
    content: [{ type: "tool-call" as const, toolCallId: `c${i}`, toolName: name, input: JSON.stringify(input) }],
    finishReason: { unified: "tool-calls" as const, raw: "tool-calls" as const },
    usage: USAGE,
    warnings: [],
  });
  const done = () => ({ content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" as const }, usage: USAGE, warnings: [] });

  async function gapShow() {
    const repository = new InMemoryWorkflowRepository();
    const { title, season } = trackedFixture();
    // E02 is a real gap, so the patrol runs the agent.
    await seedTrackedSeason({ repository, title, season, obtainedCodes: ["S01E01"] });
    const storage = new FakeStorageExecutor();
    await seedV2Season(storage, title, season, ["S01E01"]);
    return { repository, storage, title };
  }

  const rejectOld = (repository: InMemoryWorkflowRepository, titleKey: string) =>
    repository.addRejectedResources({
      accountId: ACCOUNT,
      titleKey,
      now: fixedNow(),
      items: [{ episode: "S01E02", linkKey: `magnet:${"a".repeat(40)}`, label: "Something else.mkv", sizeBytes: 1, reason: "假片", messageId: null }],
    });

  it("a stored rejection is filtered out of an ordinary patrol's search", async () => {
    const { repository, storage, title } = await gapShow();
    await rejectOld(repository, title.id);
    let doc = "";
    let i = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        i += 1;
        if (i === 1) return step("viewResourceSnapshot", {}, i);
        if (i === 2) {
          doc = String(lastToolOutput(options.prompt, "viewResourceSnapshot")?.document);
          return step("reportNoCoverage", { reason: "x" }, i);
        }
        return done();
      },
    });

    await runScheduledType3Monitoring({ repository, resourceProvider: provider(), storage, model, storageParentDirectoryId: "library_root", now: fixedNow });

    expect(doc).toContain("NewGroup");
    expect(doc).not.toContain("OldGroup");
  });

  it("a candidate rejected after the raw pre-search is refused at transfer in an ordinary patrol", async () => {
    const { repository, storage, title } = await gapShow();
    let transferOutput: any;
    let i = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        i += 1;
        if (i === 1) return step("viewResourceSnapshot", {}, i);
        if (i === 2) {
          // Rejected meanwhile (a replace run of the same work on another drive).
          await rejectOld(repository, title.id);
          const doc = String(lastToolOutput(options.prompt, "viewResourceSnapshot").document);
          const row = /\[(s(\d+)-\d+)\] Show show S01E02 \[OldGroup\]/.exec(doc)!;
          return step("transferCandidate", { snapshotId: `s${row[2]}`, candidateId: row[1] }, i);
        }
        if (i === 3) {
          transferOutput = lastToolOutput(options.prompt, "transferCandidate");
          return step("reportNoCoverage", { reason: "x" }, i);
        }
        return done();
      },
    });

    await runScheduledType3Monitoring({
      repository,
      resourceProvider: provider(),
      storage,
      model,
      storageParentDirectoryId: "library_root",
      now: fixedNow,
      createWorkflowRunId: () => "run_rejected_guard",
    });

    expect(String(transferOutput?.error)).toMatch(/SANDBOX_CANDIDATE_REJECTED/);
    expect((await repository.getWorkflowRunSnapshot("run_rejected_guard"))?.transferAttempts).toEqual([]);
  });

  it("a failing rejected-list read never fails the patrol (fails open)", async () => {
    const { repository, storage } = await gapShow();
    repository.listRejectedResources = async () => {
      throw new Error("rejected_resources table missing");
    };
    let doc = "";
    let i = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        i += 1;
        if (i === 1) return step("viewResourceSnapshot", {}, i);
        if (i === 2) {
          doc = String(lastToolOutput(options.prompt, "viewResourceSnapshot")?.document);
          return step("reportNoCoverage", { reason: "x" }, i);
        }
        return done();
      },
    });

    const outcomes = await runScheduledType3Monitoring({
      repository,
      resourceProvider: provider(),
      storage,
      model,
      storageParentDirectoryId: "library_root",
      now: fixedNow,
      createWorkflowRunId: () => "run_rejected_down",
    });

    expect(outcomes).toEqual([expect.objectContaining({ status: "ran" })]);
    expect((await repository.getWorkflowRunSnapshot("run_rejected_down"))?.workflowRun.status).not.toBe("failed");
    expect(doc).toContain("OldGroup");
  });
});

/**
 * A frozen drive's login is dead (re-bind to recover): nothing the patrol could do on it
 * would work. 2026-09-30 production: a kicked-off 123 login froze its drive, and the 06:00
 * patrol still reserved a run per show on it — four runs, each failing on the dead login.
 */
describe("runScheduledType3Monitoring — frozen drives", () => {
  async function bindDrive(repository: InMemoryWorkflowRepository, id: string, status: "active" | "frozen") {
    await repository.upsertConnectedStorage({
      id,
      accountId: "acct_default",
      provider: "pan123",
      providerUid: id,
      payload: {},
      createdAt: fixedNow(),
    });
    if (status === "frozen") {
      await repository.setConnectedStorageStatus(id, "frozen", "PAN123_AUTH_FAILED: 未登录", fixedNow());
    }
  }

  /** A show with E02 missing, bound to `drive` (null = unbound: it lands on the account's default drive). */
  async function gappedShow(
    repository: InMemoryWorkflowRepository,
    storage: FakeStorageExecutor,
    suffix: string,
    drive: string | null,
  ) {
    const { title, season } = trackedFixture(suffix);
    await repository.saveWorkflowRunSnapshot({
      ...(drive === null ? {} : { connectedStorageId: drive }),
      title,
      season,
      workflowRun: {
        id: `seed_${season.id}`,
        kind: "type2_init",
        status: "succeeded",
        trackedSeasonId: season.id,
        startedAt: fixedNow(),
        finishedAt: fixedNow(),
        auditEvents: [],
      },
      episodes: createEpisodeStates({ trackedSeasonId: season.id, seasonNumber: 1, totalEpisodes: 2, latestAiredEpisode: 2 }),
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });
    await seedV2Season(storage, title, season, ["S01E01"]);
    return season;
  }

  it("does not patrol a show whose drive is frozen; a show on a working drive still runs", async () => {
    const repository = new InMemoryWorkflowRepository();
    const storage = new FakeStorageExecutor();
    await bindDrive(repository, "drive_live", "active");
    await bindDrive(repository, "drive_dead", "frozen");
    const live = await gappedShow(repository, storage, "live", "drive_live");
    const dead = await gappedShow(repository, storage, "dead", "drive_dead");
    let reserved = 0;

    const outcomes = await runScheduledType3Monitoring({
      repository, resourceProvider: emptyProvider(), storage, model: noCoverageModel(),
      storageParentDirectoryId: "library_root", now: fixedNow,
      createWorkflowRunId: () => `run_frozen_${(reserved += 1)}`,
    });

    expect(outcomes.map((o) => o.trackedSeasonId)).toEqual([live.id]);
    expect(outcomes.some((o) => o.trackedSeasonId === dead.id)).toBe(false);
    expect(reserved).toBe(1);
  });

  it("does not patrol an unbound show when its account's default drive is frozen", async () => {
    const repository = new InMemoryWorkflowRepository();
    const storage = new FakeStorageExecutor();
    await bindDrive(repository, "drive_dead", "frozen");
    await gappedShow(repository, storage, "unbound", null);
    let reserved = 0;

    const outcomes = await runScheduledType3Monitoring({
      repository, resourceProvider: emptyProvider(), storage, model: throwingModel(),
      storageParentDirectoryId: "library_root", now: fixedNow,
      createWorkflowRunId: () => `run_unbound_${(reserved += 1)}`,
      resolveDriveId: async () => "drive_dead",
    });

    expect(outcomes).toEqual([]);
    expect(reserved).toBe(0);
  });

  it("a message on a frozen drive's show queues nothing: it stays pending until the drive is re-bound", async () => {
    const repository = new InMemoryWorkflowRepository();
    const storage = new FakeStorageExecutor();
    await bindDrive(repository, "drive_dead", "frozen");
    await gappedShow(repository, storage, "msg", "drive_dead");
    const work = { accountId: "acct_default", drive: "drive_dead", titleKey: "title_msg" };
    await repository.createUserMessage({ ...work, body: "第 1 集发蓝", episodeTags: ["S01E01"], now: fixedNow() });

    const outcomes = await runScheduledType3Monitoring({
      repository, resourceProvider: emptyProvider(), storage, model: throwingModel(),
      storageParentDirectoryId: "library_root", now: fixedNow,
    });

    expect(outcomes).toEqual([]);
    expect(await repository.listActiveWorkflowRuns({ accountId: "acct_default", connectedStorageId: "drive_dead" })).toEqual([]);
    expect((await repository.listUserMessages(work))[0]?.status).toBe("pending");
  });

  it("once the drive is re-bound (active again) its shows are patrolled as before", async () => {
    const repository = new InMemoryWorkflowRepository();
    const storage = new FakeStorageExecutor();
    await bindDrive(repository, "drive_back", "frozen");
    await repository.setConnectedStorageStatus("drive_back", "active", null, null);
    const back = await gappedShow(repository, storage, "back", "drive_back");

    const outcomes = await runScheduledType3Monitoring({
      repository, resourceProvider: emptyProvider(), storage, model: noCoverageModel(),
      storageParentDirectoryId: "library_root", now: fixedNow,
      createWorkflowRunId: () => "run_back",
    });

    expect(outcomes).toEqual([expect.objectContaining({ trackedSeasonId: back.id, status: "ran" })]);
  });
});
