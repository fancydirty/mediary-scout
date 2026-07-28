import { BRAND_BAR, BRAND_CSS, FAVICON_LINK, THEME_BASE, THEME_TOKENS } from "./theme.js";

export function homePage(): string {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mediary Connect</title>
${FAVICON_LINK}
<style>
${THEME_TOKENS}
${THEME_BASE}
${BRAND_CSS}
main{max-width:640px;margin:0 auto;padding:36px 24px 72px}
.hero{margin:40px 0 0}
.eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:2px;color:var(--accent);margin:0 0 12px}
h1{font-size:1.7rem;font-weight:900;letter-spacing:-.5px;margin:0 0 16px}
p{color:var(--text-muted);margin:0 0 14px}
p.en{color:#8f8f8f;font-size:.95rem}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
.footer{position:relative;margin-top:44px;padding-top:20px;font-size:.82rem;color:var(--text-muted)}
.footer::before{content:"";position:absolute;top:0;left:0;right:0;height:1px;background:var(--hairline)}
.footer a{color:var(--text-muted)}
.footer a:hover{color:var(--text)}
</style>
</head>
<body>
<main>
${BRAND_BAR}
<section class="hero">
<p class="eyebrow">MEDIARY CONNECT</p>
<h1>Mediary Connect</h1>
<p lang="zh">Mediary Connect 是自托管 Mediary Scout 的远程访问之门:通过 Cloudflare Tunnel 把你自己的实例安全地发布到一个专属域名,入口由应用自身的访问密码把守(首次打开时设置)。你的媒体内容与各类凭据始终留在你自己的机器上,这里只负责开门。</p>
<p class="en" lang="en">Mediary Connect is the remote access door for self-hosted Mediary Scout: it publishes your own instance to a dedicated hostname over a Cloudflare Tunnel, gated by the app's own access password (set on first open). Your content and credentials always stay on your own machines — this service only opens the door.</p>
<p><a href="https://github.com/fancydirty/mediary-scout" target="_blank" rel="noopener">github.com/fancydirty/mediary-scout</a></p>
</section>
<div class="footer">
<a href="/pricing">定价</a> · <a href="/terms">服务条款</a> · <a href="/privacy">隐私政策</a> · <a href="/refund">退款政策</a> · <a href="/contact">联系我们</a>
</div>
</main>
</body>
</html>`;
}
