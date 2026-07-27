// Public beta signup page — a single-page two-step flow.
//
// Entry points: GET /beta on any host, and GET / on the beta subdomain
// (host-routed in routes.ts). The canonical public URL is the bare
// beta.mediaryconnect.app — print that one everywhere, never …/beta.
// step 1 collects the email (POST /waitlist, same origin), step 2 offers an
// optional survey (POST /waitlist/survey). Fully self-contained: inline
// style/script only, no external requests.
//
// Visual language mirrors the official site (site/index.html + site/style.css):
// dark base, radial green hero gradient, hairline borders, pill buttons, mono
// eyebrows — so the page reads as the same product family as mediaryscout.app.
//
// Escaping discipline: unlike invite-page this page is FULLY STATIC — the
// server interpolates zero values into it, so there is nothing to escape
// here. Client-side, every dynamic value (position, server error text) is
// inserted via textContent only; innerHTML is deliberately never used, and a
// test pins both properties.

// Aperture mark — same as apps/web/app/icon.svg and the nav logo on
// mediaryscout.app, inlined so the page stays fully self-contained (no
// external requests, strict CSP-friendly).
const LOGO =
  '<svg width="28" height="28" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Mediary Scout"><circle cx="16" cy="16" r="16" fill="#1ED760"/><g transform="translate(4,4)" fill="none" stroke="#0B3B1E" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m14.31 8 5.74 9.94"/><path d="M9.69 8h11.48"/><path d="m7.38 12 5.74-9.94"/><path d="M9.69 16 3.95 6.06"/><path d="M14.31 16H2.83"/><path d="m16.62 12-5.74 9.94"/></g></svg>';

