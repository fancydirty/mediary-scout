import type { ToolSet } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSandboxToolSet, runAcquisitionAgent } from "../src/acquisition-v2/agent-loop.js";
import { resolveTitleResearch } from "../src/acquisition-v2/title-research.js";
import { TaskSandbox } from "../src/acquisition-v2/sandbox.js";
import { FakeResourceProviderV2 } from "../src/acquisition-v2/fake-provider.js";
import { Storage115Simulator } from "../src/acquisition-v2/storage-115-simulator.js";

const ENDPOINT = "https://search.parallel.ai/mcp";
const SOURCE = "https://example.org/silent-2022";
const USAGE = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
};

async function setup() {
  const provider = new FakeResourceProviderV2({ results: { 静雪: [{ id: "real-candidate", title: "静雪 2022 全集" }] } });
  const storage = new Storage115Simulator({ packs: {} });
  const stagingDirectoryId = await storage.createDirectory({ name: "staging", parentId: "root" });
  const seasonId = await storage.createDirectory({ name: "Season 1", parentId: "root" });
  const sandbox = new TaskSandbox({ provider, storage, stagingDirectoryId, targetSeasonDirectoryIds: { 1: seasonId }, need: ["S01E01"] });
  return { sandbox, provider };
}

async function call(tools: ToolSet, name: string, args: unknown, abortSignal?: AbortSignal) {
  const execute = tools[name]?.execute as (input: unknown, options: unknown) => Promise<Record<string, unknown>>;
  return execute(args, { toolCallId: "test", messages: [], ...(abortSignal ? { abortSignal } : {}) });
}

