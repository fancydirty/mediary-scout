import type { AccountRow, EndpointRow, EntitlementRow } from "../db.js";
import { GRACE_PERIOD_DAYS, daysLeftInGrace } from "../expiry.js";
import { isEntitlementActive, latestExpiry } from "../entitlement.js";
import { buildConnectPrompt, CLAIM_CODE_PLACEHOLDER } from "./connect-prompt.js";
import { SLUG_FORM_CSS, slugFormHtml } from "./slug-form.js";
import { slugFormScript } from "./slug-form-script.js";
import { BRAND_BAR, BRAND_CSS, esc, FAVICON_LINK, THEME_BASE, THEME_TOKENS } from "./theme.js";

/**
 * 控制台 v2(决策 #13:智能给 agent、确定性给脚本)。
 *
 * 三种状态:
 *  - 未开通(无有效时长):只显示状态 + 「开通」CTA,不显示接入区。
 *  - 已开通但还没选 slug / 没 endpoint:显示「选择你的专属地址」入口。
 *  - 已开通且有 active endpoint:接入区为主角——一段交给 AI 助手的提示词
 *    (大框 + 复制按钮),真实取件码由客户端向 /api/claim-code 现取后
 *    替换占位符注入;裸 curl 命令降级进「或手动」折叠区。
 *
 * 提示词模板在服务端用占位符 CLAIM_CODE_PLACEHOLDER 生成(此时还没有码),
 * 客户端点「获取接入命令」时才 POST /api/claim-code 拿 15 分钟有效的真码,
 * 把占位符替换成真码——提示词天然是临时生成的(码短命),token 从不出现。
 */
