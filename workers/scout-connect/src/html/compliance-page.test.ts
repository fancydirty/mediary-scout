import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COMPLIANCE_MARKDOWN } from "./compliance-content.gen.js";
import { compliancePage, COMPLIANCE_PAGES } from "./compliance-page.js";

describe("generated content freshness", () => {
  it("compliance-content.gen.ts matches src/content/*.md byte-for-byte", () => {
    // 生成文件进 git；.md 改了但忘了重新生成 → 这里红。
    const contentDir = join(__dirname, "..", "content");
    const files = readdirSync(contentDir).filter((f) => f.endsWith(".md")).sort();
    expect(files.map((f) => f.replace(/\.md$/, ""))).toEqual(
      Object.keys(COMPLIANCE_MARKDOWN).sort(),
    );
    for (const f of files) {
      const key = f.replace(/\.md$/, "");
      expect(COMPLIANCE_MARKDOWN[key], `${f} 与生成文件不一致——跑 node scripts/generate-content.mjs`).toBe(
        readFileSync(join(contentDir, f), "utf8"),
      );
    }
  });
});

describe("compliance pages", () => {
  it("exposes exactly the five pages with zh titles", () => {
    expect(Object.keys(COMPLIANCE_PAGES).sort()).toEqual([
      "contact",
      "pricing",
      "privacy",
      "refund",
      "terms",
    ]);
  });

  it("renders a full HTML document with the page title and footer nav", () => {
    const html = compliancePage("refund");
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("<title>退款政策 · Mediary Connect</title>");
    expect(html).toContain("<h1>退款政策</h1>");
    // 页脚互链：五页彼此可达（Paddle 审核员会点着看）。
    for (const path of ["/terms", "/privacy", "/refund", "/pricing", "/contact"]) {
      expect(html).toContain(`href="${path}"`);
    }
  });

  it("refund page states the 14-day minimum explicitly (Paddle rejection letter item)", () => {
    const html = compliancePage("refund");
    expect(html).toContain("14 天");
    expect(html).toContain("无理由");
    // 必须链到 Paddle Buyer Terms —— 拒信原文点名要求一致性。
    expect(html).toContain("https://www.paddle.com/legal/checkout-buyer-terms");
  });

  it("pricing page lists the four tiers with exact CNY amounts", () => {
    const html = compliancePage("pricing");
    for (const amount of ["¥45", "¥108", "¥188", "¥88"]) {
      expect(html).toContain(amount);
    }
    expect(html).toContain("不自动扣款");
  });

  it("privacy page keeps the honesty guardrails", () => {
    const html = compliancePage("privacy");
    expect(html).toContain("始终只在你自己的机器上");
    expect(html).not.toMatch(/我们会存储你的(媒体|内容)/);
  });

  it("never leaks raw markdown syntax into the page", () => {
    for (const key of Object.keys(COMPLIANCE_PAGES)) {
      const html = compliancePage(key as keyof typeof COMPLIANCE_PAGES);
      expect(html, `${key} 含未渲染的 markdown 标题`).not.toMatch(/^#{1,3}\s/m);
      expect(html, `${key} 含未渲染的粗体语法`).not.toContain("**");
    }
  });
});
