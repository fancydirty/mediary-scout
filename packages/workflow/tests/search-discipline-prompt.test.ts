import { describe, expect, it } from "vitest";
import { buildTvAnimeSystemPrompt, buildMovieSystemPrompt } from "../src/acquisition-v2/task-agents.js";
import { searchProfile, getSearchRecipe } from "../src/acquisition-v2/search-profile.js";

// Over-search regression: a live 超市 (躲在超市后门抽烟的两人) no-coverage run did ~10 DISTINCT
// reworded searches — appending genre/sub-type tags (动漫/动画/日剧/ドラマ) the recipe forbids and
// chasing the Japanese name into manga/raws. The fix is a prompt-only hard rule (no mechanical
// keyword filter — selection stays the agent's judgment per the author's stance) that bounds
// VARIANT churn. It deliberately does NOT touch the per-title recipe's keyword/0-retry strategy
// (e.g. UNIVERSAL_LAW ① "0 必复搜"), so the two never contradict — that interaction (the sandbox
// dedups identical keywords while the recipe says to re-submit on 0) is a separate finding.
describe("search discipline — anti-churn hard rule (超市 over-search regression)", () => {
  // mirror production: run-tv-v2 ALWAYS injects the per-title recipe via getSearchRecipe.
  const recipe = getSearchRecipe(searchProfile({ type: "anime", originCountries: ["JP"] }));

  it("tv/anime prompt (recipe injected): defers keyword strategy to the recipe, forbids genre tags, bounds churn", () => {
    const p = buildTvAnimeSystemPrompt({ searchHints: recipe });
    // the per-title recipe is actually present (this is the combined text the agent receives)
    expect(p).toContain(recipe);
    // the discipline rule explicitly DEFERS keyword/0-retry strategy to the recipe — so it does
    // not contradict the recipe's "0 必复搜"; it only governs variant churn on top.
    expect(p).toMatch(/per-title recipe owns the keyword strategy/i);
    // never append a genre/sub-type tag — exact phrase + a concrete offending tag
    expect(p).toContain("genre/sub-type tag");
    expect(p).toContain("番剧");
    // a handful of DISTINCT good-faith queries that all miss = reportNoCoverage; don't churn
    expect(p).toMatch(/do ?not churn|don't churn/i);
    // original/foreign name is a FALLBACK to find subtitle-carrying releases, not a license to
    // keep hunting raws (regex tolerates "not a license" / "not license")
    expect(p).toMatch(/not a? ?license to keep (hunting|chasing) raws/i);
  });

  it("movie prompt is unaffected by the tv/anime churn rule", () => {
    expect(buildMovieSystemPrompt({})).not.toMatch(/do ?not churn a dozen/i);
  });
});