export function consolePage(input: {
  account: AccountRow;
  entitlements: EntitlementRow[];
  endpoint: EndpointRow | null;
  baseUrl: string;
  /** slug 的后缀域(CONNECT_ROOT_DOMAIN,已 normalize)。不能用 baseUrl.host
   *  推:控制台可从 beta 子域访问,host 会是 beta.<root>,后缀就错了。 */
  rootDomain: string;
  now: string;
  /** 隧道配额是否已满(CF 1000 硬上限)。只影响「已付费未开通」态:满了就不给
   *  slug 表单,免得用户填完名字才吃 503。已开通用户完全不受影响。 */
  atCapacity?: boolean;
}): string {
  const expiry = latestExpiry(input.entitlements);
  const active = isEntitlementActive(expiry, input.now);

  // **三态,不是二态。** 原先把「已付费但已过期」误报成「尚未开通」——
  // 一个真实付过钱的老用户被当成从没来过。现在区分:
  //   有效 / 宽限期中(已过期但 7 天内仍可续期恢复) / 已过期。
  // 宽限期判断与 cron 用同一份 GRACE_PERIOD_DAYS,保证两边算的是同一段时间。
  // **必须与 cron 的边界语义一致**(`<=`):宽限截止的精确瞬间仍属宽限期。
  // daysLeftInGrace 在那一刻返回 0,若用 `daysLeft > 0` 会把仍在宽限的用户
  // 误报成「已过期」—— UI 与 cron 的边界就分叉了。用毫秒边界直接判。
  const expMs = expiry === null ? NaN : Date.parse(expiry);
  const nowMs = Date.parse(input.now);
  const inGrace =
    !active &&
    Number.isFinite(expMs) &&
    Number.isFinite(nowMs) &&
    nowMs <= expMs + GRACE_PERIOD_DAYS * 24 * 60 * 60_000;
  const daysLeft = inGrace ? daysLeftInGrace(expiry!, input.now) : 0;
  const statusBadge = active
    ? `<span class="badge ok">● 有效 · 到期 ${esc(expiry!.slice(0, 10))}</span>`
    : inGrace
      ? `<span class="badge warn">● 宽限期中 · 剩 ${daysLeft} 天</span>`
      : expiry !== null
        ? `<span class="badge none">已过期 · 续期即恢复</span>`
        : `<span class="badge none">尚未开通</span>`;

  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>控制台 · Mediary Connect</title>
${FAVICON_LINK}
<style>
${THEME_TOKENS}
${THEME_BASE}
${BRAND_CSS}
main{max-width:680px;margin:0 auto;padding:36px 24px 90px}
.email-line{color:var(--text-muted);font-size:.85rem;margin:22px 0 18px;font-family:var(--mono)}
.status-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:6px}
h1{font-size:1.5rem;font-weight:900;letter-spacing:-.5px;margin:0}
.badge{font-family:var(--mono);font-size:11px;letter-spacing:1px;padding:5px 12px;border-radius:999px}
.badge.ok{background:rgba(30,215,96,.12);color:var(--accent);border:1px solid rgba(30,215,96,.35)}
.badge.none{background:rgba(243,114,127,.1);color:var(--err);border:1px solid rgba(243,114,127,.35)}
.badge.warn{background:rgba(255,176,32,.12);color:#ffb020;border:1px solid rgba(255,176,32,.35)}
.sub{color:var(--text-muted);font-size:.92rem;margin:2px 0 0}
.addr{color:var(--accent);font-family:var(--mono);font-size:.92rem}
.btn{display:inline-block;margin-top:14px;font:inherit;font-weight:700;cursor:pointer;border:1px solid transparent;border-radius:500px;background:var(--accent);color:#000;padding:12px 26px;font-size:.96rem;text-decoration:none;transition:transform .15s ease,background .15s ease,opacity .15s ease}
.btn:hover:not(:disabled){transform:scale(1.02)}
.btn:active:not(:disabled){background:var(--accent-press)}
.btn:disabled{opacity:.55;cursor:default}
.panel{position:relative;background:rgba(24,24,24,.8);border:1px solid #2b2b2b;border-radius:18px;box-shadow:inset 0 1px 0 rgba(255,255,255,.07),rgba(0,0,0,.55) 0 18px 40px -12px;padding:26px;margin-top:26px}
.step{font-family:var(--mono);font-size:11px;letter-spacing:1.5px;color:var(--accent);margin:0 0 6px}
.lead{font-size:1.05rem;font-weight:700;margin:0 0 4px}
.lead-sub{color:var(--text-muted);font-size:.9rem;margin:0 0 18px;line-height:1.6}
.prompt-wrap{position:relative}
.prompt{background:#0d0d0d;border:1px solid #2b2b2b;border-radius:12px;padding:16px;font-family:var(--mono);font-size:12px;line-height:1.7;color:#cfcfcf;max-height:230px;overflow:auto;white-space:pre-wrap;word-break:break-word}
.copy-btn{width:100%;margin-top:14px}
.helprow{display:flex;gap:8px;align-items:center;color:#8f8f8f;font-size:12.5px;margin-top:14px}
.helprow svg{color:var(--accent);flex:none}
.msg{font-size:.9rem;margin-top:12px;color:var(--text-muted)}
.msg.err{color:var(--err)}
.msg.ok{color:var(--accent)}
${SLUG_FORM_CSS}
#provision{margin-top:16px;width:100%}
.btn:disabled{opacity:.55;cursor:default;transform:none}
details{margin-top:18px;border-top:1px solid #222;padding-top:16px}
summary{cursor:pointer;font-size:.9rem;color:var(--text-muted);list-style:none;display:flex;align-items:center;gap:8px}
summary::-webkit-details-marker{display:none}
summary .chev{transition:transform .15s;color:var(--accent)}
details[open] summary .chev{transform:rotate(90deg)}
.manual-note{color:#8f8f8f;font-size:12.5px;margin:12px 0 10px;line-height:1.6}
.cmd{background:#0d0d0d;border:1px solid #2b2b2b;border-radius:10px;padding:13px 15px;font-family:var(--mono);font-size:12px;color:#cfcfcf;overflow-x:auto;white-space:nowrap}
.expire{font-family:var(--mono);font-size:11px;color:#777;margin-top:16px;text-align:center}
.footer{position:relative;margin-top:48px;padding-top:20px;text-align:center;font-size:.82rem;color:var(--text-muted)}
.footer::before{content:"";position:absolute;top:0;left:12%;right:12%;height:1px;background:var(--hairline)}
.footer a{color:var(--text-muted);text-decoration:none}
.footer a:hover{color:var(--text)}
[hidden]{display:none!important}
</style>
</head>
<body>
<main>
${BRAND_BAR}
<p class="email-line">${esc(input.account.email)}</p>
<div class="status-row"><h1>远程访问</h1>${statusBadge}</div>
${renderBody({ ...input, atCapacity: input.atCapacity === true }, active)}
<div class="footer"><a href="/pricing">定价</a> · <a href="/terms">服务条款</a> · <a href="/privacy">隐私政策</a> · <a href="/refund">退款政策</a> · <a href="/contact">联系我们</a></div>
</main>
${renderScript({ ...input, atCapacity: input.atCapacity === true }, active)}
</body>
</html>`;
}

function renderBody(
  input: {
    account: AccountRow;
    endpoint: EndpointRow | null;
    rootDomain: string;
    /** 隧道配额已满(CF 1000 硬上限)。已开通用户不受影响,只挡新开通。 */
    atCapacity: boolean;
  },
  active: boolean,
): string {
  if (!active) {
    return `<p class="sub">你还没有有效时长。开通后即可为自托管实例生成专属远程访问地址。</p>
<a class="btn" href="/pricing">开通</a>`;
  }
  if (input.endpoint === null && input.atCapacity) {
    // 满容量:**不渲染表单**。让用户输完名字、点开通、再吃 503 是最差的体验
    // (他会以为自己名字填错了)。直接说清是我方容量、以及他能做什么。
    // 已付费才会走到这里,所以必须给退款出口 —— 14 天内无条件。
    return `<p class="sub">你的时长已生效，但目前暂时无法分配新地址。</p>
<div class="panel">
<p class="step" style="color:var(--err)">暂时售罄</p>
<p class="lead">隧道配额已满</p>
<p class="lead-sub">我们的 Cloudflare 隧道配额（每账号上限 1000 条，所有套餐一致）已用尽，暂时无法为新实例分配地址。你的时长不会流失——配额释放后回到这里即可开通，我们也会邮件通知你。</p>
<p class="lead-sub">如果不想等，14 天内可无条件全额退款：<a href="/refund">退款政策</a> · <a href="/contact">联系我们</a></p>
</div>`;
  }
  if (input.endpoint === null) {
    // 已付费未开通:内嵌 slug 选择表单(方向 B:活体域名预览为主角;
    // 实时查重走 /api/slug/check,开通走 /api/provision,成功后整页刷新)。
    return slugFormHtml({ rootDomain: input.rootDomain });
  }

  const hostname = input.endpoint.hostname;
  // 提示词模板由 renderScript 在客户端脚本里生成(带占位符),点按钮时现取
  // 真码替换。这里不预生成——服务端渲染时页面里的 #prompt 是空的。
  return `<p class="sub">你的专属地址：<span class="addr">${esc(hostname)}</span>（配置好后浏览器打开它即可）</p>
<div class="panel">
<p class="step">接入你的实例</p>
<p class="lead">把下面这段交给你的 AI 助手</p>
<p class="lead-sub">Claude Code / Codex / opencode 都行。它会找到你部署 Mediary Scout 的那台机器、连上去、配好隧道并验证连通——你不用自己敲命令。</p>
<button class="btn" id="gen" type="button">获取接入命令</button>
<p class="msg" id="msg" hidden></p>
<div id="result" hidden>
<div class="prompt-wrap"><div class="prompt" id="prompt"></div></div>
<button class="btn copy-btn" id="copy" type="button">复制提示词</button>
<div class="helprow"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="9"/></svg>取件码已内嵌在提示词里，15 分钟有效</div>
<details>
<summary><span class="chev">▸</span> 或者：我能直接操作那台机器，手动接</summary>
<p class="manual-note">如果你现在就在部署 Mediary Scout 的那台机器上（或能直接 SSH 过去），进到部署目录直接跑这一条：</p>
<div class="cmd" id="cmd"></div>
</details>
<p class="expire">取件码 15 分钟后失效 · 过期回这里再点一次「获取接入命令」即可</p>
</div>
</div>`;
}

/** active 时才需要客户端脚本:有 endpoint → 取码/复制;无 endpoint → slug
 *  选择表单(实时查重 + 开通)。 */
function renderScript(
  input: { endpoint: EndpointRow | null; baseUrl: string; rootDomain: string; atCapacity?: boolean },
  active: boolean,
): string {
  if (!active) return "";
  // 满容量时 renderBody 不渲染 #slug/#provision,注入表单脚本会对 null 调
  // addEventListener 直接抛错、整段脚本崩掉。条件必须与 renderBody 的分支一致。
  if (input.endpoint === null && input.atCapacity === true) return "";
  if (input.endpoint === null) return slugFormScript(input.rootDomain);
  return `<script type="module">
const $=(id)=>document.getElementById(id);
const PLACEHOLDER=${JSON.stringify(CLAIM_CODE_PLACEHOLDER)};
const template=$("prompt").dataset.template=${JSON.stringify(
    buildConnectPrompt({
      hostname: input.endpoint.hostname,
      claimCode: CLAIM_CODE_PLACEHOLDER,
      baseUrl: input.baseUrl,
    }),
  )};
const cmdTemplate=${JSON.stringify(
    `curl -fsSL ${new URL(input.baseUrl).origin}/connect.sh | sh -s -- ${CLAIM_CODE_PLACEHOLDER}`,
  )};
const gen=$("gen"),msg=$("msg"),result=$("result");
gen.addEventListener("click",async()=>{
  gen.disabled=true;msg.hidden=true;msg.className="msg";
  try{
    const res=await fetch("/api/claim-code",{method:"POST",headers:{"content-type":"application/json"}});
    if(!res.ok){
      msg.textContent=res.status===404?"还没有可接入的实例——请先选择你的专属地址。":"获取失败，请稍后重试。";
      msg.className="msg err";msg.hidden=false;gen.disabled=false;return;
    }
    const data=await res.json();
    const code=typeof data.code==="string"?data.code:"";
    if(code===""){msg.textContent="返回数据异常，请重试。";msg.className="msg err";msg.hidden=false;gen.disabled=false;return;}
    // 用 split/join 替换所有占位符（真码只用于本次会话，不落任何存储）。
    $("prompt").textContent=template.split(PLACEHOLDER).join(code);
    $("cmd").textContent=cmdTemplate.split(PLACEHOLDER).join(code);
    result.hidden=false;
    gen.textContent="重新生成取件码";gen.disabled=false;
  }catch{
    msg.textContent="网络错误，请稍后重试。";msg.className="msg err";msg.hidden=false;gen.disabled=false;
  }
});
$("copy").addEventListener("click",async()=>{
  try{await navigator.clipboard.writeText($("prompt").textContent);$("copy").textContent="已复制 ✓";setTimeout(()=>{$("copy").textContent="复制提示词";},1800);}
  catch{
    // clipboard 不可用时降级为选中文本让用户手动复制。getSelection() 在
    // 某些上下文可能返回 null,先判空再用,别让 fallback 自己抛。
    const s=window.getSelection();
    if(s){const r=document.createRange();r.selectNodeContents($("prompt"));s.removeAllRanges();s.addRange(r);}
  }
});
</script>`;
}

/** slug 选择表单的客户端逻辑:输入防抖 → /api/slug/check 实时查重(可用/
 *  占用+推荐)→ 可用才解锁「开通」→ POST /api/provision → 成功整页刷新
 *  (服务端按新状态渲染接入区)。所有动态文本走 textContent,不用 innerHTML。 */

