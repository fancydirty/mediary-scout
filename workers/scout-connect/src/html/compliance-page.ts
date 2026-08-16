import { COMPLIANCE_MARKDOWN } from "./compliance-content.gen.js";
import { extractLang, type Lang } from "./lang-split.js";
import { renderMarkdown } from "./markdown.js";
import { BRAND_BAR, BRAND_CSS, FAVICON_LINK, THEME_BASE, THEME_TOKENS } from "./theme.js";

/** 五个合规页。key 即 URL 路径(/terms 等)。中英内容来自同一份 Markdown,
 *  避免条款、隐私、退款、定价与联系页在不同语言之间漂移。 */
export const COMPLIANCE_PAGES = {
  terms: { en: "Terms of Service", zh: "服务条款" },
  privacy: { en: "Privacy Policy", zh: "隐私政策" },
  refund: { en: "Refund Policy", zh: "退款政策" },
  pricing: { en: "Pricing", zh: "定价" },
  contact: { en: "Contact", zh: "联系我们" },
} as const;

export type CompliancePageKey = keyof typeof COMPLIANCE_PAGES;

/** 每页的 SERP 摘要。取自各页真实主旨(不编造、不堆词):没有 description 时
 *  Google 会自行截取正文首段,法律页的首段往往是「Last updated」这类无信息量
 *  的行,白白浪费 SERP 那两行。 */
const COMPLIANCE_DESCRIPTIONS: Record<CompliancePageKey, { en: string; zh: string }> = {
  terms: {
    en: "Terms for Mediary Connect: what the remote-access tunnel does, your responsibilities (access password, lawful use), prepaid duration with no auto-charge, and the operating entity.",
    zh: "Mediary Connect 服务条款:远程访问隧道提供什么、你的责任(访问密码、合法使用)、预付时长与不自动扣款、运营主体与适用法律。",
  },
  privacy: {
    en: "What Mediary Connect collects (email, payment ID, service config) and what it cannot reach: your media, drive credentials and LLM keys never leave your own machine.",
    zh: "Mediary Connect 收集什么(邮箱、交易号、服务配置),以及技术上接触不到什么:媒体内容、网盘凭据与 LLM 密钥始终只在你自己的机器上。",
  },
  refund: {
    en: "14-day, no-questions-asked full refund for Mediary Connect — whether or not you have used the service. How to request, and what happens to your slug afterwards.",
    zh: "Mediary Connect 14 天无理由全额退款(无论是否使用过),如何申请、退款后专属地址与账号如何保留。",
  },
  pricing: {
    en: "Mediary Connect pricing: prepaid access for your self-hosted Mediary Scout instance, from ¥45 per quarter. Stackable, never auto-charged, 14-day refund.",
    zh: "Mediary Connect 定价:为自托管的 Mediary Scout 实例提供远程访问,季度 ¥45 起。时长可叠加、不自动续费、14 天无理由退款。",
  },
  contact: {
    en: "How to reach Mediary Connect support: refunds, data deletion, product bugs and deployment questions, plus the operating entity behind the service.",
    zh: "联系 Mediary Connect:退款、数据删除、产品缺陷与部署问题的联系方式,以及本服务的运营主体信息。",
  },
};

/** 页脚互链必须带上当前语言:否则在中文页点「隐私政策」会跳回英文页,
 *  用户得每页重新切一次语言。中文是默认值,故 zh 不带 query。 */
function footerLinks(lang: Lang): string {
  const entries = Object.entries(COMPLIANCE_PAGES) as [
    CompliancePageKey,
    { en: string; zh: string },
  ][];
  return entries
    .map(([key, title]) => {
      const href = lang === "en" ? `/${key}?lang=en` : `/${key}`;
      return `<a href="${href}">${lang === "en" ? title.en : title.zh}</a>`;
    })
    .join(" · ");
}

/** 中英各自成页(用户反馈:中英交叉排在同一页读起来很累)。
 *  中文是默认语言(受众是中文用户);英文页走 ?lang=en,供海外用户阅读。
 *  两页内容同源,由 extractLang 从同一份 .md 拆出,不存在
 *  「改了中文忘改英文」的漂移。 */
