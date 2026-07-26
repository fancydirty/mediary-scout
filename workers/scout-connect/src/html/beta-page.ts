// Public beta signup page (GET /beta) — a single-page two-step flow:
// step 1 collects the email (POST /waitlist, same origin), step 2 offers an
// optional survey (POST /waitlist/survey). Fully self-contained: inline
// style/script only, no external requests.
//
// Escaping discipline: unlike invite-page this page is FULLY STATIC — the
// server interpolates zero values into it, so there is nothing to escape
// here. Client-side, every dynamic value (position, server error text) is
// inserted via textContent only; innerHTML is deliberately never used, and a
// test pins both properties.

// Aperture mark — same as apps/web/app/icon.svg, inlined so the page stays
// fully self-contained (no external requests, strict CSP-friendly).
const LOGO =
  '<svg width="44" height="44" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Mediary Scout"><circle cx="16" cy="16" r="16" fill="#1ED760"/><g transform="translate(4,4)" fill="none" stroke="#0B3B1E" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m14.31 8 5.74 9.94"/><path d="M9.69 8h11.48"/><path d="m7.38 12 5.74-9.94"/><path d="M9.69 16 3.95 6.06"/><path d="M14.31 16H2.83"/><path d="m16.62 12-5.74 9.94"/></g></svg>';

export function betaPage(): string {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Scout Connect 远程访问 · 内测 · Mediary Scout Connect</title>
<style>
:root{--green:#1ED760;--green-dark:#0B3B1E;--ink:#1a2b22;--muted:#5b6b62;--line:#e3e9e5;--card:#fff;--bg:#f4f7f5}
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--ink);line-height:1.7;min-height:100vh;display:flex;align-items:flex-start;justify-content:center;padding:2.5rem 1rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;box-shadow:0 4px 24px rgba(11,59,30,.06);max-width:600px;width:100%;padding:2.25rem 2rem 2rem}
.brand{display:flex;align-items:center;gap:.7rem;margin-bottom:1.5rem}
.brand .name{font-weight:700;font-size:1.05rem;letter-spacing:.01em}
.brand .name span{color:var(--muted);font-weight:500}
h1{font-size:1.45rem;line-height:1.3;margin:.2rem 0 1rem}
h2{font-size:1.05rem;margin:1.75rem 0 .5rem}
p{margin:.6rem 0}
.muted{color:var(--muted);font-size:.92rem}
input[type=email],textarea{width:100%;font:inherit;padding:.55rem .7rem;border:1px solid var(--line);border-radius:10px;background:#fff;color:var(--ink)}
input[type=email]:focus,textarea:focus{outline:2px solid var(--green);outline-offset:1px;border-color:var(--green)}
textarea{resize:vertical}
fieldset{border:1px solid var(--line);border-radius:10px;margin:.9rem 0;padding:.6rem .9rem .8rem}
legend{font-weight:600;font-size:.95rem;padding:0 .3rem}
fieldset label{display:inline-flex;align-items:center;gap:.35rem;margin:.25rem .9rem .25rem 0;font-size:.95rem}
button{font:inherit;font-weight:600;padding:.6rem 1.15rem;cursor:pointer;border-radius:10px;border:1px solid transparent;transition:transform .05s ease}
button:active{transform:translateY(1px)}
button:disabled{opacity:.55;cursor:default}
.btn-primary{background:var(--green);color:var(--green-dark);border-color:var(--green)}
.btn-primary:hover:not(:disabled){filter:brightness(1.05)}
.btn-ghost{background:#fff;color:var(--green-dark);border-color:var(--line)}
.btn-ghost:hover{border-color:var(--green)}
.btnrow{display:flex;gap:.6rem;flex-wrap:wrap;margin-top:.9rem}
.err{color:#b42318;font-size:.92rem}
.footer{margin-top:2rem;padding-top:1rem;border-top:1px solid var(--line);font-size:.82rem;color:var(--muted);text-align:center}
.footer a{color:var(--muted);font-weight:500;text-decoration:none}
.footer a:hover{text-decoration:underline}
@media(max-width:480px){.card{padding:1.75rem 1.25rem}}
</style>
</head>
<body>
<main class="card">
<div class="brand">${LOGO}<div class="name">Mediary Scout <span>Connect</span></div></div>

<section id="step-signup">
<h1>Scout Connect 远程访问 · 内测</h1>
<p>在外网也能打开家里实例的浏览器界面——出差时下发新任务、查转存进度、改配置。经 Cloudflare 加密隧道，不开端口、不要公网 IP、不需要域名。内容与凭据始终只在你自己的机器上。</p>
<p class="muted">内测期免费，创始批 100 席；正式定价 ¥19/月 或 ¥199/年（创始价 ¥149/年）。先填邮箱，开通时邮件通知。</p>
<form id="signup">
<p><label for="email">邮箱</label><br>
<input id="email" name="email" type="email" required autocomplete="email" placeholder="you@example.com"></p>
<div class="btnrow"><button id="join" type="submit" class="btn-primary" aria-label="申请内测席位" aria-busy="false">申请内测席位</button></div>
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
<p><label><input id="donate" type="checkbox" name="donate" value="yes"> 如果喜欢这个项目，我愿意打赏作者</label></p>
<p><label for="feedback">其他想说的</label><br>
<textarea id="feedback" name="feedback" maxlength="500" rows="4"></textarea></p>
<div class="btnrow">
<button id="send" type="submit" class="btn-primary" aria-label="提交（可选）" aria-busy="false">提交（可选）</button>
<button id="skip" type="button" class="btn-ghost">跳过</button>
</div>
<p id="survey-err" class="err" role="alert" hidden></p>
</form>
<p id="thanks" hidden>感谢，开通时邮件通知你。</p>
</section>

<div class="footer">内容全程留在你自己的设备上 · <a href="https://github.com/fancydirty/mediary-scout" target="_blank" rel="noopener">开源自部署</a></div>
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
