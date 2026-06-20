import { describe, expect, it } from "vitest";
import { buildMovieSystemPrompt, buildTvAnimeSystemPrompt } from "../src/index.js";

describe("languageLine — Chinese-subtitle selection guidance", () => {
  it("no preference → no LANGUAGE PREFERENCE block", () => {
    expect(buildMovieSystemPrompt({})).not.toContain("LANGUAGE PREFERENCE");
  });

  it("中文 preference → release-nature judgement (strip prefix, scene vs community, no subtitle-file trust, hard requirement)", () => {
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
    // hard requirement
    expect(p).toContain("HARD");
    // same wording reaches the TV/anime prompt too
    expect(buildTvAnimeSystemPrompt({ preferredLanguage: "中文" })).toContain("STRIP");
  });

  it("non-Chinese preference → still gives a generic release-language line (no regression)", () => {
    const p = buildMovieSystemPrompt({ preferredLanguage: "English" });
    expect(p).toContain("LANGUAGE PREFERENCE");
    expect(p).toContain("English");
  });
});
