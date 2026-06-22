import { describe, expect, it } from "vitest";
import { buildTvAnimeSystemPrompt, buildMovieSystemPrompt } from "../src/acquisition-v2/task-agents.js";

// Over-search regression: a live 超市 (躲在超市后门抽烟的两人) no-coverage run did 12
// searchPansou calls — re-submitting an identical keyword (a no-op: searchResources dedups
// it, no fresh provider hit — sandbox.ts) AND churning many DISTINCT variants with genre/
// sub-type tags appended (动漫/动画/日剧/ドラマ) that the recipe forbids, chasing the Japanese
// name into manga/raws. (A "全集" fallback is NOT a defect — the recipe allows it.) The fix
// elevates search discipline to a prominent hard rule (prompt-only, no mechanical keyword
// filter — selection stays the agent's judgment per the author's stance).
describe("search discipline — anti-churn hard rule (超市 over-search regression)", () => {
  it("tv/anime prompt: identical re-search is deduped (vary instead), forbids genre/sub-type tags, bounds churn", () => {
    const p = buildTvAnimeSystemPrompt({});
    // re-submitting an identical keyword is a no-op (sandbox dedups → cached snapshot); to
    // re-check a 0 you must VARY the keyword. The rule must reflect the real tool behavior.
    expect(p).toMatch(/dedups|cached snapshot/i);
    expect(p).toMatch(/vary the keyword/i);
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
