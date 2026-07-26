export type InvitePageState =
  | { kind: "not_found" }
  | { kind: "waiting" }
  | { kind: "revealed"; hostname: string }
  | { kind: "ready"; code: string };

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

// Aperture mark — same as apps/web/app/icon.svg, inlined so the page stays
// fully self-contained (no external requests, strict CSP-friendly).
const LOGO =
  '<svg width="44" height="44" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Mediary Scout"><circle cx="16" cy="16" r="16" fill="#1ED760"/><g transform="translate(4,4)" fill="none" stroke="#0B3B1E" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m14.31 8 5.74 9.94"/><path d="M9.69 8h11.48"/><path d="m7.38 12 5.74-9.94"/><path d="M9.69 16 3.95 6.06"/><path d="M14.31 16H2.83"/><path d="m16.62 12-5.74 9.94"/></g></svg>';

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Mediary Scout Connect</title>
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
a{color:var(--green-dark);font-weight:600}
ol{padding-left:1.3rem}
li{margin:.45rem 0}
pre{background:#0B3B1E;color:#c9f2d8;padding:.9rem 1rem;border-radius:10px;overflow-x:auto;word-break:break-all;font-size:.86rem}
code{background:#eef3f0;padding:.12rem .35rem;border-radius:5px;font-size:.88em}
pre code{background:none;padding:0;color:inherit}
button{font:inherit;font-weight:600;padding:.6rem 1.15rem;cursor:pointer;border-radius:10px;border:1px solid transparent;transition:transform .05s ease}
button:active{transform:translateY(1px)}
button:disabled{opacity:.55;cursor:default}
.btn-primary{background:var(--green);color:var(--green-dark);border-color:var(--green)}
.btn-primary:hover:not(:disabled){filter:brightness(1.05)}
.btn-ghost{background:#fff;color:var(--green-dark);border-color:var(--line)}
.btn-ghost:hover{border-color:var(--green)}
.btnrow{display:flex;gap:.6rem;flex-wrap:wrap;margin-top:.9rem}
.warn{border:1px solid #e3b341;background:#fffbe6;padding:.8rem 1rem;border-radius:10px;font-size:.92rem}
.addr{font-size:1.05rem;margin:1rem 0 .2rem}
.footer{margin-top:2rem;padding-top:1rem;border-top:1px solid var(--line);font-size:.82rem;color:var(--muted);text-align:center}
.footer a{color:var(--muted);font-weight:500;text-decoration:none}
.footer a:hover{text-decoration:underline}
@media(max-width:480px){.card{padding:1.75rem 1.25rem}}
</style>
</head>
<body>
<main class="card">
<div class="brand">${LOGO}<div class="name">Mediary Scout <span>Connect</span></div></div>
${body}
<div class="footer">内容全程留在你自己的设备上 · <a href="https://github.com/fancydirty/mediary-scout" target="_blank" rel="noopener">开源自部署</a></div>
</main>
</body>
</html>`;
}

function readyBody(codeJson: string): string {
  return `<h1>你的远程访问已就绪</h1>
<div id="start">
<p class="muted">作者已为你开通一条从你家里到公网的加密通道。点击下方按钮查看连接信息。</p>
<p class="warn"><b>此信息只显示这一次</b> — 请先准备好再点。</p>
<div class="btnrow"><button id="reveal" class="btn-primary">显示连接信息</button></div>
</div>
<div id="result" hidden>
<p class="warn"><b>⚠️ 此信息只显示这一次</b>,刷新或关闭后将无法再次查看,请立即复制保存。</p>
<p class="addr">访问地址:<br><a id="link" target="_blank" rel="noopener"></a></p>
<p style="margin-top:1.2rem">TUNNEL_TOKEN:</p>
<pre><code id="tok"></code></pre>
<div class="btnrow">
<button id="copy-tok" class="btn-ghost" data-label="复制 Token">复制 Token</button>
<button id="copy-agent" class="btn-ghost" data-label="复制给 Agent">复制给 Agent</button>
</div>
<p class="muted">把「复制给 Agent」粘贴给 Claude Code / Codex / opencode,它会帮你完成下面的配置。</p>
<h2>手动配置步骤</h2>
<ol>
<li>进入 mediary-scout 部署目录(docker compose 项目根)。</li>
<li>在 .env 中写入一行 <code>TUNNEL_TOKEN=<span class="tk"></span></code>(若已有旧值,先备份再替换)。</li>
<li>可选:网络不稳定或 UDP 受限时,追加一行 <code>TUNNEL_TRANSPORT_PROTOCOL=http2</code>。</li>
<li>执行 <code>docker compose --profile tunnel up -d</code>。</li>
<li>执行 <code>docker compose logs -f cloudflared</code>,直到出现 Registered tunnel connection 字样。</li>
<li>浏览器打开 <code>https://<span class="hn"></span></code>,首次打开先设置访问密码(这就是门禁),之后登录进入 Mediary Scout。</li>
<li>若失败:检查 compose 服务名是否为 web、cloudflared 是否与 web 同网络、token 是否完整一行、防火墙是否拦截出站。</li>
</ol>
</div>
<script type="module">
const CODE=${codeJson};
const $=(id)=>document.getElementById(id);
let agentPrompt="";
async function copyText(btn,text){
  try{await navigator.clipboard.writeText(text);btn.textContent="已复制 ✓";}
  catch(_){btn.textContent="复制失败,请手动选择复制";}
  setTimeout(()=>{btn.textContent=btn.dataset.label||btn.textContent;},2000);
}
$("reveal").onclick=async()=>{
  $("reveal").disabled=true;
  let r=null;
  try{r=await fetch("/api/i/"+encodeURIComponent(CODE)+"/reveal",{method:"POST"});}
  catch(_){
    $("reveal").disabled=false;
    $("reveal").textContent="网络错误,请重试";
    return;
  }
  let d=null;
  try{d=await r.json();}catch(_){}
  // 409 未就绪 / 404 已失效 / 已显示过 → 回到服务端渲染的对应页面
  if(!r.ok||d===null||typeof d.token!=="string"){location.reload();return;}
  agentPrompt=d.agentPrompt;
  const link=$("link");
  link.href="https://"+d.hostname;
  link.textContent="https://"+d.hostname;
  $("tok").textContent=d.token;
  const hns=document.querySelectorAll(".hn");
  for(let i=0;i<hns.length;i++)hns[i].textContent=d.hostname;
  const tks=document.querySelectorAll(".tk");
  for(let i=0;i<tks.length;i++)tks[i].textContent=d.token;
  $("start").hidden=true;
  $("result").hidden=false;
};
$("copy-tok").onclick=()=>{copyText($("copy-tok"),$("tok").textContent);};
$("copy-agent").onclick=()=>{copyText($("copy-agent"),agentPrompt);};
</script>`;
}

export function invitePage(state: InvitePageState): string {
  switch (state.kind) {
    case "not_found":
      return shell(
        "链接无效",
        `<h1>链接无效</h1>
<p class="muted">这个链接不存在或已失效。如有疑问,请联系邀请你的人。</p>`,
      );
    case "waiting":
      return shell(
        "请稍候",
        `<h1>请稍候</h1>
<p class="muted">作者尚未开通,请稍候。开通后刷新本页即可。</p>`,
      );
    case "revealed": {
      const hn = escapeHtml(state.hostname);
      return shell(
        "连接信息已显示",
        `<h1>连接信息已显示</h1>
<p class="addr">你的访问地址:<br><a href="https://${hn}" target="_blank" rel="noopener">https://${hn}</a></p>
<p class="muted">连接信息已显示过一次;如丢失请联系作者吊销重建。</p>`,
      );
    }
    case "ready": {
      // Interpolate the code into the inline script as a JSON string literal;
      // escape "<" so an attacker-controlled code cannot break out of the
      // <script> block.
      const codeJson = JSON.stringify(state.code).replace(/</g, "\\u003c");
      return shell("已就绪", readyBody(codeJson));
    }
  }
}
