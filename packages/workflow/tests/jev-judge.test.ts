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
  normalizeTitleForContainment,
  normalizedTargetNames,
  titleContainsAny,
  titleContainsTarget,
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

  it("tv year rule is ASYMMETRIC: an earlier-labelled candidate is rejected, a later one never is", () => {
    // The symmetric 「相差≥2」 rule rejected a long-running show's later seasons
    // (first air 2016, S8 labelled 2024 → diff 8 → 否 → silently dropped). That is
    // the one unacceptable failure for this prefilter: multi-season acquisition is core.
    const text = buildJevQuestions({ kind: "tv" }, ["c0"]).c0!.instructions;
    expect(text).toContain("早2年及以上");
    expect(text).toContain("后续季");
    expect(text).not.toContain("相差≥2");
  });

  it("movie wording guards against remakes/sequels and mentions aliases", () => {
    const q = buildJevQuestions({ kind: "movie" }, ["c0"]);
    expect(q.c0!.instructions).toContain("这部电影本身");
    // The movie wording is NOT asymmetric — a movie's year identifies the film itself
    // (1984 沙丘 vs 2021 沙丘), so it stays exactly as the evals measured it.
    expect(q.c0!.instructions).toContain("(`target.year`)");
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
  it("flags every kept candidate the judge was not confident about, floored to 2 dp", () => {
    expect(jevUncertaintyFlag(0.52)).toBe(" ⚠ 相关度存疑(0.52)");
    // 0.699 must never print as 0.70 next to a "< 0.7" rule.
    expect(jevUncertaintyFlag(0.699)).toBe(" ⚠ 相关度存疑(0.69)");
    expect(jevUncertaintyFlag(0.3)).toBe(" ⚠ 相关度存疑(0.30)");
    // Binary float: 0.57 * 100 === 56.99999999999999, so a naive floor prints 0.56 —
    // the agent would read a number the judge never produced.
    expect(jevUncertaintyFlag(0.57)).toBe(" ⚠ 相关度存疑(0.57)");
    expect(jevUncertaintyFlag(0.58)).toBe(" ⚠ 相关度存疑(0.58)");
    // Below dropBelow: such a row only ever reaches the agent through the containment
    // floor, and it must carry the judge's REAL number — flagging it 0.29/0.04 is the
    // honest signal; hiding the flag would present a 0.04 row as an ordinary result.
    expect(jevUncertaintyFlag(0.29)).toBe(" ⚠ 相关度存疑(0.29)");
    expect(jevUncertaintyFlag(0.04)).toBe(" ⚠ 相关度存疑(0.04)");
    expect(jevUncertaintyFlag(0.7)).toBe("");
    expect(jevUncertaintyFlag(undefined)).toBe("");
    // NaN classifies as keep (fail-open) → no flag, and never "NaN" in a title.
    expect(jevUncertaintyFlag(Number.NaN)).toBe("");
  });
});

describe("prefilter legend and all-dropped warning", () => {
  it("legend explains the flag is not an exclusion, the number, and the floor", () => {
    // The one semantic that matters: a flag is not an exclusion. Asserting the
    // constant contains its own opening words would only restate the source.
    expect(JEV_UNCERTAIN_LEGEND).toMatch(/不是排除/);
    // The flag now carries sub-threshold numbers (containment floor), so a naked
    // "(0.04)" needs both halves said out loud: what the number is, and that a low
    // one did not sneak past the filter — the title matched, so it was kept on purpose.
    expect(JEV_UNCERTAIN_LEGEND).toMatch(/括号内/);
    expect(JEV_UNCERTAIN_LEGEND).toMatch(/概率很低也会保留/);
  });

  it("all-dropped warning names the count and rules out a source outage", () => {
    const w = jevAllDroppedWarning(7);
    expect(w).toMatch(/7 个被系统按片名预筛剔除/);
    // It must NOT claim the search returned only those 7: dead-link filtering runs
    // after the prefilter and can remove the rest, so "全部剔除" would be a lie.
    expect(w).not.toContain("全部剔除");
    expect(w).toContain("不是搜索源故障");
    expect(w).toContain("reportNoCoverage");
  });
});

