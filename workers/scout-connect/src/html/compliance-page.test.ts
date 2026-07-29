import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COMPLIANCE_MARKDOWN } from "./compliance-content.gen.js";
import { compliancePage, COMPLIANCE_PAGES } from "./compliance-page.js";

describe("generated content freshness", () => {
  it("compliance-content.gen.ts matches src/content/*.md byte-for-byte", () => {
    // 生成文件进 git；.md 改了但忘了重新生成 → 这里红。
    // import.meta.url 而非 __dirname：本仓测试跑在 ESM 语义下，__dirname
    // 依赖 vitest 的 CJS shim，换 runner/配置就碎（round 1 评审指出）。
    const contentDir = join(dirname(fileURLToPath(import.meta.url)), "..", "content");
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
  it("exposes exactly the five pages with EN + zh titles", () => {
    expect(Object.keys(COMPLIANCE_PAGES).sort()).toEqual([
      "contact",
      "pricing",
      "privacy",
      "refund",
      "terms",
    ]);
    // 每页都有英文与中文标题(双语版式)。
    for (const t of Object.values(COMPLIANCE_PAGES)) {
      expect(typeof t.en).toBe("string");
      expect(typeof t.zh).toBe("string");
    }
  });

  // 中英已拆成各自一页(用户反馈:交叉着读很累)。中文是默认语言。
  it("renders a full dark-themed document; 中文默认、英文走 ?lang=en", () => {
    const zh = compliancePage("refund");
    expect(zh).toContain("<!doctype html>");
    expect(zh).toContain('<html lang="zh-Hans">');
    expect(zh).toContain("<title>退款政策 · Mediary Connect</title>");
    expect(zh).toContain("--accent:#1ed760");
    expect(zh).toContain('rel="icon"');
    expect(zh).toContain("CONNECT");
    // 中文页必须有主标题(首个 h2 被提升为 h1),否则文档无 h1
    expect(zh).toMatch(/<h1[^>]*>退款政策<\/h1>/);
    expect(zh).not.toContain("Refund Policy</h1>");
    // 页脚互链：五页彼此可达（Paddle 审核员会点着看），且保持当前语言
    for (const path of ["/terms", "/privacy", "/refund", "/pricing", "/contact"]) {
      expect(zh).toContain(`href="${path}"`);
    }

    const en = compliancePage("refund", "en");
    expect(en).toContain('<html lang="en">');
    expect(en).toContain("<title>Refund Policy · Mediary Connect</title>");
    expect(en).toContain("<h1>Refund Policy</h1>");
    for (const path of ["/terms", "/privacy", "/refund", "/pricing", "/contact"]) {
      expect(en).toContain(`href="${path}?lang=en"`);
    }
  });

  it("refund page states the 14-day minimum in both languages (Paddle rejection letter item)", () => {
    const en = compliancePage("refund", "en");
    const zh = compliancePage("refund", "zh");
    expect(en).toContain("14 days");
    expect(en).toContain("no-questions-asked");
    expect(zh).toContain("14 天");
    expect(zh).toContain("无理由");
    // Paddle 要求「无条件」:任何限定词都会被拒(拒信原文点名"含限定条件")。
    expect(en).toContain("whether or not you have used the service");
    expect(zh).toContain("无论是否已经使用过本服务");
    // 必须链到 Paddle Buyer Terms —— 拒信原文点名要求一致性。两页都要有。
    for (const html of [en, zh]) {
      expect(html).toContain("https://www.paddle.com/legal/checkout-buyer-terms");
    }
  });

  it("pricing page lists the four tiers with exact CNY amounts (两种语言都要有)", () => {
    for (const lang of ["en", "zh"] as const) {
      const html = compliancePage("pricing", lang);
      for (const amount of ["¥45", "¥108", "¥188", "¥88"]) {
        expect(html, `${lang} 缺 ${amount}`).toContain(amount);
      }
    }
    expect(compliancePage("pricing", "zh")).toContain("不自动扣款");
    expect(compliancePage("pricing", "en")).toContain("never auto-charged");
  });

  it("privacy page keeps the honesty guardrails", () => {
    const zh = compliancePage("privacy", "zh");
    const en = compliancePage("privacy", "en");
    expect(zh).toContain("始终只在你自己的机器上");
    expect(en).toContain("always stay on your own machine");
    expect(zh).not.toMatch(/我们会存储你的(媒体|内容)/);
  });

  it("never leaks raw markdown syntax into the page", () => {
    for (const key of Object.keys(COMPLIANCE_PAGES)) {
      for (const lang of ["en", "zh"] as const) {
      const html = compliancePage(key as keyof typeof COMPLIANCE_PAGES, lang);
      expect(html, `${key}/${lang} 含未渲染的 markdown 标题`).not.toMatch(/^#{1,3}\s/m);
      expect(html, `${key}/${lang} 含未渲染的粗体语法`).not.toContain("**");
      }
    }
  });
});
