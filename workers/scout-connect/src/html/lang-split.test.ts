import { describe, expect, it } from "vitest";
import { extractLang, isZhBlock } from "./lang-split.js";
import { COMPLIANCE_MARKDOWN } from "./compliance-content.gen.js";

describe("isZhBlock", () => {
  it("含汉字判中文,纯英文判英文", () => {
    expect(isZhBlock("退款政策")).toBe(true);
    expect(isZhBlock("Refund Policy")).toBe(false);
  });

  it("既无汉字也无 CJK 专属标点 → 不判中文(纯数字/纯符号块)", () => {
    expect(isZhBlock("2026-07-28")).toBe(false);
    expect(isZhBlock("---")).toBe(false);
  });

  // em dash / ellipsis 在英文排版里同样常用(本仓 content 里有 10 个纯英文块
  // 用了 em dash)。曾把它们当中文信号,导致整段英文正文从英文页消失。
  it("em dash 与省略号不算中文信号(英文排版同样常用)", () => {
    expect(isZhBlock("No conditions, no exceptions, no deductions — it just works")).toBe(false);
    expect(isZhBlock("Pay once … and that is it")).toBe(false);
    // 但真正 CJK 专属的标点仍应判中文
    expect(isZhBlock("如有争议,以 Paddle Buyer Terms 与适用法律为准。")).toBe(true);
  });

  // URL/域名/代码里的拉丁字母不表达语种,计数前必须剔除。
  // 真实案例:refund.md 那段「…Paddle 的 [Buyer Terms](https://…) 一致…」
  // 中文 52 字,但 URL 带进 78 个拉丁字母 → 曾被判成英文块,导致该段同时
  // 出现在英文页、又从中文页消失。
  // 这里刻意用**不含全角标点**的样本,否则会被 CJK_PUNCT_RE 提前判定,
  // 测不到剔除逻辑本身(反向验证发现过这个盲区)。
  it("URL/域名/代码里的拉丁字母不计入语种判定", () => {
    // 中文 6 字 vs URL 里 40+ 拉丁字母:不剔除就会误判成英文
    expect(
      isZhBlock("详见 [退款政策](https://mediaryconnect.app/refund/policy/details)"),
    ).toBe(true);
    // 裸域名同理
    expect(isZhBlock("专属域名 alice.mediaryconnect.app 永久保留")).toBe(true);
    // 行内代码同理
    expect(isZhBlock("在设置里填 `MEDIARY_CONNECT_HOSTNAME` 这一项")).toBe(true);
    // 反面:剔除后确实以英文为主的块仍判英文
    expect(isZhBlock("Visit [the docs](https://example.com/docs) for setup steps")).toBe(false);
  });

  // 判据是「剔除 URL/代码后含任何汉字 → 中文」,而非比数量。
  // 依据:本仓双语约定为「英文块 + 中文块成对」,实测 content/*.md 里剔除
  // URL/代码后含汉字的 70 个块全部是中文块,**不存在英文正文夹汉字的块**。
  // 数量比较是更弱的近似,会在邮箱/专名/链接多的块上翻车(contact.md 曾因此
  // 丢掉支持邮箱)。
  it("含汉字即判中文(不比数量,专名与邮箱再多也不翻车)", () => {
    expect(isZhBlock("本服务由 Paddle 作为记录商户处理你的付款")).toBe(true);
    // 这两个是真实翻车案例:按数量判会被当成英文
    expect(isZhBlock("支持与商务:**support@mediaryconnect.app**")).toBe(true);
    expect(
      isZhBlock("Mediary Scout 是开源项目:[github.com/fancydirty/mediary-scout](https://github.com/fancydirty/mediary-scout)"),
    ).toBe(true);
    // 纯英文仍是英文
    expect(isZhBlock("Your slug is kept forever and nobody can take it")).toBe(false);
  });
});

