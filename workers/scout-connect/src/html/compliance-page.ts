import { COMPLIANCE_MARKDOWN } from "./compliance-content.gen.js";
import { renderMarkdown } from "./markdown.js";
import { BRAND_BAR, BRAND_CSS, FAVICON_LINK, THEME_BASE, THEME_TOKENS } from "./theme.js";

/** 五个合规页。key 即 URL 路径(/terms 等),Paddle 域名审核的硬性要求:
 *  条款/隐私/退款(≥14 天,与 Buyer Terms 一致)/定价/联系,缺一被拒
 *  (拒信原文点过名)。中英双语:英文主、中文次(照顾 Paddle 审核员)。 */
export const COMPLIANCE_PAGES = {
  terms: { en: "Terms of Service", zh: "服务条款" },
  privacy: { en: "Privacy Policy", zh: "隐私政策" },
  refund: { en: "Refund Policy", zh: "退款政策" },
  pricing: { en: "Pricing", zh: "定价" },
  contact: { en: "Contact", zh: "联系我们" },
} as const;

export type CompliancePageKey = keyof typeof COMPLIANCE_PAGES;

const FOOTER_LINKS = (
  Object.entries(COMPLIANCE_PAGES) as [CompliancePageKey, { en: string; zh: string }][]
)
  .map(([key, title]) => `<a href="/${key}">${title.en}</a>`)
  .join(" · ");

export function compliancePage(key: CompliancePageKey): string {
  const title = COMPLIANCE_PAGES[key];
  const md = COMPLIANCE_MARKDOWN[key];
  if (md === undefined) {
    // 生成管线保证五页齐备;缺 = 构建坏了,宁可 500 也不空页。
    throw new Error(`compliance content missing: ${key}`);
  }
  const body = renderMarkdown(md);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title.en} · Mediary Connect</title>
${FAVICON_LINK}
<style>
${THEME_TOKENS}
${THEME_BASE}
${BRAND_CSS}
main{max-width:760px;margin:0 auto;padding:36px 24px 96px}
.lang-bar{display:inline-flex;font-family:var(--mono);font-size:11px;letter-spacing:1px;border:1px solid #2b2b2b;border-radius:999px;overflow:hidden;margin:26px 0 8px}
.lang-bar span{padding:5px 14px}
.lang-bar .on{background:var(--accent);color:#000}
.lang-bar .off{color:var(--text-muted)}
/* 英文主色，中文次级(略暗)——renderMarkdown 给 CJK 块自动挂 .zh */
h1{font-size:1.7rem;font-weight:900;letter-spacing:-.5px;margin:18px 0 2px}
h2{font-size:1.1rem;font-weight:700;margin:34px 0 0}
h3{font-size:1rem;font-weight:700;margin:22px 0 0}
h1.zh{font-size:1.2rem;font-weight:700;color:var(--text-zh);margin:4px 0 0}
h2.zh{font-size:.92rem;font-weight:600;color:var(--text-zh);margin:2px 0 0}
h3.zh{font-size:.9rem;font-weight:600;color:var(--text-zh);margin:2px 0 0}
p{font-size:14.5px;margin:14px 0 0}
p.zh{font-size:13.5px;color:var(--text-zh);margin:6px 0 0}
ul{margin:12px 0 0;padding-left:20px}
ul.zh{color:var(--text-zh);font-size:13.5px}
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
<div class="lang-bar"><span class="on">EN</span><span class="off">中文</span></div>
${body}
</main>
<div class="footer" style="max-width:760px;margin-left:auto;margin-right:auto;padding-left:24px;padding-right:24px">
<p>${FOOTER_LINKS}</p>
<p><a href="https://mediaryconnect.app">Mediary Connect</a> · Remote access for self-hosted Mediary Scout</p>
</div>
</body>
</html>`;
}
