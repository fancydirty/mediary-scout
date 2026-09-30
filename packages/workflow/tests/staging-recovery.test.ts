import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";
import {
  createEpisodeStates,
  FakeStorageExecutor,
  InMemoryWorkflowRepository,
  runQueuedStagingRecovery,
  type StorageExecutor,
} from "../src/index.js";
import { runAcquisitionV2Workflow } from "../src/acquisition-v2/workflow-v2.js";
import { runStagingRecoveryV2AndPersist } from "../src/runner-v2.js";
import { Storage115Simulator, type SimTreeFile } from "../src/acquisition-v2/storage-115-simulator.js";
import type { ResourceSnapshot } from "../src/domain.js";

const USAGE = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
} as const;

const FORBIDDEN = [
  "searchResources",
  "transferCandidate",
  "transferUntilLanded",
  "viewSubtitleSnapshot",
  "transferSubtitle",
  "writeMemory",
];

interface NamedFile {
  id: string;
  path: string;
  isVideo?: boolean;
  isSubtitle?: boolean;
}

function isNamedFile(value: unknown): value is NamedFile {
  return Boolean(value && typeof value === "object" && typeof (value as NamedFile).id === "string" && typeof (value as NamedFile).path === "string");
}

function toolValues(prompt: unknown, toolName: string): unknown[] {
  const values: unknown[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const record = node as Record<string, unknown>;
    if (record["type"] === "tool-result" && record["toolName"] === toolName) {
      const output = record["output"];
      if (output && typeof output === "object" && "value" in output) values.push((output as { value: unknown }).value);
      else values.push(output ?? record["result"]);
    }
    for (const value of Object.values(record)) visit(value);
  };
  visit(prompt);
  return values;
}

function asFiles(value: unknown): NamedFile[] {
  return Array.isArray(value) ? value.filter(isNamedFile) : [];
}

/** Move the staging videos the season does not already have, plus their subtitles. */
function fileIdsToMove(prompt: unknown): string[] {
  const staging = asFiles(toolValues(prompt, "inspectStaging").at(-1));
  const season = asFiles(toolValues(prompt, "inspectTargetDir").at(-1));
  const seasonVideos = new Set(season.filter((file) => file.isVideo).map((file) => file.path.split("/").pop()));
  const videos = staging.filter((file) => file.isVideo && !seasonVideos.has(file.path.split("/").pop()));
  const stems = new Set(videos.map((file) => (file.path.split("/").pop() ?? "").replace(/\.[^.]+$/, "")));
  const subtitles = staging.filter((file) => {
    if (!file.isSubtitle) return false;
    const stem = (file.path.split("/").pop() ?? "").replace(/\.[^.]+$/, "");
    return stems.has(stem);
  });
  return [...videos, ...subtitles].map((file) => file.id);
}

function recoveryModel(offered: Set<string>, failMove: boolean, sawPrompt: { value: boolean }) {
  let step = 0;
  return new MockLanguageModelV3({
    doGenerate: async (options: LanguageModelV3CallOptions) => {
      for (const tool of options.tools ?? []) {
        if (tool.type === "function") offered.add(tool.name);
      }
      step += 1;
      const text = JSON.stringify(options.prompt);
      if (text.includes("left over from an earlier run")) sawPrompt.value = true;
      const call = (name: string, input: unknown) => ({
        content: [{ type: "tool-call" as const, toolCallId: `c${step}`, toolName: name, input: JSON.stringify(input) }],
        finishReason: { unified: "tool-calls" as const, raw: "tool-calls" as const },
        usage: USAGE,
        warnings: [],
      });
      if (text.includes("MOVE_NOT_DONE") || text.includes("move failed")) return call("finish", {});
      if (step === 1) return call("inspectStaging", {});
      if (step === 2) return call("inspectTargetDir", { season: 1 });
      if (step === 3) {
        const fileIds = fileIdsToMove(options.prompt);
        if (fileIds.length === 0) throw new Error(`recovery model saw no file to move: ${text.slice(0, 1500)}`);
        return call("moveToSeason", { moves: [{ season: 1, fileIds }] });
      }
      if (!failMove && step === 4) return call("markObtained", { codes: ["S01E05"] });
      if (!failMove && step === 5) return call("discardStaging", {});
      return call("finish", {});
    },
  });
}