describe("extractLang", () => {
  const md = [
    "# Refund Policy",
    "## 退款政策",
    "Within 14 days you may request a refund.",
    "自付款之日起 14 天内,你可以申请退款。",
  ].join("\n\n");

  it("英文页只留英文块", () => {
    const en = extractLang(md, "en");
    expect(en).toContain("# Refund Policy");
    expect(en).toContain("Within 14 days");
    expect(en).not.toContain("退款政策");
    expect(en).not.toContain("自付款之日起");
  });

  it("中文页只留中文块", () => {
    const zh = extractLang(md, "zh");
    // 首标题由 h2 提升为 h1(单语成页后中文页需要主标题)
    expect(zh).toContain("# 退款政策");
    expect(zh).toContain("自付款之日起");
    expect(zh).not.toContain("# Refund Policy");
    expect(zh).not.toContain("Within 14 days");
  });

  // 语言中立块必须两页都留,否则中文页会丢掉分隔线/日期,版式塌掉。
  it("语言中立块(hr、纯日期)两页都保留", () => {
    const withNeutral = ["# Title", "标题", "---", "2026-07-28", "Body text here", "正文内容在此"].join(
      "\n\n",
    );
    for (const lang of ["en", "zh"] as const) {
      const out = extractLang(withNeutral, lang);
      expect(out, `${lang} 应保留 hr`).toContain("---");
      expect(out, `${lang} 应保留日期`).toContain("2026-07-28");
    }
  });

  it("空块被丢弃,不产生连续空行", () => {
    const out = extractLang("# A\n\n\n\n\nBody", "en");
    expect(out).toBe("# A\n\nBody");
  });

  // 真实内容的回归护栏:五页拆完两边都必须非空,且各自不含对方语言的
  // 标志性字符。曾经的隐患是某页忘了写中文块 → 中文页空白上线。
  // 独立判据的护栏。旧护栏(只查全角标点)与被测代码犯了同一个假设错误:
  // contact.md 用半角冒号的两块中文被判成英文,测试却全绿。改用三条与实现
  // **无关**的不变量:①含汉字的块必须出现在中文页 ②汉字守恒(源=中+英)
  // ③英文页零汉字。审计发现该盲区后补入。
  it("不变量:含汉字的块都在中文页、汉字守恒、英文页零汉字", () => {
    const norm = (t: string) => t.replace(/^#+\s+/gm, "");
    const cjkCount = (t: string) => (t.match(/[\u4e00-\u9fff]/g) ?? []).length;
    for (const key of ["terms", "privacy", "refund", "pricing", "contact"]) {
      const raw = COMPLIANCE_MARKDOWN[key]!;
      const zh = extractLang(raw, "zh");
      const en = extractLang(raw, "en");
      for (const block of raw.replace(/\r\n/g, "\n").split(/\n{2,}/)) {
        const t = block.trim();
        if (t === "" || !/[\u4e00-\u9fff]/.test(t)) continue;
        // 首标题会被 h2→h1 提升,故归一化井号后比对
        expect(norm(zh), `${key}: 含汉字的块必须在中文页 → ${t.slice(0, 40)}`).toContain(norm(t));
      }
      expect(cjkCount(zh) + cjkCount(en), `${key}: 汉字不得丢失`).toBe(cjkCount(raw));
      expect(cjkCount(en), `${key}: 英文页不得残留汉字`).toBe(0);
    }
  });

  // 单语成页后中文页必须有主标题:内容约定是「# English + ## 中文」,
  // 不提升的话中文页首元素是 h2,文档没有 h1。
  it("中文页首个 h2 被提升为 h1(五页都要有主标题)", () => {
    for (const key of ["terms", "privacy", "refund", "pricing", "contact"]) {
      const raw = COMPLIANCE_MARKDOWN[key]!;
      expect((extractLang(raw, "zh").match(/^# /gm) ?? []).length, `${key} 中文页 h1`).toBe(1);
      expect((extractLang(raw, "en").match(/^# /gm) ?? []).length, `${key} 英文页 h1`).toBe(1);
    }
  });

  it("五个真实合规页拆分后两种语言都非空", () => {
    for (const key of ["terms", "privacy", "refund", "pricing", "contact"]) {
      const raw = COMPLIANCE_MARKDOWN[key];
      expect(raw, `${key} 内容应存在`).toBeTruthy();
      const en = extractLang(raw!, "en");
      const zh = extractLang(raw!, "zh");
      expect(en.length, `${key} 英文页非空`).toBeGreaterThan(100);
      expect(zh.length, `${key} 中文页非空`).toBeGreaterThan(100);
      // 英文页不应残留成段中文(允许 URL/专名里的个别字符,故查中文标点)
      expect(en, `${key} 英文页不应含中文全角标点`).not.toMatch(/[，。；：]/);
    }
  });
});

describe("compliancePage 单语渲染", () => {
  it("中文页:html lang=zh-Hans、标题中文、不含英文正文", async () => {
    const { compliancePage } = await import("./compliance-page.js");
    const html = compliancePage("refund", "zh");
    expect(html).toContain('<html lang="zh-Hans">');
    expect(html).toContain("退款政策 · Mediary Connect");
    expect(html).toContain("14 天内");
    expect(html).not.toContain("no-questions-asked");
  });

  it("英文页:html lang=en、标题英文、不含中文正文", async () => {
    const { compliancePage } = await import("./compliance-page.js");
    const html = compliancePage("refund", "en");
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("Refund Policy · Mediary Connect");
    expect(html).toContain("no-questions-asked");
    expect(html).not.toContain("自付款之日起");
  });

  it("默认参数是中文(受众是中文用户)", async () => {
    const { compliancePage } = await import("./compliance-page.js");
    expect(compliancePage("terms")).toContain('<html lang="zh-Hans">');
  });

  // 切换按钮曾是两个无 href 的 <span>(纯装饰,点不动)——必须是真链接。
  it("语言切换是可点链接,且指向同一页的另一语言", async () => {
    const { compliancePage } = await import("./compliance-page.js");
    expect(compliancePage("privacy", "zh")).toContain('href="/privacy?lang=en"');
    expect(compliancePage("privacy", "en")).toContain('href="/privacy"');
  });

  // 页脚互链不带语言,用户每翻一页都得重新切一次。
  it("页脚互链保持当前语言", async () => {
    const { compliancePage } = await import("./compliance-page.js");
    const en = compliancePage("terms", "en");
    expect(en).toContain('href="/privacy?lang=en"');
    const zh = compliancePage("terms", "zh");
    expect(zh).toContain('href="/privacy"');
    expect(zh).not.toContain('href="/privacy?lang=en"');
  });

  // Paddle domain review 硬要求:法定实体名必须与 Paddle 账号一致,
  // 且要出现在条款里。踩坑记录第二次被拒就是实体名不匹配。
  it("两种语言的页脚与条款都写明 DF Digital", async () => {
    const { compliancePage } = await import("./compliance-page.js");
    for (const lang of ["en", "zh"] as const) {
      expect(compliancePage("terms", lang), `${lang} 页脚实体名`).toContain("DF Digital");
    }
  });

  it("五页 × 两语言全部可渲染且非空", async () => {
    const { compliancePage } = await import("./compliance-page.js");
    for (const key of ["terms", "privacy", "refund", "pricing", "contact"] as const) {
      for (const lang of ["en", "zh"] as const) {
        const html = compliancePage(key, lang);
        expect(html.length, `${key}/${lang}`).toBeGreaterThan(1000);
      }
    }
  });
});

describe("免费档措辞已彻底移除(不做免费试用,留着即虚假宣传)", () => {
  it("定价页两种语言都不再提免费档/随机前缀/30 天轮换", async () => {
    const { compliancePage } = await import("./compliance-page.js");
    for (const lang of ["en", "zh"] as const) {
      const html = compliancePage("pricing", lang);
      for (const banned of ["Free tier", "免费档", "k7m2x9", "rotates every 30 days", "每 30 天轮换"]) {
        expect(html, `${lang} 不应含「${banned}」`).not.toContain(banned);
      }
    }
  });

  it("退款政策显式声明「无论是否已使用」(Paddle 要求零例外)", async () => {
    const { compliancePage } = await import("./compliance-page.js");
    expect(compliancePage("refund", "en")).toContain("whether or not you have used the service");
    expect(compliancePage("refund", "zh")).toContain("无论是否已经使用过本服务");
  });
});
