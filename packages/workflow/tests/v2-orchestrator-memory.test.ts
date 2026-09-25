import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { runAcquisitionV2 } from "../src/acquisition-v2/orchestrator.js";
import type { ResourceProvider } from "../src/ports.js";
import { FakeStorageExecutor } from "../src/fakes.js";
import { InMemoryWorkflowRepository } from "../src/repository.js";

const USAGE = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
} as const;
const tool = (name: string, input: unknown, i: number) => ({
  content: [{ type: "tool-call" as const, toolCallId: `c${i}`, toolName: name, input: JSON.stringify(input) }],
  finishReason: { unified: "tool-calls" as const, raw: "tool-calls" as const },
  usage: USAGE,
  warnings: [],
});
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], finishReason: { unified: "stop" as const, raw: "stop" as const }, usage: USAGE, warnings: [] });

const provider: ResourceProvider = {
  search: async ({ keyword }) => ({ id: `snap_${keyword}`, provider: "pansou", keyword, candidates: [], createdAt: "2026-09-25T00:00:00.000Z" }),
};

describe("runAcquisitionV2 — agent memory", () => {
  it("injects this work's memory into the run, then a reflection turn writes a new one under the SAME work", async () => {
    const store = new InMemoryWorkflowRepository();
    await store.upsertAgentMemory({ accountId: "acct_1", titleKey: "tmdb_movie_1241918", entry: { scope: "title", name: "old-note", description: "上次的经验", kind: "search", body: "上次搜 X 0 命中" }, now: "2026-09-20T00:00:00.000Z" });
    await store.upsertAgentMemory({ accountId: "acct_1", titleKey: "tmdb_movie_999", entry: { scope: "title", name: "other-work", description: "别的片", kind: "search", body: "不该出现" }, now: "2026-09-20T00:00:00.000Z" });
    await store.upsertAgentMemory({ accountId: "acct_1", titleKey: null, entry: { scope: "global", name: "guangya-empty", description: "光鸭分享常列不出文件", kind: "drive", body: "global body" }, now: "2026-09-20T00:00:00.000Z" });

    const systems: string[] = [];
    let i = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        const sys = JSON.stringify(options.prompt.find((m) => m.role === "system") ?? "");
        systems.push(sys);
        i += 1;
        const isReflection = sys.includes("reviewing an acquisition run");
        if (!isReflection) {
          if (i === 1) return tool("searchResources", { keyword: "出入平安 2025" }, i);
          if (i === 2) return tool("reportNoCoverage", { reason: "none" }, i);
          return text("done");
        }
        if (!systems.slice(0, -1).some((s) => s.includes("reviewing an acquisition run"))) {
          return tool("writeMemory", { scope: "title", name: "no-2025-year", description: "2024 年的片", kind: "search", body: "搜「出入平安 2025」0 命中" }, i);
        }
        return text("nothing more");
      },
    });

    const result = await runAcquisitionV2({
      provider,
      executor: new FakeStorageExecutor({ directories: { staging: [], movie: [] } }),
      model,
      workflowRunId: "run-mem",
      target: { kind: "movie", title: "出入平安", aliases: [], year: 2024, qualityPreference: "4K", tmdbId: 1241918 },
      stagingDirectoryId: "staging",
      targetMovieDirectoryId: "movie",
      memory: { store, accountId: "acct_1", now: () => "2026-09-25T00:00:00.000Z" },
    });

    const main = systems[0]!;
    expect(main).toContain("old-note");
    expect(main).toContain("上次搜 X 0 命中");
    expect(main).toContain("guangya-empty");
    expect(main).not.toContain("global body"); // index only
    expect(main).not.toContain("other-work"); // another work's memory never leaks in
    const rows = await store.listAgentMemories({ accountId: "acct_1", scope: "title", titleKey: "tmdb_movie_1241918" });
    expect(rows.map((r) => r.name).sort()).toEqual(["no-2025-year", "old-note"]);
    expect(rows.find((r) => r.name === "old-note")!.lastUsedAt).toBe("2026-09-25T00:00:00.000Z");
    expect(result.auditEvents.some((e) => e.type === "memory_written")).toBe(true);
    expect(result.coverage.coverageMet).toBe(false);
  });

  it("no memory option → no memory block, no reflection call", async () => {
    let calls = 0;
    const systems: string[] = [];
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        calls += 1;
        systems.push(JSON.stringify(options.prompt.find((m) => m.role === "system") ?? ""));
        if (calls === 1) return tool("searchResources", { keyword: "出入平安" }, calls);
        if (calls === 2) return tool("reportNoCoverage", { reason: "none" }, calls);
        return text("done");
      },
    });
    await runAcquisitionV2({
      provider,
      executor: new FakeStorageExecutor({ directories: { staging: [], movie: [] } }),
      model,
      workflowRunId: "run-nomem",
      target: { kind: "movie", title: "出入平安", aliases: [], year: 2024, qualityPreference: "4K" },
      stagingDirectoryId: "staging",
      targetMovieDirectoryId: "movie",
    });
    expect(systems.some((s) => s.includes("reviewing an acquisition run"))).toBe(false);
    expect(systems[0]).not.toContain("AGENT MEMORY");
  });

  it("a failing memory store never breaks the acquisition", async () => {
    const broken = new InMemoryWorkflowRepository();
    broken.listAgentMemories = async () => { throw new Error("db down"); };
    let calls = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        calls += 1;
        if (calls === 1) return tool("searchResources", { keyword: "出入平安" }, calls);
        if (calls === 2) return tool("reportNoCoverage", { reason: "none" }, calls);
        return text("done");
      },
    });
    const result = await runAcquisitionV2({
      provider,
      executor: new FakeStorageExecutor({ directories: { staging: [], movie: [] } }),
      model,
      workflowRunId: "run-broken",
      target: { kind: "movie", title: "出入平安", aliases: [], year: 2024, qualityPreference: "4K", tmdbId: 1241918 },
      stagingDirectoryId: "staging",
      targetMovieDirectoryId: "movie",
      memory: { store: broken, accountId: "acct_1" },
    });
    expect(result.coverage.missing).toEqual(["MOVIE"]);
  });
});

