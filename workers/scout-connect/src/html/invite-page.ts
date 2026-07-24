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

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Scout Connect</title>
<style>
body{font-family:system-ui,sans-serif;max-width:640px;margin:3rem auto;padding:0 1rem;color:#222;line-height:1.7}
a{color:#06c}
pre{background:#f4f4f4;padding:.75rem;border-radius:6px;overflow-x:auto;word-break:break-all}
code{background:#f4f4f4;padding:.1rem .3rem;border-radius:4px}
pre code{background:none;padding:0}
button{font:inherit;padding:.5rem 1rem;cursor:pointer}
.warn{border:1px solid #e3b341;background:#fffbe6;padding:.75rem;border-radius:6px}
</style>
</head>
<body>
${body}
</body>
</html>`;
}

function readyBody(codeJson: string): string {
  return `<h1>你的远程访问已就绪</h1>
<div id="start">
<p>点击下方按钮查看连接信息。<b>此信息只显示这一次</b>,请先准备好再点。</p>
<p><button id="reveal">显示连接信息</button></p>
</div>
<div id="result" hidden>
<p class="warn"><b>⚠️ 此信息只显示这一次</b>,刷新或关闭后将无法再次查看,请立即复制保存。</p>
<p>访问地址:<a id="link" target="_blank" rel="noopener"></a></p>
<p>TUNNEL_TOKEN:</p>
<pre><code id="tok"></code></pre>
<p><button id="copy-tok" data-label="复制 Token">复制 Token</button> <button id="copy-agent" data-label="复制给 Agent">复制给 Agent</button></p>
<h2>手动配置步骤</h2>
<ol>
<li>进入 mediary-scout 部署目录(docker compose 项目根)。</li>
<li>在 .env 中写入一行 <code>TUNNEL_TOKEN=<span class="tk"></span></code>(若已有旧值,先备份再替换)。</li>
<li>可选:网络不稳定或 UDP 受限时,追加一行 <code>TUNNEL_TRANSPORT_PROTOCOL=http2</code>。</li>
<li>执行 <code>docker compose --profile tunnel up -d</code>。</li>
<li>执行 <code>docker compose logs -f cloudflared</code>,直到出现 Registered tunnel connection 字样。</li>
<li>浏览器打开 <code>https://<span class="hn"></span></code>,先完成 Cloudflare Access 邮箱验证,通过后进入 Mediary Scout。</li>
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
<p>这个链接不存在或已失效。如有疑问,请联系邀请你的人。</p>`,
      );
    case "waiting":
      return shell(
        "请稍候",
        `<h1>请稍候</h1>
<p>作者尚未开通，请稍候。开通后刷新本页即可。</p>`,
      );
    case "revealed": {
      const hn = escapeHtml(state.hostname);
      return shell(
        "连接信息已显示",
        `<h1>连接信息已显示</h1>
<p>你的访问地址:<a href="https://${hn}" target="_blank" rel="noopener">https://${hn}</a></p>
<p>连接信息已显示过一次；如丢失请联系作者吊销重建。</p>`,
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
