export function homePage(): string {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Scout Connect</title>
<style>
body{font-family:system-ui,sans-serif;max-width:640px;margin:4rem auto;padding:0 1rem;color:#222;line-height:1.7}
h1{font-size:1.6rem}
a{color:#06c}
</style>
</head>
<body>
<main>
<h1>Scout Connect</h1>
<p lang="zh">Scout Connect 是自托管 Mediary Scout 的远程访问之门:通过 Cloudflare Tunnel 把你自己的实例安全地发布到一个专属域名,入口由 Cloudflare Access 邮箱验证把守。你的媒体内容与各类凭据始终留在你自己的机器上,这里只负责开门。</p>
<p lang="en">Scout Connect is the remote access door for self-hosted Mediary Scout: it publishes your own instance to a dedicated hostname over a Cloudflare Tunnel, gated by Cloudflare Access email verification. Your content and credentials always stay on your own machines — this service only opens the door.</p>
<p><a href="https://github.com/fancydirty/mediary-scout">github.com/fancydirty/mediary-scout</a></p>
</main>
</body>
</html>`;
}
