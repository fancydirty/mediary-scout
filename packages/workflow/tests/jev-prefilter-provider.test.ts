// packages/workflow/tests/jev-prefilter-provider.test.ts
import { describe, expect, it } from "vitest";
import { JevPrefilterProvider } from "../src/jev-prefilter-provider.js";
import type { JevJudge, JevJudgeInput } from "../src/jev-judge.js";
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
  });

  it("fail-open: judge throws → snapshot returned untouched with status failed + reason", async () => {
    const boom: JevJudge = { judgeCandidates: async () => { throw new Error("Jev HTTP 503"); } };
    const p = new JevPrefilterProvider({ inner: inner(snapshot(["a", "b"])), target, judge: boom });
    const out = await p.search({ keyword: "交锋" });
    expect(out.candidates.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(out.prefilter).toMatchObject({ status: "failed", reason: "Jev HTTP 503", scores: {}, dropped: [] });
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

  it("passes workflowRunId through to the inner provider", async () => {
    let seenRun: string | undefined;
    const innerSpy: ResourceProvider = { search: async (i) => { seenRun = i.workflowRunId; return snapshot([]); } };
    await new JevPrefilterProvider({ inner: innerSpy, target, judge: judge({}) }).search({ keyword: "x", workflowRunId: "run-9" });
    expect(seenRun).toBe("run-9");
  });
});
