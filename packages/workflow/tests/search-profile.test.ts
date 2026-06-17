import { describe, expect, it } from "vitest";
import { getQualityGuidance, getSearchRecipe, searchProfile } from "../src/index.js";

describe("getSearchRecipe — post-deep-research recipe", () => {
  it("us-tv leads with 裸中文名 (NOT the old 别裸搜/+美剧), and forbids +美剧", () => {
    const r = getSearchRecipe("us-tv");
    expect(r).not.toContain("别裸搜");
    expect(r).toMatch(/首搜[^。]*中文/); // bare Chinese name first
    expect(r).toMatch(/避免[^]*美剧|美剧[^]*(有害|禁|避免|别)/); // +美剧 forbidden
  });

  it("cn-anime leads with 裸中文名 (research bare=0 was API jitter) and forbids +年份", () => {
    const r = getSearchRecipe("cn-anime");
    expect(r).toMatch(/首搜[^。]*中文|裸中文名/);
    expect(r).toMatch(/避免[^]*年份|年份[^]*(危险|避免|禁)/); // +年份 dangerous (拉真人版)
    expect(r).toContain("国漫"); // +国漫 still present as disambiguator
  });

  it("jp-anime forbids +年份 (脆/偏) and mandates 复搜 on 0", () => {
    const r = getSearchRecipe("jp-anime");
    expect(r).toMatch(/避免[^]*年份|年份[^]*(避免|禁|脆|别)/);
    expect(r).toMatch(/复搜/);
  });

  it("universal laws: 复搜 hardened (multiple times), 子类型词 forbidden (国漫 exception), 语言 follows 字幕偏好", () => {
    const r = getSearchRecipe("movie"); // laws ride on every recipe
    expect(r).toMatch(/复搜[^。]*[2-3]|[2-3][^。]*次/); // re-search 2-3 times
    expect(r).toContain("子类型词"); // the new sub-type-token law
    expect(r).toContain("国漫"); // its stated exception
    expect(r).toMatch(/字幕偏好|偏好[^。]*中文译名/); // search-language-follows-subtitle law
  });
});

describe("searchProfile", () => {
  it("maps any movie to the single movie profile, regardless of origin", () => {
    expect(searchProfile({ type: "movie", originCountries: ["CN"] })).toBe("movie");
    expect(searchProfile({ type: "movie", originCountries: ["JP"] })).toBe("movie");
    expect(searchProfile({ type: "movie", originCountries: [] })).toBe("movie");
  });

  it("splits tv by origin (cn/us/kr/jp), else generic-tv", () => {
    expect(searchProfile({ type: "tv", originCountries: ["CN"] })).toBe("cn-tv");
    expect(searchProfile({ type: "tv", originCountries: ["US"] })).toBe("us-tv");
    expect(searchProfile({ type: "tv", originCountries: ["KR"] })).toBe("kr-tv");
    expect(searchProfile({ type: "tv", originCountries: ["JP"] })).toBe("jp-tv");
    expect(searchProfile({ type: "tv", originCountries: ["GB"] })).toBe("generic-tv");
    expect(searchProfile({ type: "tv", originCountries: [] })).toBe("generic-tv");
  });

  it("splits anime by origin (jp/cn/us), else generic-anime", () => {
    expect(searchProfile({ type: "anime", originCountries: ["JP"] })).toBe("jp-anime");
    expect(searchProfile({ type: "anime", originCountries: ["CN"] })).toBe("cn-anime");
    expect(searchProfile({ type: "anime", originCountries: ["US"] })).toBe("us-anime");
    expect(searchProfile({ type: "anime", originCountries: ["KR"] })).toBe("generic-anime");
    expect(searchProfile({ type: "anime", originCountries: [] })).toBe("generic-anime");
  });

  it("resolves co-productions by a deterministic precedence", () => {
    // anime: JP wins (anime is JP-centric); tv: CN wins (indexed in the 国产/合拍 circle).
    expect(searchProfile({ type: "anime", originCountries: ["US", "JP"] })).toBe("jp-anime");
    expect(searchProfile({ type: "tv", originCountries: ["US", "CN"] })).toBe("cn-tv");
  });
});

describe("getQualityGuidance", () => {
  it("returns empty for 不限 / undefined", () => {
    expect(getQualityGuidance("movie", undefined)).toBe("");
    expect(getQualityGuidance("jp-anime", undefined)).toBe("");
  });

  it("high on a 4K-reachable profile promises real 4K + coverage-first fallback", () => {
    const g = getQualityGuidance("us-tv", "high");
    expect(g).toContain("高");
    expect(g).toMatch(/2160p|4K/);
    expect(g).toContain("覆盖"); // coverage-first fallback present
    expect(g).not.toMatch(/极少|没有|稀缺/); // reachable → not the scarcity warning
  });

  it("high prefers playable REMUX/video and warns AGAINST 原盘/ISO disc images", () => {
    // Live e2e caught a 100GB 4K BD原盘 .iso being picked — high quality but
    // unplayable, not a single video. Guidance must steer to REMUX/video.
    for (const p of ["movie", "us-tv", "jp-anime"] as const) {
      const g = getQualityGuidance(p, "high");
      expect(g).toContain("REMUX");
      expect(g).toMatch(/避免[^]*?(ISO|原盘|BDMV)/); // AVOID disc images, not promote them
    }
  });

  it("cn-anime is 4K-reachable (GM-Team HEVC=4K) — high guidance is NOT the scarcity variant", () => {
    const g = getQualityGuidance("cn-anime", "high");
    expect(g).toMatch(/2160p|4K/);
    expect(g).not.toMatch(/极少|没有|稀缺/);
  });

  it("high on a 4K-scarce profile warns 4K is rare and forbids over-searching", () => {
    for (const p of ["jp-anime", "us-anime", "jp-tv"] as const) {
      const g = getQualityGuidance(p, "high");
      expect(g).toMatch(/极少|没有|稀缺/); // scarcity stated
      expect(g).toMatch(/过度搜索|撞限|预算/); // over-search warning
      expect(g).toContain("1080"); // realistic ceiling
    }
  });

  it("medium targets 1080p, coverage-first, and reminds quality never enters the keyword", () => {
    const g = getQualityGuidance("movie", "medium");
    expect(g).toContain("1080");
    expect(g).toContain("覆盖");
    expect(g).toMatch(/不进搜索|不进关键词|召回后/);
  });
});
