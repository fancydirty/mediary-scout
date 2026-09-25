import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import {
  FakeResourceProvider,
  FakeStorageExecutor,
  InMemoryWorkflowRepository,
  queueMovieAcquisition,
  runQueuedMovieAcquisition,
  type JevJudge,
  type JevJudgeInput,
  type MediaTitle,
} from "../src/index.js";

const fixedNow = () => "2026-06-13T00:00:00.000Z";

const USAGE = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
} as const;

/** §6b#8: the film is already in 115, so the agent inspects, sees it, and marks
 *  MOVIE from that evidence — no search, no transfer. (There is no mechanical
 *  file-count no-op anymore; obtained is the agent's coverage.) */
function inspectAndMarkModel() {
  const steps = [
    { tool: "inspectTargetDir", input: {} },
    { tool: "markObtained", input: { codes: ["MOVIE"] } },
    { tool: "finish", input: {} },
  ];
  let i = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => {
      if (i < steps.length) {
        const s = steps[i]!;
        i += 1;
        return {
          content: [{ type: "tool-call" as const, toolCallId: `c${i}`, toolName: s.tool, input: JSON.stringify(s.input) }],
          finishReason: { unified: "tool-calls" as const, raw: "tool-calls" as const },
          usage: USAGE,
          warnings: [],
        };
      }
      return { content: [{ type: "text" as const, text: "已在库" }], finishReason: { unified: "stop" as const, raw: "stop" as const }, usage: USAGE, warnings: [] };
    },
  });
}

function movieTitle(): MediaTitle {
  return {
    id: "tmdb_movie_872585",
    tmdbId: 872585,
    type: "movie",
    title: "奥本海默",
    originalTitle: "Oppenheimer",
    year: 2023,
    aliases: ["Oppenheimer"],
  };
}