export function betaPage(): string {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Scout Connect 远程访问 · 内测 · Mediary Scout Connect</title>
<style>
:root{--bg-base:#121212;--bg-surface:#181818;--bg-raised:#1f1f1f;--bg-card:#252525;--accent:#1ed760;--accent-press:#169c46;--text:#fff;--text-muted:#b3b3b3;--border:#4d4d4d;--border-outline:#7c7c7c;--err:#f3727f;--hairline:linear-gradient(90deg,transparent,#2c2c2c 25%,#2c2c2c 75%,transparent);--font:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;--mono:ui-monospace,SFMono-Regular,monospace;color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;font-family:var(--font);color:var(--text);line-height:1.65;background:var(--bg-base)}
/* Full-viewport hero gradient, anchored to the viewport like site's #hero. */
body::before{content:"";position:fixed;inset:0;z-index:-1;pointer-events:none;background:radial-gradient(120% 90% at 50% -20%,rgba(30,215,96,.28),rgba(30,215,96,.06) 42%,var(--bg-base) 75%)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
main{max-width:720px;margin:0 auto;padding:0 20px 56px;position:relative}

/* Brand bar — nav-left from the site: aperture mark + wordmark. */
.brand{display:flex;align-items:center;gap:10px;padding:24px 0 0}
.brand svg{display:block;flex:none}
.wordmark{font-weight:700;font-size:16px;letter-spacing:.01em}
.connect-tag{font-family:var(--mono);font-size:10.5px;letter-spacing:1px;color:var(--accent);border:1px solid rgba(30,215,96,.35);border-radius:999px;padding:3px 9px}

/* Hero — clamp-sized 900-weight title like the site, mono eyebrow, muted sub. */
.hero{text-align:center;padding:56px 0 0}
.eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:2.2px;color:var(--accent);margin:0 0 16px}
h1{font-size:clamp(2rem,7vw,2.8rem);font-weight:900;letter-spacing:-1px;line-height:1.12;margin:0 0 18px;text-wrap:balance}
.sub{font-size:16px;color:var(--text-muted);max-width:600px;margin:0 auto;text-wrap:balance}
.sub2{font-size:13.5px;color:#8f8f8f;max-width:560px;margin:14px auto 0;text-wrap:balance}
.values{display:flex;justify-content:center;align-items:center;gap:10px 26px;flex-wrap:wrap;list-style:none;margin:28px 0 0;padding:0}
.values li{display:flex;align-items:center;gap:8px;font-size:13.5px;color:var(--text-muted)}
.values li svg{color:var(--accent);flex:none}

/* Signup panel — dark glass card with the site's hairline-border treatment
   (top-edge inset highlight + deep ambient shadow) and a faint green glow. */
.panel{position:relative;margin:44px 0 0;background:rgba(24,24,24,.8);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);border:1px solid #2b2b2b;border-radius:18px;box-shadow:inset 0 1px 0 rgba(255,255,255,.07),rgba(0,0,0,.55) 0 18px 40px -12px;padding:28px 28px 26px}
.panel::before{content:"";position:absolute;inset:-48px -60px;z-index:-1;pointer-events:none;background:radial-gradient(ellipse at 50% 100%,rgba(30,215,96,.1),transparent 65%)}
.peyebrow{font-family:var(--mono);font-size:10.5px;letter-spacing:1.5px;color:var(--accent);margin:0 0 8px}
.price{font-size:.92rem;color:var(--text-muted);margin:0 0 20px;text-wrap:pretty}
.field{display:block;margin:0 0 14px}
.field label{display:block;font-size:.85rem;color:var(--text-muted);margin-bottom:6px}
input[type=email],textarea{width:100%;font:inherit;padding:12px 14px;border:1px solid var(--border);border-radius:12px;background:var(--bg-raised);color:var(--text);transition:border-color .15s ease,box-shadow .15s ease}
input[type=email]::placeholder,textarea::placeholder{color:#6b6b6b}
input[type=email]:focus,textarea:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px rgba(30,215,96,.18)}
textarea{resize:vertical}
button{font:inherit;font-weight:700;cursor:pointer;border-radius:500px;border:1px solid transparent;transition:transform .15s ease,background .15s ease,border-color .15s ease,opacity .15s ease}
button:disabled{opacity:.55;cursor:default}
.btn-primary{background:var(--accent);color:#000;padding:13px 28px}
.btn-primary:hover:not(:disabled){transform:scale(1.03)}
.btn-primary:active:not(:disabled){background:var(--accent-press)}
#signup .btn-primary{width:100%;font-size:.98rem}
.btn-ghost{background:transparent;color:var(--text);border-color:var(--border-outline);padding:13px 24px}
.btn-ghost:hover:not(:disabled){border-color:var(--text-muted);transform:scale(1.03)}
.btnrow{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px}
.btnrow .btn-primary{flex:1;min-width:150px}
.err{color:var(--err);font-size:.9rem;margin:12px 0 0}

/* Survey — flat editorial groups separated by center-fading hairlines
   (no boxes), options as pill chips; the checked state highlight is a
   :has() progressive enhancement over the always-visible accent inputs. */
#welcome{font-size:1.05rem;margin:0 0 6px}
#pos{color:var(--accent);font-weight:800}
#step-survey h2{font-size:1rem;font-weight:700;margin:0 0 20px;color:var(--text)}
#survey fieldset{border:0;min-width:0;margin:0 0 20px;padding:0 0 20px;position:relative}
#survey fieldset:not(:last-of-type)::after{content:"";position:absolute;left:0;right:0;bottom:0;height:1px;background:var(--hairline)}
#survey legend{padding:0;margin-bottom:2px;font-weight:700;font-size:15px;color:var(--text)}
#survey fieldset label,#survey .optline label{display:inline-flex;align-items:center;gap:.4rem;margin:.45rem .55rem 0 0;padding:.42rem .85rem;border:1px solid #3a3a3a;border-radius:500px;font-size:.92rem;color:var(--text-muted);cursor:pointer;transition:border-color .15s ease,color .15s ease,background .15s ease}
#survey label:has(input:checked){border-color:var(--accent);color:var(--text);background:rgba(30,215,96,.08)}
input[type=radio],input[type=checkbox]{accent-color:var(--accent);margin:0}
#survey .optline{margin:0 0 20px}
#thanks:not([hidden]){display:flex;align-items:center;gap:10px;margin:20px 0 0;font-size:1.05rem}

/* Footer — hairline-separated, quiet label voice like the site's trust row. */
.footer{position:relative;margin-top:52px;padding-top:22px;text-align:center;font-size:.82rem;color:var(--text-muted)}
.footer::before{content:"";position:absolute;top:0;left:12%;right:12%;height:1px;background:var(--hairline)}
.footer a{color:var(--text-muted);font-weight:500;text-decoration:none;transition:color .15s ease}
.footer a:hover{color:var(--text)}

/* Load-in motion — same tkin discipline as the site's ticker lines. */
.rise{opacity:0;transform:translateY(10px);animation:tkin .55s ease forwards}
.d1{animation-delay:.05s}.d2{animation-delay:.14s}.d3{animation-delay:.23s}.d4{animation-delay:.32s}.d5{animation-delay:.41s}.d6{animation-delay:.5s}
@keyframes tkin{to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}.rise{opacity:1;transform:none}}

@media(max-width:560px){
.hero{padding-top:40px}
.panel{margin-top:36px;padding:22px 18px 20px}
.values{gap:8px 18px}
.btnrow{flex-direction:column}
.btnrow .btn-primary,.btnrow .btn-ghost{width:100%}
}
</style>
</head>
<body>
<main>
<header class="brand">${LOGO}<span class="wordmark">Mediary Scout</span><span class="connect-tag">CONNECT</span></header>

<section class="hero">
<p class="eyebrow rise d1">SCOUT CONNECT · BETA</p>
<h1 class="rise d2">Scout Connect 远程访问 · 内测</h1>
<p class="sub rise d3">在外网也能打开家里实例的浏览器界面——出差时下发新任务、查转存进度、改配置。</p>
<p class="sub2 rise d4">经 Cloudflare 加密隧道，不开端口、不要公网 IP、不需要域名。内容与凭据始终只在你自己的机器上。</p>
<ul class="values rise d5">
<li><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>加密隧道免端口</li>
<li><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 12 7.5 12 10.5 5 14.5 19 17.5 12 21 12"/></svg>转存进度随时查</li>
<li><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l7 2.8v5.4c0 4.4-2.9 7.6-7 9.8-4.1-2.2-7-5.4-7-9.8V5.8z"/><path d="M9 12l2.2 2.2L15.5 9.8"/></svg>凭据不出你的机器</li>
</ul>
</section>

<div class="panel rise d6">
<section id="step-signup">
<p class="peyebrow">BETA WAITLIST</p>
<p class="price">内测期免费，创始批 100 席；正式定价 ¥19/月 或 ¥199/年（创始价 ¥149/年）。先填邮箱，开通时邮件通知。</p>
<form id="signup">
<p class="field"><label for="email">邮箱</label>
<input id="email" name="email" type="email" required autocomplete="email" placeholder="you@example.com"></p>
<button id="join" type="submit" class="btn-primary" aria-label="申请内测席位" aria-busy="false">申请内测席位</button>
<p id="err" class="err" role="alert" hidden></p>
</form>
</section>

<section id="step-survey" hidden>
<p id="welcome"><span id="welcome-prefix">已登记，你是第 </span><b id="pos"></b> 位。</p>
<h2>顺便帮个忙（可跳过）</h2>
<form id="survey">
<fieldset><legend>愿意付费吗</legend>
<label><input type="radio" name="willing_to_pay" value="willing"> 愿意</label>
<label><input type="radio" name="willing_to_pay" value="free"> 只想免费</label>
<label><input type="radio" name="willing_to_pay" value="depends"> 看情况</label>
</fieldset>
<fieldset><legend>心理价位</legend>
<label><input type="radio" name="price_point" value="9"> ¥9/月</label>
<label><input type="radio" name="price_point" value="19"> ¥19/月</label>
<label><input type="radio" name="price_point" value="29"> ¥29/月</label>
<label><input type="radio" name="price_point" value="year149"> 年付 ¥149</label>
<label><input type="radio" name="price_point" value="unsure"> 说不好</label>
</fieldset>
<fieldset><legend>你会在哪些场景用它</legend>
<label><input type="checkbox" name="use_cases" value="progress"> 查进度</label>
<label><input type="checkbox" name="use_cases" value="newtask"> 下新任务</label>
<label><input type="checkbox" name="use_cases" value="config"> 改配置</label>
<label><input type="checkbox" name="use_cases" value="all"> 都有</label>
</fieldset>
<p class="optline"><label><input id="donate" type="checkbox" name="donate" value="yes"> 如果喜欢这个项目，我愿意打赏作者</label></p>
<p class="field"><label for="feedback">其他想说的</label>
<textarea id="feedback" name="feedback" maxlength="500" rows="4"></textarea></p>
<div class="btnrow">
<button id="send" type="submit" class="btn-primary" aria-label="提交（可选）" aria-busy="false">提交（可选）</button>
<button id="skip" type="button" class="btn-ghost">跳过</button>
</div>
<p id="survey-err" class="err" role="alert" hidden></p>
</form>
<p id="thanks" hidden><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#1ed760" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/></svg>感谢，开通时邮件通知你。</p>
</section>
</div>

<div class="footer"><a href="https://github.com/fancydirty/mediary-scout" target="_blank" rel="noopener">开源</a> · 自部署 · <a href="https://mediaryscout.app" target="_blank" rel="noopener">mediaryscout.app</a></div>
</main>
<script type="module">
const $=(id)=>document.getElementById(id);
let signupId=null;

function showErr(el,msg){el.textContent=msg;el.hidden=false;}

const joinBtn=$("join");
const joinLabel=joinBtn.getAttribute("aria-label");
function setJoinPending(pending){
  joinBtn.disabled=pending;
  joinBtn.setAttribute("aria-busy",pending?"true":"false");
  joinBtn.setAttribute("aria-label",pending?"正在提交内测申请":joinLabel);
  joinBtn.textContent=pending?"提交中…":joinLabel;
}

$("signup").onsubmit=async(ev)=>{
  ev.preventDefault();
  if(joinBtn.disabled)return;
  const email=$("email").value.trim();
  const err=$("err");
  err.hidden=true;err.textContent="";
  setJoinPending(true);
  let r=null;
  try{r=await fetch("/waitlist",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email:email})});}
  catch(_){setJoinPending(false);showErr(err,"网络异常，提交失败——请稍后再试。");return;}
  let d=null;
  try{d=await r.json();}catch(_){}
  // 契约:两条成功路径(201/200)都必带 id:string 与 position:number。
  if(r.ok&&d!==null&&typeof d.id==="string"&&typeof d.position==="number"){
    signupId=d.id;
    $("welcome-prefix").textContent=d.already_exists===true?"你已经在队列里，第 ":"已登记，你是第 ";
    $("pos").textContent=String(d.position);
    $("step-signup").hidden=true;
    $("step-survey").hidden=false;
    return;
  }
  setJoinPending(false);
  showErr(err,(d!==null&&typeof d.error==="string")?d.error:"提交失败，请稍后再试。");
};

