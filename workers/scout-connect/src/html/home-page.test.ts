import { describe, expect, it } from "vitest";
import { homePage } from "./home-page.js";

describe("home page", () => {
  it("uses the shared dark+green theme, brand bar, and favicon (unified with the other pages)", () => {
    const html = homePage();
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("--accent:#1ed760");
    expect(html).toContain("color-scheme:dark");
    expect(html).toContain("CONNECT");
    expect(html).toContain('rel="icon"');
    // 旧浅色样式的痕迹必须消失
    expect(html).not.toContain("color:#222");
    expect(html).not.toContain("color:#06c");
  });

  it("keeps the bilingual product description and footer nav", () => {
    const html = homePage();
    expect(html).toContain("只负责开门");
    expect(html).toContain("only opens the door");
    for (const path of ["/pricing", "/terms", "/privacy", "/refund", "/contact"]) {
      expect(html).toContain(`href="${path}"`);
    }
  });
});
