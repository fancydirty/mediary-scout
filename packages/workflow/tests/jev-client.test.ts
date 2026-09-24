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
    expect(captured[0]!.init.signal).toBeInstanceOf(AbortSignal);
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
    expect("failedChunks" in res).toBe(false);
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

  it("rejects a blank API key synchronously at construction", () => {
    expect(() =>
      createJevJudge({ apiKey: "   ", fetchImpl: (async () => new Response("{}")) as unknown as typeof fetch }),
    ).toThrow(/Jev API key is blank/);
  });

  it("falls back to the default base URL when baseUrl is blank", async () => {
    const captured: Captured[] = [];
    const judge = createJevJudge({ apiKey: "k", baseUrl: "   ", fetchImpl: fetchReturning(() => ({ c0: 0.5 }), captured) });
    await judge.judgeCandidates({ target: { kind: "tv", title: "t", aliases: [] }, candidates: [{ id: "a", title: "x" }] });
    expect(captured[0]!.url).toBe(DEFAULT_JEV_BASE_URL);
  });

  it("never leaks the key from a transport error (undici embeds the header value verbatim)", async () => {
    const leaky = (async () => {
      throw new Error('Headers.append: "Bearer sk-SECRET\nX" is an invalid header value.');
    }) as unknown as typeof fetch;
    const judge = createJevJudge({ apiKey: "sk-SECRET", fetchImpl: leaky });
    await expect(
      judge.judgeCandidates({ target: { kind: "tv", title: "t", aliases: [] }, candidates: [{ id: "a", title: "x" }] }),
    ).rejects.toThrow(/^Jev request failed: Error$/);
    await expect(
      judge.judgeCandidates({ target: { kind: "tv", title: "t", aliases: [] }, candidates: [{ id: "a", title: "x" }] }),
    ).rejects.not.toThrow(/SECRET/);
  });

  it("aborts the request when it exceeds timeoutMs and reports a clean timeout error", async () => {
    const hangs = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject((init.signal as AbortSignal).reason));
      })) as unknown as typeof fetch;
    const judge = createJevJudge({ apiKey: "k", timeoutMs: 5, fetchImpl: hangs });
    await expect(
      judge.judgeCandidates({ target: { kind: "tv", title: "t", aliases: [] }, candidates: [{ id: "a", title: "x" }] }),
    ).rejects.toThrow(/Jev request failed: TimeoutError/);
  });

  const jsonThrowing = (name: string): typeof fetch =>
    (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => {
          throw Object.assign(new Error("aborted"), { name });
        },
      }) as unknown as Response) as unknown as typeof fetch;

  it("does not relabel a timeout as invalid JSON", async () => {
    const judge = createJevJudge({ apiKey: "k", fetchImpl: jsonThrowing("TimeoutError") });
    await expect(
      judge.judgeCandidates({ target: { kind: "tv", title: "t", aliases: [] }, candidates: [{ id: "a", title: "x" }] }),
    ).rejects.toThrow(/^Jev request failed: TimeoutError$/);
  });

  it("does not relabel an abort as invalid JSON", async () => {
    const judge = createJevJudge({ apiKey: "k", fetchImpl: jsonThrowing("AbortError") });
    await expect(
      judge.judgeCandidates({ target: { kind: "tv", title: "t", aliases: [] }, candidates: [{ id: "a", title: "x" }] }),
    ).rejects.toThrow(/^Jev request failed: AbortError$/);
  });

  it("resolves with partial results and failedChunks count when some (not all) chunks fail", async () => {
    const n = JEV_CHUNK_SIZE * 2 + 5;
    let call = 0;
    let failedChunkCandidates = 0;
    const flaky = (async (_url: string, init: RequestInit) => {
      call += 1;
      const body = JSON.parse(String(init.body));
      if (call === 2) {
        failedChunkCandidates = Object.keys(body.state.candidates).length;
        return new Response("nope", { status: 429 });
      }
      const answers = Object.fromEntries(
        Object.keys(body.state.candidates).map((k) => [k, { type: "noul", noul: 0.8 }]),
      );
      return new Response(
        JSON.stringify({ model: "m", answers, usage: { input_tokens: 10, cost: 0.000001 } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const judge = createJevJudge({ apiKey: "k", fetchImpl: flaky });
    const res = await judge.judgeCandidates({
      target: { kind: "tv", title: "t", aliases: [] },
      candidates: Array.from({ length: n }, (_, i) => ({ id: `id${i}`, title: `t${i}` })),
    });
    expect(call).toBe(3);
    expect(failedChunkCandidates).toBeGreaterThan(0);
    expect(Object.keys(res.scores)).toHaveLength(n - failedChunkCandidates);
    // The chunks that answered are applied in full; the 429'd chunk's candidates are absent.
    expect(res.scores.id0).toBe(0.8);
    expect(res.scores[`id${n - 1}`]).toBe(0.8);
    expect(`id${JEV_CHUNK_SIZE}` in res.scores).toBe(false);
    expect(res.inputTokens).toBe(20);
    expect(res.failedChunks).toBe(1);
  });

  it("rejects when every chunk fails", async () => {
    const allFail = (async () => new Response("nope", { status: 429 })) as unknown as typeof fetch;
    const judge = createJevJudge({ apiKey: "k", fetchImpl: allFail });
    const n = JEV_CHUNK_SIZE + 5;
    await expect(
      judge.judgeCandidates({
        target: { kind: "tv", title: "t", aliases: [] },
        candidates: Array.from({ length: n }, (_, i) => ({ id: `id${i}`, title: `t${i}` })),
      }),
    ).rejects.toThrow(/Jev HTTP 429/);
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

  it("omits inputTokens/cost entirely when the response has no usage field", async () => {
    const noUsage = (async () =>
      new Response(JSON.stringify({ model: "m", answers: { c0: { type: "noul", noul: 0.5 } } }), { status: 200 })) as unknown as typeof fetch;
    const judge = createJevJudge({ apiKey: "k", fetchImpl: noUsage });
    const res = await judge.judgeCandidates({ target: { kind: "tv", title: "t", aliases: [] }, candidates: [{ id: "a", title: "x" }] });
    expect("inputTokens" in res).toBe(false);
    expect("cost" in res).toBe(false);
  });

  it("trims the API key before putting it in the Authorization header", async () => {
    // A key pasted into a settings textarea arrives with whitespace; undici rejects a
    // header value containing a newline (and quotes the value verbatim when it does).
    const captured: Captured[] = [];
    const judge = createJevJudge({ apiKey: " sk-test\n", fetchImpl: fetchReturning(() => ({ c0: 0.5 }), captured) });
    await judge.judgeCandidates({ target: { kind: "tv", title: "t", aliases: [] }, candidates: [{ id: "a", title: "x" }] });
    expect((captured[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
  });

  it("appends the transport cause code when the platform provides one", async () => {
    const refused = (async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    }) as unknown as typeof fetch;
    const judge = createJevJudge({ apiKey: "sk-SECRET", fetchImpl: refused });
    await expect(
      judge.judgeCandidates({ target: { kind: "tv", title: "t", aliases: [] }, candidates: [{ id: "a", title: "x" }] }),
    ).rejects.toThrow(/^Jev request failed: TypeError \(ECONNREFUSED\)$/);
  });

  it("reports a mid-body connection drop as a request failure, not invalid JSON", async () => {
    const dropped = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => {
          throw new TypeError("terminated");
        },
      }) as unknown as Response) as unknown as typeof fetch;
    const judge = createJevJudge({ apiKey: "k", fetchImpl: dropped });
    await expect(
      judge.judgeCandidates({ target: { kind: "tv", title: "t", aliases: [] }, candidates: [{ id: "a", title: "x" }] }),
    ).rejects.toThrow(/^Jev request failed: TypeError$/);
  });

  it("reports a genuinely unparseable body as invalid JSON", async () => {
    const notJson = (async () => new Response("not json", { status: 200 })) as unknown as typeof fetch;
    const judge = createJevJudge({ apiKey: "k", fetchImpl: notJson });
    await expect(
      judge.judgeCandidates({ target: { kind: "tv", title: "t", aliases: [] }, candidates: [{ id: "a", title: "x" }] }),
    ).rejects.toThrow(/^Jev returned invalid JSON$/);
  });

  it("treats a literal null body as a missing answers field", async () => {
    const nullBody = (async () => new Response("null", { status: 200 })) as unknown as typeof fetch;
    const judge = createJevJudge({ apiKey: "k", fetchImpl: nullBody });
    await expect(
      judge.judgeCandidates({ target: { kind: "tv", title: "t", aliases: [] }, candidates: [{ id: "a", title: "x" }] }),
    ).rejects.toThrow(/Jev response invalid: no answers/);
  });

  it("throws when the merge does not cover every candidate (merge invariant)", async () => {
    // Ids are minted `${snapshotId}_candidate_${index+1}` upstream so duplicates cannot
    // occur in production; this pins the guard that would catch a chunking/merge bug.
    const judge = createJevJudge({
      apiKey: "k",
      fetchImpl: fetchReturning((b) => Object.fromEntries(Object.keys(b.state.candidates).map((k) => [k, 0.5]))),
    });
    await expect(
      judge.judgeCandidates({
        target: { kind: "tv", title: "t", aliases: [] },
        candidates: [{ id: "a", title: "x" }, { id: "a", title: "y" }],
      }),
    ).rejects.toThrow(/merge invariant/);
  });
});

describe("createJevJudge — nsfw question", () => {
  it("asks n<i> beside c<i> in the same request and maps both back to candidate ids", async () => {
    const captured: Captured[] = [];
    const judge = createJevJudge({ apiKey: "k", fetchImpl: fetchReturning(() => ({ c0: 0.9, c1: 0.1, n0: 0.02, n1: 0.99 }), captured) });
    const res = await judge.judgeCandidates({
      target: { kind: "movie", title: "出入平安", aliases: [], year: 2024 },
      candidates: [{ id: "a", title: "出入平安 2160p" }, { id: "b", title: "出入平安的白虎…" }],
    });
    expect(captured).toHaveLength(1);
    expect(Object.keys(captured[0]!.body.questions).sort()).toEqual(["c0", "c1", "n0", "n1"]);
    expect(captured[0]!.body.questions.n1.instructions).toContain("`candidates.c1`");
    expect(res.scores).toEqual({ a: 0.9, b: 0.1 });
    expect(res.nsfw).toEqual({ a: 0.02, b: 0.99 });
  });

  it("a missing or malformed nsfw answer leaves that candidate unscored but keeps identity", async () => {
    const judge = createJevJudge({ apiKey: "k", fetchImpl: fetchReturning(() => ({ c0: 0.9, c1: 0.8, n1: 7 })) });
    const res = await judge.judgeCandidates({
      target: { kind: "movie", title: "t", aliases: [] },
      candidates: [{ id: "a", title: "x" }, { id: "b", title: "y" }],
    });
    expect(res.scores).toEqual({ a: 0.9, b: 0.8 });
    expect(res.nsfw).toEqual({});
  });

  it("merges nsfw across chunks", async () => {
    const n = JEV_CHUNK_SIZE + 3;
    const judge = createJevJudge({
      apiKey: "k",
      fetchImpl: fetchReturning((b) => Object.fromEntries(Object.keys(b.state.candidates).flatMap((k) => [[k, 0.9], [`n${k.slice(1)}`, 0.01]]))),
    });
    const res = await judge.judgeCandidates({
      target: { kind: "tv", title: "t", aliases: [] },
      candidates: Array.from({ length: n }, (_, i) => ({ id: `id${i}`, title: `t${i}` })),
    });
    expect(Object.keys(res.nsfw!)).toHaveLength(n);
  });
});