describe("movie acquisition command + worker", () => {
  it("queues a movie and blocks a duplicate while active (title lock)", async () => {
    const repository = new InMemoryWorkflowRepository();
    const first = await queueMovieAcquisition({
      title: movieTitle(),
      keyword: "奥本海默 4K",
      repository,
      createWorkflowRunId: () => "run_movie_1",
      now: fixedNow,
    });
    expect(first.status).toBe("queued");
    const second = await queueMovieAcquisition({
      title: movieTitle(),
      keyword: "奥本海默 4K",
      repository,
      createWorkflowRunId: () => "run_movie_2",
      now: fixedNow,
    });
    expect(second.status).toBe("already_running");
  });

  it("worker claims, runs, and persists a movie acquisition (already in 115 → agent marks from evidence → succeeded)", async () => {
    const repository = new InMemoryWorkflowRepository();
    const title = movieTitle();
    await queueMovieAcquisition({
      title,
      keyword: "奥本海默 4K",
      repository,
      createWorkflowRunId: () => "run_movie",
      now: fixedNow,
    });
    const storage = new FakeStorageExecutor();
    // Verify-or-create resolves the canonical `Title (Year)` movie dir; seed it
    // with the film already present so the run is a succeeded no-op.
    const movieDir = await storage.createDirectory({ name: `${title.title} (${title.year})`, parentId: "movies_root" });
    storage.seedDirectoryFiles(movieDir, [
      {
        id: "oppen_v",
        storageDirectoryId: movieDir,
        name: "Oppenheimer.2023.mkv",
        sizeBytes: 8_000_000_000,
        episodeCode: null,
        providerFileId: "oppen_v",
      },
    ]);

    const result = await runQueuedMovieAcquisition({
      repository,
      resourceProvider: new FakeResourceProvider({ keywordResults: {} }),
      storage,
      model: inspectAndMarkModel(),
      moviesParentDirectoryId: "movies_root",
      now: fixedNow,
    });

    expect(result.status).toBe("ran");
    const saved = await repository.getWorkflowRunSnapshot("run_movie");
    expect(saved?.workflowRun.kind).toBe("movie_init");
    expect(saved?.workflowRun.status).toBe("succeeded");
    expect(saved?.title.type).toBe("movie");
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
describe("runQueuedMovieAcquisition — the Jev prefilter reaches the engine", () => {
  it("runs the per-account judge over the film's candidates (worker → runner-v2 → movie workflow)", async () => {
    const repository = new InMemoryWorkflowRepository();
    const title = movieTitle();
    await queueMovieAcquisition({
      title,
      keyword: "奥本海默 4K",
      repository,
      createWorkflowRunId: () => "run_jev_movie",
      now: fixedNow,
    });
    const storage = new FakeStorageExecutor();
    const movieDir = await storage.createDirectory({ name: `${title.title} (${title.year})`, parentId: "movies_root" });
    storage.seedDirectoryFiles(movieDir, [
      {
        id: "oppen_v",
        storageDirectoryId: movieDir,
        name: "Oppenheimer.2023.mkv",
        sizeBytes: 8_000_000_000,
        episodeCode: null,
        providerFileId: "oppen_v",
      },
    ]);

    const seen: JevJudgeInput[] = [];
    const jevJudge: JevJudge = {
      judgeCandidates: async (input) => {
        seen.push(input);
        return { scores: {}, model: "m" };
      },
    };

    await runQueuedMovieAcquisition({
      repository,
      resourceProvider: new FakeResourceProvider({
        keywordResults: { [title.title]: [{ title: "奥本海默.Oppenheimer.2023.2160p.mkv" }] },
      }),
      storage,
      model: inspectAndMarkModel(),
      moviesParentDirectoryId: "movies_root",
      now: fixedNow,
      resolveAccountContext: async () => ({ jevJudge }),
    });

    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]!.target.kind).toBe("movie");
    expect(seen[0]!.target.title).toBe("奥本海默");
  });
});

/** Same chain guard for agent memory: enter at the WORKER so every hop is covered
 *  (TS does not excess-property-check spreads — the jevJudge 2026-09-20 lesson). The
 *  memory store is the repository itself; nothing extra is passed in. */
describe("runQueuedMovieAcquisition — agent memory reaches the engine", () => {
  it("the film's title memory is injected and read under its tmdb key (worker → runner-v2 → movie workflow)", async () => {
    const repository = new InMemoryWorkflowRepository();
    const title = movieTitle();
    await repository.upsertAgentMemory({
      accountId: "acct_default",
      titleKey: `tmdb_movie_${title.tmdbId}`,
      entry: { scope: "title", name: "prior-lesson", description: "上次的经验", kind: "search", body: "MEMORY-SENTINEL" },
      now: fixedNow(),
    });
    await queueMovieAcquisition({ title, keyword: "奥本海默 4K", repository, createWorkflowRunId: () => "run_mem_movie", now: fixedNow });
    const storage = new FakeStorageExecutor();
    const movieDir = await storage.createDirectory({ name: `${title.title} (${title.year})`, parentId: "movies_root" });
    storage.seedDirectoryFiles(movieDir, [
      { id: "oppen_v", storageDirectoryId: movieDir, name: "Oppenheimer.2023.mkv", sizeBytes: 8_000_000_000, episodeCode: null, providerFileId: "oppen_v" },
    ]);
    const systems: string[] = [];
    const inner = inspectAndMarkModel();
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        systems.push(JSON.stringify(options.prompt.find((m) => m.role === "system") ?? ""));
        return inner.doGenerate(options);
      },
    });
    await runQueuedMovieAcquisition({
      repository,
      resourceProvider: new FakeResourceProvider({ keywordResults: { [title.title]: [{ title: "奥本海默.Oppenheimer.2023.2160p.mkv" }] } }),
      storage,
      model,
      moviesParentDirectoryId: "movies_root",
      now: fixedNow,
    });
    expect(systems[0]).toContain("MEMORY-SENTINEL");
  });
});

