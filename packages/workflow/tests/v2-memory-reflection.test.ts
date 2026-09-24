import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { runMemoryReflection, buildReflectionDigest } from "../src/acquisition-v2/agent-loop.js";
import { TaskSandbox } from "../src/acquisition-v2/sandbox.js";
import { FakeResourceProviderV2 } from "../src/acquisition-v2/fake-provider.js";
import { InMemoryWorkflowRepository } from "../src/repository.js";

const USAGE = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
} as const;

function sandboxWith(store = new InMemoryWorkflowRepository()) {
  return {
    store,
    sandbox: new TaskSandbox({
      provider: new FakeResourceProviderV2({ results: {} }),
      need: ["MOVIE"],
      memory: { store, accountId: "acct_1", titleKey: "tmdb_movie_1", runId: "run-1", now: () => "2026-09-25T00:00:00.000Z" },
    }),
  };
}

describe("runMemoryReflection", () => {
  it("exposes ONLY the memory tools and persists what the model writes", async () => {
    const { sandbox, store } = sandboxWith();
    const seenTools: string[][] = [];
    let call = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        seenTools.push((options.tools ?? []).map((t) => (t as { name: string }).name).sort());
        call += 1;
        if (call === 1) {
          return {
            content: [{ type: "tool-call" as const, toolCallId: "w", toolName: "writeMemory", input: JSON.stringify({ scope: "title", name: "no-2025-year", description: "2026 首播", kind: "search", body: "搜「X 2025」0 命中" }) }],
            finishReason: { unified: "tool-calls" as const, raw: "tool-calls" as const }, usage: USAGE, warnings: [],
          };
        }
        return { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" as const }, usage: USAGE, warnings: [] };
      },
    });
    const out = await runMemoryReflection({ sandbox, model, digest: "facts", memory: { title: [], globalIndex: [] } });
    expect(seenTools[0]).toEqual(["deleteMemory", "readMemory", "writeMemory"]);
    expect(out).toMatchObject({ ran: true, changes: 1 });
    expect(await store.listAgentMemories({ accountId: "acct_1", scope: "title", titleKey: "tmdb_movie_1" })).toHaveLength(1);
  });

  it("never throws: a model failure is swallowed and reported as skipped", async () => {
    const { sandbox } = sandboxWith();
    const model = new MockLanguageModelV3({ doGenerate: async () => { throw new Error("upstream 500"); } });
    const out = await runMemoryReflection({ sandbox, model, digest: "facts", memory: { title: [], globalIndex: [] } });
    expect(out.ran).toBe(false);
    expect(out.skipped).toMatch(/upstream 500/);
  });

  it("a sandbox without memory binding is skipped without calling the model", async () => {
    const sandbox = new TaskSandbox({ provider: new FakeResourceProviderV2({ results: {} }), need: [] });
    let calls = 0;
    const model = new MockLanguageModelV3({ doGenerate: async () => { calls += 1; throw new Error("x"); } });
    const out = await runMemoryReflection({ sandbox, model, digest: "facts", memory: { title: [], globalIndex: [] } });
    expect(out).toMatchObject({ ran: false, skipped: "memory disabled" });
    expect(calls).toBe(0);
  });

  it("the reflection prompt carries the digest, the existing memory and the what-to-write rules", async () => {
    const { sandbox } = sandboxWith();
    let system = "", prompt = "";
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        system = JSON.stringify(options.prompt.find((m) => m.role === "system"));
        prompt = JSON.stringify(options.prompt.filter((m) => m.role === "user"));
        return { content: [{ type: "text" as const, text: "nothing" }], finishReason: { unified: "stop" as const, raw: "stop" as const }, usage: USAGE, warnings: [] };
      },
    });
    await runMemoryReflection({
      sandbox, model, digest: "KEYWORD 出入平安 2025 → 0 hits",
      memory: { title: [{ name: "old-note", kind: "search", description: "d", body: "b", updatedAt: "2026-09-01T00:00:00.000Z" }], globalIndex: [] },
    });
    expect(prompt).toContain("KEYWORD 出入平安 2025 → 0 hits");
    expect(prompt).toContain("old-note");
    expect(system).toMatch(/evidence/i);
    expect(system).toMatch(/nothing worth/i);
  });
});

describe("buildReflectionDigest", () => {
  it("summarizes keywords with hit counts, transfers with outcome, and the final coverage", () => {
    const digest = buildReflectionDigest({
      snapshots: [
        { keyword: "出入平安", candidates: [{ title: "a" }, { title: "b" }], prefilter: { dropped: [{}], nsfwDropped: [{}, {}] } },
        { keyword: "出入平安 2025", candidates: [] },
      ] as never,
      attempts: [
        { candidateId: "c1", status: "failed", providerMessage: "分享已失效" },
        { candidateId: "c2", status: "succeeded", providerMessage: "", materializedFileIds: ["f"] },
      ] as never,
      candidateTitle: (id) => (id === "c2" ? "出入平安 2160p" : "出入平安 1080p"),
      coverage: { coverageMet: true, obtained: ["MOVIE"], missing: [] },
      auditEvents: [],
    });
    expect(digest).toContain("出入平安 2025");
    expect(digest).toMatch(/出入平安 2025.*0/);
    expect(digest).toMatch(/出入平安 2160p.*succeeded/);
    expect(digest).toContain("分享已失效");
    expect(digest).toMatch(/coverage.*MOVIE/i);
    expect(digest).toMatch(/prefilter dropped 1 .*nsfw 2/);
  });
});
