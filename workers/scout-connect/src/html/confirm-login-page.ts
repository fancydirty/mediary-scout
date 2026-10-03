import { BRAND_BAR, BRAND_CSS, esc, FAVICON_LINK, THEME_BASE, THEME_TOKENS } from "./theme.js";

/** 魔法链接的落地确认页。GET 只显示「将以哪个邮箱登录」,点按钮才由本站页面
 *  POST 登录:任何网页都能把访客导到 /auth/callback?t=<它自己的 token>,如果
 *  GET 直接种 cookie,访客就被悄悄登进别人的账号,之后付的钱、拿的接入命令都
 *  记到对方名下。token 不写进页面,脚本从地址栏读;按钮用 fetch 提交 —— CORS
 *  模式的请求总带 Origin,而表单提交在 no-referrer 下会发 Origin: null,过不了
 *  同源检查。 */
export function confirmLoginPage(email: string): string {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>确认登录 · Mediary Connect</title>
<meta name="robots" content="noindex">
${FAVICON_LINK}
<style>
${THEME_TOKENS}
${THEME_BASE}
${BRAND_CSS}
main{max-width:420px;margin:0 auto;padding:36px 22px 64px}
.hero{margin:40px 0 0}
.eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:2px;color:var(--accent);margin:0 0 12px}
h1{font-size:1.6rem;font-weight:900;letter-spacing:-.5px;margin:0 0 10px}
.hint{color:var(--text-muted);font-size:.95rem;margin:0}
.panel{position:relative;margin:28px 0 0;background:rgba(24,24,24,.8);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);border:1px solid #2b2b2b;border-radius:18px;box-shadow:inset 0 1px 0 rgba(255,255,255,.07),rgba(0,0,0,.55) 0 18px 40px -12px;padding:24px}
.email{font-family:var(--mono);font-size:1rem;margin:0;word-break:break-all}
button{width:100%;margin-top:18px;font:inherit;font-weight:700;cursor:pointer;border:1px solid transparent;border-radius:500px;background:var(--accent);color:#000;padding:13px 28px;font-size:.98rem;transition:transform .15s ease,background .15s ease,opacity .15s ease}
button:hover:not(:disabled){transform:scale(1.02)}
button:active:not(:disabled){background:var(--accent-press)}
button:disabled{opacity:.55;cursor:default}
.msg{margin-top:16px;font-size:.95rem;color:var(--text-muted)}
.note{margin-top:22px;font-size:.88rem;color:var(--text-muted)}
.note a{color:var(--text-muted)}
</style>
</head>
<body>
<main>
${BRAND_BAR}
<section class="hero">
<p class="eyebrow">SIGN IN</p>
<h1>确认登录</h1>
<p class="hint">将以下面这个邮箱登录 Mediary Connect：</p>
</section>
<div class="panel">
<p class="email">${esc(email)}</p>
<button id="btn" type="button">继续登录</button>
<p class="msg" id="msg" hidden></p>
<noscript><p class="msg">需要启用 JavaScript 才能登录。</p></noscript>
</div>
<p class="note">不是你的邮箱？关掉这个页面即可，什么都不会发生。也可以<a href="/login">重新发送登录链接</a>。</p>
</main>
<script type="module">
const btn=document.getElementById("btn"),msg=document.getElementById("msg");
btn.addEventListener("click",async()=>{
  btn.disabled=true;
  msg.hidden=true;
  try{
    const t=new URLSearchParams(location.search).get("t")||"";
    const res=await fetch("/auth/callback",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({t})});
    if(res.ok){location.replace("/console");return;}
    msg.textContent=res.status===400?"链接已失效，请重新发送登录链接。":"登录没有成功，请稍后再试。";
  }catch{
    msg.textContent="网络错误，请稍后重试。";
  }
  msg.hidden=false;
  btn.disabled=false;
});
</script>
</body>
</html>`;
}