describe("runQueuedMovieAcquisition — memory is tagged with the run's concrete drive", () => {
  it("a note written by the reflection carries the run's connectedStorageId (worker → runner-v2 → orchestrator)", async () => {
    const repository = new InMemoryWorkflowRepository();
    const title = movieTitle();
    await queueMovieAcquisition({ title, keyword: "奥本海默 4K", repository, createWorkflowRunId: () => "run_mem_drive", now: fixedNow, connectedStorageId: "cs_drive_A" });
    const storage = new FakeStorageExecutor();
    const movieDir = await storage.createDirectory({ name: `${title.title} (${title.year})`, parentId: "movies_root" });
    storage.seedDirectoryFiles(movieDir, [
      { id: "oppen_v", storageDirectoryId: movieDir, name: "Oppenheimer.2023.mkv", sizeBytes: 8_000_000_000, episodeCode: null, providerFileId: "oppen_v" },
    ]);
    const inner = inspectAndMarkModel();
    let wrote = false;
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        const sys = JSON.stringify(options.prompt.find((m) => m.role === "system") ?? "");
        if (sys.includes("reviewing an acquisition run")) {
          if (wrote) return { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" as const }, usage: { inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: undefined, text: undefined, reasoning: undefined } }, warnings: [] };
          wrote = true;
          return {
            content: [{ type: "tool-call" as const, toolCallId: "r1", toolName: "writeMemory", input: JSON.stringify({ scope: "title", name: "drive-note", description: "d", kind: "works", body: "证据" }) }],
            finishReason: { unified: "tool-calls" as const, raw: "tool-calls" as const },
            usage: { inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: undefined, text: undefined, reasoning: undefined } },
            warnings: [],
          };
        }
        return inner.doGenerate(options);
      },
    });
    await runQueuedMovieAcquisition({
      repository,
      resourceProvider: new FakeResourceProvider({ keywordResults: { [title.title]: [{ title: "奥本海默.Oppenheimer.2023.2160p.mkv" }] } }),
      storage,
      model,
      moviesParentDirectoryId: "movies_root",
      now: fixedNow,
    });
    const rows = await repository.listAgentMemories({ accountId: "acct_default", scope: "title", titleKey: `tmdb_movie_${title.tmdbId}` });
    expect(rows).toMatchObject([{ name: "drive-note", provider: "cs_drive_A" }]);
  });
});

describe("runQueuedMovieAcquisition — agent memory off switch", () => {
  it("an account that turned memory off gets no memory block and no reflection", async () => {
    const repository = new InMemoryWorkflowRepository();
    const title = movieTitle();
    await repository.upsertAgentMemory({
      accountId: "acct_default",
      titleKey: `tmdb_movie_${title.tmdbId}`,
      entry: { scope: "title", name: "prior-lesson", description: "d", kind: "search", body: "OFF-SENTINEL" },
      now: fixedNow(),
    });
    await queueMovieAcquisition({ title, keyword: "奥本海默 4K", repository, createWorkflowRunId: () => "run_mem_off", now: fixedNow });
    const storage = new FakeStorageExecutor();
    const movieDir = await storage.createDirectory({ name: `${title.title} (${title.year})`, parentId: "movies_root" });
    storage.seedDirectoryFiles(movieDir, [
      { id: "oppen_v", storageDirectoryId: movieDir, name: "Oppenheimer.2023.mkv", sizeBytes: 8_000_000_000, episodeCode: null, providerFileId: "oppen_v" },
    ]);
    const systems: string[] = [];
    const inner = inspectAndMarkModel();
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        systems.push(JSON.stringify(options.prompt.find((m) => m.role === "system") ?? ""));
        return inner.doGenerate(options);
      },
    });
    await runQueuedMovieAcquisition({
      repository,
      resourceProvider: new FakeResourceProvider({ keywordResults: { [title.title]: [{ title: "奥本海默.Oppenheimer.2023.2160p.mkv" }] } }),
      storage,
      model,
      moviesParentDirectoryId: "movies_root",
      now: fixedNow,
      resolveAccountContext: async () => ({ agentMemory: false }),
    });
    expect(systems.some((s) => s.includes("OFF-SENTINEL"))).toBe(false);
    expect(systems.some((s) => s.includes("reviewing an acquisition run"))).toBe(false);
  });
});
