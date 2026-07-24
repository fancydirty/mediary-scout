// Self-contained admin page: inline module script, no external resources.
// The admin token lives only in sessionStorage and is sent as a bearer on
// every /api/admin/* call.
export function adminPage(): string {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Scout Connect Admin</title>
<style>
body{font-family:system-ui,sans-serif;max-width:1000px;margin:2rem auto;padding:0 1rem;color:#222;font-size:14px}
input,button{font:inherit;padding:.35rem .5rem}
table{border-collapse:collapse;width:100%;margin-top:.5rem}
td,th{border:1px solid #ccc;padding:.35rem .5rem;text-align:left;vertical-align:top}
pre{background:#f4f4f4;padding:.75rem;border-radius:6px;overflow-x:auto;word-break:break-all}
code{background:#f4f4f4;padding:.1rem .3rem;border-radius:4px}
.err{color:#b00020}.ok{color:#0a7d2c}
.warn{border:1px solid #e3b341;background:#fffbe6;padding:.75rem;border-radius:6px;margin-top:1rem}
h1{font-size:1.3rem}h2{font-size:1.05rem;margin-top:2rem}
</style>
</head>
<body>
<h1>Scout Connect Admin</h1>
<p>
<label>Admin Token <input id="token" type="password" size="42" autocomplete="off"></label>
<button id="save-token">保存 Token</button>
<button id="refresh">刷新</button>
<span id="msg"></span>
</p>

<h2>创建邀请</h2>
<form id="create">
<input name="email" type="text" placeholder="invitee@email.com" required>
<input name="invitee_label" type="text" placeholder="称呼(可选)">
<input name="slug" type="text" placeholder="slug(可选,开通时也可填)">
<button type="submit">创建邀请</button>
</form>
<div id="created"></div>

<h2>邀请列表</h2>
<table>
<thead><tr><th>email</th><th>称呼</th><th>状态</th><th>slug</th><th>邀请链接</th><th>操作</th></tr></thead>
<tbody id="invites"></tbody>
</table>
<div id="provision-result"></div>

<h2>端点列表</h2>
<table>
<thead><tr><th>hostname</th><th>状态</th><th>token 显示时间</th><th>创建时间</th><th>吊销时间</th><th>操作</th></tr></thead>
<tbody id="endpoints"></tbody>
</table>

<script type="module">
const $=(id)=>document.getElementById(id);
const esc=(s)=>String(s).replace(/[&<>"']/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const msg=(t,cls)=>{const m=$("msg");m.textContent=t;m.className=cls||"";};
const tokenEl=$("token");
tokenEl.value=sessionStorage.getItem("adminToken")||"";
$("save-token").onclick=()=>{sessionStorage.setItem("adminToken",tokenEl.value);msg("token 已保存","ok");};

async function api(path,opts){
  const r=await fetch(path,{
    method:(opts&&opts.method)||"GET",
    headers:{"authorization":"Bearer "+(sessionStorage.getItem("adminToken")||""),"content-type":"application/json"},
    body:opts&&opts.body?JSON.stringify(opts.body):undefined
  });
  if(!r.ok){let e="HTTP "+r.status;try{const j=await r.json();if(j&&j.error)e=j.error;}catch(_){}
  throw new Error(e);}
  return r.json();
}
function guard(fn){return async(ev)=>{msg("");try{await fn(ev);}catch(e){msg(e.message,"err");}};}
async function copyText(t){try{await navigator.clipboard.writeText(t);msg("已复制","ok");}catch(_){msg("复制失败,请手动选择复制","err");}}

let lastProvision=null;
function showProvision(r){
  lastProvision=r;
  $("provision-result").innerHTML=
    '<div class="warn"><b>⚠️ Token 只显示这一次</b>,请立即把邀请链接或连接信息转交对方。</div>'+
    '<p>访问地址:<a href="https://'+esc(r.hostname)+'" target="_blank" rel="noopener">'+esc(r.hostname)+'</a> '+
    '邀请链接:<a href="'+esc(r.inviteUrl)+'" target="_blank" rel="noopener">'+esc(r.inviteUrl)+'</a></p>'+
    '<p>TUNNEL_TOKEN:</p><pre><code>'+esc(r.token)+'</code></pre>'+
    '<p><button id="p-copy-token">复制 Token</button> <button id="p-copy-prompt">复制 Agent 提示词</button> <button id="p-copy-url">复制邀请链接</button></p>'+
    '<details><summary>Agent 提示词预览</summary><pre><code>'+esc(r.agentPrompt)+'</code></pre></details>';
  $("p-copy-token").onclick=()=>copyText(lastProvision.token);
  $("p-copy-prompt").onclick=()=>copyText(lastProvision.agentPrompt);
  $("p-copy-url").onclick=()=>copyText(lastProvision.inviteUrl);
}

async function refresh(){
  const data=await Promise.all([api("/api/admin/invites"),api("/api/admin/endpoints")]);
  const invites=data[0].invites,endpoints=data[1].endpoints;
  $("invites").innerHTML=invites.map((i)=>{
    const url=location.origin+"/i/"+i.code;
    const slugCell=i.status==="pending"
      ?'<input size="12" id="slug-'+esc(i.id)+'" value="'+esc(i.slug||"")+'" placeholder="slug">'
      :esc(i.slug||"");
    const action=i.status==="pending"?'<button data-provision="'+esc(i.id)+'">开通</button>':"";
    return '<tr><td>'+esc(i.email)+'</td><td>'+esc(i.invitee_label||"")+'</td><td>'+esc(i.status)+'</td><td>'+slugCell+'</td><td><a href="'+esc(url)+'" target="_blank" rel="noopener">链接</a></td><td>'+action+'</td></tr>';
  }).join("");
  for(const b of document.querySelectorAll("[data-provision]")){
    b.onclick=guard(async()=>{
      const input=$("slug-"+b.getAttribute("data-provision"));
      const slug=input?input.value.trim():"";
      const r=await api("/api/admin/invites/"+b.getAttribute("data-provision")+"/provision",{method:"POST",body:slug?{slug}:{}});
      showProvision(r);
      await refresh();
    });
  }
  $("endpoints").innerHTML=endpoints.map((e)=>{
    const action=e.status==="active"||e.status==="revoke_failed"?'<button data-revoke="'+esc(e.id)+'">吊销</button>':"";
    return '<tr><td><a href="https://'+esc(e.hostname)+'" target="_blank" rel="noopener">'+esc(e.hostname)+'</a></td><td>'+esc(e.status)+'</td><td>'+esc(e.token_shown_at||"")+'</td><td>'+esc(e.created_at)+'</td><td>'+esc(e.revoked_at||"")+'</td><td>'+action+'</td></tr>';
  }).join("");
  for(const b of document.querySelectorAll("[data-revoke]")){
    b.onclick=guard(async()=>{
      if(!confirm("确认吊销?对方的远程访问将立即失效。"))return;
      await api("/api/admin/endpoints/"+b.getAttribute("data-revoke")+"/revoke",{method:"POST",body:{}});
      await refresh();
    });
  }
}
$("refresh").onclick=guard(refresh);
$("create").onsubmit=guard(async(ev)=>{
  ev.preventDefault();
  const fd=new FormData(ev.target);
  const body={email:fd.get("email")};
  const label=String(fd.get("invitee_label")||"").trim();
  const slug=String(fd.get("slug")||"").trim();
  if(label)body.invitee_label=label;
  if(slug)body.slug=slug;
  const r=await api("/api/admin/invites",{method:"POST",body:body});
  $("created").innerHTML='<p class="ok">已创建,邀请链接:<a href="'+esc(r.inviteUrl)+'" target="_blank" rel="noopener">'+esc(r.inviteUrl)+'</a></p>';
  ev.target.reset();
  await refresh();
});
if(tokenEl.value)guard(refresh)();
</script>
</body>
</html>`;
}
