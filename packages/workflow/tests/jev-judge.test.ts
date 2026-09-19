// packages/workflow/tests/jev-judge.test.ts
import { describe, expect, it } from "vitest";
import {
  buildJevQuestions,
  JEV_DROP_BELOW,
  JEV_UNCERTAIN_BELOW,
  classifyJevScore,
} from "../src/jev-judge.js";

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
  });
});
