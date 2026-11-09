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

  it("type3 patrol that lands a new episode records only that episode on its drive — never what another drive holds (issue #369)", async () => {
    const repository = new InMemoryWorkflowRepository();
    const season4: TrackedSeason = { ...trackedSeason(), totalEpisodes: 4, latestAiredEpisode: 4 };
    const local = createEpisodeStates({ trackedSeasonId: season4.id, seasonNumber: 1, totalEpisodes: 4, latestAiredEpisode: 4 }).map((ep) =>
      ep.episodeCode === "S01E01" || ep.episodeCode === "S01E02"
        ? { ...ep, obtained: true, verifiedFileIds: [`f_${ep.episodeCode}`] }
        : ep,
    );
    await repository.saveWorkflowRunSnapshot({
      accountId: "acct_default",
      connectedStorageId: "cs_115",
      title: tvTitle,
      season: season4,
      workflowRun: { id: "run_seed", kind: "type2_init", status: "partial", trackedSeasonId: season4.id, startedAt: "2026-11-01T00:00:00.000Z", finishedAt: "2026-11-01T00:00:00.000Z", auditEvents: [] },
      episodes: local,
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });
    const seeded = ["S01E01", "S01E02"].map((code) => ({
      trackedSeasonId: season4.id, episodeCode: code, storageId: "cs_115", fileIds: [`f_${code}`], sizeBytes: 1_000, quality: null, runId: "run_seed", recordedAt: "2026-11-01T00:00:00.000Z",
    }));
    await repository.upsertEpisodeCopies(seeded);

    const storage = new FakeStorageExecutor();
    const landed = { id: "f_S01E04", storageDirectoryId: "staging", name: "示例剧.S01E04.2160p.mkv", sizeBytes: 2_000, episodeCode: "S01E04", providerFileId: "f_S01E04" };
    storage.transfer = async (input) => ({
      id: `${input.workflowRunId}_t1`, workflowRunId: input.workflowRunId, candidateId: input.candidate.id, status: "succeeded", providerMessage: "", materializedFileIds: [landed.id],
    });
    storage.listTree = async () => [{ path: landed.name, providerFileId: landed.id, sizeBytes: landed.sizeBytes }];
    storage.listVideoFiles = async () => [landed];
    const provider: ResourceProvider = {
      search: async ({ keyword }): Promise<ResourceSnapshot> => ({
        id: "snap_e4", provider: "pansou", keyword, createdAt: "2026-11-07T00:00:00.000Z",
        candidates: [{ id: "cand_e4", snapshotId: "snap_e4", index: 0, title: "示例剧 S01E04 2160p 中字", type: "magnet", source: "pansou", providerPayload: { url: `magnet:?xt=urn:btih:${"a".repeat(40)}` } }],
      }),
    };
    let step = 0;
    const tool = (name: string, input: unknown) => ({
      content: [{ type: "tool-call" as const, toolCallId: `call_${step}`, toolName: name, input: JSON.stringify(input) }],
      finishReason: { unified: "tool-calls" as const, raw: "tool-calls" as const }, usage: USAGE, warnings: [],
    });
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        step += 1;
        if (step === 1) return tool("viewResourceSnapshot", {});
        if (step === 2) return tool("transferCandidate", { snapshotId: "s1", candidateId: "s1-1" });
        if (step === 3) return tool("moveToSeason", { moves: [{ season: 1, fileIds: [landed.id] }] });
        if (step === 4) return tool("markObtained", { codes: ["S01E04"] });
        if (step === 5) return tool("discardStaging", {});
        if (step === 6) return tool("finish", {});
        return { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" as const }, usage: USAGE, warnings: [] };
      },
    });

    const result = await runType3MonitoringV2AndPersist({
      title: tvTitle,
      season: season4,
      episodes: local,
      // E03 lives on another drive: counted as had, never written here.
      crossDriveObtained: ["S01E01", "S01E02", "S01E03"],
      categoryParentId: "tv_root",
      resourceProvider: provider,
      storage,
      model,
      repository,
      accountId: "acct_default",
      connectedStorageId: "cs_115",
      workflowRun: { id: "run_patrol", startedAt: "2026-11-07T00:11:00.000Z", finishedAt: null },
      now: () => "2026-11-07T00:12:00.000Z",
    });

    expect(result.status).toBe("succeeded");
    const state = await repository.getTrackedSeasonState(season4.id, { accountId: "acct_default", connectedStorageId: "cs_115" });
    expect(state!.episodes.filter((e) => e.obtained).map((e) => e.episodeCode)).toEqual(["S01E01", "S01E02", "S01E04"]);
    expect(state!.episodes.find((e) => e.episodeCode === "S01E01")?.verifiedFileIds).toEqual(["f_S01E01"]);
    const copies = await repository.listEpisodeCopies(season4.id);
    expect(copies.map((c) => [c.episodeCode, c.storageId, c.runId])).toEqual([
      ["S01E01", "cs_115", "run_seed"],
      ["S01E02", "cs_115", "run_seed"],
      ["S01E04", "cs_115", "run_patrol"],
    ]);
  });

  it("multi-drive type3 patrol landing on a secondary drive attributes only the new episode there, keeps what that drive held, and leaves a mixed directory's size unknown", async () => {
    const repository = new InMemoryWorkflowRepository();
    const season3: TrackedSeason = { ...trackedSeason(), totalEpisodes: 3, latestAiredEpisode: 3 };
    const local = createEpisodeStates({ trackedSeasonId: season3.id, seasonNumber: 1, totalEpisodes: 3, latestAiredEpisode: 3 }).map((ep) =>
      ep.episodeCode === "S01E03" ? ep : { ...ep, obtained: true, verifiedFileIds: [`f115_${ep.episodeCode}`] },
    );
    await repository.saveWorkflowRunSnapshot({
      accountId: "acct_default",
      connectedStorageId: "cs_115",
      title: tvTitle,
      season: season3,
      workflowRun: { id: "run_seed", kind: "type2_init", status: "partial", trackedSeasonId: season3.id, startedAt: "2026-11-01T00:00:00.000Z", finishedAt: "2026-11-01T00:00:00.000Z", auditEvents: [] },
      episodes: local,
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });

    // UC already holds E04, ahead of TMDB's three episodes.
    const ucHeld = createEpisodeStates({ trackedSeasonId: season3.id, seasonNumber: 1, totalEpisodes: 3, latestAiredEpisode: 3 });
    ucHeld.push({ trackedSeasonId: season3.id, episodeCode: "S01E04", airDate: null, title: "S01E04", airStatus: "unknown", obtained: true, metadataStatus: "provider_ahead", verifiedFileIds: ["uc_e4"] });
    await repository.saveWorkflowRunSnapshot({
      accountId: "acct_default",
      connectedStorageId: "cs_uc",
      title: tvTitle,
      season: season3,
      workflowRun: { id: "run_seed_uc", kind: "type2_init", status: "partial", trackedSeasonId: season3.id, startedAt: "2026-11-02T00:00:00.000Z", finishedAt: "2026-11-02T00:00:00.000Z", auditEvents: [] },
      episodes: ucHeld,
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });
    await repository.upsertEpisodeCopies([
      { trackedSeasonId: season3.id, episodeCode: "S01E04", storageId: "cs_uc", fileIds: ["uc_e4"], sizeBytes: 4_000, quality: null, runId: "run_seed_uc", recordedAt: "2026-11-02T00:00:00.000Z" },
    ]);

    const exec115 = new FakeStorageExecutor();
    exec115.listVideoFiles = async () => [];
    // Opaque names: nothing tells the earlier E04 file from the new E03 one.
    const ucFile = { id: "uc_e3", storageDirectoryId: "uc_s1_dir", name: "第三集.mkv", sizeBytes: 3_000, episodeCode: null, providerFileId: "uc_e3" };
    const ucOld = { id: "uc_e4", storageDirectoryId: "uc_s1_dir", name: "x.mkv", sizeBytes: 4_000, episodeCode: null, providerFileId: "uc_e4" };
    const execUc = new FakeStorageExecutor();
    execUc.listVideoFiles = async () => [ucOld, ucFile];
    execUc.listTree = async () => [{ path: ucFile.name, providerFileId: ucFile.id, sizeBytes: ucFile.sizeBytes }];
    execUc.transfer = async (input) => ({
      id: `${input.workflowRunId}_t1`, workflowRunId: input.workflowRunId, candidateId: input.candidate.id, status: "succeeded", providerMessage: "", materializedFileIds: [ucFile.id],
    });
    const provider: ResourceProvider = {
      search: async ({ keyword }): Promise<ResourceSnapshot> => ({
        id: "snap_uc3", provider: "pansou", keyword, createdAt: "2026-11-07T00:00:00.000Z",
        candidates: [{ id: "cand_uc3", snapshotId: "snap_uc3", index: 0, title: "示例剧 第3集 中字", type: "uc" as never, source: "pansou", providerPayload: { url: "https://drive.uc.cn/s/e3e3e3e3e3e3" } }],
      }),
    };
    let step = 0;
    const tool = (name: string, input: unknown) => ({
      content: [{ type: "tool-call" as const, toolCallId: `call_${step}`, toolName: name, input: JSON.stringify(input) }],
      finishReason: { unified: "tool-calls" as const, raw: "tool-calls" as const }, usage: USAGE, warnings: [],
    });
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        step += 1;
        if (step === 1) return tool("viewResourceSnapshot", {});
        if (step === 2) return tool("transferCandidate", { snapshotId: "s1", candidateId: "s1-1", storageId: "cs_uc" });
        if (step === 3) return tool("moveToSeason", { moves: [{ season: 1, fileIds: [`cs_uc::${ucFile.id}`] }] });
        if (step === 4) return tool("markObtained", { codes: ["S01E03"] });
        if (step === 5) return tool("discardStaging", {});
        if (step === 6) return tool("finish", {});
        return { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" as const }, usage: USAGE, warnings: [] };
      },
    });

    const result = await runType3MonitoringV2AndPersist({
      title: tvTitle,
      season: season3,
      episodes: local,
      crossDriveObtained: ["S01E01", "S01E02", "S01E04"],
      categoryParentId: "115_tv_root",
      resourceProvider: provider,
      storage: exec115,
      model,
      repository,
      accountId: "acct_default",
      connectedStorageId: "cs_115",
      drives: [
        { storageId: "cs_115", provider: "pan115", label: "115 网盘", storage: exec115, parents: { tv: "115_tv_root", anime: "115_anime_root", movies: "115_movies_root" }, space: { totalBytes: 10 * 1024 ** 4, usedBytes: 1 * 1024 ** 4 } },
        { storageId: "cs_uc", provider: "uc", label: "UC网盘", storage: execUc, parents: { tv: "uc_tv_root", anime: "uc_anime_root", movies: "uc_movies_root" }, space: { totalBytes: 6 * 1024 ** 4, usedBytes: 1 * 1024 ** 4 } },
      ],
      workflowRun: { id: "run_patrol_md", startedAt: "2026-11-07T00:11:00.000Z", finishedAt: null },
      now: () => "2026-11-07T00:12:00.000Z",
    });

    expect(result.status).toBe("succeeded");
    const copies = await repository.listEpisodeCopies(season3.id);
    expect(copies.map((c) => [c.episodeCode, c.storageId, c.runId, c.sizeBytes])).toEqual([
      // E03 shares a directory with E04's file: its size is unknown, not 7000.
      ["S01E03", "cs_uc", "run_patrol_md", null],
      ["S01E04", "cs_uc", "run_seed_uc", 4_000],
    ]);
    const uc = await repository.getTrackedSeasonState(season3.id, { accountId: "acct_default", connectedStorageId: "cs_uc" });
    expect(uc!.episodes.filter((e) => e.obtained).map((e) => e.episodeCode)).toEqual(["S01E03", "S01E04"]);
    expect(uc!.episodes.find((e) => e.episodeCode === "S01E04")?.verifiedFileIds).toEqual(["uc_e4"]);
    const primary = await repository.getTrackedSeasonState(season3.id, { accountId: "acct_default", connectedStorageId: "cs_115" });
    expect(primary!.episodes.filter((e) => e.obtained).map((e) => e.episodeCode)).toEqual(["S01E01", "S01E02"]);
    expect(primary!.episodes.some((e) => e.episodeCode === "S01E04")).toBe(false);
    expect(primary!.episodes.find((e) => e.episodeCode === "S01E01")?.verifiedFileIds).toEqual(["f115_S01E01"]);
  });

  it("multi-drive type3 patrol landing on the primary records only the new episode, leaving the primary's earlier copies as they were", async () => {
    const repository = new InMemoryWorkflowRepository();
    const season3: TrackedSeason = { ...trackedSeason(), totalEpisodes: 3, latestAiredEpisode: 3 };
    const local = createEpisodeStates({ trackedSeasonId: season3.id, seasonNumber: 1, totalEpisodes: 3, latestAiredEpisode: 3 }).map((ep) =>
      ep.episodeCode === "S01E03" ? ep : { ...ep, obtained: true, verifiedFileIds: [`f115_${ep.episodeCode}`] },
    );
    await repository.saveWorkflowRunSnapshot({
      accountId: "acct_default",
      connectedStorageId: "cs_115",
      title: tvTitle,
      season: season3,
      workflowRun: { id: "run_seed", kind: "type2_init", status: "partial", trackedSeasonId: season3.id, startedAt: "2026-11-01T00:00:00.000Z", finishedAt: "2026-11-01T00:00:00.000Z", auditEvents: [] },
      episodes: local,
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });
    const seeded = ["S01E01", "S01E02"].map((code) => ({
      trackedSeasonId: season3.id, episodeCode: code, storageId: "cs_115", fileIds: [`f115_${code}`], sizeBytes: 1_000, quality: null, runId: "run_seed", recordedAt: "2026-11-01T00:00:00.000Z",
    }));
    await repository.upsertEpisodeCopies(seeded);

    // The season dir on 115 now holds the two earlier episodes plus the new, opaquely named one.
    const newFile = { id: "f115_new", storageDirectoryId: "s1", name: "第三集.mkv", sizeBytes: 3_000, episodeCode: null, providerFileId: "f115_new" };
    const exec115 = new FakeStorageExecutor();
    exec115.listVideoFiles = async () => [
      { id: "f115_S01E01", storageDirectoryId: "s1", name: "a.mkv", sizeBytes: 1_000, episodeCode: null, providerFileId: "f115_S01E01" },
      { id: "f115_S01E02", storageDirectoryId: "s1", name: "b.mkv", sizeBytes: 1_000, episodeCode: null, providerFileId: "f115_S01E02" },
      newFile,
    ];
    exec115.listTree = async () => [{ path: newFile.name, providerFileId: newFile.id, sizeBytes: newFile.sizeBytes }];
    exec115.transfer = async (input) => ({
      id: `${input.workflowRunId}_t1`, workflowRunId: input.workflowRunId, candidateId: input.candidate.id, status: "succeeded", providerMessage: "", materializedFileIds: [newFile.id],
    });
    const execUc = new FakeStorageExecutor();
    execUc.listVideoFiles = async () => [];
    const provider: ResourceProvider = {
      search: async ({ keyword }): Promise<ResourceSnapshot> => ({
        id: "snap_m3", provider: "pansou", keyword, createdAt: "2026-11-07T00:00:00.000Z",
        candidates: [{ id: "cand_m3", snapshotId: "snap_m3", index: 0, title: "示例剧 第3集 中字", type: "magnet", source: "pansou", providerPayload: { url: `magnet:?xt=urn:btih:${"b".repeat(40)}` } }],
      }),
    };
    let step = 0;
    const tool = (name: string, input: unknown) => ({
      content: [{ type: "tool-call" as const, toolCallId: `call_${step}`, toolName: name, input: JSON.stringify(input) }],
      finishReason: { unified: "tool-calls" as const, raw: "tool-calls" as const }, usage: USAGE, warnings: [],
    });
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        step += 1;
        if (step === 1) return tool("viewResourceSnapshot", {});
        if (step === 2) return tool("transferCandidate", { snapshotId: "s1", candidateId: "s1-1", storageId: "cs_115" });
        if (step === 3) return tool("moveToSeason", { moves: [{ season: 1, fileIds: [`cs_115::${newFile.id}`] }] });
        if (step === 4) return tool("markObtained", { codes: ["S01E03"] });
        if (step === 5) return tool("discardStaging", {});
        if (step === 6) return tool("finish", {});
        return { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" as const }, usage: USAGE, warnings: [] };
      },
    });

    const result = await runType3MonitoringV2AndPersist({
      title: tvTitle,
      season: season3,
      episodes: local,
      crossDriveObtained: ["S01E01", "S01E02"],
      categoryParentId: "115_tv_root",
      resourceProvider: provider,
      storage: exec115,
      model,
      repository,
      accountId: "acct_default",
      connectedStorageId: "cs_115",
      drives: [
        { storageId: "cs_115", provider: "pan115", label: "115 网盘", storage: exec115, parents: { tv: "115_tv_root", anime: "115_anime_root", movies: "115_movies_root" }, space: { totalBytes: 10 * 1024 ** 4, usedBytes: 1 * 1024 ** 4 } },
        { storageId: "cs_uc", provider: "uc", label: "UC网盘", storage: execUc, parents: { tv: "uc_tv_root", anime: "uc_anime_root", movies: "uc_movies_root" }, space: { totalBytes: 6 * 1024 ** 4, usedBytes: 1 * 1024 ** 4 } },
      ],
      workflowRun: { id: "run_patrol_p", startedAt: "2026-11-07T00:11:00.000Z", finishedAt: null },
      now: () => "2026-11-07T00:12:00.000Z",
    });

    expect(result.status).toBe("succeeded");
    const copies = await repository.listEpisodeCopies(season3.id);
    expect(copies.map((c) => [c.episodeCode, c.storageId, c.runId, c.sizeBytes])).toEqual([
      ["S01E01", "cs_115", "run_seed", 1_000],
      ["S01E02", "cs_115", "run_seed", 1_000],
      // Opaque name in a dir that also holds earlier episodes: size unknown, not 5000/1.
      ["S01E03", "cs_115", "run_patrol_p", null],
    ]);
  });

  it("multi-drive type3 patrol that only inspects both drives' season dirs re-records nothing", async () => {
    const repository = new InMemoryWorkflowRepository();
    const season3: TrackedSeason = { ...trackedSeason(), totalEpisodes: 3, latestAiredEpisode: 3 };
    const statesWith = (codes: string[], prefix: string) =>
      createEpisodeStates({ trackedSeasonId: season3.id, seasonNumber: 1, totalEpisodes: 3, latestAiredEpisode: 3 }).map((ep) =>
        codes.includes(ep.episodeCode) ? { ...ep, obtained: true, verifiedFileIds: [`${prefix}_${ep.episodeCode}`] } : ep,
      );
    const execs: Record<string, FakeStorageExecutor> = { cs_115: new FakeStorageExecutor(), cs_uc: new FakeStorageExecutor() };
    // Each drive already has the show's Season 01 dir with its own episode in it.
    for (const [drive, code, parent] of [["cs_115", "S01E01", "115_tv_root"], ["cs_uc", "S01E02", "uc_tv_root"]] as const) {
      const exec = execs[drive]!;
      const showId = await exec.createDirectory({ name: "示例剧 (2024) {tmdb-100}", parentId: parent });
      const seasonDir = await exec.createDirectory({ name: "Season 01", parentId: showId });
      const prefix = drive === "cs_115" ? "f115" : "fuc";
      exec.listVideoFiles = async (dirId: string) =>
        dirId === seasonDir ? [{ id: `${prefix}_${code}`, storageDirectoryId: seasonDir, name: `示例剧.${code}.mkv`, sizeBytes: 1_000, episodeCode: code, providerFileId: `${prefix}_${code}` }] : [];
      await repository.saveWorkflowRunSnapshot({
        accountId: "acct_default",
        connectedStorageId: drive,
        title: tvTitle,
        season: { ...season3, storageDirectoryId: seasonDir },
        workflowRun: { id: `run_seed_${drive}`, kind: "type2_init", status: "partial", trackedSeasonId: season3.id, startedAt: "2026-11-01T00:00:00.000Z", finishedAt: "2026-11-01T00:00:00.000Z", auditEvents: [] },
        episodes: statesWith([code], prefix),
        resourceSnapshots: [],
        decisions: [],
        transferAttempts: [],
        notifications: [],
      });
      await repository.upsertEpisodeCopies([
        { trackedSeasonId: season3.id, episodeCode: code, storageId: drive, fileIds: [`${prefix}_${code}`], sizeBytes: 1_000, quality: null, runId: `run_seed_${drive}`, recordedAt: "2026-11-01T00:00:00.000Z" },
      ]);
    }
    const copiesBefore = await repository.listEpisodeCopies(season3.id);
    let step = 0;
    const tool = (name: string, input: unknown) => ({
      content: [{ type: "tool-call" as const, toolCallId: `call_${step}`, toolName: name, input: JSON.stringify(input) }],
      finishReason: { unified: "tool-calls" as const, raw: "tool-calls" as const }, usage: USAGE, warnings: [],
    });
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        step += 1;
        if (step === 1) return tool("inspectTargetDir", { season: 1 });
        if (step === 2) return tool("reportNoCoverage", { reason: "E03 not found" });
        return { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" as const }, usage: USAGE, warnings: [] };
      },
    });

    const result = await runType3MonitoringV2AndPersist({
      title: tvTitle,
      season: season3,
      episodes: statesWith(["S01E01"], "f115"),
      crossDriveObtained: ["S01E01", "S01E02"],
      categoryParentId: "115_tv_root",
      resourceProvider: emptyProvider(),
      storage: execs.cs_115!,
      model,
      repository,
      accountId: "acct_default",
      connectedStorageId: "cs_115",
      drives: [
        { storageId: "cs_115", provider: "pan115", label: "115 网盘", storage: execs.cs_115!, parents: { tv: "115_tv_root", anime: "115_anime_root", movies: "115_movies_root" }, space: { totalBytes: 10 * 1024 ** 4, usedBytes: 1 * 1024 ** 4 } },
        { storageId: "cs_uc", provider: "uc", label: "UC网盘", storage: execs.cs_uc!, parents: { tv: "uc_tv_root", anime: "uc_anime_root", movies: "uc_movies_root" }, space: { totalBytes: 6 * 1024 ** 4, usedBytes: 1 * 1024 ** 4 } },
      ],
      workflowRun: { id: "run_inspect_only", startedAt: "2026-11-07T00:11:00.000Z", finishedAt: null },
      now: () => "2026-11-07T00:12:00.000Z",
    });

    expect(result.status).toBe("no_coverage");
    // Both drives were counted as touched by the inspection…
    expect(result.touchedTargetDrives?.map((d) => d.storageId).sort()).toEqual(["cs_115", "cs_uc"]);
    // …yet no earlier copy was re-recorded under this run.
    expect(await repository.listEpisodeCopies(season3.id)).toEqual(copiesBefore);
  });
});
