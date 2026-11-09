import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { inferSeasonFileEpisodeCode, runReplaceRequestV2AndPersist, runType3MonitoringV2AndPersist } from "../src/runner-v2.js";
import { FakeStorageExecutor } from "../src/fakes.js";
import { InMemoryWorkflowRepository } from "../src/repository.js";
import { createEpisodeStates, type MediaTitle, type ResourceSnapshot, type TrackedSeason } from "../src/domain.js";
import type { AcquisitionDriveContext, ResourceProvider } from "../src/ports.js";

const USAGE = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
} as const;

describe("inferSeasonFileEpisodeCode — attribution-only reading of a file name", () => {
  it.each([
    // Real names from 伟大的长征 on UC / Quark that used to read as nothing.
    ["38~4K.mp4", "S01E38"],
    ["50~4K.mkv", "S01E50"],
    ["52 4K.mkv", "S01E52"],
    ["CZZLZDWS-45.mkv", "S01E45"],
    // Already handled before.
    ["28.mkv", "S01E28"],
    ["EP03.mkv", "S01E03"],
    ["伟大的长征.S01E34.第34集.2160p.WEB-DL.H265.DDP 5.1 2Audios.mkv", "S01E34"],
    ["Show.2160p.H265.DDP5.1-07.mkv", "S01E07"],
    // Nothing, or more than one number left: no guess.
    ["高清版.mkv", null],
    ["伟大的长征 2026 4K.mkv", null],
    ["三体2 38.mkv", null],
    // A dotted title number is not an audio layout: still two numbers, no guess.
    ["三体2.38.mkv", null],
    ["Show AAC2.0 12.mkv", "S01E12"],
  ])("%s → %s", (name, expected) => {
    expect(inferSeasonFileEpisodeCode(name, 1, null)).toBe(expected);
  });
});

const tvTitle = { id: "tmdb_tv_297253", tmdbId: 297253, type: "tv", title: "伟大的长征", year: 2026, aliases: [] } as unknown as MediaTitle;
const season: TrackedSeason = {
  id: "tmdb_tv_297253_s1",
  mediaTitleId: "tmdb_tv_297253",
  seasonNumber: 1,
  status: "active",
  qualityPreference: "4K",
  storageDirectoryId: "",
  totalEpisodes: 60,
  latestAiredEpisode: 53,
  latestAiredSource: "metadata",
};

function emptyProvider(): ResourceProvider {
  return {
    search: async ({ keyword }): Promise<ResourceSnapshot> => ({ id: "snap_empty", provider: "pansou", keyword, candidates: [], createdAt: "2026-11-08T22:00:00.000Z" }),
  };
}

/** Three drives, each already holding the show's Season 01 dir with the given file names
 *  (`null`: the drive has no folder for the show at all). */
async function threeDrives(filesByDrive: Record<"cs_115" | "cs_uc" | "cs_quark", string[] | null>): Promise<AcquisitionDriveContext[]> {
  const meta = {
    cs_115: { provider: "pan115", label: "115 网盘", root: "115_tv" },
    cs_uc: { provider: "uc", label: "UC网盘", root: "uc_tv" },
    cs_quark: { provider: "quark", label: "夸克网盘", root: "qk_tv" },
  } as const;
  const drives: AcquisitionDriveContext[] = [];
  for (const id of ["cs_115", "cs_uc", "cs_quark"] as const) {
    const exec = new FakeStorageExecutor();
    const names = filesByDrive[id];
    if (names === null) {
      exec.listVideoFiles = async () => [];
      drives.push({
        storageId: id, provider: meta[id].provider, label: meta[id].label, storage: exec,
        parents: { tv: meta[id].root, anime: `${meta[id].root}_anime`, movies: `${meta[id].root}_movies` },
        space: { totalBytes: 10 * 1024 ** 4, usedBytes: 1 * 1024 ** 4 },
      });
      continue;
    }
    const show = await exec.createDirectory({ name: "伟大的长征 (2026) {tmdb-297253}", parentId: meta[id].root });
    const dir = await exec.createDirectory({ name: "Season 01", parentId: show });
    const files = names.map((name, i) => ({ id: `${id}_f${i}`, storageDirectoryId: dir, name, sizeBytes: 1_000, episodeCode: null, providerFileId: `${id}_f${i}` }));
    exec.listVideoFiles = async (dirId: string) => (dirId === dir ? files : []);
    drives.push({
      storageId: id,
      provider: meta[id].provider,
      label: meta[id].label,
      storage: exec,
      parents: { tv: meta[id].root, anime: `${meta[id].root}_anime`, movies: `${meta[id].root}_movies` },
      space: { totalBytes: 10 * 1024 ** 4, usedBytes: 1 * 1024 ** 4 },
    });
  }
  return drives;
}