describe("runAcquisitionV2 — reflection digest is best-effort (Copilot #272 r7)", () => {
  it("a digest that throws (malformed outside data) never fails the run; reflection still gets a minimal digest", async () => {
    const store = new InMemoryWorkflowRepository();
    const badProvider: ResourceProvider = {
      // A candidate whose title is not a string — the digest's .slice() would throw.
      search: async ({ keyword }) => ({
        id: `snap_${keyword}`,
        provider: "pansou",
        keyword,
        candidates: [{ id: "x", provider: "pansou", title: 42 as unknown as string, sizeBytes: 1, providerPayload: {} } as never],
        createdAt: "2026-09-25T00:00:00.000Z",
      }),
    };
    let reflectionPrompt = "";
    let i = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        const sys = JSON.stringify(options.prompt.find((m) => m.role === "system") ?? "");
        i += 1;
        if (sys.includes("reviewing an acquisition run")) {
          reflectionPrompt = JSON.stringify(options.prompt.filter((m) => m.role === "user"));
          return text("nothing");
        }
        if (i === 1) return tool("reportNoCoverage", { reason: "none" }, i);
        return text("done");
      },
    });
    const result = await runAcquisitionV2({
      provider: badProvider,
      executor: new FakeStorageExecutor({ directories: { staging: [], movie: [] } }),
      model,
      workflowRunId: "run-bad",
      target: { kind: "movie", title: "出入平安", aliases: [], year: 2024, qualityPreference: "4K", tmdbId: 1241918 },
      stagingDirectoryId: "staging",
      targetMovieDirectoryId: "movie",
      memory: { store, accountId: "acct_1", now: () => "2026-09-25T00:00:00.000Z" },
    });
    expect(result.coverage.coverageMet).toBe(false);
    expect(reflectionPrompt).toMatch(/details unavailable/);
  });
});

