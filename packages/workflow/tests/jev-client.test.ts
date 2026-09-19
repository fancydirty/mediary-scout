// packages/workflow/tests/jev-client.test.ts
import { describe, expect, it } from "vitest";
import { createJevJudge, DEFAULT_JEV_BASE_URL, JEV_CHUNK_SIZE } from "../src/jev-client.js";

type Captured = { url: string; init: RequestInit; body: any };

function fetchReturning(answersFor: (body: any) => Record<string, number>, captured: Captured[] = []): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    captured.push({ url, init, body });
    const answers = Object.fromEntries(
      Object.entries(answersFor(body)).map(([k, v]) => [k, { type: "noul", noul: v }]),
    );
    return new Response(
      JSON.stringify({ model: "typesafe/jev-1.13-20260917", answers, usage: { input_tokens: 100, output_tokens: 10, cost: 0.000004 } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}

describe("createJevJudge", () => {
  it("POSTs the native decisions shape with bearer auth and maps answers back to candidate ids", async () => {
    const captured: Captured[] = [];
    const judge = createJevJudge({ apiKey: "sk-test", fetchImpl: fetchReturning(() => ({ c0: 0.9, c1: 0.1 }), captured) });
    const res = await judge.judgeCandidates({
      target: { kind: "tv", title: "交锋", aliases: ["Crossfire"], year: 2026 },
      candidates: [{ id: "pansou_x_candidate_1", title: "交锋 全24集" }, { id: "pansou_x_candidate_2", title: "无敌少侠" }],
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]!.url).toBe(DEFAULT_JEV_BASE_URL);
    expect((captured[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    expect(captured[0]!.body.model).toBe("jev-latest");
    expect(captured[0]!.body.state.target).toEqual({ title: "交锋", type: "tv", year: 2026, aliases: ["Crossfire"] });
    // year is ALWAYS sent (null when unknown) because the wording references `target.year`.
    const noYear = createJevJudge({ apiKey: "k", fetchImpl: fetchReturning(() => ({ c0: 0.5 }), captured) });
    await noYear.judgeCandidates({ target: { kind: "tv", title: "t", aliases: [] }, candidates: [{ id: "a", title: "x" }] });
    expect(captured[1]!.body.state.target.year).toBeNull();
    expect(captured[0]!.body.state.candidates).toEqual({ c0: "交锋 全24集", c1: "无敌少侠" });
    expect(captured[0]!.body.questions.c0.type).toBe("noul");
    expect(res.scores).toEqual({ pansou_x_candidate_1: 0.9, pansou_x_candidate_2: 0.1 });
    expect(res.model).toBe("typesafe/jev-1.13-20260917");
    expect(res.inputTokens).toBe(100);
    expect(res.cost).toBeCloseTo(0.000004);
  });

  it("chunks candidates beyond JEV_CHUNK_SIZE into parallel requests and merges scores/usage", async () => {
    const captured: Captured[] = [];
    const judge = createJevJudge({ apiKey: "k", fetchImpl: fetchReturning((b) => Object.fromEntries(Object.keys(b.state.candidates).map((k) => [k, 0.8])), captured) });
    const n = JEV_CHUNK_SIZE + 5;
    const res = await judge.judgeCandidates({
      target: { kind: "tv", title: "t", aliases: [] },
      candidates: Array.from({ length: n }, (_, i) => ({ id: `id${i}`, title: `t${i}` })),
    });
    expect(captured).toHaveLength(2);
    expect(Object.keys(res.scores)).toHaveLength(n);
    expect(res.inputTokens).toBe(200);
  });

  it("uses the configured base URL", async () => {
    const captured: Captured[] = [];
    const judge = createJevJudge({ apiKey: "k", baseUrl: "https://api.typesafe.ai/v1/systemone", fetchImpl: fetchReturning(() => ({ c0: 0.5 }), captured) });
    await judge.judgeCandidates({ target: { kind: "movie", title: "m", aliases: [] }, candidates: [{ id: "a", title: "x" }] });
    expect(captured[0]!.url).toBe("https://api.typesafe.ai/v1/systemone");
  });

  it("throws on non-2xx without leaking the key", async () => {
    const judge = createJevJudge({ apiKey: "sk-SECRET", fetchImpl: (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch });
    await expect(judge.judgeCandidates({ target: { kind: "tv", title: "t", aliases: [] }, candidates: [{ id: "a", title: "x" }] }))
      .rejects.toThrow(/HTTP 401/);
    await expect(judge.judgeCandidates({ target: { kind: "tv", title: "t", aliases: [] }, candidates: [{ id: "a", title: "x" }] }))
      .rejects.not.toThrow(/SECRET/);
  });

  it("throws when an answer is missing or not a 0..1 number (whole call is invalid)", async () => {
    const bad = (async () => new Response(JSON.stringify({ model: "m", answers: { c0: { type: "noul", noul: "0.9" } } }), { status: 200 })) as unknown as typeof fetch;
    const judge = createJevJudge({ apiKey: "k", fetchImpl: bad });
    await expect(judge.judgeCandidates({ target: { kind: "tv", title: "t", aliases: [] }, candidates: [{ id: "a", title: "x" }] }))
      .rejects.toThrow(/invalid/i);
  });

  it("returns empty scores without calling fetch when there are no candidates", async () => {
    let calls = 0;
    const judge = createJevJudge({ apiKey: "k", fetchImpl: (async () => { calls += 1; return new Response("{}"); }) as unknown as typeof fetch });
    const res = await judge.judgeCandidates({ target: { kind: "tv", title: "t", aliases: [] }, candidates: [] });
    expect(res.scores).toEqual({});
    expect(calls).toBe(0);
  });
});