function asExecutor(sim: Storage115Simulator, failMove: boolean): { executor: StorageExecutor; created: string[]; removed: string[] } {
  const created: string[] = [];
  const removed: string[] = [];
  let moves = 0;
  const executor = {
    async createDirectory(input: { name: string; parentId: string }) {
      created.push(input.name);
      return sim.createDirectory(input);
    },
    async listChildDirectories(parentId: string) {
      const subs = await sim.listSubdirectories({ directoryId: parentId });
      return subs.filter((entry) => !entry.path.includes("/")).map((entry) => ({ id: entry.id, name: entry.path }));
    },
    async listTree(input: { directoryId: string }) {
      const files = await sim.listTree({ directoryId: input.directoryId });
      return files.map((file) => ({ path: file.path, providerFileId: file.id, sizeBytes: file.sizeBytes }));
    },
    async listSubdirectories(input: { directoryId: string }) {
      return sim.listSubdirectories(input);
    },
    async moveFiles(input: { fileIds: string[]; targetDirectoryId: string }) {
      moves += 1;
      if (failMove && moves === 1) throw new Error("PAN115_RATE_LIMIT: move failed");
      return sim.moveFiles(input);
    },
    async deleteFiles(input: { directoryId: string; fileIds: string[] }) {
      return sim.deleteFiles(input);
    },
    async removeDirectory(directoryId: string) {
      removed.push(directoryId);
      try {
        await sim.removeDirectory({ directoryId });
        return { removed: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("NOT_FOUND")) return { removed: true };
        throw error;
      }
    },
    async renameFile() {
      throw new Error("rename is not part of this recovery");
    },
  };
  return { executor: executor as unknown as StorageExecutor, created, removed };
}

async function stage(failMove: boolean) {
  const sim = new Storage115Simulator({
    packs: {
      have: { files: [{ path: "Show.S01E01.mkv", sizeBytes: 1000 }] },
      left: {
        files: [
          { path: "Show.S01E01.mkv", sizeBytes: 1000 },
          { path: "Show.S01E05.mkv", sizeBytes: 5000 },
          { path: "Show.S01E05.ass", sizeBytes: 20 },
        ],
      },
    },
  });
  const showId = await sim.createDirectory({ name: "Show (2024) {tmdb-7}", parentId: "root" });
  const seasonId = await sim.createDirectory({ name: "Season 01", parentId: showId });
  const stagingId = await sim.createDirectory({ name: "staging-old", parentId: showId });
  await sim.transferCandidate({ candidateId: "have", intoDirectoryId: seasonId });
  await sim.transferCandidate({ candidateId: "left", intoDirectoryId: stagingId });
  const seasonBefore = await sim.listTree({ directoryId: seasonId });
  const stagingBefore = await sim.listTree({ directoryId: stagingId });
  const { executor, created, removed } = asExecutor(sim, failMove);
  const repo = new InMemoryWorkflowRepository();
  const title = {
    id: "title_7",
    tmdbId: 7,
    type: "tv" as const,
    title: "Show",
    originalTitle: "Show",
    year: 2024,
    aliases: [] as string[],
  };
  const season = {
    id: "title_7_s1",
    mediaTitleId: title.id,
    seasonNumber: 1,
    status: "active" as const,
    qualityPreference: "1080p",
    storageDirectoryId: seasonId,
    totalEpisodes: 5,
    latestAiredEpisode: 5,
    latestAiredSource: "metadata" as const,
  };
  const episodes = createEpisodeStates({
    trackedSeasonId: season.id,
    seasonNumber: 1,
    totalEpisodes: 5,
    latestAiredEpisode: 5,
  }).map((episode) => (episode.episodeCode === "S01E01" ? { ...episode, obtained: true } : episode));
  await repo.saveWorkflowRunSnapshot({
    accountId: "acct",
    connectedStorageId: "drive",
    title,
    season,
    workflowRun: {
      id: "done",
      kind: "type3_monitor",
      status: "succeeded",
      trackedSeasonId: season.id,
      startedAt: "2026-09-26T00:00:00.000Z",
      finishedAt: "2026-09-26T01:00:00.000Z",
      auditEvents: [],
    },
    episodes,
    resourceSnapshots: [],
    decisions: [],
    transferAttempts: [],
    notifications: [],
  });
  await repo.reserveWorkflowRun({
    accountId: "acct",
    connectedStorageId: "drive",
    title,
    season,
    workflowRun: {
      id: "recovery-1",
      kind: "staging_recovery",
      status: "queued",
      trackedSeasonId: season.id,
      startedAt: "2026-09-28T03:00:00.000Z",
      finishedAt: null,
      auditEvents: [
        {
          type: "staging_recovery_queued",
          message: "queued",
          data: { stagingDirectoryId: stagingId, showDirectoryId: showId, seasonNumbers: [1] },
        },
      ],
    },
    episodes,
    resourceSnapshots: [],
    decisions: [],
    transferAttempts: [],
    notifications: [],
    keepCurrentEpisodes: true,
    requireTrackedSeason: true,
    blockIfTitleHasActiveRun: true,
  });
  let searches = 0;
  const resourceProvider = {
    async search(): Promise<ResourceSnapshot> {
      searches += 1;
      return { id: "snap", provider: "pansou", keyword: "Show", candidates: [], createdAt: "2026-09-28T03:00:00.000Z" };
    },
  };
  return { sim, repo, executor, created, removed, seasonId, stagingId, seasonBefore, stagingBefore, searches: () => searches, resourceProvider };
}