describe("runAcquisitionV2 — the prompt says which drive this run is on (Copilot #273 r4)", () => {
  it("renders the current drive next to the drive-tagged notes", async () => {
    const store = new InMemoryWorkflowRepository();
    await store.upsertAgentMemory({ accountId: "acct_1", titleKey: "tmdb_movie_1241918", entry: { scope: "title", name: "src", description: "d", kind: "resource", body: "b", provider: "cs_guangya_x" }, now: "2026-09-20T00:00:00.000Z" });
    let system = "";
    let i = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        const sys = JSON.stringify(options.prompt.find((m) => m.role === "system") ?? "");
        i += 1;
        if (!sys.includes("reviewing an acquisition run") && !system) system = sys;
        if (i === 1) return tool("reportNoCoverage", { reason: "none" }, i);
        return text("done");
      },
    });
    await runAcquisitionV2({
      provider,
      executor: new FakeStorageExecutor({ directories: { staging: [], movie: [] } }),
      model,
      workflowRunId: "run-drive",
      target: { kind: "movie", title: "出入平安", aliases: [], year: 2024, qualityPreference: "4K", tmdbId: 1241918 },
      stagingDirectoryId: "staging",
      targetMovieDirectoryId: "movie",
      storageProvider: "pan115",
      memory: { store, accountId: "acct_1", drive: "cs_115_y", now: () => "2026-09-25T00:00:00.000Z" },
    });
    expect(system).toContain("You are on drive cs_115_y");
    expect(system).toContain("[drive: cs_115_y] or [drive: pan115]");
    expect(system).toContain("[drive: cs_guangya_x]");
  });
});

describe("runAcquisitionV2 — upgrade: brand-tagged notes stay editable by that brand's drive (Copilot #273 r5)", () => {
  it("a reflection on drive cs_115_y can refine a note tagged pan115 (retagged), but not one tagged guangya", async () => {
    const store = new InMemoryWorkflowRepository();
    await store.upsertAgentMemory({ accountId: "acct_1", titleKey: "tmdb_movie_1241918", entry: { scope: "title", name: "old-115", description: "d", kind: "resource", body: "旧", provider: "pan115" }, now: "2026-09-20T00:00:00.000Z" });
    await store.upsertAgentMemory({ accountId: "acct_1", titleKey: "tmdb_movie_1241918", entry: { scope: "title", name: "old-gy", description: "d", kind: "resource", body: "光鸭", provider: "guangya" }, now: "2026-09-20T00:00:00.000Z" });
    let i = 0;
    let r = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        const sys = JSON.stringify(options.prompt.find((m) => m.role === "system") ?? "");
        i += 1;
        if (sys.includes("reviewing an acquisition run")) {
          r += 1;
          if (r === 1) return tool("writeMemory", { scope: "title", name: "old-115", description: "d", kind: "resource", body: "新" }, i);
          if (r === 2) return tool("writeMemory", { scope: "title", name: "old-gy", description: "d", kind: "resource", body: "115 覆盖" }, i);
          return text("done");
        }
        if (i === 1) return tool("reportNoCoverage", { reason: "none" }, i);
        return text("done");
      },
    });
    await runAcquisitionV2({
      provider,
      executor: new FakeStorageExecutor({ directories: { staging: [], movie: [] } }),
      model,
      workflowRunId: "run-upgrade",
      target: { kind: "movie", title: "出入平安", aliases: [], year: 2024, qualityPreference: "4K", tmdbId: 1241918 },
      stagingDirectoryId: "staging",
      targetMovieDirectoryId: "movie",
      storageProvider: "pan115",
      memory: { store, accountId: "acct_1", drive: "cs_115_y", now: () => "2026-09-25T00:00:00.000Z" },
    });
    const rows = await store.listAgentMemories({ accountId: "acct_1", scope: "title", titleKey: "tmdb_movie_1241918" });
    expect(rows.find((m) => m.name === "old-115")).toMatchObject({ body: "新", provider: "cs_115_y" });
    expect(rows.find((m) => m.name === "old-gy")).toMatchObject({ body: "光鸭", provider: "guangya" });
  });
});
