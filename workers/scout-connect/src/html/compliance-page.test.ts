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
describe("合规页与产品现实的一致性", () => {
  const ALL = ["pricing", "terms", "privacy", "refund", "contact"] as const;

  it("五页都不提「支付宝」(live API 实测中国区不支持)", () => {
    // Paddle live API 实测可用:card / wechat_pay / apple_pay / google_pay。
    // 写支付宝既是事实错误,也是 MoR 的支付方式表述合规风险。
    for (const key of ALL) {
      for (const lang of ["zh", "en"] as const) {
        const html = compliancePage(key, lang);
        expect(html, `${key}/${lang}`).not.toContain("支付宝");
        expect(html, `${key}/${lang}`).not.toContain("Alipay");
      }
    }
  });

  // 说明要准确:代码里**有**席位计数(WAITLIST_SEAT_CAP=100,那是内测报名的上限),
  // 缺的是**付费档位**的席位计数与续期锁价 —— entitlements 表不记录用什么价买的,
  // 所以「续期同价」无从判断。两者别混为一谈。
  it("定价页不承诺创始价席位(缺的是付费席位计数与续期锁价)", () => {
    for (const lang of ["zh", "en"] as const) {
      const html = compliancePage("pricing", lang);
      expect(html).not.toContain("创始价");
      expect(html).not.toContain("Founding");
      expect(html).not.toContain("100 席");
      expect(html).not.toContain("100 seats");
    }
  });

  // **两种语言都要断言**:compliancePage 把一份双语 markdown 拆成 EN/zh 两页,
  // 只测中文的话英文那侧可以静默丢内容而测试照样绿。
  it("定价页提到微信支付与 MoR 账单说明(消除 chargeback 诱因)", () => {
    const zh = compliancePage("pricing", "zh");
    expect(zh).toContain("微信支付");
    // 账单上出现 Paddle 的名字是 chargeback 的常见诱因,要提前说明
    expect(zh).toContain("记录商户");
    const en = compliancePage("pricing", "en");
    expect(en).toContain("WeChat Pay");
    expect(en).toContain("Merchant of Record");
  });

  it("定价页补了首页没有的细节:购买顺序 / 不包含什么 / 换档调价 / 容量", () => {
    const zh = compliancePage("pricing", "zh");
    for (const k of ["先登录", "不包含什么", "换档与调价", "容量"]) expect(zh).toContain(k);
    // 涨价不影响已买时长 —— 这条能兑现(预付时长本就没有下次扣款)
    expect(zh).toContain("已经买到的时长不受影响");

    const en = compliancePage("pricing", "en");
    for (const k of ["you log in first", "does not include", "price changes", "Capacity"]) {
      expect(en, `EN 缺 ${k}`).toContain(k);
    }
    expect(en).toContain("time you already bought is unaffected");
  });

  // Copilot round-2:隐私政策不该点名任何具体支付方式 —— Paddle 支持的方式
  // 按地区/时间变,写死一个就是给自己埋下一次过时(这个 PR 本身就是在修
  // 「支付宝」过时的问题)。这一段的重点是「我们碰不到」,与方式无关。
  // Copilot round-3:我原本写「结账前有容量闸门,售罄会告诉你而不是先收钱」——
  // 但 createCheckout **不检查容量**,闸门在 selfServeProvision(选 slug 那步)。
  // 用户可能先付款成功、到选域名时才撞上售罄。承诺不能比代码强。
  it("容量条款不承诺「结账会拦住」(闸门实际在选域名那步)", () => {
    const zh = compliancePage("pricing", "zh");
    expect(zh).not.toContain("结账前设了容量闸门");
    expect(zh).not.toContain("而不是先收钱");
    // 要说清真实位置,并给出已付款后撞上售罄的兜底
    expect(zh).toContain("选定域名那一步");
    expect(zh).toContain("14 天退款政策适用");
    const en = compliancePage("pricing", "en");
    expect(en).not.toContain("capacity gate in front of checkout");
    expect(en).toContain("when you claim your hostname");
  });

  it("隐私政策不点名具体支付方式(避免再次过时)", () => {
    for (const lang of ["zh", "en"] as const) {
      const html = compliancePage("privacy", lang);
      for (const m of ["支付宝", "Alipay", "微信支付", "WeChat Pay"]) {
        expect(html, `${lang} 不该出现 ${m}`).not.toContain(m);
      }
    }
    // 但「我们碰不到付款凭据」这个承诺必须还在
    expect(compliancePage("privacy", "zh")).toContain("不接触");
    expect(compliancePage("privacy", "en")).toContain("never touch");
  });

  it("改了内容就要动 Last updated(否则这个字段是骗人的)", () => {
    for (const key of ["pricing", "privacy"] as const) {
      expect(compliancePage(key, "en")).toContain("Last updated: 2026-07-31");
      expect(compliancePage(key, "zh")).toContain("最后更新:2026-07-31");
    }
  });

  it("三档价格与首页一致", () => {
    const zh = compliancePage("pricing", "zh");
    for (const p of ["¥45", "¥108", "¥188"]) expect(zh).toContain(p);
    expect(zh).not.toContain("¥88");
  });
});