type Message = { id?: number; method: string; params?: { protocolVersion?: string; name?: string; arguments?: Record<string, unknown> } };
function mcpFixture() {
  const requests: Array<{ url: string; headers: Headers; message: Message | undefined }> = [];
  let toolResult: Record<string, unknown> = { content: [{ type: "text", text: `Silent (2022) is also known as 静雪. Source: ${SOURCE}` }] };
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
    const message = init?.body ? JSON.parse(String(init.body)) as Message : undefined;
    requests.push({ url: String(url), headers: new Headers(init?.headers), message });
    if (init?.method === "GET") return new Response(null, { status: 405 });
    if (!message || message.id === undefined) return new Response(null, { status: 202 });
    let result: unknown;
    if (message.method === "initialize") result = { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } };
    else if (message.method === "tools/list") result = { tools: ["web_search", "web_fetch"].map((name) => ({ name, inputSchema: { type: "object" } })) };
    else if (message.method === "tools/call") result = toolResult;
    else throw new Error(`Unexpected MCP method ${message.method}`);
    return Response.json({ jsonrpc: "2.0", id: message.id, result });
  }));
  return {
    requests,
    calls: () => requests.flatMap((r) => r.message?.method === "tools/call" ? [r.message.params!] : []),
    setResult: (result: Record<string, unknown>) => { toolResult = result; },
  };
}

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("optional title research through the maintained dispatcher", () => {
  it("preserves the default, explicit disables, deployment choice and recovery permissions without network", async () => {
    const network = vi.fn(); vi.stubGlobal("fetch", network);
    vi.stubEnv("MEDIA_TRACK_TITLE_RESEARCH", "");
    vi.stubEnv("PARALLEL_API_KEY", "ambient-key-must-not-enable-research");
    const { sandbox } = await setup();
    expect(buildSandboxToolSet(sandbox).researchTitle).toBeUndefined();
    vi.stubEnv("MEDIA_TRACK_TITLE_RESEARCH", "parallel");
    expect(buildSandboxToolSet(sandbox).researchTitle).toBeDefined();
    expect(buildSandboxToolSet(sandbox, { titleResearch: false }).researchTitle).toBeUndefined();
    expect(buildSandboxToolSet(sandbox, { stagingRecovery: true }).researchTitle).toBeUndefined();
    vi.stubEnv("MEDIA_TRACK_TITLE_RESEARCH", "off");
    expect(buildSandboxToolSet(sandbox).researchTitle).toBeUndefined();
    expect(buildSandboxToolSet(sandbox, { titleResearch: "parallel" }).researchTitle).toBeDefined();
    expect(resolveTitleResearch(undefined, { MEDIA_TRACK_TITLE_RESEARCH: "unknown" })).toBe(false);
    expect(network).not.toHaveBeenCalled();
  });

  it("feeds research and fetched evidence through an AI SDK loop into the existing resource search", async () => {
    const fixture = mcpFixture();
    vi.stubEnv("MEDIA_TRACK_TITLE_RESEARCH", "parallel");
    vi.stubEnv("PARALLEL_API_KEY", "must-not-be-sent");
    const { sandbox, provider } = await setup();
    const search = vi.spyOn(provider, "search");
    let step = 0;
    const model = new MockLanguageModelV3({ doGenerate: async ({ prompt }) => {
      step += 1;
      const history = JSON.stringify(prompt);
      let toolName: string; let input: unknown;
      if (step === 1) { toolName = "researchTitle"; input = { query: "Silent 2022 Japanese drama alternate titles" }; }
      else if (step === 2) {
        expect(history).toContain("untrustedWebEvidence"); expect(history).toContain(SOURCE);
        toolName = "readTitleReference"; input = { urls: [SOURCE] };
      } else if (step === 3) {
        // A scripted model, not an inference-quality claim: choose the alias
        // from the tool result that the real AI SDK loop supplied to this turn.
        const alias = history.match(/also known as ([^ .]+)\./)?.[1];
        expect(alias).toBe("静雪"); toolName = "searchResources"; input = { keyword: alias };
      } else {
        expect(history).toContain("real-candidate");
        return { content: [{ type: "text" as const, text: "Found matching resource evidence" }], finishReason: { unified: "stop" as const, raw: "stop" }, usage: USAGE, warnings: [] };
      }
      return { content: [{ type: "tool-call" as const, toolCallId: `c${step}`, toolName, input: JSON.stringify(input) }], finishReason: { unified: "tool-calls" as const, raw: "tool-calls" }, usage: USAGE, warnings: [] };
    } });
    const result = await runAcquisitionAgent({ sandbox, model, system: "Acquire Silent (2022). Research is reference only.", prompt: "Existing title search was weak.", maxSteps: 5 });
    expect(search).toHaveBeenCalledWith("静雪");
    expect(result.coverage.obtained).toEqual([]); // web evidence never means obtained
    expect(fixture.calls().map((c) => c.name)).toEqual(["web_search", "web_fetch"]);
    expect(fixture.calls()[1]!.arguments!.urls).toEqual([SOURCE]);
    for (const request of fixture.requests) {
      expect(request.url).toBe(ENDPOINT);
      expect(request.headers.get("user-agent")).toBe("mediary-scout/1.0 (+https://github.com/fancydirty/mediary-scout)");
      expect(request.headers.has("authorization")).toBe(false);
    }
    expect(fixture.requests.some((r) => r.message?.method === "tools/list")).toBe(true);
    const tools = buildSandboxToolSet(sandbox);
    expect(await call(tools, "transferCandidate", { snapshotId: "web", candidateId: SOURCE })).toHaveProperty("error");
  });

  it("keeps task IDs across search, fetch, retry and follow-up while isolating interleaved tasks and reset", async () => {
    const fixture = mcpFixture();
    const a = buildSandboxToolSet((await setup()).sandbox, { titleResearch: "parallel" });
    const b = buildSandboxToolSet((await setup()).sandbox, { titleResearch: "parallel" });
    await Promise.all([call(a, "researchTitle", { query: "Silent 2022 alternate title" }), call(b, "researchTitle", { query: "Legal High 2012 alternate title" })]);
    const first = fixture.calls();
    const aId = first.find((c) => String(c.arguments!.search_queries).includes("Silent"))!.arguments!.session_id;
    const bId = first.find((c) => String(c.arguments!.search_queries).includes("Legal"))!.arguments!.session_id;
    expect(aId).toMatch(/^[0-9a-f-]{36}$/); expect(bId).not.toBe(aId);
    fixture.setResult({ isError: true, content: [{ type: "text", text: "Anonymous quota exceeded" }] });
    expect(await call(a, "readTitleReference", { urls: [SOURCE] })).toHaveProperty("error", "Anonymous quota exceeded");
    fixture.setResult({ content: [{ type: "text", text: "Source confirms 静雪" }] });
    await Promise.all([call(a, "readTitleReference", { urls: [SOURCE] }), call(b, "researchTitle", { query: "Legal High alternate title follow-up" })]);
    await call(a, "researchTitle", { query: "Silent translated title follow-up" });
    const calls = fixture.calls();
    expect(calls.filter((c) => c.name === "web_fetch").map((c) => c.arguments!.session_id)).toEqual([aId, aId]);
    expect(calls.at(-1)!.arguments!.session_id).toBe(aId);
    expect(calls.find((c) => String(c.arguments!.search_queries).includes("follow-up") && String(c.arguments!.search_queries).includes("Legal"))!.arguments!.session_id).toBe(bId);
    const reset = buildSandboxToolSet((await setup()).sandbox, { titleResearch: "parallel" });
    await call(reset, "researchTitle", { query: "Silent 2022 alternate title" });
    expect(fixture.calls().at(-1)!.arguments!.session_id).not.toBe(aId);
    expect(fixture.calls().at(-1)!.arguments!.session_id).not.toBe(bId);
  });

  it("caps combined calls and keeps research failures separate from resource evidence", async () => {
    const fixture = mcpFixture(); const { sandbox } = await setup();
    const tools = buildSandboxToolSet(sandbox, { titleResearch: "parallel" });
    fixture.setResult({ isError: true, content: [{ type: "text", text: "Search unavailable" }] });
    expect(await call(tools, "researchTitle", { query: "Silent 2022" })).toHaveProperty("error", "Search unavailable");
    fixture.setResult({ content: [] });
    expect(await call(tools, "readTitleReference", { urls: [SOURCE] })).toHaveProperty("error", "Parallel returned no title evidence");
    for (let i = 0; i < 2; i += 1) await call(tools, "researchTitle", { query: "Silent 2022" });
    expect(await call(tools, "researchTitle", { query: "Silent 2022" })).toHaveProperty("error", expect.stringContaining("budget exhausted"));
    expect(fixture.calls()).toHaveLength(4);
    expect(await call(tools, "searchResources", { keyword: "静雪" })).toHaveProperty("snapshot");
  });

  it("aborts discovery/network on the overall deadline and caller cancellation", async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const seen: AbortSignal[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
      const signal = init!.signal!; seen.push(signal);
      return new Promise<Response>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }));
    const tools = buildSandboxToolSet((await setup()).sandbox, { titleResearch: "parallel" });
    const pending = call(tools, "researchTitle", { query: "Silent 2022" });
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
    deadline.abort(new Error("Research deadline elapsed"));
    expect(await pending).toHaveProperty("error", expect.stringContaining("deadline"));
    expect(timeout).toHaveBeenCalledWith(20_000); expect(seen[0]!.aborted).toBe(true);
    timeout.mockRestore();
    const caller = new AbortController();
    const cancelled = call(tools, "readTitleReference", { urls: [SOURCE] }, caller.signal);
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(1));
    caller.abort(new Error("Caller cancelled"));
    expect(await cancelled).toHaveProperty("error", expect.stringContaining("cancelled"));
    expect(seen[1]!.aborted).toBe(true);
    const before = seen.length;
    expect(await call(tools, "researchTitle", { query: "Silent" }, caller.signal)).toHaveProperty("error", "Title research cancelled");
    expect(seen).toHaveLength(before);
  });

  it.each([401, 429, 500])("surfaces HTTP %i without an automatic retry or fallback", async (status) => {
    const fixture = mcpFixture(); const goodFetch = globalThis.fetch;
    let failed = false;
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      const message = init?.body ? JSON.parse(String(init.body)) as Message : undefined;
      if (message?.method === "tools/call" && !failed) { failed = true; return new Response("Provider refused", { status }); }
      return goodFetch(url, init);
    });
    const tools = buildSandboxToolSet((await setup()).sandbox, { titleResearch: "parallel" });
    expect(await call(tools, "researchTitle", { query: "Silent 2022" })).toHaveProperty("error");
    expect(fixture.calls()).toHaveLength(0);
    expect(await call(tools, "researchTitle", { query: "Silent 2022" })).toHaveProperty("referenceOnly", true);
    expect(fixture.calls()).toHaveLength(1);
  });

  it("rejects malformed MCP results instead of treating them as title evidence", async () => {
    const fixture = mcpFixture();
    fixture.setResult({ content: [{ type: "text", text: 123 }] });
    const tools = buildSandboxToolSet((await setup()).sandbox, { titleResearch: "parallel" });
    const result = await call(tools, "researchTitle", { query: "Silent 2022" });
    expect(result).toHaveProperty("error");
    expect(result).not.toHaveProperty("referenceOnly");
  });

  it.each(["not-a-url", "file:///tmp/private", "https://user:password@example.org/", "ftp://example.org/"])("rejects invalid reference URL %s through the AI SDK caller", async (url) => {
    const network = vi.fn(); vi.stubGlobal("fetch", network);
    const { sandbox } = await setup(); let step = 0;
    const model = new MockLanguageModelV3({ doGenerate: async () => {
      step += 1;
      if (step === 1) return { content: [{ type: "tool-call" as const, toolCallId: "bad-url", toolName: "readTitleReference", input: JSON.stringify({ urls: [url] }) }], finishReason: { unified: "tool-calls" as const, raw: "tool-calls" }, usage: USAGE, warnings: [] };
      return { content: [{ type: "text" as const, text: "Invalid URL refused" }], finishReason: { unified: "stop" as const, raw: "stop" }, usage: USAGE, warnings: [] };
    } });
    await runAcquisitionAgent({ sandbox, model, titleResearch: "parallel", system: "Research a title", prompt: "Check the source", maxSteps: 2 });
    expect(network).not.toHaveBeenCalled();
  });
});