/**
 * Mirrors the 123 / 光鸭 / 天翼 executors: a write target must be a scope root, a
 * directory this executor created, or one it listed under an in-scope parent. A class
 * (not a plain object) so the recovery path is exercised with methods that use `this`.
 */
class DerivedScopeExecutor {
  private readonly inScope: Set<string>;

  constructor(
    private readonly inner: StorageExecutor,
    roots: string[],
  ) {
    this.inScope = new Set(roots);
  }

  private assertInScope(directoryId: string, action: string): void {
    if (!this.inScope.has(directoryId)) {
      throw new Error(`WRITE_SCOPE_VIOLATION: refusing to ${action} outside configured write scope; fileId=${directoryId}`);
    }
  }

  async listChildDirectories(parentId: string) {
    const parentInScope = this.inScope.has(parentId);
    const dirs = await this.inner.listChildDirectories!(parentId);
    if (parentInScope) for (const dir of dirs) this.inScope.add(dir.id);
    return dirs;
  }

  async listSubdirectories(input: { directoryId: string; maxDepth?: number }) {
    const parentInScope = this.inScope.has(input.directoryId);
    const dirs = await this.inner.listSubdirectories!(input);
    if (parentInScope) for (const dir of dirs) this.inScope.add(dir.id);
    return dirs;
  }

  async listTree(input: { directoryId: string; maxDepth?: number }) {
    return this.inner.listTree(input);
  }

  async createDirectory(input: { name: string; parentId: string }) {
    this.assertInScope(input.parentId, "create directory");
    const id = await this.inner.createDirectory(input);
    this.inScope.add(id);
    return id;
  }

  async moveFiles(input: { fileIds: string[]; targetDirectoryId: string }) {
    this.assertInScope(input.targetDirectoryId, "move files into");
    return this.inner.moveFiles!(input);
  }

  async deleteFiles(input: { directoryId: string; fileIds: string[] }) {
    this.assertInScope(input.directoryId, "delete files");
    return this.inner.deleteFiles!(input);
  }

  async removeDirectory(directoryId: string) {
    this.assertInScope(directoryId, "remove directory");
    return this.inner.removeDirectory(directoryId);
  }

  async renameFile(): Promise<never> {
    throw new Error("rename is not part of this recovery");
  }
}

