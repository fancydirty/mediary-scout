import { HINT_TEXT, ISSUE_TEXT, SLUG_MAX_LENGTH, sanitizeSlug, slugHint, slugIssues } from "./slug-input.js";

/**
 * slug 表单的客户端逻辑(方向 B)。
 *
 * 与旧实现的差异(全是修过的坑):
 * - **输入即净化**:sanitizeSlug 同步回写输入框 —— 显示值与最终开通值永远一致,
 *   消灭「显示 Alice 实际开通 alice」的漂移。
 * - **真 <form> + 回车提交**(旧按钮 type=button,回车无反应)。
 * - **开通中加载态**:串行 3 次 CF API 实测数秒,旧实现按钮只变灰。
 * - **内联状态图标**(spinner/✓/✕)在输入框右侧,视线不用离开输入点。
 * - **可点候选 chip**(旧是死文本得手打)。
 * - **校验错误不再说「稍后重试」**(那永远不会成功),而是说清差在哪。
 * - **逐条打勾**:规则清单实时勾选。
 */

// 把纯函数注入客户端(模块打包由 worker 的内联 <script type="module"> 处理,
// 这些 import 在生成脚本时被内联)。
export function slugFormScript(rootDomain: string): string {
  // rootDomain 是已 normalize 的服务端值,注入为 JSON 字面量(防引号截断)。
  const domainLiteral = JSON.stringify(rootDomain);
  return `<script type="module">
const $=(id)=>document.getElementById(id);
const form=$("slug-form"),input=$("slug"),state=$("slug-state"),count=$("slug-count"),
      msg=$("slug-msg"),rules=$("slug-rules"),suggest=$("slug-suggest"),
      btn=$("provision"),perr=$("prov-msg"),preview=$("slug-preview"),pname=$("preview-name");
const DOMAIN=${domainLiteral};
const MAX=${SLUG_MAX_LENGTH};
const ISSUE_TEXT=${JSON.stringify(ISSUE_TEXT)};

// —— 纯函数(与 src/html/slug-input.ts 同一份逻辑,生成时内联)——
// toString() 不会带上模块作用域的 SLUG_MAX_LENGTH 引用,注入时替换成上面的 MAX。
// 若两个函数体里出现新的外部引用,这里必须同步 —— 否则脚本会因 ReferenceError 整段崩掉。
const sanitizeSlug=${sanitizeSlug.toString().replace(/\bSLUG_MAX_LENGTH\b/g, "MAX")};
const slugIssues=${slugIssues.toString().replace(/\bSLUG_MAX_LENGTH\b/g, "MAX")};
const slugHint=${slugHint.toString()};
const HINT_TEXT=${JSON.stringify(HINT_TEXT)};

let timer=null,seq=0,lastAvailable=false;

function setState(kind,text){
  state.className="slug-state "+(kind==="spin"?"spin":kind);
  state.textContent=kind==="ok"?"✓":kind==="bad"?"✕":"";
  if(kind==="ok")input.className="ok";else if(kind==="bad")input.className="bad";else input.className="";
  // 无障碍:校验失败时同步 aria-invalid,否则读屏用户在出错时仍听到「未无效」。
  input.setAttribute("aria-invalid",kind==="bad"?"true":"false");
}
function setMsg(text,cls){msg.textContent=text;msg.className="msg "+(cls||"");msg.hidden=text==="";}
function updateCount(v){
  count.textContent=v.length+" / "+MAX;
  count.classList.toggle("over",v.length>MAX);
}
const tailname=$("preview-tail-name");
function updatePreview(slug,available){
  if(slug===""){
    preview.classList.remove("filled","ok");
    pname.textContent="你的名字";
    tailname.textContent="…";
    return;
  }
  pname.textContent=slug;
  tailname.textContent=slug;
  preview.classList.add("filled");
  preview.classList.toggle("ok",available===true);
}
function updateRules(slug,availability){
  const pass={
    chars:/^[a-z0-9-]*$/.test(slug)||slug==="",
    edge:!(slug.startsWith("-")||slug.endsWith("-")),
    len:slug.length>=1&&slug.length<=MAX,
    free:availability===true,
  };
  for(const li of rules.querySelectorAll(".rule")){
    const key=li.dataset.rule;
    const ok=pass[key]===true;
    li.classList.toggle("pass",ok);
    li.querySelector(".rule-mark").textContent=ok?"✓":"○";
  }
  return pass;
}
function setSuggestions(list){
  // 先清掉旧 chip
  for(const c of suggest.querySelectorAll(".chip"))c.remove();
  if(!Array.isArray(list)||list.length===0){suggest.hidden=true;return;}
  for(const name of list.slice(0,4)){
    const b=document.createElement("button");
    b.type="button";b.className="chip";b.textContent=name;
    b.addEventListener("click",()=>{input.value=name;onInput();});
    suggest.appendChild(b);
  }
  suggest.hidden=false;
}

async function check(slug){
  const res=await fetch("/api/slug/check?s="+encodeURIComponent(slug));
  if(res.status===401){location.href="/login";return null;}
  if(res.status===429){return {rateLimited:true};}
  if(!res.ok)return {error:true};
  return res.json();
}

function onInput(){
  // **输入即净化**:回写净化后的值,显示值与最终开通值永远一致。
  const raw=input.value;
  const clean=sanitizeSlug(raw);
  if(clean!==raw)input.value=clean;
  const slug=input.value;
  btn.disabled=true;perr.hidden=true;lastAvailable=false;
  // 同步按钮文案:清空回到占位「开通」,非空但未确认时也回到占位
  // (旧 slug 的「开通 xxx.domain」文案会残留,造成 UI 与当前输入不一致)。
  btn.textContent="开通";
  updateCount(slug);
  updatePreview(slug,false);
  updateRules(slug,null);
  if(timer)clearTimeout(timer);
  setSuggestions([]);
  if(slug===""){setState("","");setMsg("","");return;}
  const issues=slugIssues(slug);
  if(issues.length>0){
    setState("bad","");
    // 「还差什么」,不是「哪里错了」
    setMsg(issues.map((i)=>ISSUE_TEXT[i]).join("、"),"err");
    return;
  }
  // too_short 是**软提示不阻断**:assertSlug 允许 1 字符,前端不该更严。
  // 显示提醒但继续查重、可开通。
  const hint=slugHint(slug);
  setState("spin","");
  setMsg(hint?HINT_TEXT[hint]:"检查中…","");
  timer=setTimeout(async()=>{
    const mySeq=++seq;
    const d=await check(slug);
    if(mySeq!==seq)return; // 过期响应丢弃(快速连打)
    if(d===null)return; // 已跳登录页
    if(d.rateLimited){setState("bad","");setMsg("操作太频繁，请稍候再试。","err");return;}
    if(d.error||typeof d.available==="undefined"){setState("bad","");setMsg("查询失败，请检查网络后重试。","err");return;}
    if(d.available===true){
      setState("ok","");
      setMsg("✓ 这个名字可用","ok");
      updatePreview(slug,true);
      updateRules(slug,true);
      btn.disabled=false;lastAvailable=true;
      // 按钮复述完整域名 —— 让「我将得到什么」在提交前无可辩驳。
      btn.textContent="开通 "+slug+"."+DOMAIN;
    }else{
      setState("bad","");
      const reason=d.reason==="reserved"?"这个名字被保留了(可能与商标冲突)"
        :d.reason==="invalid"?"这个名字不符合规则"
        :"这个名字已被占用";
      setMsg(reason,"err");
      updateRules(slug,false);
      if(Array.isArray(d.suggestions))setSuggestions(d.suggestions);
    }
  },300);
}

input.addEventListener("input",onInput);
// 首屏初始化:把空输入的占位/隐藏状态同步到 DOM。
// 不调用的话,预览尾部初始空串、规则勾选态不按空值计算,首屏与逻辑不一致。
onInput();

// Enter 走原生 form 提交(真 <form>,不再需要手写回车监听)。
form.addEventListener("submit",async(ev)=>{
  ev.preventDefault();
  if(btn.disabled||!lastAvailable)return;
  const slug=input.value;
  btn.disabled=true;btn.textContent="正在开通…";perr.hidden=true;
  // **提交期间禁用输入框**:否则用户在请求途中继续编辑会触发 onInput()
  // 把 lastAvailable 置 false、重置 UI,而请求失败回滚又复述旧 slug,
  // 出现「按钮看似可点但 submit 直接 return」的不一致。finally 保证所有
  // 返回路径(含 reload 前)都恢复。
  input.disabled=true;
  let reloading=false;
  try{
    const res=await fetch("/api/provision",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({slug})});
    if(res.ok){reloading=true;location.reload();return;}
    if(res.status===401){reloading=true;location.href="/login";return;}
    let d=null;try{d=await res.json();}catch{}
    const e=d&&typeof d.error==="string"?d.error:"";
    // **确定性失败**(这个 slug 明确不能用)把 lastAvailable 置 false —— 否则
    // 用户能对着一个服务端已拒的 slug 反复点开通。这些情形必须换名字才有意义。
    if(res.status===402){perr.textContent="时长已过期，请先续期。";}
    else if(e==="already provisioned"){reloading=true;location.reload();return;}
    else if(e==="slug taken"){perr.textContent="刚被别人抢先占用了，换一个吧。";lastAvailable=false;}
    else if(e==="at capacity"){perr.textContent="暂时售罄，请稍后再试或联系支持。";lastAvailable=false;}
    // 校验错误说清差在哪,而不是「稍后重试」(那永远不会成功)。
    else if(res.status===400){perr.textContent="这个名字不符合规则，请检查后再试。";lastAvailable=false;}
    // 其余(网络/5xx 等)是**可重试**的,保持 lastAvailable 让用户能再点一次。
    else{perr.textContent="开通失败，请检查网络后重试。";}
    perr.hidden=false;
    btn.textContent=lastAvailable?"开通 "+slug+"."+DOMAIN:"开通";
  }catch{
    perr.textContent="网络错误，请稍后重试。";perr.hidden=false;
    btn.textContent="开通 "+slug+"."+DOMAIN;
  }finally{
    // 页面正在跳转/刷新时不必恢复(避免闪一下可编辑态)。
    // 按钮只在「仍可用」时才重新启用 —— 确定性失败后不该还能直接提交旧 slug。
    if(!reloading){input.disabled=false;btn.disabled=!lastAvailable;}
  }
});
</script>`;
}
