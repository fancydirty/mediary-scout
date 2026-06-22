import { describe, expect, it } from "vitest";
import { buildTvAnimeSystemPrompt, buildMovieSystemPrompt } from "../src/acquisition-v2/task-agents.js";

// #2: the user's emphatic complaint was "语言偏好一点屁用没有" — the agent on a 115 drive
// (where 超市中字 doesn't exist; only 日文生肉 has a 115-compatible link) settled for raw.
// 中文 must be a HARD floor: when no 中文-subbed candidate is reachable on the drive, the agent
// must reportNoCoverage honestly rather than land an unreadable 生肉/foreign rip.
describe("language preference — 中文 is a hard floor (no raw fallback)", () => {
  for (const [name, build] of [
    ["tv/anime", buildTvAnimeSystemPrompt],
    ["movie", buildMovieSystemPrompt],
  ] as const) {
    it(`${name}: 中文 unreachable → report no-coverage, never land raw`, () => {
      const p = build({ preferredLanguage: "中文" });
      expect(p).toContain("中文 subtitles — a HARD requirement");
      // NEW directive: no 中文 reachable ⇒ not acceptable coverage ⇒ reportNoCoverage
      expect(p).toContain("NOT acceptable coverage");
      expect(p).toContain("该盘无中文字幕源");
      // the old loose permission to "treat it as weak coverage" (i.e. land the raw) is gone
      expect(p).not.toContain("treat it as weak coverage");
    });
  }

  it("no preference set → no language block (不限)", () => {
    expect(buildTvAnimeSystemPrompt({})).not.toContain("LANGUAGE PREFERENCE");
  });
});
