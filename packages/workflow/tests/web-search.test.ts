import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clampQueryForProvider,
  isDeepSeekEndpoint,
  renderWebHits,
  resolveWebSearchVendor,
  webFetchPages,
  webSearch,
} from "../src/web-search.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("web search vendor routing", () => {
  it("uses DeepSeek only when the endpoint is DeepSeek's own API and a key is present", () => {
    expect(isDeepSeekEndpoint("https://api.deepseek.com")).toBe(true);
    expect(isDeepSeekEndpoint("https://api.deepseek.com/v1")).toBe(true);
    expect(isDeepSeekEndpoint("https://api.deepseek.com.cn.evil.example")).toBe(false);
    expect(isDeepSeekEndpoint("https://api.openai.com/v1")).toBe(false);
    expect(isDeepSeekEndpoint("not a url")).toBe(false);
    expect(isDeepSeekEndpoint(undefined)).toBe(false);

    expect(resolveWebSearchVendor({ llmBaseURL: "https://api.deepseek.com", llmApiKey: "sk-x" })).toBe("deepseek");
    // A DeepSeek endpoint without a key cannot authenticate — fall back.
    expect(resolveWebSearchVendor({ llmBaseURL: "https://api.deepseek.com" })).toBe("parallel");
    // A BYO OpenAI-compatible endpoint is not DeepSeek, key or not.
    expect(resolveWebSearchVendor({ llmBaseURL: "https://api.moonshot.cn/v1", llmApiKey: "sk-x" })).toBe("parallel");
    expect(resolveWebSearchVendor({})).toBe("parallel");
  });
});

describe("Parallel anonymous Search MCP", () => {
  it("posts JSON-RPC tools/call and parses the nested tool text into hits", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                results: [
                  { url: "https://a.example/1", title: "咒术回战 第二季", excerpts: ["E25-E47"] },
                  { url: "https://b.example/2", title: "死灭回游", excerpt: "E48-E59" },
                ],
              }),
            },
          ],
        },
      }),
    );

    const hits = await webSearch("咒术回战 第二季 对应第几集", { fetch: fetchMock as unknown as typeof fetch });

    expect(hits).toEqual([
      { title: "咒术回战 第二季", url: "https://a.example/1", snippet: "E25-E47" },
      { title: "死灭回游", url: "https://b.example/2", snippet: "E48-E59" },
    ]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://search.parallel.ai/mcp");
    const body = JSON.parse(String(init.body));
    expect(body.method).toBe("tools/call");
    expect(body.params.name).toBe("web_search");
    expect(body.params.arguments.search_queries).toEqual(["咒术回战 第二季 对应第几集"]);
    // Anonymous: never sends an Authorization header toward a third party.
    expect(new Headers(init.headers).has("authorization")).toBe(false);
  });

  it("treats an MCP isError result and a non-2xx status as failures", async () => {
    const failing = vi.fn(async () =>
      jsonResponse({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: "quota" }] } }),
    );
    await expect(webSearch("q", { fetch: failing as unknown as typeof fetch })).rejects.toThrow();

    const http = vi.fn(async () => new Response("nope", { status: 429 }));
    await expect(webSearch("q", { fetch: http as unknown as typeof fetch })).rejects.toThrow(/429/);
  });

  it("returns no hits for an empty query without touching the network", async () => {
    const fetchMock = vi.fn();
    expect(await webSearch("   ", { fetch: fetchMock as unknown as typeof fetch })).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("DeepSeek official search", () => {
  it("posts to {baseURL}/v1/tools/search with the user's own bearer key", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        results: [{ url: "https://c.example", title: "静雪", summary: "Silent (2022) 的中文名" }],
      }),
    );

    const hits = await webSearch("Silent 2022 中文名", {
      llmBaseURL: "https://api.deepseek.com/v1/",
      llmApiKey: "sk-deepseek",
      fetch: fetchMock as unknown as typeof fetch,
    });

    expect(hits).toEqual([{ title: "静雪", url: "https://c.example", snippet: "Silent (2022) 的中文名" }]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.deepseek.com/v1/tools/search");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer sk-deepseek");
    expect(JSON.parse(String(init.body))).toMatchObject({ query: "Silent 2022 中文名", count: 6 });
  });

  it("returns an empty list on no_matches rather than throwing", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }));
    expect(
      await webSearch("nothing", {
        llmBaseURL: "https://api.deepseek.com",
        llmApiKey: "sk",
        fetch: fetchMock as unknown as typeof fetch,
      }),
    ).toEqual([]);
  });
});

describe("renderWebHits", () => {
  it("numbers hits, keeps links, and truncates long evidence", () => {
    const rendered = renderWebHits([
      { title: "A", url: "https://a", snippet: "first" },
      { title: "B", url: "", snippet: "" },
    ]);
    expect(rendered).toContain("1. A — https://a\nfirst");
    expect(rendered).toContain("2. B");

    const long = renderWebHits([{ title: "A", url: "https://a", snippet: "x".repeat(500) }], 100);
    expect(long.length).toBeLessThanOrEqual(101);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("clampQueryForProvider", () => {
  it("keeps short queries untouched and truncates by code point, not UTF-16 unit", () => {
    expect(clampQueryForProvider("咒术回战")).toBe("咒术回战");

    // 200 CJK chars must become exactly 128 — never 64 code units.
    const long = "测".repeat(200);
    expect([...clampQueryForProvider(long)]).toHaveLength(128);

    // An astral emoji is ONE code point but TWO UTF-16 units: cutting by length
    // would split the surrogate pair and send invalid text.
    const emoji = "😀".repeat(140);
    const clamped = clampQueryForProvider(emoji);
    expect([...clamped]).toHaveLength(128);
    expect(clamped).not.toContain("\uFFFD");
    expect(clamped.endsWith("😀")).toBe(true);
  });
});

describe("webFetchPages — reading the source page", () => {
  it("calls Parallel's web_fetch (not a search) and returns page text", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: "第三季：第49集至第60集" }] },
      }),
    );
    const pages = await webFetchPages(["https://a.example/x"], { fetch: fetchMock as unknown as typeof fetch });

    expect(pages).toEqual([{ url: "https://a.example/x", title: "https://a.example/x", content: "第三季：第49集至第60集" }]);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.params.name).toBe("web_fetch");
    expect(body.params.arguments.urls).toEqual(["https://a.example/x"]);
  });

  it("uses DeepSeek's /v1/tools/fetch with the user's key", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ title: "MAL", content: "Episodes: 12" }),
    );
    const pages = await webFetchPages(["https://b.example"], {
      llmBaseURL: "https://api.deepseek.com/v1",
      llmApiKey: "sk-d",
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(pages).toEqual([{ url: "https://b.example", title: "MAL", content: "Episodes: 12" }]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.deepseek.com/v1/tools/fetch");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer sk-d");
  });

  it("keeps the pages that load when one URL fails", async () => {
    let n = 0;
    const fetchMock = vi.fn(async () => {
      n += 1;
      if (n === 1) return new Response("nope", { status: 404 });
      return jsonResponse({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "ok" }] } });
    });
    const pages = await webFetchPages(["https://dead.example", "https://live.example"], {
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(pages.map((p) => p.url)).toEqual(["https://live.example"]);
  });
});
