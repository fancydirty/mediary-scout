import { describe, expect, it } from "vitest";
import {
  BRAND_BAR,
  BRAND_CSS,
  esc,
  FAVICON_LINK,
  FAVICON_SVG,
  LOGO_SVG,
  THEME_BASE,
  THEME_TOKENS,
} from "./theme.js";

describe("theme tokens", () => {
  it("defines the dark base and brand-green accent", () => {
    expect(THEME_TOKENS).toContain("--bg-base:#121212");
    expect(THEME_TOKENS).toContain("--accent:#1ed760");
    expect(THEME_TOKENS).toContain("color-scheme:dark");
  });

  it("base layer paints the dark background and green hero glow", () => {
    expect(THEME_BASE).toContain("background:var(--bg-base)");
    expect(THEME_BASE).toContain("radial-gradient");
  });

  it("brand bar carries the wordmark and CONNECT tag", () => {
    expect(BRAND_BAR).toContain("Mediary Scout");
    expect(BRAND_BAR).toContain("CONNECT");
    expect(BRAND_BAR).toContain(LOGO_SVG);
    expect(BRAND_CSS).toContain(".brand");
  });
});

describe("favicon", () => {
  it("svg is a standalone document with xmlns and the aperture fill", () => {
    expect(FAVICON_SVG).toContain("xmlns=");
    expect(FAVICON_SVG).toContain("#1ED760");
  });

  it("link tag embeds the svg as a url-encoded data uri", () => {
    expect(FAVICON_LINK).toContain('rel="icon"');
    expect(FAVICON_LINK).toContain("image/svg+xml");
    expect(FAVICON_LINK).toContain("data:image/svg+xml,");
    // 编码后不得残留裸引号/尖括号,否则会截断 href 属性。
    const href = FAVICON_LINK.split('href="')[1]!.split('"')[0]!;
    expect(href).not.toContain("<");
    expect(href).not.toContain('"');
  });
});

describe("esc", () => {
  it("escapes the five html-significant characters", () => {
    expect(esc(`<a href="x" data='y'>&`)).toBe(
      "&lt;a href=&quot;x&quot; data=&#39;y&#39;&gt;&amp;",
    );
  });
});
