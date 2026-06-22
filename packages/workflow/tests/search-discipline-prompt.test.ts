import { describe, expect, it } from "vitest";
import { buildTvAnimeSystemPrompt, buildMovieSystemPrompt } from "../src/acquisition-v2/task-agents.js";

// Over-search regression: a live 超市 (躲在超市后门抽烟的两人) no-coverage run did 12
// searchPansou calls — churning many DISTINCT variants and appending genre/sub-type tags
// (动漫/动画/日剧/ドラマ) that the per-title recipe forbids. (An identical re-search and a
// "全集" fallback are NOT defects — the recipe relies on flaky-0 jitter-retry and allows
// 全集/Complete as a fallback.) The agent kept chasing the Japanese name into manga/raws. The
// fix elevates search discipline to a prominent hard rule (prompt-only, no mechanical
// keyword filter — selection stays the agent's judgment per the author's stance).
describe("search discipline — anti-churn hard rule (超市 over-search regression)", () => {
  it("tv/anime prompt allows jitter-retry but forbids genre/sub-type tags and bounds variant churn", () => {
    const p = buildTvAnimeSystemPrompt({});
    // a 0 can be jitter — re-running the SAME keyword 1-2x is correct (must NOT forbid it,
    // the per-title recipe relies on it). The rule targets variant churn, not jitter-retry.
    expect(p).toMatch(/jitter/i);
    // never append a genre/sub-type tag — assert the exact phrase + a concrete offending tag
    expect(p).toContain("genre/sub-type tag");
    expect(p).toContain("番剧");
    // a handful of DISTINCT good-faith queries that all miss = reportNoCoverage; don't churn
    expect(p).toMatch(/do ?not churn|don't churn/i);
    // the original/foreign name is a FALLBACK to find subtitle-carrying releases, not a
    // license to keep hunting raws (regex tolerates "not a license" / "not license")
    expect(p).toMatch(/not a? ?license to keep (hunting|chasing) raws/i);
  });

  it("movie prompt is unaffected by the tv/anime churn rule", () => {
    // the movie loop is already bounded ("stop the moment you can identify the one film")
    expect(buildMovieSystemPrompt({})).not.toMatch(/do ?not churn a dozen/i);
  });
});