const sendBtn=$("send");
const sendLabel=sendBtn.getAttribute("aria-label");
function setSendPending(pending){
  sendBtn.disabled=pending;
  sendBtn.setAttribute("aria-busy",pending?"true":"false");
  sendBtn.setAttribute("aria-label",pending?"正在提交":sendLabel);
  sendBtn.textContent=pending?"提交中…":sendLabel;
}
function thanks(){$("survey").hidden=true;$("thanks").hidden=false;}
$("skip").onclick=thanks;

$("survey").onsubmit=async(ev)=>{
  ev.preventDefault();
  if(sendBtn.disabled||signupId===null)return;
  const serr=$("survey-err");
  serr.hidden=true;serr.textContent="";
  const body={id:signupId};
  const wp=document.querySelector('input[name="willing_to_pay"]:checked');
  if(wp!==null)body.willing_to_pay=wp.value;
  const pp=document.querySelector('input[name="price_point"]:checked');
  if(pp!==null)body.price_point=pp.value;
  const ucs=document.querySelectorAll('input[name="use_cases"]:checked');
  if(ucs.length>0){body.use_cases=[];for(let i=0;i<ucs.length;i++)body.use_cases.push(ucs[i].value);}
  if($("donate").checked)body.donate=true;
  const fb=$("feedback").value.trim();
  if(fb!=="")body.feedback=fb;
  setSendPending(true);
  let r=null;
  try{r=await fetch("/waitlist/survey",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});}
  catch(_){setSendPending(false);showErr(serr,"网络异常，提交失败——请稍后再试。");return;}
  if(r.status===204){thanks();return;}
  let d=null;
  try{d=await r.json();}catch(_){}
  setSendPending(false);
  showErr(serr,(d!==null&&typeof d.error==="string")?d.error:"提交失败，请稍后再试。");
};
</script>
</body>
</html>`;
}
