import { normalizeTurnstileSitekey } from "./beta-page.js";

/** 极简登录页:输邮箱 → POST /api/auth/magic → 收魔法链接邮件。无密码。
 *  Turnstile 成对配置时渲染 widget 并把 token 一起提交——否则 magic 端点
 *  会 400 turnstile required,登录直接坏掉(页面与门必须同进同退)。 */
export function loginPage(sitekeyRaw?: string): string {
  const sitekey = normalizeTurnstileSitekey(sitekeyRaw);
  const tsScript = sitekey
    ? `\n<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" defer></script>`
    : "";
  const tsWidget = sitekey
    ? `<div class="cf-turnstile" data-sitekey="${sitekey}" data-theme="light"></div>`
    : "";
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>登录 · Mediary Connect</title>${tsScript}
<style>
body{font-family:system-ui,sans-serif;max-width:420px;margin:4rem auto;padding:0 1.2rem;color:#222;line-height:1.7}
h1{font-size:1.4rem}
input{width:100%;padding:.7rem .9rem;font-size:1rem;border:1px solid #ccc;border-radius:8px;box-sizing:border-box}
.cf-turnstile{margin-top:.8rem}
button{width:100%;margin-top:.8rem;padding:.7rem;font-size:1rem;border:none;border-radius:999px;background:#1ed760;color:#06210f;font-weight:700;cursor:pointer}
button:disabled{opacity:.6;cursor:default}
.msg{margin-top:1rem;font-size:.95rem}
.hint{color:#666;font-size:.9rem;margin-top:.4rem}
</style>
</head>
<body>
<main>
<h1>登录 Mediary Connect</h1>
<p class="hint">输入邮箱，我们会发一封登录链接给你。无需密码。</p>
<form id="f">
<input id="email" type="email" placeholder="you@example.com" aria-label="邮箱地址" autocomplete="email" required>
${tsWidget}
<button id="btn" type="submit">发送登录链接</button>
</form>
<p class="msg" id="msg" hidden></p>
</main>
<script type="module">
const f=document.getElementById("f"),btn=document.getElementById("btn"),msg=document.getElementById("msg");
f.addEventListener("submit",async(e)=>{
  e.preventDefault();
  btn.disabled=true;
  try{
    const email=document.getElementById("email").value.trim();
    const tsEl=document.querySelector('[name=cf-turnstile-response]');
    const payload={email};
    if(tsEl) payload.turnstile_token=tsEl.value;
    const res=await fetch("/api/auth/magic",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});
    if(res.status===202){
      msg.textContent="已发送。请查收邮件（含垃圾箱），点击链接即可登录。";
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
