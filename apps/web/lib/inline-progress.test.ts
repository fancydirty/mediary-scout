import { describe, expect, it } from "vitest";
import {
  advanceTrickle,
  findActiveRun,
  initialTrickleState,
  inlineProgressView,
  trickleDisplayPercent,
} from "./inline-progress";
import type { ActivityActiveRun } from "./activity-view";

function run(over: Partial<ActivityActiveRun>): ActivityActiveRun {
  return {
    runId: "r",
    tmdbId: 1,
    title: "T",
    year: 2026,
    type: "movie",
    posterPath: null,
    seasonNumber: null,
    seasonNumbers: [],
    status: "running",
    queuePosition: null,
    missingCount: 0,
    progress: null,
    ...over,
  };
}

function progress(percent: number, activity: string): ActivityActiveRun["progress"] {
  return { percent, activity, phase: "transfer", updatedAt: "2026-06-23T00:00:00.000Z" };
}

describe("findActiveRun", () => {
  it("matches a movie by tmdbId (seasonNumber null = any)", () => {
    const a = [run({ runId: "x", tmdbId: 5 }), run({ runId: "y", tmdbId: 9 })];
    expect(findActiveRun(a, 9, null)?.runId).toBe("y");
  });
  it("matches a series by tmdbId + seasonNumber", () => {
    const a = [
      run({ runId: "s2", tmdbId: 5, seasonNumber: 2 }),
      run({ runId: "s3", tmdbId: 5, seasonNumber: 3 }),
    ];
    expect(findActiveRun(a, 5, 3)?.runId).toBe("s3");
  });
  it("seasonNumber null prefers a running run over a queued one (same tmdbId)", () => {
    const a = [
      run({ runId: "q", tmdbId: 5, seasonNumber: 2, status: "queued" }),
      run({ runId: "run", tmdbId: 5, seasonNumber: 3, status: "running" }),
    ];
    expect(findActiveRun(a, 5, null)?.runId).toBe("run");
  });
  it("returns null when no run matches", () => {
    expect(findActiveRun([run({ tmdbId: 1 })], 999, null)).toBeNull();
  });
});

describe("inlineProgressView", () => {
  it("running run → running:true, percent clamped, step from activity", () => {
    const v = inlineProgressView(run({ status: "running", progress: progress(42, "转存中…") }));
    expect(v).toEqual({ running: true, percent: 42, step: "转存中…" });
  });
  it("clamps percent to [3,100] and falls back step", () => {
    expect(inlineProgressView(run({ status: "running", progress: progress(0, "") })).percent).toBe(3);
    expect(inlineProgressView(run({ status: "running", progress: progress(250, "x") })).percent).toBe(100);
    expect(inlineProgressView(run({ status: "running", progress: null })).step).toBe("正在准备…");
  });
  it("treats empty/whitespace activity as missing → fallback step", () => {
    expect(inlineProgressView(run({ status: "running", progress: progress(50, "") })).step).toBe("正在准备…");
    expect(inlineProgressView(run({ status: "running", progress: progress(50, "   ") })).step).toBe("正在准备…");
  });
  it("queued or null → running:false", () => {
    expect(inlineProgressView(run({ status: "queued" })).running).toBe(false);
    expect(inlineProgressView(null).running).toBe(false);
  });
});

