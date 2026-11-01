import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import {
  runMovieAcquisitionV2AndPersist,
  runSeriesInitializationV2AndPersist,
  runType2InitializationV2AndPersist,
  runType3MonitoringV2AndPersist,
} from "../src/runner-v2.js";
import { FakeStorageExecutor } from "../src/fakes.js";
import { InMemoryWorkflowRepository } from "../src/repository.js";
import { createEpisodeStates, type MediaTitle, type ResourceSnapshot, type TrackedSeason } from "../src/domain.js";
import type { ResourceProvider } from "../src/ports.js";

const USAGE = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
} as const;

function emptyProvider(): ResourceProvider {
  return {
    search: async ({ keyword }): Promise<ResourceSnapshot> => ({
      id: "snap_empty",
      provider: "pansou",
      keyword,
      candidates: [],
      createdAt: "2026-06-15T00:00:00.000Z",
    }),
  };
}

function searchThenReportModel() {
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

const tvTitle = {
  id: "tmdb_tv_100",
  tmdbId: 100,
  type: "tv",
  title: "示例剧",
  year: 2024,
  aliases: ["Example Show"],
} as unknown as MediaTitle;

const movieTitle = {
  id: "tmdb_movie_27205",
  tmdbId: 27205,
  type: "movie",
  title: "盗梦空间",
  year: 2010,
  aliases: ["Inception"],
} as unknown as MediaTitle;

function trackedSeason(): TrackedSeason {
  return {
    id: "tmdb_tv_100_s1",
    mediaTitleId: "tmdb_tv_100",
    seasonNumber: 1,
    status: "active",
    qualityPreference: "4K",
    storageDirectoryId: "",
    totalEpisodes: 3,
    latestAiredEpisode: 3,
    latestAiredSource: "metadata",
  };
}

const workflowRun = { id: "run-x", startedAt: "2026-06-15T00:00:00.000Z", finishedAt: "2026-06-15T00:01:00.000Z" };

describe("runner-v2 persist wrappers — V2 engine results persisted in the existing record shapes", () => {
  it("type2 init: persists one type2_init snapshot with the tracked season and episodes", async () => {
    const repository = new InMemoryWorkflowRepository();
    const result = await runType2InitializationV2AndPersist({
      title: tvTitle,
      season: trackedSeason(),
      categoryParentId: "tv_root",
      resourceProvider: emptyProvider(),
      storage: new FakeStorageExecutor(),
      model: searchThenReportModel(),
      repository,
      workflowRun,
    });

    expect(result.status).toBe("no_coverage");
    const snapshot = await repository.getWorkflowRunSnapshot("run-x");
    expect(snapshot).not.toBeNull();
    expect(snapshot!.workflowRun.kind).toBe("type2_init");
    expect(snapshot!.workflowRun.trackedSeasonId).toBe("tmdb_tv_100_s1");
    expect(snapshot!.episodes).toHaveLength(3);
    const tracked = await repository.listTrackedSeasonStates();
    expect(tracked.map((state) => state.season.id)).toContain("tmdb_tv_100_s1");
  });

  it("type3 patrol: persists a type3_monitor snapshot, scheduled-trigger notification", async () => {
    const repository = new InMemoryWorkflowRepository();
    await runType3MonitoringV2AndPersist({
      title: tvTitle,
      season: trackedSeason(),
      episodes: createEpisodeStates({ trackedSeasonId: "tmdb_tv_100_s1", seasonNumber: 1, totalEpisodes: 3, latestAiredEpisode: 3 }),
      categoryParentId: "tv_root",
      resourceProvider: emptyProvider(),
      storage: new FakeStorageExecutor(),
      model: searchThenReportModel(),
      repository,
      workflowRun,
    });

    const snapshot = await repository.getWorkflowRunSnapshot("run-x");
    expect(snapshot!.workflowRun.kind).toBe("type3_monitor");
    const notifications = await repository.listNotifications();
    expect(notifications.some((notification) => notification.trigger === "scheduled")).toBe(true);
  });

  it("series init: persists one type1_package_init record per season under _s{n} ids", async () => {
    const repository = new InMemoryWorkflowRepository();
    await runSeriesInitializationV2AndPersist({
      title: tvTitle,
      seasons: [
        { seasonNumber: 1, totalEpisodes: 3, latestAiredEpisode: 3 },
        { seasonNumber: 2, totalEpisodes: 3, latestAiredEpisode: 3 },
      ],
      categoryParentId: "tv_root",
      resourceProvider: emptyProvider(),
      storage: new FakeStorageExecutor(),
      model: searchThenReportModel(),
      repository,
      workflowRun,
      seasonQualityRecord: "4K",
    });

    const s1 = await repository.getWorkflowRunSnapshot("run-x_s1");
    const s2 = await repository.getWorkflowRunSnapshot("run-x_s2");
    expect(s1!.workflowRun.kind).toBe("type1_package_init");
    expect(s2!.workflowRun.kind).toBe("type1_package_init");
    // Resource evidence rides on the first season only.
    expect(s2!.resourceSnapshots).toEqual([]);
    const tracked = await repository.listTrackedSeasonStates();
    expect(tracked.map((state) => state.season.id).sort()).toEqual(["tmdb_tv_100_s1", "tmdb_tv_100_s2"]);
  });

  it("movie init: persists a movie_init snapshot via the V2 movie engine", async () => {
    const repository = new InMemoryWorkflowRepository();
    const result = await runMovieAcquisitionV2AndPersist({
      title: movieTitle,
      categoryParentId: "movies_root",
      resourceProvider: emptyProvider(),
      storage: new FakeStorageExecutor(),
      model: searchThenReportModel(),
      repository,
      workflowRun,
    });

    expect(result.status).toBe("no_coverage");
    const snapshot = await repository.getWorkflowRunSnapshot("run-x");
    expect(snapshot!.workflowRun.kind).toBe("movie_init");
  });

  it("multi-drive TV: persists obtained episodes and copies on a secondary drive even when filenames are bare digits (1.mp4..7.mp4) and primary drive holds an empty season dir (假面骑士麦斯 regression)", async () => {
    const repository = new InMemoryWorkflowRepository();
    const ucVideoFiles = Array.from({ length: 7 }, (_, idx) => ({
      id: `uc_file_${idx + 1}`,
      storageDirectoryId: "uc_s1_dir",
      name: `${idx + 1}.mp4`,
      sizeBytes: 1_000_000_000,
      // Bare digit filenames ("1.mp4".."7.mp4") return episodeCode: null from episodeCodeFromFileName
      episodeCode: null,
      providerFileId: `uc_file_${idx + 1}`,
    }));

    const exec115 = new FakeStorageExecutor();
    exec115.listVideoFiles = async () => [];

    const execUc = new FakeStorageExecutor();
    execUc.listVideoFiles = async () => ucVideoFiles;
    execUc.listTree = async () =>
      ucVideoFiles.map((f) => ({ path: f.name, providerFileId: f.id, sizeBytes: f.sizeBytes }));
    execUc.transfer = async (input) => ({
      id: `${input.workflowRunId}_t1`,
      workflowRunId: input.workflowRunId,
      candidateId: input.candidate.id,
      status: "succeeded",
      providerMessage: "",
      materializedFileIds: ucVideoFiles.map((f) => f.id),
    });

    const provider: ResourceProvider = {
      search: async ({ keyword }): Promise<ResourceSnapshot> => ({
        id: "snap_uc",
        provider: "pansou",
        keyword,
        createdAt: "2026-10-31T06:00:00.000Z",
        candidates: [
          {
            id: "cand_uc_1",
            snapshotId: "snap_uc",
            index: 0,
            title: "假面骑士麦斯 1-7 台配",
            type: "uc" as never,
            source: "pansou",
            providerPayload: { url: "https://drive.uc.cn/s/abc123def456" },
          },
        ],
      }),
    };

    let step = 0;
    const tool = (name: string, input: unknown) => ({
      content: [{ type: "tool-call" as const, toolCallId: `call_${step}`, toolName: name, input: JSON.stringify(input) }],
      finishReason: { unified: "tool-calls" as const, raw: "tool-calls" as const },
      usage: USAGE,
      warnings: [],
    });

    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        step += 1;
        // Step 1: view pre-warmed raw snapshot
        if (step === 1) return tool("viewResourceSnapshot", {});
        // Step 2: transfer onto UC drive
        if (step === 2) return tool("transferCandidate", { snapshotId: "s1", candidateId: "s1-1", storageId: "cs_uc" });
        // Step 3: move to Season 1 on UC
        if (step === 3) {
          return tool("moveToSeason", {
            moves: [
              {
                season: 1,
                fileIds: ucVideoFiles.map((f) => `cs_uc::${f.id}`),
              },
            ],
          });
        }
        if (step === 4) {
          return tool("markObtained", {
            codes: ["S01E01", "S01E02", "S01E03", "S01E04", "S01E05", "S01E06", "S01E07"],
          });
        }
        if (step === 5) return tool("discardStaging", {});
        if (step === 6) return tool("finish", {});
        return { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" as const }, usage: USAGE, warnings: [] };
      },
    });

    const season8: TrackedSeason = {
      id: "tmdb_tv_318445_s1",
      mediaTitleId: "tmdb_tv_318445",
      seasonNumber: 1,
      status: "active",
      qualityPreference: "4K",
      storageDirectoryId: "",
      totalEpisodes: 9,
      latestAiredEpisode: 8,
      latestAiredSource: "metadata",
    };

    const result = await runType2InitializationV2AndPersist({
      title: {
        id: "tmdb_tv_318445",
        tmdbId: 318445,
        type: "tv",
        title: "假面骑士麦斯",
        year: 2026,
        aliases: [],
      } as unknown as MediaTitle,
      season: season8,
      categoryParentId: "115_tv_root",
      resourceProvider: provider,
      storage: exec115,
      model,
      repository,
      accountId: "acct_default",
      connectedStorageId: "cs_115",
      drives: [
        {
          storageId: "cs_115",
          provider: "pan115",
          label: "115 网盘",
          storage: exec115,
          parents: { tv: "115_tv_root", anime: "115_anime_root", movies: "115_movies_root" },
          space: { totalBytes: 10 * 1024 ** 4, usedBytes: 1 * 1024 ** 4 },
        },
        {
          storageId: "cs_uc",
          provider: "uc",
          label: "UC网盘",
          storage: execUc,
          parents: { tv: "uc_tv_root", anime: "uc_anime_root", movies: "uc_movies_root" },
          space: { totalBytes: 6 * 1024 ** 4, usedBytes: 1 * 1024 ** 4 },
        },
      ],
      workflowRun: { id: "run_myth", startedAt: "2026-10-31T06:42:00.000Z", finishedAt: null },
    });

    expect(result.status).toBe("partial");
    const crossDrive = await repository.obtainedEpisodesForSeason!("tmdb_tv_318445_s1", "acct_default");
    const obtainedCodes = crossDrive.filter((c) => c.obtained).map((c) => c.episodeCode);
    expect(obtainedCodes).toEqual(["S01E01", "S01E02", "S01E03", "S01E04", "S01E05", "S01E06", "S01E07"]);
    expect(crossDrive.find((c) => c.episodeCode === "S01E01")?.drives).toEqual([
      {
        storageId: "cs_uc",
        fileIds: ["uc_file_1"],
        sizeBytes: 1_000_000_000,
        quality: null,
      },
    ]);
  });
});