export function compliancePage(key: CompliancePageKey, lang: Lang = "zh"): string {
  const title = COMPLIANCE_PAGES[key];
  const md = COMPLIANCE_MARKDOWN[key];
  if (md === undefined) {
    // 生成管线保证五页齐备;缺 = 构建坏了,宁可 500 也不空页。
    throw new Error(`compliance content missing: ${key}`);
  }
  const single = extractLang(md, lang);
  if (single.trim() === "") {
    // 拆分后为空 = 该页缺这门语言的内容(或判据出错)。宁可 500 也不给
    // 用户一个空白的法律页面——那比报错更糟(看起来像"没有条款")。
    throw new Error(`compliance content empty after lang split: ${key}/${lang}`);
  }
  const body = renderMarkdown(single);
  const pageTitle = lang === "en" ? title.en : title.zh;
  return `<!doctype html>
<html lang="${lang === "en" ? "en" : "zh-Hans"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${pageTitle} · Mediary Connect</title>
<meta name="description" content="${lang === "en" ? COMPLIANCE_DESCRIPTIONS[key].en : COMPLIANCE_DESCRIPTIONS[key].zh}">
<!-- 规范化信号:中英两版内容同源(由 extractLang 从同一份 .md 拆出),若不声明
     canonical/alternate,Google 会把它们判成重复内容且无从选择规范页。
     alternate 集合必须自含(含自己)——缺了会被判「无返回标记」错误。
     x-default 指中文:主受众是中文用户。 -->
<link rel="canonical" href="https://mediaryconnect.app/${key}${lang === "en" ? "?lang=en" : ""}">
<link rel="alternate" hreflang="zh-Hans" href="https://mediaryconnect.app/${key}">
<link rel="alternate" hreflang="en" href="https://mediaryconnect.app/${key}?lang=en">
<link rel="alternate" hreflang="x-default" href="https://mediaryconnect.app/${key}">
${FAVICON_LINK}
<style>
${THEME_TOKENS}
${THEME_BASE}
${BRAND_CSS}
main{max-width:760px;margin:0 auto;padding:36px 24px 96px}
.lang-bar{display:inline-flex;font-family:var(--mono);font-size:11px;letter-spacing:1px;border:1px solid #2b2b2b;border-radius:999px;overflow:hidden;margin:26px 0 8px}
/* span 与 a 同款 padding：a 是真正可点的那一侧，只给 span 会让点击/触控
   目标明显小于 pill，视觉上也破形（Copilot round-2 指出）。 */
.lang-bar span,.lang-bar a{padding:5px 14px;text-decoration:none}
.lang-bar a:hover{color:var(--text)}
.lang-bar .on{background:var(--accent);color:#000}
.lang-bar .off{color:var(--text-muted)}
/* 单语成页后不再需要「中文次级色」——那是中英并排时区分主次用的。
   renderMarkdown 仍会给 CJK 块挂 .zh，这里把它还原成与英文同级的正文样式，
   否则整个中文页会通篇偏暗、像是被降级的副本。 */
h1{font-size:1.7rem;font-weight:900;letter-spacing:-.5px;margin:18px 0 2px}
h2{font-size:1.1rem;font-weight:700;margin:34px 0 0}
h3{font-size:1rem;font-weight:700;margin:22px 0 0}
h1.zh{font-size:1.7rem;font-weight:900;letter-spacing:-.5px;margin:18px 0 2px}
h2.zh{font-size:1.1rem;font-weight:700;margin:34px 0 0}
h3.zh{font-size:1rem;font-weight:700;margin:22px 0 0}
p{font-size:14.5px;margin:14px 0 0}
p.zh{font-size:14.5px;margin:14px 0 0}
ul{margin:12px 0 0;padding-left:20px}
ul.zh{margin:12px 0 0;padding-left:20px}
li{margin:6px 0 0}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
strong{color:var(--text)}
code{background:var(--bg-raised);padding:.1em .4em;border-radius:4px;font-family:var(--mono);font-size:.92em}
hr{border:none;height:1px;background:var(--hairline);margin:30px 0}
.footer{position:relative;margin-top:48px;padding-top:20px;font-size:.82rem;color:var(--text-muted)}
.footer::before{content:"";position:absolute;top:0;left:0;right:0;height:1px;background:var(--hairline)}
.footer a{color:var(--text-muted);text-decoration:none}
.footer a:hover{color:var(--text)}
</style>
</head>
<body>
<main>
${BRAND_BAR}
<div class="lang-bar">${
    lang === "zh"
      ? `<span class="on">中文</span><a class="off" href="/${key}?lang=en" hreflang="en">EN</a>`
      : `<a class="off" href="/${key}" hreflang="zh-Hans">中文</a><span class="on">EN</span>`
  }</div>
${body}
</main>
<div class="footer" style="max-width:760px;margin-left:auto;margin-right:auto;padding-left:24px;padding-right:24px">
<p>${footerLinks(lang)}</p>
<p><a href="https://mediaryconnect.app">Mediary Connect</a> · ${
  lang === "en"
    ? "Remote access for self-hosted Mediary Scout"
    : "自托管 Mediary Scout 的远程访问服务"
}</p>
<p>${lang === "en" ? "Operated by" : "运营主体"} DF Digital · ${
  lang === "en" ? "Payments via Alipay" : "付款使用支付宝"
}</p>
</div>
</body>
</html>`;
}