describe("staging_recovery", () => {
  it("claims nothing while mayStartRun says no; the recovery stays queued", async () => {
    const staged = await stage(false);
    const result = await runQueuedStagingRecovery({
      repository: staged.repo,
      resourceProvider: staged.resourceProvider,
      storage: staged.executor,
      model: recoveryModel(new Set<string>(), false, { value: false }),
      now: () => "2026-09-28T04:00:00.000Z",
      mayStartRun: () => false,
    });
    expect(result).toEqual({ status: "idle" });
    const saved = await staged.repo.getWorkflowRunSnapshot("recovery-1", { accountId: "acct", connectedStorageId: "drive" });
    expect(saved?.workflowRun.status).toBe("queued");
  });

  it("moves the episode the season lacks, discards the duplicate with staging, and does not notify", async () => {
    const staged = await stage(false);
    const offered = new Set<string>();
    const sawPrompt = { value: false };
    const result = await runQueuedStagingRecovery({
      repository: staged.repo,
      resourceProvider: staged.resourceProvider,
      storage: staged.executor,
      model: recoveryModel(offered, false, sawPrompt),
      now: () => "2026-09-28T04:00:00.000Z",
    });
    expect(result.status).toBe("ran");
    expect(staged.searches()).toBe(0);
    expect(staged.created.some((name) => name.startsWith("staging"))).toBe(false);
    for (const name of FORBIDDEN) expect(offered.has(name)).toBe(false);
    expect(offered.has("inspectStaging")).toBe(true);
    expect(offered.has("moveToSeason")).toBe(true);
    expect(offered.has("discardStaging")).toBe(true);
    expect(sawPrompt.value).toBe(true);

    const saved = await staged.repo.getWorkflowRunSnapshot("recovery-1", { accountId: "acct", connectedStorageId: "drive" });
    expect(saved?.notifications).toEqual([]);
    expect(await staged.repo.listNotifications({ accountId: "acct" })).toEqual([]);
    expect(saved?.episodes.find((episode) => episode.episodeCode === "S01E05")?.obtained).toBe(true);
    expect(saved?.episodes.find((episode) => episode.episodeCode === "S01E01")?.obtained).toBe(true);
    const seasonAfter = await staged.sim.listTree({ directoryId: staged.seasonId });
    const seasonIds = seasonAfter.map((file) => file.id);
    for (const file of staged.seasonBefore) expect(seasonIds).toContain(file.id);
    const moved = staged.stagingBefore.find((file) => file.path.endsWith("S01E05.mkv"))!;
    const subtitle = staged.stagingBefore.find((file) => file.path.endsWith("S01E05.ass"))!;
    const duplicate = staged.stagingBefore.find((file) => file.path.endsWith("S01E01.mkv"))!;
    expect(seasonIds).toContain(moved.id);
    expect(seasonIds).toContain(subtitle.id);
    expect(seasonIds).not.toContain(duplicate.id);
    await expect(staged.sim.listTree({ directoryId: staged.stagingId })).rejects.toThrow(/NOT_FOUND/);
    expect(staged.removed).toContain(staged.stagingId);
  });

  it("on a derived-scope drive (123 / 光鸭 / 天翼) it reaches the leftover through the drive's category dirs", async () => {
    // 2026-09-30 production: the recovery adopted the janitor's ids without walking down
    // to them, so every move and delete was refused and the leftover stayed for good.
    const staged = await stage(false);
    const tvCategory = await staged.sim.createDirectory({ name: "TV", parentId: "root" });
    const storage = new DerivedScopeExecutor(staged.executor, [tvCategory, "root"]) as unknown as StorageExecutor;
    const result = await runQueuedStagingRecovery({
      repository: staged.repo,
      resourceProvider: staged.resourceProvider,
      storage,
      model: recoveryModel(new Set<string>(), false, { value: false }),
      now: () => "2026-09-28T04:00:00.000Z",
      // The drive's category dirs come from the per-account context, as in production.
      // The show sits under the second one ("root" stands in for the anime category).
      resolveAccountContext: async () => ({ storageParentDirectoryId: tvCategory, animeStorageParentDirectoryId: "root" }),
    });
    expect(result.status).toBe("ran");
    const saved = await staged.repo.getWorkflowRunSnapshot("recovery-1", { accountId: "acct", connectedStorageId: "drive" });
    expect(saved?.episodes.find((episode) => episode.episodeCode === "S01E05")?.obtained).toBe(true);
    const moved = staged.stagingBefore.find((file) => file.path.endsWith("S01E05.mkv"))!;
    expect((await staged.sim.listTree({ directoryId: staged.seasonId })).map((file) => file.id)).toContain(moved.id);
    await expect(staged.sim.listTree({ directoryId: staged.stagingId })).rejects.toThrow(/NOT_FOUND/);
  });

  it("keeps the staging dir when the move fails and does not mark the episode obtained", async () => {
    const staged = await stage(true);
    const offered = new Set<string>();
    const result = await runQueuedStagingRecovery({
      repository: staged.repo,
      resourceProvider: staged.resourceProvider,
      storage: staged.executor,
      model: recoveryModel(offered, true, { value: false }),
      now: () => "2026-09-28T04:00:00.000Z",
    });
    expect(result.status).toBe("ran");
    const saved = await staged.repo.getWorkflowRunSnapshot("recovery-1", { accountId: "acct", connectedStorageId: "drive" });
    expect(saved?.notifications).toEqual([]);
    expect(saved?.episodes.find((episode) => episode.episodeCode === "S01E05")?.obtained).toBe(false);
    expect(saved?.workflowRun.auditEvents.some((event) => event.type === "staging_kept_unmoved_files")).toBe(true);
    const seasonAfter = await staged.sim.listTree({ directoryId: staged.seasonId });
    expect(seasonAfter.map((file) => file.id).sort()).toEqual(staged.seasonBefore.map((file: SimTreeFile) => file.id).sort());
    const still = await staged.sim.listTree({ directoryId: staged.stagingId });
    expect(still.map((file) => file.id).sort()).toEqual(staged.stagingBefore.map((file) => file.id).sort());
    for (const name of FORBIDDEN) expect(offered.has(name)).toBe(false);
  });

  it("a model error before any tool call leaves the leftover in place, fails the run, and writes no notification", async () => {
    const staged = await stage(false);
    const result = await runQueuedStagingRecovery({
      repository: staged.repo,
      resourceProvider: staged.resourceProvider,
      storage: staged.executor,
      model: new MockLanguageModelV3({
        doGenerate: async () => {
          throw new Error("model exploded before any tool");
        },
      }),
      now: () => "2026-09-28T04:00:00.000Z",
    });
    expect(result.status).toBe("failed");
    expect(staged.removed).not.toContain(staged.stagingId);
    const still = await staged.sim.listTree({ directoryId: staged.stagingId });
    expect(still.map((file) => file.id).sort()).toEqual(staged.stagingBefore.map((file) => file.id).sort());
    const saved = await staged.repo.getWorkflowRunSnapshot("recovery-1", { accountId: "acct", connectedStorageId: "drive" });
    expect(saved?.workflowRun.status).toBe("failed");
    expect(saved?.notifications).toEqual([]);
    expect(await staged.repo.listNotifications({ accountId: "acct" })).toEqual([]);
    // Terminal: a later sweep can queue this dir again.
    expect(
      await staged.repo.findActiveStagingRecovery({
        accountId: "acct",
        connectedStorageId: "drive",
        stagingDirectoryId: staged.stagingId,
      }),
    ).toBeNull();
  });

  it("a transient error requeues the same run against the same leftover dir", async () => {
    const staged = await stage(false);
    const result = await runQueuedStagingRecovery({
      repository: staged.repo,
      resourceProvider: staged.resourceProvider,
      storage: staged.executor,
      model: new MockLanguageModelV3({
        doGenerate: async () => {
          throw new Error("socket hang up");
        },
      }),
      now: () => "2026-09-28T04:00:00.000Z",
    });
    expect(result).toMatchObject({ status: "ran", workflowRunId: "recovery-1", workflowStatus: "queued" });
    expect(staged.removed).not.toContain(staged.stagingId);
    const still = await staged.sim.listTree({ directoryId: staged.stagingId });
    expect(still.length).toBe(staged.stagingBefore.length);
    const active = await staged.repo.findActiveStagingRecovery({
      accountId: "acct",
      connectedStorageId: "drive",
      stagingDirectoryId: staged.stagingId,
    });
    expect(active?.workflowRun.id).toBe("recovery-1");
    expect(active?.workflowRun.auditEvents.some((event) => event.data?.["stagingDirectoryId"] === staged.stagingId)).toBe(true);
    expect(active?.notifications).toEqual([]);
  });

  it("a setup failure fails the claimed recovery instead of leaving it running", async () => {
    const repo = new InMemoryWorkflowRepository();
    await repo.saveWorkflowRunSnapshot({
      accountId: "acct",
      connectedStorageId: "drive",
      title: {
        id: "title_7",
        tmdbId: 7,
        type: "tv",
        title: "Show",
        originalTitle: "Show",
        year: 2024,
        aliases: [],
      },
      season: {
        id: "title_7_s1",
        mediaTitleId: "title_7",
        seasonNumber: 1,
        status: "active",
        qualityPreference: "1080p",
        storageDirectoryId: "season",
        totalEpisodes: 1,
        latestAiredEpisode: 1,
        latestAiredSource: "metadata",
      },
      workflowRun: {
        id: "recovery-setup",
        kind: "staging_recovery",
        status: "queued",
        trackedSeasonId: "title_7_s1",
        startedAt: "2026-09-28T03:00:00.000Z",
        finishedAt: null,
        auditEvents: [
          {
            type: "staging_recovery_queued",
            message: "queued",
            data: { stagingDirectoryId: "stg", showDirectoryId: "show", seasonNumbers: [1] },
          },
        ],
      },
      episodes: [],
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });
    const result = await runQueuedStagingRecovery({
      repository: repo,
      resourceProvider: {
        async search() {
          return { id: "snap", provider: "pansou", keyword: "Show", candidates: [], createdAt: "2026-09-28T03:00:00.000Z" };
        },
      },
      storage: {} as StorageExecutor,
      model: new MockLanguageModelV3({
        doGenerate: async () => {
          throw new Error("model should not be called");
        },
      }),
      resolveAccountContext: async () => {
        throw new Error("drive creds missing");
      },
      now: () => "2026-09-28T04:00:00.000Z",
    });
    expect(result).toMatchObject({ status: "failed", workflowRunId: "recovery-setup" });
    const saved = await repo.getWorkflowRunSnapshot("recovery-setup", { accountId: "acct", connectedStorageId: "drive" });
    expect(saved?.workflowRun.status).toBe("failed");
    expect(saved?.notifications).toEqual([]);
    expect(await repo.listNotifications({ accountId: "acct" })).toEqual([]);
  });

  it("a transient setup failure requeues the claimed recovery and writes no notification", async () => {
    const repo = new InMemoryWorkflowRepository();
    await repo.saveWorkflowRunSnapshot({
      accountId: "acct",
      connectedStorageId: "drive",
      title: {
        id: "title_7",
        tmdbId: 7,
        type: "tv",
        title: "Show",
        originalTitle: "Show",
        year: 2024,
        aliases: [],
      },
      season: {
        id: "title_7_s1",
        mediaTitleId: "title_7",
        seasonNumber: 1,
        status: "active",
        qualityPreference: "1080p",
        storageDirectoryId: "season",
        totalEpisodes: 1,
        latestAiredEpisode: 1,
        latestAiredSource: "metadata",
      },
      workflowRun: {
        id: "recovery-setup",
        kind: "staging_recovery",
        status: "queued",
        trackedSeasonId: "title_7_s1",
        startedAt: "2026-09-28T03:00:00.000Z",
        finishedAt: null,
        auditEvents: [],
      },
      episodes: [],
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });
    const result = await runQueuedStagingRecovery({
      repository: repo,
      resourceProvider: {
        async search() {
          return { id: "snap", provider: "pansou", keyword: "Show", candidates: [], createdAt: "2026-09-28T03:00:00.000Z" };
        },
      },
      storage: {} as StorageExecutor,
      model: new MockLanguageModelV3({
        doGenerate: async () => {
          throw new Error("model should not be called");
        },
      }),
      resolveAccountContext: async () => {
        throw new Error("socket hang up");
      },
      now: () => "2026-09-28T04:00:00.000Z",
    });
    expect(result).toMatchObject({ status: "ran", workflowRunId: "recovery-setup", workflowStatus: "queued" });
    const saved = await repo.getWorkflowRunSnapshot("recovery-setup", { accountId: "acct", connectedStorageId: "drive" });
    expect(saved?.workflowRun.status).toBe("queued");
    expect(saved?.notifications).toEqual([]);
  });

  it("a sibling season untracked while a two-season recovery runs stays untracked", async () => {
    const repo = new InMemoryWorkflowRepository();
    const scope = { accountId: "acct", connectedStorageId: "drive" };
    const title = {
      id: "title_7",
      tmdbId: 7,
      type: "tv" as const,
      title: "Show",
      originalTitle: "Show",
      year: 2024,
      aliases: [] as string[],
    };
    const storage = new FakeStorageExecutor();
    const showId = await storage.createDirectory({ name: "Show (2024) {tmdb-7}", parentId: "root" });
    const seasonDirs = [
      await storage.createDirectory({ name: "Season 01", parentId: showId }),
      await storage.createDirectory({ name: "Season 02", parentId: showId }),
    ];
    await storage.createDirectory({ name: "staging-old", parentId: showId });
    for (const seasonNumber of [1, 2] as const) {
      const season = {
        id: `title_7_s${seasonNumber}`,
        mediaTitleId: title.id,
        seasonNumber,
        status: "active" as const,
        qualityPreference: "1080p" as const,
        storageDirectoryId: seasonDirs[seasonNumber - 1]!,
        totalEpisodes: 1,
        latestAiredEpisode: 1,
        latestAiredSource: "metadata" as const,
      };
      const episodes = createEpisodeStates({
        trackedSeasonId: season.id,
        seasonNumber,
        totalEpisodes: 1,
        latestAiredEpisode: 1,
      }).map((episode) => ({ ...episode, obtained: true }));
      await repo.saveWorkflowRunSnapshot({
        ...scope,
        title,
        season,
        workflowRun: {
          id: `done-s${seasonNumber}`,
          kind: "type3_monitor",
          status: "succeeded",
          trackedSeasonId: season.id,
          startedAt: "2026-09-26T00:00:00.000Z",
          finishedAt: "2026-09-26T01:00:00.000Z",
          auditEvents: [],
        },
        episodes,
        resourceSnapshots: [],
        decisions: [],
        transferAttempts: [],
        notifications: [],
      });
    }
    const states = (await repo.listTrackedSeasonStates(scope)).sort((a, b) => a.season.seasonNumber - b.season.seasonNumber);
    await repo.saveWorkflowRunSnapshot({
      ...scope,
      title,
      season: states[0]!.season,
      workflowRun: {
        id: "recovery-ms",
        kind: "staging_recovery",
        status: "running",
        trackedSeasonId: states[0]!.season.id,
        startedAt: "2026-09-28T03:00:00.000Z",
        finishedAt: null,
        auditEvents: [
          {
            type: "staging_recovery_queued",
            message: "queued",
            data: { stagingDirectoryId: "stg", showDirectoryId: showId, seasonNumbers: [1, 2] },
          },
        ],
      },
      episodes: states[0]!.episodes,
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });
    let untracked: { status: string; removedSeasons: number } | undefined;
    await runStagingRecoveryV2AndPersist({
      title,
      seasons: states.map((state) => ({ season: state.season, episodes: state.episodes })),
      lockSeasonNumber: 1,
      lockAuditEvents: [],
      stagingRecovery: { showDirectoryId: showId, stagingDirectoryId: "stg" },
      categoryParentId: "unused",
      resourceProvider: {
        async search(): Promise<ResourceSnapshot> {
          return { id: "snap", provider: "pansou", keyword: "Show", candidates: [], createdAt: "2026-09-28T03:00:00.000Z" };
        },
      },
      storage,
      model: new MockLanguageModelV3({
        doGenerate: async () => {
          untracked ??= await repo.untrackTitle(7, scope, "tv", 2);
          return {
            content: [{ type: "text" as const, text: "stopping" }],
            finishReason: { unified: "stop" as const, raw: "stop" as const },
            usage: USAGE,
            warnings: [],
          };
        },
      }),
      repository: repo,
      ...scope,
      agentMemory: false,
      maxSteps: 1,
      workflowRun: { id: "recovery-ms", startedAt: "2026-09-28T03:00:00.000Z", finishedAt: null },
      now: () => "2026-09-28T04:00:00.000Z",
    });

    expect(untracked).toEqual({ status: "untracked", removedSeasons: 1 });
    const after = await repo.listTrackedSeasonStates(scope);
    expect(after.map((state) => state.season.seasonNumber)).toEqual([1]);
    expect(await repo.getWorkflowRunSnapshot("recovery-ms_s2", scope)).toBeNull();
    const lock = await repo.getWorkflowRunSnapshot("recovery-ms", scope);
    expect(lock?.workflowRun.kind).toBe("staging_recovery");
    expect(lock?.season.seasonNumber).toBe(1);
    expect(lock?.workflowRun.status).not.toBe("running");
  });

  it("untracking the lock season while the recovery runs stays untracked after it finishes", async () => {
    const repo = new InMemoryWorkflowRepository();
    const scope = { accountId: "acct", connectedStorageId: "drive" };
    const title = {
      id: "title_7",
      tmdbId: 7,
      type: "tv" as const,
      title: "Show",
      originalTitle: "Show",
      year: 2024,
      aliases: [] as string[],
    };
    const storage = new FakeStorageExecutor();
    const showId = await storage.createDirectory({ name: "Show (2024) {tmdb-7}", parentId: "root" });
    const seasonDir = await storage.createDirectory({ name: "Season 01", parentId: showId });
    const season = {
      id: "title_7_s1",
      mediaTitleId: title.id,
      seasonNumber: 1,
      status: "active" as const,
      qualityPreference: "1080p" as const,
      storageDirectoryId: seasonDir,
      totalEpisodes: 1,
      latestAiredEpisode: 1,
      latestAiredSource: "metadata" as const,
    };
    const episodes = createEpisodeStates({
      trackedSeasonId: season.id,
      seasonNumber: 1,
      totalEpisodes: 1,
      latestAiredEpisode: 1,
    });
    await repo.saveWorkflowRunSnapshot({
      ...scope,
      title,
      season,
      workflowRun: {
        id: "done-s1",
        kind: "type3_monitor",
        status: "succeeded",
        trackedSeasonId: season.id,
        startedAt: "2026-09-26T00:00:00.000Z",
        finishedAt: "2026-09-26T01:00:00.000Z",
        auditEvents: [],
      },
      episodes,
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });
    await repo.saveWorkflowRunSnapshot({
      ...scope,
      title,
      season,
      episodes,
      workflowRun: {
        id: "recovery-live",
        kind: "staging_recovery",
        status: "running",
        trackedSeasonId: season.id,
        startedAt: "2026-09-28T03:00:00.000Z",
        finishedAt: null,
        auditEvents: [],
      },
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });
    let untracked: { status: string; removedSeasons: number } | undefined;
    const result = await runStagingRecoveryV2AndPersist({
      title,
      seasons: [{ season, episodes }],
      lockSeasonNumber: 1,
      lockAuditEvents: [],
      stagingRecovery: { showDirectoryId: showId, stagingDirectoryId: "stg" },
      categoryParentId: "unused",
      resourceProvider: {
        async search(): Promise<ResourceSnapshot> {
          return { id: "snap", provider: "pansou", keyword: "Show", candidates: [], createdAt: "2026-09-28T03:00:00.000Z" };
        },
      },
      storage,
      model: new MockLanguageModelV3({
        doGenerate: async () => {
          untracked ??= await repo.untrackTitle(7, scope, "tv");
          return {
            content: [{ type: "text" as const, text: "stopping" }],
            finishReason: { unified: "stop" as const, raw: "stop" as const },
            usage: USAGE,
            warnings: [],
          };
        },
      }),
      repository: repo,
      ...scope,
      agentMemory: false,
      maxSteps: 1,
      workflowRun: { id: "recovery-live", startedAt: "2026-09-28T03:00:00.000Z", finishedAt: null },
      now: () => "2026-09-28T04:00:00.000Z",
    });
    expect(untracked).toEqual({ status: "untracked", removedSeasons: 1 });
    expect(result.status).not.toBe("failed");
    expect(await repo.listTrackedSeasonStates(scope)).toEqual([]);
    expect(await repo.getWorkflowRunSnapshot("recovery-live", scope)).toBeNull();
  });

  it("a recovery that throws after its season was untracked does not write the season back", async () => {
    const repo = new InMemoryWorkflowRepository();
    const scope = { accountId: "acct", connectedStorageId: "drive" };
    const title = {
      id: "title_7",
      tmdbId: 7,
      type: "tv" as const,
      title: "Show",
      originalTitle: "Show",
      year: 2024,
      aliases: [] as string[],
    };
    const season = {
      id: "title_7_s1",
      mediaTitleId: title.id,
      seasonNumber: 1,
      status: "active" as const,
      qualityPreference: "1080p" as const,
      storageDirectoryId: "season-dir",
      totalEpisodes: 1,
      latestAiredEpisode: 1,
      latestAiredSource: "metadata" as const,
    };
    const episodes = createEpisodeStates({
      trackedSeasonId: season.id,
      seasonNumber: 1,
      totalEpisodes: 1,
      latestAiredEpisode: 1,
    });
    await repo.saveWorkflowRunSnapshot({
      ...scope,
      title,
      season,
      workflowRun: {
        id: "done-s1",
        kind: "type3_monitor",
        status: "succeeded",
        trackedSeasonId: season.id,
        startedAt: "2026-09-26T00:00:00.000Z",
        finishedAt: "2026-09-26T01:00:00.000Z",
        auditEvents: [],
      },
      episodes,
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });
    await repo.reserveWorkflowRun({
      ...scope,
      title,
      season,
      episodes,
      workflowRun: {
        id: "recovery-throw",
        kind: "staging_recovery",
        status: "queued",
        trackedSeasonId: season.id,
        startedAt: "2026-09-28T03:00:00.000Z",
        finishedAt: null,
        auditEvents: [
          {
            type: "staging_recovery_queued",
            message: "queued",
            data: { stagingDirectoryId: "stg", showDirectoryId: "show", seasonNumbers: [1] },
          },
        ],
      },
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
      keepCurrentEpisodes: true,
      requireTrackedSeason: true,
    });
    let untracked: { status: string; removedSeasons: number } | undefined;
    const result = await runQueuedStagingRecovery({
      repository: repo,
      resourceProvider: {
        async search(): Promise<ResourceSnapshot> {
          return { id: "snap", provider: "pansou", keyword: "Show", candidates: [], createdAt: "2026-09-28T03:00:00.000Z" };
        },
      },
      storage: new FakeStorageExecutor(),
      model: new MockLanguageModelV3({
        doGenerate: async () => {
          untracked ??= await repo.untrackTitle(7, scope, "tv");
          throw new Error("model exploded after untrack");
        },
      }),
      now: () => "2026-09-28T04:00:00.000Z",
    });
    expect(untracked).toEqual({ status: "untracked", removedSeasons: 1 });
    expect(result.status).toBe("failed");
    expect(await repo.listTrackedSeasonStates(scope)).toEqual([]);
    expect(await repo.getWorkflowRunSnapshot("recovery-throw", scope)).toBeNull();
  });

  it("an ordinary acquisition that throws still discards its own staging", async () => {
    const executor = new FakeStorageExecutor();
    const created: Array<{ id: string; name: string }> = [];
    const removed: string[] = [];
    const createDirectory = executor.createDirectory.bind(executor);
    executor.createDirectory = async (input) => {
      const id = await createDirectory(input);
      created.push({ id, name: input.name });
      return id;
    };
    const removeDirectory = executor.removeDirectory.bind(executor);
    executor.removeDirectory = async (directoryId) => {
      removed.push(directoryId);
      return removeDirectory(directoryId);
    };
    await expect(
      runAcquisitionV2Workflow({
        provider: {
          async search() {
            return { id: "snap", provider: "pansou", keyword: "Show", candidates: [], createdAt: "2026-09-28T03:00:00.000Z" };
          },
        },
        executor,
        model: new MockLanguageModelV3({
          doGenerate: async () => {
            throw new Error("model exploded before any tool");
          },
        }),
        workflowRunId: "run-ordinary",
        title: { name: "Show", year: 2024, aliases: [], tmdbId: 42 },
        categoryParentId: "tv_root",
        seasons: [{ seasonNumber: 1, latestAiredEpisode: 1 }],
        qualityPreference: "1080p",
      }),
    ).rejects.toThrow(/model exploded before any tool/);
    const staging = created.find((dir) => dir.name === "staging-run-ordinary");
    expect(staging).toBeDefined();
    expect(removed).toContain(staging!.id);
  });
});
