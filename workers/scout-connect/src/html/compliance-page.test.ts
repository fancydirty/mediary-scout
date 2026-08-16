import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COMPLIANCE_MARKDOWN } from "./compliance-content.gen.js";
import { compliancePage, COMPLIANCE_PAGES, type CompliancePageKey } from "./compliance-page.js";

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
    // 页脚互链：五页彼此可达，且保持当前语言
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

  it("refund page states the 14-day no-questions-asked promise in both languages", () => {
    const en = compliancePage("refund", "en");
    const zh = compliancePage("refund", "zh");
    expect(en).toContain("14 days");
    expect(en).toContain("no-questions-asked");
    expect(zh).toContain("14 天");
    expect(zh).toContain("无理由");
    expect(en).toContain("whether or not you have used the service");
    expect(zh).toContain("无论是否已经使用过本服务");
  });

  // 创始价那档已撤(代码里无席位计数、无续期锁价,「前 100 席 · 续期同价」
  // 兑现不了)。所以是**三**档,不是四档 —— 这条测试原本钉着 ¥88,
  // 撤档后它就成了「钉住一个不该存在的承诺」。
  it("pricing page lists the three tiers with exact CNY amounts (两种语言都要有)", () => {
    for (const lang of ["en", "zh"] as const) {
      const html = compliancePage("pricing", lang);
      for (const amount of ["¥45", "¥108", "¥188"]) {
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

  // ---- 双语页的规范化信号(SEO 基线审计发现:此前 head 里既无 canonical
  // 也无 alternate,中英两版互为重复内容,Google 无从判断谁是规范)。----
  it("每页都有 canonical，指向自己的规范 URL(中文无参、英文带 ?lang=en)", () => {
    for (const key of Object.keys(COMPLIANCE_PAGES) as CompliancePageKey[]) {
      expect(compliancePage(key, "zh")).toContain(
        `<link rel="canonical" href="https://mediaryconnect.app/${key}">`,
      );
      expect(compliancePage(key, "en")).toContain(
        `<link rel="canonical" href="https://mediaryconnect.app/${key}?lang=en">`,
      );
    }
  });

  it("每页都有自含的 hreflang 集合(zh-Hans + en + x-default，且含自己)", () => {
    // Google 要求 alternate 集合自含:缺了自己会被判「无返回标记」。
    for (const key of Object.keys(COMPLIANCE_PAGES) as CompliancePageKey[]) {
      for (const lang of ["zh", "en"] as const) {
        const html = compliancePage(key, lang);
        expect(html).toContain(
          `<link rel="alternate" hreflang="zh-Hans" href="https://mediaryconnect.app/${key}">`,
        );
        expect(html).toContain(
          `<link rel="alternate" hreflang="en" href="https://mediaryconnect.app/${key}?lang=en">`,
        );
        expect(html).toContain(
          `<link rel="alternate" hreflang="x-default" href="https://mediaryconnect.app/${key}">`,
        );
      }
    }
  });

  it("每页都有 description(SERP 摘要，此前缺失)", () => {
    for (const key of Object.keys(COMPLIANCE_PAGES) as CompliancePageKey[]) {
      for (const lang of ["zh", "en"] as const) {
        expect(compliancePage(key, lang)).toMatch(/<meta name="description" content="[^"]{20,}"/);
      }
    }
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

// 合规页与首页/代码现实必须一致 —— 不一致就是虚假宣传,退款争议里站不住。
describe("合规页与支付宝支付现实的一致性", () => {
  const ALL = ["pricing", "terms", "privacy", "refund", "contact"] as const;

  it("五页完全移除旧支付服务商与记录商户表述", () => {
    for (const key of ALL) {
      const markdown = COMPLIANCE_MARKDOWN[key];
      expect(markdown).not.toContain("Paddle");
      expect(markdown).not.toContain("Merchant of Record");
      expect(markdown).not.toContain("记录商户");
    }
  });

  it("定价页明确仅支付宝，三档价格保持不变", () => {
    const zh = compliancePage("pricing", "zh");
    const en = compliancePage("pricing", "en");
    expect(zh).toContain("仅支持支付宝");
    expect(en).toContain("Alipay only");
    expect(zh).not.toContain("微信支付");
    expect(en).not.toContain("WeChat Pay");
    for (const price of ["¥45", "¥108", "¥188"]) {
      expect(zh).toContain(price);
      expect(en).toContain(price);
    }
    expect(zh).not.toContain("¥88");
  });

  it("退款页要求提供原支付宝订单或交易号，并保留原路退款承诺", () => {
    const zh = compliancePage("refund", "zh");
    const en = compliancePage("refund", "en");
    expect(zh).toContain("原支付宝订单号或交易号");
    expect(en).toContain("original Alipay order or transaction number");
    expect(zh).toContain("原路退回");
    expect(en).toContain("original payment method");
    expect(zh).toContain("support@mediaryconnect.app");
  });

  it("隐私页准确说明支付宝处理凭据、我方只存最少订单记录", () => {
    const zh = compliancePage("privacy", "zh");
    const en = compliancePage("privacy", "en");
    expect(zh).toContain("支付宝处理你的钱包凭据");
    expect(zh).toContain("不会接收或保存");
    expect(en).toContain("Alipay handles your wallet credentials");
    expect(en).toContain("never receive or store");
    expect(zh).toContain("订单号");
    expect(en).toContain("order number");
  });

  it("容量条款不承诺结账前拦截，已付款售罄仍有 14 天退款", () => {
    const zh = compliancePage("pricing", "zh");
    expect(zh).not.toContain("结账前设了容量闸门");
    expect(zh).toContain("选定域名那一步");
    expect(zh).toContain("14 天退款政策适用");
    const en = compliancePage("pricing", "en");
    expect(en).not.toContain("capacity gate in front of checkout");
    expect(en).toContain("when you claim your hostname");
  });

  it("所有本轮修改页的 Last updated 都是切换日期", () => {
    for (const key of ALL) {
      expect(compliancePage(key, "en")).toContain("Last updated: 2026-08-16");
      expect(compliancePage(key, "zh")).toContain("最后更新:2026-08-16");
    }
  });
});
