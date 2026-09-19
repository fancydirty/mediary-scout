// packages/workflow/tests/jev-judge.test.ts
import { describe, expect, it } from "vitest";
import {
  buildJevQuestions,
  JEV_DROP_BELOW,
  JEV_THRESHOLDS,
  JEV_UNCERTAIN_BELOW,
  JEV_UNCERTAIN_LEGEND,
  classifyJevScore,
  jevAllDroppedWarning,
  jevUncertaintyFlag,
} from "../src/jev-judge.js";
import type { ResourceSnapshot, SnapshotPrefilter } from "../src/domain.js";

describe("buildJevQuestions", () => {
  it("emits one noul question per candidate keyed by candidate key, tv wording", () => {
    const q = buildJevQuestions({ kind: "tv" }, ["c0", "c1"]);
    expect(Object.keys(q)).toEqual(["c0", "c1"]);
    expect(q.c0!.type).toBe("noul");
    expect(q.c0!.instructions).toContain("`candidates.c0`");
    expect(q.c0!.instructions).toContain("剧集/动漫");
    expect(q.c0!.instructions).toContain("剧场版/电影/广播剧");
    expect(q.c0!.instructions).toContain("`target.year`");
    expect(q.c0!.instructions).toContain("`target.aliases`");
    expect(q.c1!.instructions).toContain("`candidates.c1`");
  });

  it("movie wording guards against remakes/sequels and mentions aliases", () => {
    const q = buildJevQuestions({ kind: "movie" }, ["c0"]);
    expect(q.c0!.instructions).toContain("这部电影本身");
    expect(q.c0!.instructions).toContain("续集/前传/翻拍");
    expect(q.c0!.instructions).toContain("`target.aliases`");
  });
});

describe("classifyJevScore", () => {
  it("bands are [0,0.3) drop, [0.3,0.7) uncertain, [0.7,1] keep", () => {
    expect(JEV_DROP_BELOW).toBe(0.3);
    expect(JEV_UNCERTAIN_BELOW).toBe(0.7);
    expect(classifyJevScore(0)).toBe("drop");
    expect(classifyJevScore(0.29)).toBe("drop");
    expect(classifyJevScore(0.3)).toBe("uncertain");
    expect(classifyJevScore(0.69)).toBe("uncertain");
    expect(classifyJevScore(0.7)).toBe("keep");
    expect(classifyJevScore(1)).toBe("keep");
    expect(classifyJevScore(Number.NaN)).toBe("keep");
    expect(classifyJevScore(null as unknown as number)).toBe("keep");
    expect(classifyJevScore(undefined as unknown as number)).toBe("keep");
    expect(classifyJevScore(-1)).toBe("drop");   // finite but out of range: honest low score
    expect(classifyJevScore(1.5)).toBe("keep");
  });
});

describe("SnapshotPrefilter type", () => {
  it("is assignable onto ResourceSnapshot.prefilter", () => {
    const pf: SnapshotPrefilter = {
      provider: "jev",
      model: "typesafe/jev-1.13",
      status: "applied",
      scores: { c1: 0.95 },
      dropped: [{ id: "c2", title: "x", score: 0.1 }],
      thresholds: { dropBelow: 0.3, uncertainBelow: 0.7 },
      durationMs: 12,
    };
    const snap: ResourceSnapshot = {
      id: "s", provider: "p", keyword: "k", candidates: [], createdAt: "2026-09-19T00:00:00.000Z", prefilter: pf,
    };
    expect(snap.prefilter?.status).toBe("applied");
    expect(JEV_THRESHOLDS).toEqual({ dropBelow: 0.3, uncertainBelow: 0.7 });
  });
});

describe("jevUncertaintyFlag", () => {
  it("flags only the uncertain band and floors the score to 2 dp", () => {
    expect(jevUncertaintyFlag(0.52)).toBe(" ⚠ 相关度存疑(0.52)");
    // 0.699 must never print as 0.70 next to a "< 0.7" rule.
    expect(jevUncertaintyFlag(0.699)).toBe(" ⚠ 相关度存疑(0.69)");
    expect(jevUncertaintyFlag(0.3)).toBe(" ⚠ 相关度存疑(0.30)");
    expect(jevUncertaintyFlag(0.7)).toBe("");
    expect(jevUncertaintyFlag(0.29)).toBe("");
    expect(jevUncertaintyFlag(undefined)).toBe("");
    expect(jevUncertaintyFlag(Number.NaN)).toBe("");
  });
});

describe("prefilter legend and all-dropped warning", () => {
  it("legend explains the flag is not an exclusion", () => {
    expect(JEV_UNCERTAIN_LEGEND).toContain("⚠ 相关度存疑");
    expect(JEV_UNCERTAIN_LEGEND).toContain("这不是排除");
  });

  it("all-dropped warning names the count and rules out a source outage", () => {
    const w = jevAllDroppedWarning(7);
    expect(w).toContain("7 个候选");
    expect(w).toContain("预筛全部剔除");
    expect(w).toContain("不是搜索源故障");
    expect(w).toContain("reportNoCoverage");
  });
});
