import { describe, expect, it } from "vitest";
import { buildTvAnimeSystemPrompt, buildMovieSystemPrompt } from "../src/acquisition-v2/task-agents.js";

// #4: a coherent full-season pack often carries episodes BEYOND TMDB's aired cursor
// (the release is ahead of TMDB). The agent must mark those (verified-landed) episodes
// too — sync-need records them as provider-ahead and the frontend shows 超前 — instead
// of "leaving them for the patrol". Safety: only VERIFIED-landed episodes from a coherent
// full pack, never episodes a pack merely claims.
describe("coverage honesty — trust a full pack's beyond-aired episodes (#4 provider-ahead)", () => {
  it("tv/anime: marks verified-landed beyond-aired episodes as provider-ahead", () => {
    const p = buildTvAnimeSystemPrompt({});
    // NEW #4 clause — distinctive phrases absent from the prior prompt:
    expect(p).toContain("ahead of TMDB"); // a full pack can be ahead of TMDB's aired count
    expect(p).toMatch(/markObtained them too[\s\S]{0,80}provider-ahead/i); // mark them → recorded provider-ahead
    // must MOVE the extra episodes into the season dir, or discardStaging wipes them (Copilot #23):
    expect(p).toMatch(/moveToSeason[^.]{0,140}discardStaging|discardStaging[^.]{0,140}moveToSeason/i);
    // hard-safety wording specific to this clause (not a generic 'inspect' elsewhere):
    expect(p).toContain("a pack merely claims");
    expect(p).toMatch(/patrol/i); // genuinely-unaired (no resource) still left for the patrol
  });

  it("movie prompt is unaffected (no seasons/episodes)", () => {
    expect(buildMovieSystemPrompt({})).not.toContain("provider-ahead");
  });
});
