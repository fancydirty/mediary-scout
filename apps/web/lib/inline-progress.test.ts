import { describe, expect, it } from "vitest";
import { findActiveRun, inlineProgressView } from "./inline-progress";
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
