import {
  BRAND_BAR,
  BRAND_CSS,
  FAVICON_LINK,
  normalizeTurnstileSitekey,
  THEME_BASE,
  THEME_TOKENS,
} from "./theme.js";

/** 极简登录页:输邮箱 → POST /api/auth/magic → 收魔法链接邮件。无密码。
 *  Turnstile 成对配置时渲染 widget 并把 token 一起提交——否则 magic 端点
 *  会 400 turnstile required,登录直接坏掉(页面与门必须同进同退)。
 *  视觉走 theme.ts 的深色 + 品牌绿,与 beta / console / 合规页同一家族。 */
export function loginPage(sitekeyRaw?: string): string {
  const sitekey = normalizeTurnstileSitekey(sitekeyRaw);
  const tsScript = sitekey
    ? `\n<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" defer></script>`
    : "";
  // widget 主题跟随页面:深色。
  const tsWidget = sitekey
    ? `<div class="cf-turnstile" data-sitekey="${sitekey}" data-theme="dark"></div>`
    : "";
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>登录 · Mediary Connect</title>
${FAVICON_LINK}${tsScript}
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
label{display:block;font-size:.85rem;color:var(--text-muted);margin:0 0 6px}
input[type=email]{width:100%;font:inherit;padding:12px 14px;border:1px solid var(--border);border-radius:12px;background:var(--bg-raised);color:var(--text);transition:border-color .15s ease,box-shadow .15s ease}
input[type=email]::placeholder{color:#6b6b6b}
input[type=email]:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px rgba(30,215,96,.18)}
.cf-turnstile{margin-top:14px}
button{width:100%;margin-top:16px;font:inherit;font-weight:700;cursor:pointer;border:1px solid transparent;border-radius:500px;background:var(--accent);color:#000;padding:13px 28px;font-size:.98rem;transition:transform .15s ease,background .15s ease,opacity .15s ease}
button:hover:not(:disabled){transform:scale(1.02)}
button:active:not(:disabled){background:var(--accent-press)}
button:disabled{opacity:.55;cursor:default}
.msg{margin-top:16px;font-size:.95rem;color:var(--text-muted)}
.msg.ok{color:var(--accent)}
.footer{position:relative;margin-top:44px;padding-top:20px;text-align:center;font-size:.82rem;color:var(--text-muted)}
.footer::before{content:"";position:absolute;top:0;left:12%;right:12%;height:1px;background:var(--hairline)}
.footer a{color:var(--text-muted);text-decoration:none}
.footer a:hover{color:var(--text)}
</style>
</head>
<body>
<main>
${BRAND_BAR}
<section class="hero">
<p class="eyebrow">SIGN IN</p>
<h1>登录 Mediary Connect</h1>
<p class="hint">输入邮箱，我们会发一封登录链接给你。无需密码。</p>
</section>
<div class="panel">
<form id="f">
<label for="email">邮箱</label>
<input id="email" type="email" placeholder="you@example.com" aria-label="邮箱地址" autocomplete="email" required>
${tsWidget}
<button id="btn" type="submit">发送登录链接</button>
</form>
<p class="msg" id="msg" hidden></p>
</div>
<div class="footer"><a href="/pricing">定价</a> · <a href="/terms">服务条款</a> · <a href="/privacy">隐私政策</a> · <a href="/refund">退款政策</a> · <a href="/contact">联系我们</a></div>
</main>
<script type="module">
const f=document.getElementById("f"),btn=document.getElementById("btn"),msg=document.getElementById("msg");
f.addEventListener("submit",async(e)=>{
  e.preventDefault();
  btn.disabled=true;
  msg.hidden=true;msg.className="msg";
  try{
    const email=document.getElementById("email").value.trim();
    const tsEl=document.querySelector('[name=cf-turnstile-response]');
    const payload={email};
    if(tsEl) payload.turnstile_token=tsEl.value;
    const res=await fetch("/api/auth/magic",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});
    if(res.status===202){
      msg.textContent="已发送。请查收邮件（含垃圾箱），点击链接即可登录。";
      msg.className="msg ok";
      msg.hidden=false;
    }else{
      msg.textContent="提交未通过，请检查邮箱格式或重试人机校验。";
      msg.hidden=false;
      btn.disabled=false;
    }
  }catch{
    msg.textContent="网络错误，请稍后重试。";
    msg.hidden=false;
    btn.disabled=false;
  }
});
</script>
</body>
</html>`;
}