// 2026-06-24 bug: a single `searchResources` tool call ran 94s (half the run); the
// bar is event-driven (only writes on a tool call) so it sat FROZEN at 11% the whole
// time → looked empty / "no progress". Fix: client trickles the bar forward between
// server updates. trickleDisplayPercent eases from the last server % toward a soft
// ceiling just above it (decelerating, never reaching), so a long opaque step shows
// continuous life without claiming completion.
describe("trickleDisplayPercent — keep the bar alive during a long opaque step", () => {
  it("no creep at t=0 (shows exactly the server value)", () => {
    expect(trickleDisplayPercent(11, 0)).toBe(11);
  });
  it("creeps forward over time, strictly increasing (the frozen-94s symptom)", () => {
    const early = trickleDisplayPercent(11, 5_000);
    const mid = trickleDisplayPercent(11, 30_000);
    const late = trickleDisplayPercent(11, 90_000);
    expect(early).toBeGreaterThan(11);
    expect(mid).toBeGreaterThan(early);
    expect(late).toBeGreaterThan(mid);
  });
  it("never crosses the next real milestone (search 11% must not creep toward transfer 37%)", () => {
    // Even after an absurdly long wait, the soft ceiling stays well below the next jump.
    expect(trickleDisplayPercent(11, 10_000_000)).toBeLessThan(30);
  });
  it("never claims completion (capped below 100 even from a high base)", () => {
    expect(trickleDisplayPercent(96, 10_000_000)).toBeLessThanOrEqual(99);
  });
  it("never trickles BACKWARD for a base at/above the cap (Copilot: base 100 → stays 100)", () => {
    expect(trickleDisplayPercent(100, 0)).toBe(100);
    expect(trickleDisplayPercent(100, 60_000)).toBe(100); // not 99 — no negative slope
    expect(trickleDisplayPercent(100, 600_000)).toBeGreaterThanOrEqual(100);
  });
  it("monotonic non-decreasing in elapsed (never rewinds)", () => {
    let prev = -1;
    for (const ms of [0, 1_000, 10_000, 60_000, 300_000]) {
      const v = trickleDisplayPercent(20, ms);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});

describe("advanceTrickle — display stays monotonic across polls/ticks", () => {
  it("Copilot: a small server increment must NOT rewind the displayed bar", () => {
    // base 10, crept to ~13 after 10s; next poll reports server=11 → must stay ≥13.
    let s = initialTrickleState(10, 0, "run1");
    s = advanceTrickle(s, { serverPercent: 10, nowMs: 10_000, key: "run1" });
    const crept = s.displayed;
    expect(crept).toBeGreaterThan(11);
    s = advanceTrickle(s, { serverPercent: 11, nowMs: 10_400, key: "run1" });
    expect(s.displayed).toBeGreaterThanOrEqual(crept); // no drop to 11
  });
  it("eases from a real jump (search 11% → transfer 37%) and keeps climbing", () => {
    let s = initialTrickleState(11, 0, "r");
    s = advanceTrickle(s, { serverPercent: 11, nowMs: 90_000, key: "r" }); // long search creep
    expect(s.displayed).toBeGreaterThan(11);
    expect(s.displayed).toBeLessThan(30); // never crossed toward 37
    s = advanceTrickle(s, { serverPercent: 37, nowMs: 92_000, key: "r" }); // transfer jump
    expect(s.displayed).toBeGreaterThanOrEqual(37);
  });
  it("a new run (key change) resets the bar to that run's value", () => {
    let s = initialTrickleState(80, 0, "old");
    s = advanceTrickle(s, { serverPercent: 80, nowMs: 30_000, key: "old" });
    expect(s.displayed).toBeGreaterThan(80);
    s = advanceTrickle(s, { serverPercent: 8, nowMs: 30_100, key: "new" });
    expect(s.displayed).toBe(8); // fresh, not carrying old run's 80+
  });
  it("monotonic across a full real sequence (never rewinds at any tick)", () => {
    const ticks: Array<{ serverPercent: number; nowMs: number }> = [
      { serverPercent: 8, nowMs: 0 },
      { serverPercent: 10, nowMs: 3_000 },
      { serverPercent: 11, nowMs: 7_000 }, // then frozen 94s of trickle:
      { serverPercent: 11, nowMs: 30_000 },
      { serverPercent: 11, nowMs: 101_000 },
      { serverPercent: 37, nowMs: 121_000 },
      { serverPercent: 64, nowMs: 135_000 },
      { serverPercent: 96, nowMs: 170_000 },
    ];
    let s = initialTrickleState(8, 0, "r");
    let prev = -1;
    for (const t of ticks) {
      s = advanceTrickle(s, { ...t, key: "r" });
      expect(s.displayed).toBeGreaterThanOrEqual(prev);
      prev = s.displayed;
    }
    expect(prev).toBeGreaterThanOrEqual(96);
  });
});