function inspectThenMark(codes: string[]) {
  let step = 0;
  const tool = (name: string, input: unknown) => ({
    content: [{ type: "tool-call" as const, toolCallId: `call_${step}`, toolName: name, input: JSON.stringify(input) }],
    finishReason: { unified: "tool-calls" as const, raw: "tool-calls" as const },
    usage: USAGE,
    warnings: [],
  });
  return new MockLanguageModelV3({
    doGenerate: async () => {
      step += 1;
      if (step === 1) return tool("inspectTargetDir", { season: 1 });
      if (step === 2 && codes.length > 0) return tool("markObtained", { codes });
      if (step <= 3) return tool("finish", {});
      return { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" as const }, usage: USAGE, warnings: [] };
    },
  });
}

async function seed115(repository: InMemoryWorkflowRepository): Promise<void> {
  const episodes = createEpisodeStates({ trackedSeasonId: season.id, seasonNumber: 1, totalEpisodes: 60, latestAiredEpisode: 53 }).map((ep) =>
    ep.episodeCode === "S01E01" ? { ...ep, obtained: true, verifiedFileIds: ["cs_115_f0"] } : ep,
  );
  await repository.saveWorkflowRunSnapshot({
    accountId: "acct_default",
    connectedStorageId: "cs_115",
    title: tvTitle,
    season,
    workflowRun: { id: "run_seed", kind: "type2_init", status: "partial", trackedSeasonId: season.id, startedAt: "2026-11-01T00:00:00.000Z", finishedAt: "2026-11-01T00:00:00.000Z", auditEvents: [] },
    episodes,
    resourceSnapshots: [],
    decisions: [],
    transferAttempts: [],
    notifications: [],
  });
}

async function patrol(repository: InMemoryWorkflowRepository, drives: AcquisitionDriveContext[], codes: string[], runId: string) {
  const local = (await repository.getTrackedSeasonState(season.id, { accountId: "acct_default", connectedStorageId: "cs_115" }))!.episodes;
  const union = (await repository.obtainedEpisodesForSeason(season.id, "acct_default")).filter((c) => c.obtained).map((c) => c.episodeCode);
  return runType3MonitoringV2AndPersist({
    title: tvTitle,
    season,
    episodes: local,
    crossDriveObtained: union,
    categoryParentId: "115_tv",
    resourceProvider: emptyProvider(),
    storage: drives[0]!.storage,
    model: inspectThenMark(codes),
    repository,
    accountId: "acct_default",
    connectedStorageId: "cs_115",
    drives,
    workflowRun: { id: runId, startedAt: "2026-11-08T22:00:00.000Z", finishedAt: null },
    now: () => "2026-11-08T22:02:00.000Z",
  });
}

async function obtainedOn(repository: InMemoryWorkflowRepository, drive: string): Promise<string[] | undefined> {
  return (await repository.getTrackedSeasonState(season.id, { accountId: "acct_default", connectedStorageId: drive }))?.episodes
    .filter((e) => e.obtained)
    .map((e) => e.episodeCode);
}

describe("a mark on an opaquely named file is kept on the drive that has it (伟大的长征 daily repeat)", () => {
  it("places each marked episode on its drive, so the next patrol does not report it as new again", async () => {
    const repository = new InMemoryWorkflowRepository();
    await seed115(repository);
    const drives = await threeDrives({
      cs_115: ["伟大的长征.S01E01.第01集.2160p.mkv"],
      cs_uc: ["38~4K.mp4", "52 4K.mkv"],
      cs_quark: ["CZZLZDWS-45.mkv"],
    });

    await patrol(repository, drives, ["S01E38", "S01E45", "S01E52"], "run_day1");

    expect(await obtainedOn(repository, "cs_115")).toEqual(["S01E01"]);
    expect(await obtainedOn(repository, "cs_uc")).toEqual(["S01E38", "S01E52"]);
    expect(await obtainedOn(repository, "cs_quark")).toEqual(["S01E45"]);
    const copies = await repository.listEpisodeCopies(season.id);
    expect(copies.map((c) => [c.episodeCode, c.storageId, c.fileIds])).toEqual([
      ["S01E38", "cs_uc", ["cs_uc_f0"]],
      ["S01E45", "cs_quark", ["cs_quark_f0"]],
      ["S01E52", "cs_uc", ["cs_uc_f1"]],
    ]);

    // Next day the three are had: not missing, so not reported as 新增 again.
    const day2 = await patrol(repository, drives, [], "run_day2");
    expect((day2.notification.report?.newlyObtained ?? []).filter((code) => ["S01E38", "S01E45", "S01E52"].includes(code))).toEqual([]);
  });

  it("an episode no file name names goes to the drive whose files name nothing, not nowhere", async () => {
    const repository = new InMemoryWorkflowRepository();
    await seed115(repository);
    const drives = await threeDrives({
      cs_115: ["伟大的长征.S01E01.第01集.2160p.mkv"],
      cs_uc: ["38~4K.mp4", "高清版.mkv"],
      cs_quark: [],
    });

    await patrol(repository, drives, ["S01E38", "S01E40"], "run_fallback");

    expect(await obtainedOn(repository, "cs_uc")).toEqual(["S01E38", "S01E40"]);
    expect(await obtainedOn(repository, "cs_115")).toEqual(["S01E01"]);
    const union = (await repository.obtainedEpisodesForSeason(season.id, "acct_default")).filter((c) => c.obtained).map((c) => c.episodeCode);
    expect(union).toEqual(["S01E01", "S01E38", "S01E40"]);
  });

  it("an episode no drive's files account for still lands on the primary — state and copy alike", async () => {
    const repository = new InMemoryWorkflowRepository();
    await seed115(repository);
    // 115 has no folder for the show this run; the other two hold only what their names say.
    const drives = await threeDrives({ cs_115: null, cs_uc: ["38~4K.mp4"], cs_quark: ["CZZLZDWS-45.mkv"] });

    await patrol(repository, drives, ["S01E38", "S01E40"], "run_primary_fallback");

    expect(await obtainedOn(repository, "cs_uc")).toEqual(["S01E38"]);
    expect(await obtainedOn(repository, "cs_115")).toEqual(["S01E01", "S01E40"]);
    const copies = await repository.listEpisodeCopies(season.id);
    expect(copies.map((c) => [c.episodeCode, c.storageId])).toEqual([
      ["S01E38", "cs_uc"],
      ["S01E40", "cs_115"],
    ]);
  });

  it("a replace run that lands nothing hands none of the drive's earlier episodes to another drive", async () => {
    const repository = new InMemoryWorkflowRepository();
    const held = createEpisodeStates({ trackedSeasonId: season.id, seasonNumber: 1, totalEpisodes: 60, latestAiredEpisode: 53 }).map((ep) =>
      ["S01E01", "S01E02", "S01E03"].includes(ep.episodeCode) ? { ...ep, obtained: true, verifiedFileIds: [`old_${ep.episodeCode}`] } : ep,
    );
    await repository.saveWorkflowRunSnapshot({
      accountId: "acct_default", connectedStorageId: "cs_115", title: tvTitle, season,
      workflowRun: { id: "run_seed", kind: "type2_init", status: "partial", trackedSeasonId: season.id, startedAt: "2026-11-01T00:00:00.000Z", finishedAt: "2026-11-01T00:00:00.000Z", auditEvents: [] },
      episodes: held, resourceSnapshots: [], decisions: [], transferAttempts: [], notifications: [],
    });
    // Opaque names everywhere; UC has the most files whose names name nothing.
    const drives = await threeDrives({ cs_115: ["a.mkv", "b.mkv", "c.mkv"], cs_uc: ["w.mkv", "x.mkv", "y.mkv", "z.mkv"], cs_quark: null });

    await runReplaceRequestV2AndPersist({
      title: tvTitle,
      seasons: [{ season, episodes: held }],
      categoryParentId: "115_tv",
      resourceProvider: emptyProvider(),
      storage: drives[0]!.storage,
      model: inspectThenMark([]),
      repository,
      accountId: "acct_default",
      connectedStorageId: "cs_115",
      drives,
      workflowRun: { id: "run_replace", startedAt: "2026-11-08T22:00:00.000Z", finishedAt: null },
      now: () => "2026-11-08T22:02:00.000Z",
      lockSeasonNumber: 1,
      lockAuditEvents: [],
      userRequest: {
        requestedEpisodes: ["S01E01"],
        prompt: { messages: [{ body: "E01 换一版", episodeTags: ["S01E01"], createdAt: "2026-11-08T21:00:00.000Z" }], rejected: [], pending: [] },
        rejectedStore: { list: async () => [], add: async () => undefined },
      },
    });

    expect(await obtainedOn(repository, "cs_uc") ?? []).toEqual([]);
    expect(await obtainedOn(repository, "cs_115")).toEqual(["S01E01", "S01E02", "S01E03"]);
    expect((await repository.listEpisodeCopies(season.id)).filter((c) => c.storageId === "cs_uc")).toEqual([]);
  });
});
