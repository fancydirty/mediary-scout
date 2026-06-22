import { describe, expect, it } from "vitest";
import { buildTvAnimeSystemPrompt, buildMovieSystemPrompt } from "../src/acquisition-v2/task-agents.js";

// Over-search regression: a live 超市 (躲在超市后门抽烟的两人) no-coverage run did 12
// searchPansou calls — including an IDENTICAL repeated query and several genre/sub-type
// tags appended (动漫/动画/全集/日剧/ドラマ) that the per-title recipe already forbids.
// The agent kept chasing the Japanese name into manga/raws instead of concluding. The
// fix elevates search discipline to a prominent hard rule (prompt-only, no mechanical
// keyword filter — selection stays the agent's judgment per the author's stance).
describe("search discipline — anti-churn hard rule (超市 over-search regression)", () => {
  it("tv/anime prompt forbids identical re-searches and genre/sub-type tags, and bounds churn", () => {
    const p = buildTvAnimeSystemPrompt({});
    // never repeat an identical keyword already searched
    expect(p).toMatch(/identical keyword/i);
    // never append a genre/sub-type tag — name the offending tags so the rule is concrete
    expect(p).toMatch(/genre.{0,4}sub-?type|sub-?type.{0,4}tag/i);
    expect(p).toContain("番剧");
    // a handful of DISTINCT good-faith queries that all miss = reportNoCoverage; don't churn
    expect(p).toMatch(/do ?not churn|don't churn/i);
    // the original/foreign name is a FALLBACK to find subtitle-carrying releases, not a
    // license to keep hunting raws (directly addresses the 超市 "搜日文转生肉" churn)
    expect(p).toMatch(/not license to keep (hunting|chasing) raws/i);
  });

  it("movie prompt is unaffected by the tv/anime churn rule", () => {
    // the movie loop is already bounded ("stop the moment you can identify the one film")
    expect(buildMovieSystemPrompt({})).not.toMatch(/do ?not churn a dozen/i);
  });
});
