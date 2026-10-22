import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolSet } from "ai";
import { buildSandboxToolSet } from "../src/acquisition-v2/agent-loop.js";
import { createTitleResearchTools, TITLE_RESEARCH_MAX_CALLS } from "../src/acquisition-v2/title-research.js";
import { buildTvAnimeSystemPrompt } from "../src/acquisition-v2/task-agents.js";
import { TaskSandbox } from "../src/acquisition-v2/sandbox.js";
import { FakeResourceProviderV2 } from "../src/acquisition-v2/fake-provider.js";
import { Storage115Simulator } from "../src/acquisition-v2/storage-115-simulator.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function okPayload(text: string): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }] } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

async function sandbox() {
  const provider = new FakeResourceProviderV2({ results: { x: [] } });
  const storage = new Storage115Simulator({ packs: {} });
  const stagingDirectoryId = await storage.createDirectory({ name: "staging", parentId: "root" });
  const season = await storage.createDirectory({ name: "Season 1", parentId: "root" });
  return new TaskSandbox({
    provider,
    storage,
    stagingDirectoryId,
    targetSeasonDirectoryIds: { 1: season },
    need: ["S01E01"],
  });
}

async function call(tools: ToolSet, name: string, args: unknown) {
  const execute = tools[name]?.execute as (input: unknown, options: unknown) => Promise<Record<string, unknown>>;
  return execute(args, { toolCallId: "t", messages: [] });
}

describe("acquisition agent web-reference tools", () => {
  it("are absent by default and on a staging-recovery run", async () => {
    const box = await sandbox();
    expect(buildSandboxToolSet(box).researchTitle).toBeUndefined();
    expect(buildSandboxToolSet(box, { titleResearch: { web: {} } }).researchTitle).toBeDefined();
    expect(
      buildSandboxToolSet(box, { stagingRecovery: true, titleResearch: { web: {} } }).researchTitle,
    ).toBeUndefined();
  });

  it("feeds web evidence back as reference-only, never as coverage", async () => {
    const fetchMock = vi.fn(async () =>
      okPayload(JSON.stringify({ results: [{ url: "https://a", title: "咒术回战 季", excerpts: ["第二季 E25-E47"] }] })),
    );
    const tools = createTitleResearchTools({ web: { fetch: fetchMock as unknown as typeof fetch } });
    const result = await call(tools, "researchTitle", { query: "咒术回战 第二季 对应第几集" });

    expect(result.referenceOnly).toBe(true);
    expect(String(result.untrustedWebEvidence)).toContain("E25-E47");
    expect(result).not.toHaveProperty("coverage");
    expect(result).not.toHaveProperty("candidate");
  });

  it("caps the combined budget across both tools", async () => {
    const fetchMock = vi.fn(async () => okPayload(JSON.stringify({ results: [{ url: "https://a", title: "t" }] })));
    const tools = createTitleResearchTools({ web: { fetch: fetchMock as unknown as typeof fetch } });

    for (let i = 0; i < TITLE_RESEARCH_MAX_CALLS; i += 1) {
      const result = await call(tools, "researchTitle", { query: "q" });
      expect(result).toHaveProperty("referenceOnly");
    }
    expect(await call(tools, "readTitleReference", { urls: ["https://a"] })).toHaveProperty(
      "error",
      expect.stringContaining("budget"),
    );
    expect(fetchMock).toHaveBeenCalledTimes(TITLE_RESEARCH_MAX_CALLS);
  });

  it("returns a tool error instead of throwing when search fails", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 500 }));
    const tools = createTitleResearchTools({ web: { fetch: fetchMock as unknown as typeof fetch } });
    const result = await call(tools, "researchTitle", { query: "q" });
    expect(result).toHaveProperty("error");
    expect(result).not.toHaveProperty("referenceOnly");
  });

  it("rejects non-public and credential-bearing URLs", () => {
    const tools = createTitleResearchTools({ web: {} });
    const schema = (tools.readTitleReference as unknown as { inputSchema: { safeParse: (v: unknown) => { success: boolean } } })
      .inputSchema;
    expect(schema.safeParse({ urls: ["file:///etc/passwd"] }).success).toBe(false);
    expect(schema.safeParse({ urls: ["ftp://example.org/x"] }).success).toBe(false);
    expect(schema.safeParse({ urls: ["https://user:pass@example.org/"] }).success).toBe(false);
    expect(schema.safeParse({ urls: ["https://example.org/page"] }).success).toBe(true);
  });
});

describe("fan-split season guidance", () => {
  it("is present only when web research is available, and names the worked example", () => {
    const without = buildTvAnimeSystemPrompt({});
    expect(without).not.toContain("OFFICIALLY-UNSEGMENTED");

    const withResearch = buildTvAnimeSystemPrompt({ titleResearch: { web: {} } });
    expect(withResearch).toContain("OFFICIALLY-UNSEGMENTED");
    expect(withResearch).toContain("S01E25-E47");
    expect(withResearch).toContain("S01E48-E59");
    expect(withResearch).toMatch(/参考|reference only/i);
    expect(withResearch).toMatch(/never report no-coverage|silently leaves a real gap/i);
  });
});
