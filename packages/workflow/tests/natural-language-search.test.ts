import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { parseResolvedTitles, resolveTitles } from "../src/natural-language-search.js";
import { getSearchPageView, InMemoryMediaSearchCache, stripSeasonMarkers } from "../src/search-view.js";
import type { MediaSearchCandidate, MediaSearchProvider } from "../src/search-view.js";
import type { WorkflowRepository } from "../src/repository.js";

const USAGE = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
} as const;

function textModel(text: string) {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text" as const, text }],
      finishReason: { unified: "stop" as const, raw: "stop" as const },
      usage: USAGE,
      warnings: [],
    }),
  });
}

const TV: MediaSearchCandidate = {
  tmdbId: 95479,
  mediaType: "tv",
  title: "咒术回战",
  originalTitle: "Jujutsu Kaisen",
  year: 2020,
  overview: "",
  posterPath: null,
  backdropPath: null,
  seasons: [{ seasonNumber: 1, episodeCount: 59, latestAiredEpisode: 59 }],
};

function repositoryStub(): WorkflowRepository {
  return {
    findTrackedSeasonState: async () => null,
    listTrackedSeasonStates: async () => [],
    listTrackedSeasonStatesForTitle: async () => [],
  } as unknown as WorkflowRepository;
}

function providerOf(map: Record<string, MediaSearchCandidate[]>): MediaSearchProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    searchMedia: async ({ query }) => {
      calls.push(query);
      return map[query] ?? [];
    },
  };
}

describe("stripSeasonMarkers", () => {
  it.each([
    ["咒术回战 第三季", "咒术回战"],
    ["庆余年 第二季", "庆余年"],
    ["The Last of Us Season 2", "The Last of Us"],
    ["进击的巨人 完结篇", "进击的巨人"],
    ["沙丘 上篇", "沙丘"],
  ])("strips %s → %s", (input, expected) => {
    expect(stripSeasonMarkers(input)).toBe(expected);
  });

  it("returns null when there is nothing to strip", () => {
    expect(stripSeasonMarkers("咒术回战")).toBeNull();
    expect(stripSeasonMarkers("")).toBeNull();
    expect(stripSeasonMarkers("  ")).toBeNull();
  });
});

describe("search fallback for a season-suffixed query", () => {
  it("retries the stripped title before spending a model call", async () => {
    const provider = providerOf({ 咒术回战: [TV] });
    const resolveTitles = vi.fn(async () => ["should-not-be-called"]);
    const view = await getSearchPageView({
      query: "咒术回战 第三季",
      provider,
      cache: new InMemoryMediaSearchCache(),
      repository: repositoryStub(),
      resolveTitles,
    });

    expect(view.state).toBe("ready");
    expect(view.interpretedQuery).toBe("咒术回战");
    expect(view.candidates.map((c) => c.title)).toEqual(["咒术回战"]);
    expect(provider.calls).toEqual(["咒术回战 第三季", "咒术回战"]);
    expect(resolveTitles).not.toHaveBeenCalled();
  });

  it("falls back to the description resolver when even the stripped title finds nothing", async () => {
    const provider = providerOf({ 咒术回战: [TV] });
    const view = await getSearchPageView({
      query: "男主带着宿傩手指打咒灵的动漫 第三季",
      provider,
      cache: new InMemoryMediaSearchCache(),
      repository: repositoryStub(),
      resolveTitles: async () => ["咒术回战"],
    });

    expect(view.interpretedQuery).toBe("咒术回战");
    expect(view.candidates).toHaveLength(1);
  });

  it("stays empty (no crash) when nothing resolves", async () => {
    const provider = providerOf({});
    const view = await getSearchPageView({
      query: "完全没有的作品 第二季",
      provider,
      cache: new InMemoryMediaSearchCache(),
      repository: repositoryStub(),
      resolveTitles: async () => [],
    });
    expect(view.state).toBe("ready");
    expect(view.candidates).toEqual([]);
    expect(view.interpretedQuery).toBeUndefined();
  });

  it("survives a throwing resolver", async () => {
    const provider = providerOf({});
    const view = await getSearchPageView({
      query: "随便描述一下",
      provider,
      cache: new InMemoryMediaSearchCache(),
      repository: repositoryStub(),
      resolveTitles: async () => {
        throw new Error("model down");
      },
    });
    expect(view.state).toBe("ready");
    expect(view.candidates).toEqual([]);
  });
});

describe("parseResolvedTitles", () => {
  it("parses a plain JSON array", () => {
    expect(parseResolvedTitles('["咒术回战","Jujutsu Kaisen"]')).toEqual(["咒术回战", "Jujutsu Kaisen"]);
  });

  it("parses a fenced array surrounded by prose", () => {
    expect(parseResolvedTitles('好的：\n```json\n["静雪"]\n```\n以上。')).toEqual(["静雪"]);
  });

  it("falls back to bullet lines", () => {
    expect(parseResolvedTitles("- 咒术回战\n- 死灭回游")).toEqual(["咒术回战", "死灭回游"]);
  });

  it("drops URLs, duplicates and over-long junk", () => {
    const long = "很长的句子".repeat(30);
    expect(parseResolvedTitles(JSON.stringify(["https://x", "静雪", "静雪", long, "Silent"]))).toEqual([
      "静雪",
      "Silent",
    ]);
  });

  it("respects the limit", () => {
    expect(parseResolvedTitles('["a","b","c","d","e"]', 2)).toEqual(["a", "b"]);
  });
});

describe("resolveTitles", () => {
  it("returns nothing without a model", async () => {
    expect(await resolveTitles({ query: "男主带小绿瓶修仙" })).toEqual([]);
  });

  it("uses web evidence and the user's model to produce titles", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          result: { content: [{ type: "text", text: JSON.stringify({ results: [{ url: "https://x", title: "凡人修仙传", excerpts: ["韩立"] }] }) }] },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const titles = await resolveTitles({
      query: "男主带着小绿瓶催熟灵草修仙的国漫",
      model: textModel('["凡人修仙传"]'),
      web: { fetch: fetchMock as unknown as typeof fetch },
    });
    expect(titles).toEqual(["凡人修仙传"]);
  });

  it("still answers from the model alone when web search fails", async () => {
    const fetchMock = vi.fn(async () => new Response("boom", { status: 500 }));
    const titles = await resolveTitles({
      query: "描述",
      model: textModel('["咒术回战"]'),
      web: { fetch: fetchMock as unknown as typeof fetch },
    });
    expect(titles).toEqual(["咒术回战"]);
  });

  it("returns an empty list when the model answers garbage", async () => {
    const titles = await resolveTitles({ query: "描述", model: textModel("我不知道") });
    expect(titles).toEqual(["我不知道"]);
  });
});
