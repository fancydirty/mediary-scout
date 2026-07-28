import { COMPLIANCE_MARKDOWN } from "./compliance-content.gen.js";
import { renderMarkdown } from "./markdown.js";

/** 五个合规页。key 即 URL 路径(/terms 等),Paddle 域名审核的硬性要求:
 *  条款/隐私/退款(≥14 天,与 Buyer Terms 一致)/定价/联系,缺一被拒
 *  (拒信原文点过名)。 */
export const COMPLIANCE_PAGES = {
  terms: "服务条款",
  privacy: "隐私政策",
  refund: "退款政策",
  pricing: "定价",
  contact: "联系我们",
} as const;

export type CompliancePageKey = keyof typeof COMPLIANCE_PAGES;

const FOOTER_LINKS = (Object.entries(COMPLIANCE_PAGES) as [CompliancePageKey, string][])
  .map(([key, title]) => `<a href="/${key}">${title}</a>`)
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
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Mediary Connect</title>
<style>
body{font-family:system-ui,sans-serif;max-width:720px;margin:3rem auto;padding:0 1.2rem;color:#222;line-height:1.8}
h1{font-size:1.6rem}h2{font-size:1.2rem;margin-top:2rem}h3{font-size:1.05rem}
a{color:#06c}
code{background:#f4f4f4;padding:.1em .35em;border-radius:4px;font-size:.92em}
hr{border:none;border-top:1px solid #e5e5e5;margin:2rem 0}
footer{margin-top:3.5rem;padding-top:1.2rem;border-top:1px solid #e5e5e5;font-size:.88rem;color:#666}
footer a{color:#666}
</style>
</head>
<body>
<main>
${body}
</main>
<footer>
<p>${FOOTER_LINKS}</p>
<p><a href="https://mediaryconnect.app">Mediary Connect</a> · 自托管 Mediary Scout 的远程访问服务</p>
</footer>
</body>
</html>`;
}
