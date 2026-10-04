import { BRAND_BAR, BRAND_CSS, esc, FAVICON_LINK, THEME_BASE, THEME_TOKENS } from "./theme.js";
import { formatBeijingTime } from "../instance-link-time.js";

export type InstanceLinkPageState =
  | { kind: "invalid" }
  | { kind: "confirmed" }
  | { kind: "pending"; email: string; verifyCode: string; requestIp: string; requestedAt: string };

/** 实例连接确认页，签名 token 只留在地址栏。 */
export function instanceLinkPage(state: InstanceLinkPageState): string {
  if (state.kind === "invalid") {
    return messagePage("链接已失效，请回到实例页面重新发起。", "连接链接已失效");
  }
  if (state.kind === "confirmed") {
    return messagePage("已确认，回到实例页面即可。", "连接已确认");
  }
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>确认连接 · Mediary Connect</title>
<meta name="robots" content="noindex">
${FAVICON_LINK}
<style>
${THEME_TOKENS}
${THEME_BASE}
${BRAND_CSS}
main{max-width:460px;margin:0 auto;padding:36px 22px 64px}
.hero{margin:40px 0 0}.eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:2px;color:var(--accent);margin:0 0 12px}
h1{font-size:1.6rem;font-weight:900;letter-spacing:-.5px;margin:0 0 10px}.hint{color:var(--text-muted);font-size:.95rem;margin:0}
.panel{position:relative;margin:28px 0 0;background:rgba(24,24,24,.8);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);border:1px solid #2b2b2b;border-radius:18px;box-shadow:inset 0 1px 0 rgba(255,255,255,.07),rgba(0,0,0,.55) 0 18px 40px -12px;padding:24px}
.email{font-family:var(--mono);font-size:1rem;margin:0;word-break:break-all}.code{font-family:var(--mono);font-size:2rem;letter-spacing:6px;font-weight:900;margin:18px 0 6px;color:var(--accent)}
.meta{color:var(--text-muted);font-size:.86rem;line-height:1.7;margin:14px 0 0}.warning{font-size:.9rem;line-height:1.7;color:var(--text-muted);margin:22px 0 0}
button{width:100%;margin-top:20px;font:inherit;font-weight:700;cursor:pointer;border:1px solid transparent;border-radius:500px;background:var(--accent);color:#000;padding:13px 28px;font-size:.98rem;transition:transform .15s ease,background .15s ease,opacity .15s ease}button:hover:not(:disabled){transform:scale(1.02)}button:disabled{opacity:.55;cursor:default}
.msg{margin-top:16px;font-size:.95rem;color:var(--text-muted)}
</style>
</head>
<body>
<main>
${BRAND_BAR}
<section class="hero"><p class="eyebrow">INSTANCE LINK</p><h1>确认连接</h1><p class="hint">有人请求把下面这个实例连接到你的 Mediary Connect 账户：</p></section>
<div class="panel">
<p class="email">${esc(state.email)}</p>
<p class="code" aria-label="核对码">${esc(state.verifyCode)}</p>
<p class="meta">请核对实例页面上显示的核对码也是 ${esc(state.verifyCode)}<br>请求 IP：${esc(state.requestIp || "未知")}<br>请求时间：${esc(formatBeijingTime(state.requestedAt))}</p>
<p class="warning">只有你自己刚在实例的「设置 → 远程访问」里点了连接，才点确认；不是你发起的就关掉这个页面。</p>
<button id="btn" type="button">确认连接</button>
<p class="msg" id="msg" role="status" aria-live="polite" hidden></p>
<noscript><p class="msg">需要启用 JavaScript 才能确认连接。</p></noscript>
</div>
</main>
<script type="module">
const btn=document.getElementById("btn"),msg=document.getElementById("msg");
btn.addEventListener("click",async()=>{
  btn.disabled=true; msg.hidden=true;
  try{
    const t=new URLSearchParams(location.search).get("t")||"";
    const res=await fetch("/link",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({t})});
    // 409: confirmed already (another click, or a lost response), same end state as 200.
    if(res.ok||res.status===409){document.querySelector("h1").textContent="连接已确认";btn.remove();msg.textContent="已确认，回到实例页面即可。";msg.hidden=false;return;}
    if(res.status===410){btn.remove();msg.textContent="链接已失效，请回到实例页面重新发起。";msg.hidden=false;return;}
    msg.textContent="连接没有成功，请稍后再试。";
  }catch{msg.textContent="网络错误，请稍后重试。";}
  msg.hidden=false;btn.disabled=false;
});
</script>
</body>
</html>`;
}

function messagePage(message: string, title: string): string {
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} · Mediary Connect</title><meta name="robots" content="noindex">${FAVICON_LINK}<style>${THEME_TOKENS}${THEME_BASE}${BRAND_CSS}main{max-width:460px;margin:0 auto;padding:36px 22px 64px}.hero{margin:40px 0 0}h1{font-size:1.6rem;font-weight:900;margin:0}.panel{margin-top:28px;background:rgba(24,24,24,.8);border:1px solid #2b2b2b;border-radius:18px;padding:24px}.msg{color:var(--text-muted);line-height:1.7}</style></head><body><main>${BRAND_BAR}<section class="hero"><h1>${esc(title)}</h1></section><div class="panel"><p class="msg">${esc(message)}</p></div></main></body></html>`;
}
