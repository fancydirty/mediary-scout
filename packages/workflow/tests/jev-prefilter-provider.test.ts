// packages/workflow/tests/jev-prefilter-provider.test.ts
import { describe, expect, it } from "vitest";
import { isTitleless, JEV_CIRCUIT_BREAKER_FAILURES, JevPrefilterProvider } from "../src/jev-prefilter-provider.js";
import { JEV_MODEL, type JevJudge, type JevJudgeInput } from "../src/jev-judge.js";
import type { ResourceProvider, ResourceSnapshot } from "../src/index.js";

function snapshot(titles: Array<string | { title: string; type?: "115" | "magnet" }>): ResourceSnapshot {
  return {
    id: "snap_1",
    provider: "composite",
    keyword: "交锋",
    createdAt: "2026-09-19T00:00:00.000Z",
    sourceHealth: { status: "healthy", unhealthySources: [] } as any,
    candidates: titles.map((t, index) => {
      const title = typeof t === "string" ? t : t.title;
      return { id: `c${index + 1}`, snapshotId: "snap_1", index, title, type: typeof t === "string" ? "115" : (t.type ?? "115"), source: "pansou", providerPayload: { url: `u${index}` } };
    }),
  };
}
const inner = (snap: ResourceSnapshot): ResourceProvider => ({ search: async () => snap });
const judge = (scores: Record<string, number>, seen: JevJudgeInput[] = []): JevJudge => ({
  judgeCandidates: async (input) => { seen.push(input); return { scores, model: "m", inputTokens: 50, cost: 0.00001 }; },
});
const target = { kind: "tv" as const, title: "交锋", aliases: [], year: 2026 };