describe("normalizeTitleForContainment", () => {
  it("folds case and strips whitespace/brackets/punctuation, keeping the letters", () => {
    expect(normalizeTitleForContainment("《交 锋》(2026)")).toBe("交锋2026");
    expect(normalizeTitleForContainment("Sousou.no.Frieren S02E01")).toBe("sousounofrierens02e01");
    expect(normalizeTitleForContainment("   ")).toBe("");
  });

  it("NFKC-folds full-width forms and strips the &+# separators release names use", () => {
    // Full-width latin is common in Chinese release names; without NFKC 「ＴＨＥ ＢＯＹＳ」
    // and "The Boys" normalise to two different keys and the floor silently misses.
    expect(normalizeTitleForContainment("ＴＨＥ ＢＯＹＳ")).toBe("theboys");
    expect(normalizeTitleForContainment("Tom & Jerry")).toBe("tomjerry");
    expect(normalizeTitleForContainment("C＋＋＃1 ＆ A")).toBe("c1a");
  });
});

describe("titleContainsTarget", () => {
  it("is a structural floor: the target's name appearing verbatim in the title is enough", () => {
    // The replay's only violation: an uploader mislabel of 《交锋》 that Jev scores 0.04
    // under every wording tried, yet was the pack the agent actually selected.
    expect(titleContainsTarget("📺 权利交锋 (2026) S01E08 ✨4K", { title: "交锋", aliases: [] })).toBe(true);
    // Deliberately loose: this really is another work, but the judge's score still
    // marks it 相关度存疑 and the agent decides. Never dropping the right one wins.
    expect(titleContainsTarget("【2月新番】[交锋联盟：机巧一族][23]", { title: "交锋", aliases: [] })).toBe(true);
    expect(titleContainsTarget("无敌少侠 全4季", { title: "交锋", aliases: [] })).toBe(false);
  });

  it("separator-only punctuation between the words never breaks containment", () => {
    expect(titleContainsTarget("The.Boys.S04E01", { title: "The Boys", aliases: [] })).toBe(true);
    expect(titleContainsTarget("ＴＨＥ ＢＯＹＳ S04E01", { title: "The Boys", aliases: [] })).toBe(true);
    expect(titleContainsTarget("Tom.and.Jerry", { title: "Tom & Jerry", aliases: [] })).toBe(false);
    expect(titleContainsTarget("Tom&Jerry.2026.1080p", { title: "Tom & Jerry", aliases: [] })).toBe(true);
  });

  it("an alias counts, across the separators a release name uses", () => {
    expect(
      titleContainsTarget("Sousou.no.Frieren.S02E01", { title: "葬送的芙莉莲", aliases: ["Sousou no Frieren"] }),
    ).toBe(true);
  });

  it("a target with no usable name floors nothing (never a blanket keep-all)", () => {
    expect(titleContainsTarget("权利交锋 S01E08", { title: "   ", aliases: [] })).toBe(false);
    expect(titleContainsTarget("权利交锋 S01E08", { title: "《》", aliases: ["  "] })).toBe(false);
    expect(titleContainsTarget("   ", { title: "交锋", aliases: [] })).toBe(false);
  });
});

describe("normalizedTargetNames + titleContainsAny", () => {
  it("pre-normalises the target once so the provider does not re-normalise per candidate", () => {
    const names = normalizedTargetNames({ title: "交锋", aliases: [] });
    expect(names).toEqual(["交锋"]);
    expect(titleContainsAny("权利交锋 S01E08", names)).toBe(true);
    expect(titleContainsAny("无敌少侠 全4季", names)).toBe(false);
  });

  it("drops names that normalise to nothing, and an empty name list floors nothing", () => {
    expect(normalizedTargetNames({ title: " ", aliases: ["", "Frieren"] })).toEqual(["frieren"]);
    expect(normalizedTargetNames({ title: "《》", aliases: ["  "] })).toEqual([]);
    expect(titleContainsAny("权利交锋 S01E08", [])).toBe(false);
    expect(titleContainsAny("   ", ["交锋"])).toBe(false);
  });
});
