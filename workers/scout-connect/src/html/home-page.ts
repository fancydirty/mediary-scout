export function homePage(): string {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mediary Connect</title>
<style>
body{font-family:system-ui,sans-serif;max-width:640px;margin:4rem auto;padding:0 1rem;color:#222;line-height:1.7}
h1{font-size:1.6rem}
a{color:#06c}
</style>
</head>
<body>
<main>
<h1>Mediary Connect</h1>
<p lang="zh">Mediary Connect 是自托管 Mediary Scout 的远程访问之门:通过 Cloudflare Tunnel 把你自己的实例安全地发布到一个专属域名,入口由应用自身的访问密码把守(首次打开时设置)。你的媒体内容与各类凭据始终留在你自己的机器上,这里只负责开门。</p>
<p lang="en">Mediary Connect is the remote access door for self-hosted Mediary Scout: it publishes your own instance to a dedicated hostname over a Cloudflare Tunnel, gated by the app's own access password (set on first open). Your content and credentials always stay on your own machines — this service only opens the door.</p>
<p><a href="https://github.com/fancydirty/mediary-scout">github.com/fancydirty/mediary-scout</a></p>
<footer style="margin-top:3rem;padding-top:1rem;border-top:1px solid #e5e5e5;font-size:.88rem;color:#666">
<a href="/pricing" style="color:#666">定价</a> · <a href="/terms" style="color:#666">服务条款</a> · <a href="/privacy" style="color:#666">隐私政策</a> · <a href="/refund" style="color:#666">退款政策</a> · <a href="/contact" style="color:#666">联系我们</a>
</footer>
</main>
</body>
</html>`;
}