describe("JevPrefilterProvider", () => {
  it("drops <0.3, keeps ≥0.3, preserves id/index/order/sourceHealth, and writes prefilter metadata", async () => {
    const seen: JevJudgeInput[] = [];
    const p = new JevPrefilterProvider({ inner: inner(snapshot(["交锋 全24集", "无敌少侠", "权利交锋 S01E08"])), target, judge: judge({ c1: 0.95, c2: 0.02, c3: 0.55 }, seen), now: () => 1000 });
    const out = await p.search({ keyword: "交锋", workflowRunId: "run1" });
    expect(out.candidates.map((c) => c.id)).toEqual(["c1", "c3"]);
    expect(out.candidates.map((c) => c.index)).toEqual([0, 2]); // holes allowed, no re-index
    expect(out.id).toBe("snap_1");
    expect(out.keyword).toBe("交锋");
    expect(out.sourceHealth).toEqual({ status: "healthy", unhealthySources: [] });
    expect(out.prefilter).toMatchObject({
      provider: "jev", model: "m", status: "applied",
      scores: { c1: 0.95, c2: 0.02, c3: 0.55 },
      dropped: [{ id: "c2", title: "无敌少侠", score: 0.02 }],
      thresholds: { dropBelow: 0.3, uncertainBelow: 0.7 },
      inputTokens: 50, cost: 0.00001,
    });
    expect(seen[0]!.target).toEqual(target);
    expect(seen[0]!.candidates).toEqual([{ id: "c1", title: "交锋 全24集" }, { id: "c2", title: "无敌少侠" }, { id: "c3", title: "权利交锋 S01E08" }]);
  });

  it("never judges title-less candidates (empty / 📅 / http) and always keeps them", async () => {
    const seen: JevJudgeInput[] = [];
    const p = new JevPrefilterProvider({ inner: inner(snapshot(["", "📅 9月6日", "https://115.com/s/abc", "无敌少侠"])), target, judge: judge({ c4: 0.01 }, seen) });
    const out = await p.search({ keyword: "交锋" });
    expect(seen[0]!.candidates.map((c) => c.id)).toEqual(["c4"]);
    expect(out.candidates.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
    expect(out.prefilter?.scores).toEqual({ c4: 0.01 });
  });

  it("all candidates title-less → judge not called, status skipped, nothing dropped", async () => {
    let calls = 0;
    const j: JevJudge = { judgeCandidates: async () => { calls += 1; return { scores: {}, model: "m" }; } };
    const out = await new JevPrefilterProvider({ inner: inner(snapshot(["📅 9月6日", "https://x"])), target, judge: j }).search({ keyword: "x" });
    expect(calls).toBe(0);
    expect(out.candidates).toHaveLength(2);
    expect(out.prefilter).toMatchObject({ status: "skipped", reason: "no judgeable candidates", dropped: [] });
    // One source of truth for the model name: a literal here (and in the provider) would
    // drift the moment the client's model changes, and the audit trail would lie.
    expect(out.prefilter?.model).toBe(JEV_MODEL);
  });

  it("fail-open: judge throws → snapshot returned untouched with status failed + reason", async () => {
    const boom: JevJudge = { judgeCandidates: async () => { throw new Error("Jev HTTP 503"); } };
    const p = new JevPrefilterProvider({ inner: inner(snapshot(["a", "b"])), target, judge: boom });
    const out = await p.search({ keyword: "交锋" });
    expect(out.candidates.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(out.prefilter).toMatchObject({ status: "failed", reason: "Jev HTTP 503", scores: {}, dropped: [] });
    expect(out.prefilter?.model).toBe(JEV_MODEL);
  });

  it("fail-open: a candidate the judge did not score is kept", async () => {
    const p = new JevPrefilterProvider({ inner: inner(snapshot(["a", "b"])), target, judge: judge({ c1: 0.01 }) });
    const out = await p.search({ keyword: "交锋" });
    expect(out.candidates.map((c) => c.id)).toEqual(["c2"]);
  });

  it("does not call the judge on an empty snapshot and does not attach prefilter", async () => {
    let calls = 0;
    const j: JevJudge = { judgeCandidates: async () => { calls += 1; return { scores: {}, model: "m" }; } };
    const out = await new JevPrefilterProvider({ inner: inner(snapshot([])), target, judge: j }).search({ keyword: "x" });
    expect(calls).toBe(0);
    expect(out.prefilter).toBeUndefined();
  });

  it("keeps a title-less candidate even when the judge scores it, and records only judgeable scores", async () => {
    // The title-less guarantee has to be structural: a buggy (or prompt-injected) judge
    // that answers for a candidate it was never asked about must not be able to drop it.
    const seen: JevJudgeInput[] = [];
    const p = new JevPrefilterProvider({
      inner: inner(snapshot(["交锋 全24集", "http://example.com/x", "📅 9月6日"])),
      target,
      judge: judge({ c1: 0.9, c2: 0.01, c3: 0.01, ghost: 0.9 }, seen),
    });
    const out = await p.search({ keyword: "交锋" });
    expect(seen[0]!.candidates.map((c) => c.id)).toEqual(["c1"]);
    expect(out.candidates.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
    expect(out.prefilter?.scores).toEqual({ c1: 0.9 });
    expect(out.prefilter?.dropped).toEqual([]);
  });

  it("flags a partial judge result in failedChunks + log while still applying the scores it got", async () => {
    const lines: string[] = [];
    const partial: JevJudge = {
      judgeCandidates: async () => ({ scores: { c1: 0.9 }, model: "m", failedChunks: 1 }),
    };
    const p = new JevPrefilterProvider({
      inner: inner(snapshot(["交锋 全24集", "无敌少侠"])),
      target,
      judge: partial,
      log: (line) => lines.push(line),
    });
    const out = await p.search({ keyword: "交锋" });
    expect(out.candidates.map((c) => c.id)).toEqual(["c1", "c2"]); // c2 unscored → kept
    expect(out.prefilter).toMatchObject({ status: "applied" });
    expect(out.prefilter?.failedChunks).toBe(1);
    expect(out.prefilter?.reason).toBeUndefined();
    expect(lines.join("\n")).toContain("failedChunks=1");
  });

  // Every search leaves exactly one [jev-prefilter] line — including the two that never
  // reach the judge — so the audit trail can tell "not attempted" from "not logged".
  it("logs one [jev-prefilter] line for a search with no candidates, and for one with nothing judgeable", async () => {
    const lines: string[] = [];
    const judgeCalls: JevJudgeInput[] = [];
    const log = (line: string) => lines.push(line);

    await new JevPrefilterProvider({ inner: inner(snapshot([])), target, judge: judge({}, judgeCalls), log }).search({ keyword: "交锋" });
    await new JevPrefilterProvider({ inner: inner(snapshot(["📅 9月6日", "https://x.y/z"])), target, judge: judge({}, judgeCalls), log }).search({ keyword: "交锋 2026" });

    expect(judgeCalls).toHaveLength(0);
    expect(lines).toEqual([
      '[jev-prefilter] "交锋" skipped: 0 candidates',
      '[jev-prefilter] "交锋 2026" skipped: no judgeable candidates (2 title-less)',
    ]);
  });

  // The source failing is the third search that never reaches the judge. The error still
  // propagates untouched (source health is classified one layer down), but the line says
  // it happened — by error NAME only: undici quotes a bad header VALUE in its message, and
  // Prowlarr's X-Api-Key is a header, so the message is not safe to put in a log.
  it("logs one line (name only, never the message) when the source search throws, and rethrows the same error", async () => {
    const lines: string[] = [];
    const judgeCalls: JevJudgeInput[] = [];
    const boom = new TypeError('Headers.append: "sk-PROWLARR-SECRET\\n" is an invalid header value.');
    const failing: ResourceProvider = { search: async () => { throw boom; } };

    const search = new JevPrefilterProvider({ inner: failing, target, judge: judge({}, judgeCalls), log: (l) => lines.push(l) }).search({ keyword: "交锋" });

    await expect(search).rejects.toBe(boom);
    expect(judgeCalls).toHaveLength(0);
    expect(lines).toEqual(['[jev-prefilter] "交锋" source search failed (TypeError) — judge not called, error rethrown']);
  });

  it("passes workflowRunId through to the inner provider", async () => {
    let seenRun: string | undefined;
    const innerSpy: ResourceProvider = { search: async (i) => { seenRun = i.workflowRunId; return snapshot([]); } };
    await new JevPrefilterProvider({ inner: innerSpy, target, judge: judge({}) }).search({ keyword: "x", workflowRunId: "run-9" });
    expect(seenRun).toBe("run-9");
  });
});


describe("isTitleless", () => {
  it.each(["", "  \t ", "📅 9月6日", "http://x", "HTTP://X"])("%j carries no judgeable text", (title) => {
    expect(isTitleless(title)).toBe(true);
  });

  it.each(["magnet:?xt=urn:btih:abc", "交锋 (2026) https://x"])("%j is judgeable", (title) => {
    expect(isTitleless(title)).toBe(false);
  });
});

describe("JevPrefilterProvider containment floor", () => {
  it("keeps (and records) a sub-threshold candidate whose title contains the target title", async () => {
    // Production replay: the agent selected 《权利交锋 S01E08》 for target 《交锋》 — an
    // uploader mislabel Jev scores 0.04 under every wording tried. Containment is the
    // floor because the prefilter's only unacceptable failure is dropping the right one.
    const lines: string[] = [];
    const p = new JevPrefilterProvider({
      inner: inner(snapshot(["交锋 全24集", "权利交锋 S01E08", "无敌少侠"])),
      target,
      judge: judge({ c1: 0.95, c2: 0.04, c3: 0.02 }),
      log: (line) => lines.push(line),
    });
    const out = await p.search({ keyword: "交锋" });
    expect(out.candidates.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(out.prefilter?.dropped).toEqual([{ id: "c3", title: "无敌少侠", score: 0.02 }]);
    expect(out.prefilter?.floored).toEqual([{ id: "c2", title: "权利交锋 S01E08", score: 0.04 }]);
    // The raw score is never rewritten to buy the keep: the agent sees 0.04 on the row.
    expect(out.prefilter?.scores.c2).toBe(0.04);
    expect(lines.join("\n")).toContain("floored=1");
    // The counter covers uncertain-band AND floored rows, so it is named for what it
    // means to the agent (a ⚠ on the row), not for one of the two bands it comes from.
    expect(lines.join("\n")).toContain("flagged=1");
    expect(lines.join("\n")).not.toContain("uncertain=");
  });

  it("an alias in the candidate title floors it too", async () => {
    const p = new JevPrefilterProvider({
      inner: inner(snapshot(["Sousou.no.Frieren.S02E01"])),
      target: { kind: "tv", title: "葬送的芙莉莲", aliases: ["Sousou no Frieren"], year: 2023 },
      judge: judge({ c1: 0.1 }),
    });
    const out = await p.search({ keyword: "葬送的芙莉莲" });
    expect(out.candidates.map((c) => c.id)).toEqual(["c1"]);
    expect(out.prefilter?.floored).toEqual([{ id: "c1", title: "Sousou.no.Frieren.S02E01", score: 0.1 }]);
    expect(out.prefilter?.dropped).toEqual([]);
  });

  it("omits the field entirely (and the log fragment) when nothing was floored", async () => {
    const lines: string[] = [];
    const p = new JevPrefilterProvider({
      inner: inner(snapshot(["交锋 全24集", "无敌少侠"])),
      target,
      judge: judge({ c1: 0.95, c2: 0.02 }),
      log: (line) => lines.push(line),
    });
    const out = await p.search({ keyword: "交锋" });
    expect(out.candidates.map((c) => c.id)).toEqual(["c1"]);
    expect("floored" in out.prefilter!).toBe(false);
    expect(lines.join("\n")).not.toContain("floored=");
  });
});

describe("JevPrefilterProvider floor-rate log", () => {
  const lines: string[] = [];
  const run = async (titles: string[], scores: Record<string, number>) => {
    lines.length = 0;
    const p = new JevPrefilterProvider({ inner: inner(snapshot(titles)), target, judge: judge(scores), log: (line) => lines.push(line) });
    await p.search({ keyword: "交锋" });
    return lines.join("\n");
  };

  it("reports floorRate when the floor carried at least half of the judged candidates", async () => {
    // A batch where the floor does most of the keeping is a wording regression in
    // disguise: the judge stopped recognising the target and only containment saved it.
    // Silent in the drop rate, loud here.
    const line = await run(
      ["权利交锋 S01E08", "交锋联盟 23", "交锋 (2015) 全集", "无敌少侠"],
      { c1: 0.04, c2: 0.05, c3: 0.06, c4: 0.02 },
    );
    expect(line).toContain("floored=3");
    expect(line).toContain("floorRate=75%");
  });

  it("50% is inside the band (≥), and a minority floor prints no rate at all", async () => {
    expect(await run(["权利交锋 S01E08", "无敌少侠"], { c1: 0.04, c2: 0.02 })).toContain("floorRate=50%");
    const quiet = await run(
      ["权利交锋 S01E08", "无敌少侠", "少年歌行", "铁拳教育"],
      { c1: 0.04, c2: 0.02, c3: 0.02, c4: 0.02 },
    );
    expect(quiet).toContain("floored=1");
    expect(quiet).not.toContain("floorRate=");
  });
});


describe("JevPrefilterProvider circuit breaker", () => {
  // The provider instance is built per acquisition run, so the counter is that run's:
  // a judge that is down stops costing the run one timeout per search (and the agent
  // searches many times), while the next run starts with a closed circuit.
  const throwing = (calls: { n: number }): JevJudge["judgeCandidates"] => async () => { calls.n += 1; throw new Error("Jev HTTP 503"); };

  it("opens after two consecutive judge failures: the third search never calls the judge", async () => {
    const calls = { n: 0 };
    const lines: string[] = [];
    const p = new JevPrefilterProvider({
      inner: inner(snapshot(["交锋 全24集", "无敌少侠"])),
      target,
      judge: { judgeCandidates: throwing(calls) },
      log: (line) => lines.push(line),
    });
    await p.search({ keyword: "交锋" });
    await p.search({ keyword: "交锋" });
    const third = await p.search({ keyword: "交锋" });
    expect(calls.n).toBe(2); // the judge was spared the third round trip
    expect(third.candidates.map((c) => c.id)).toEqual(["c1", "c2"]); // still fail-open
    expect(third.prefilter?.status).toBe("failed");
    expect(third.prefilter?.reason).toMatch(/circuit-open/);
    expect(third.prefilter?.model).toBe(JEV_MODEL);
    expect(third.prefilter?.dropped).toEqual([]);
    expect(lines.join("\n")).toContain("circuit open");
  });

  it("counts CONSECUTIVE failures only: a success in between resets the counter", async () => {
    const calls = { n: 0 };
    let round = 0;
    const flaky: JevJudge = {
      judgeCandidates: async (input) => {
        calls.n += 1;
        round += 1;
        if (round === 2) return { scores: Object.fromEntries(input.candidates.map((c) => [c.id, 0.9])), model: "m" };
        throw new Error("Jev HTTP 503");
      },
    };
    const p = new JevPrefilterProvider({ inner: inner(snapshot(["交锋 全24集", "无敌少侠"])), target, judge: flaky });
    await p.search({ keyword: "交锋" }); // fail  → 1
    await p.search({ keyword: "交锋" }); // ok    → 0
    const third = await p.search({ keyword: "交锋" }); // fail → 1, still below the threshold
    expect(calls.n).toBe(3);
    expect(third.prefilter?.reason).toBe("Jev HTTP 503");
  });

  it("the threshold is two failures by default, and is overridable per provider", async () => {
    expect(JEV_CIRCUIT_BREAKER_FAILURES).toBe(2);
    const calls = { n: 0 };
    const p = new JevPrefilterProvider({
      inner: inner(snapshot(["交锋 全24集"])),
      target,
      judge: { judgeCandidates: throwing(calls) },
      maxConsecutiveFailures: 1,
    });
    await p.search({ keyword: "交锋" });
    const second = await p.search({ keyword: "交锋" });
    expect(calls.n).toBe(1);
    expect(second.prefilter?.reason).toMatch(/circuit-open/);
  });
});
