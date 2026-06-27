import { describe, expect, it } from "vitest";
import { buildMovieSystemPrompt, buildTvAnimeSystemPrompt } from "../src/index.js";

describe("languageLine — Chinese-subtitle selection guidance", () => {
  it("no preference → no LANGUAGE PREFERENCE block", () => {
    expect(buildMovieSystemPrompt({})).not.toContain("LANGUAGE PREFERENCE");
  });

  it("中文 preference → release-nature judgement (strip prefix, scene vs community, no subtitle-file trust); movie SOFT, tv HARD", () => {
    const p = buildMovieSystemPrompt({ preferredLanguage: "中文" });
    expect(p).toContain("LANGUAGE PREFERENCE");
    // judge by the release, after stripping PanSou's prepended Chinese name
    expect(p).toContain("STRIP");
    // recognise English scene releases as no-Chinese-subs
    expect(p).toMatch(/scene/i);
    // a Chinese-community release implies subs without a literal 中字 token
    expect(p).toContain("中字");
    // never infer from subtitle file / mkv
    expect(p).toMatch(/mkv/i);
    // movie: SOFT last-resort fallback (NOT a hard floor) — the 环太平洋 fix
    expect(p).toContain("subtitleFallback");
    expect(p).not.toContain("中文 subtitles — a HARD requirement");
    // the shared release-nature wording reaches the TV/anime prompt too — which IS hard
    const tv = buildTvAnimeSystemPrompt({ preferredLanguage: "中文" });
    expect(tv).toContain("STRIP");
    expect(tv).toContain("HARD");
  });

  it("non-Chinese preference → still gives a generic release-language line (no regression)", () => {
    const p = buildMovieSystemPrompt({ preferredLanguage: "English" });
    expect(p).toContain("LANGUAGE PREFERENCE");
    expect(p).toContain("English");
  });
});
