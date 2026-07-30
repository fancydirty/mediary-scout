import { esc } from "./theme.js";
import { SLUG_MAX_LENGTH } from "./slug-input.js";

/**
 * slug 选择表单 —— 方向 B(已冻结设计):活体域名预览为主角。
 *
 * 这一步的核心焦虑是「我到底会得到什么」,所以把完整域名放大成视觉主体,
 * 输入框退为配角。状态图标内联在输入框右侧(不是下方一行灰字),
 * 规则逐条打勾,按钮复述完整域名。
 *
 * 服务端渲染静态骨架(规则清单初始全部 ○),客户端脚本用 textContent 实时更新
 * 勾选态与预览(不用 innerHTML)。与 slug-input.ts 的共享点是 SLUG_MAX_LENGTH
 * 与那几个纯函数(sanitizeSlug/slugIssues/slugHint,由脚本内联);RULES 的**展示
 * 文案**在本文件,因为它是 UI 层措辞,与校验逻辑解耦。
 */

export interface SlugFormInput {
  rootDomain: string;
}

/** 规则清单(zh)。与 slug-input.ts 的 slugIssues 一一对应。 */
const RULES: { id: string; label: string }[] = [
  { id: "chars", label: "小写字母、数字、连字符" },
  { id: "edge", label: "不以连字符开头或结尾" },
  { id: "len", label: `1 到 ${SLUG_MAX_LENGTH} 个字符` },
  { id: "free", label: "尚未被占用" },
];

export function slugFormHtml(input: SlugFormInput): string {
  const domain = esc(input.rootDomain);
  const rules = RULES.map(
    (r) =>
      `<li class="rule" data-rule="${r.id}"><span class="rule-mark" aria-hidden="true">○</span><span class="rule-label">${r.label}</span></li>`,
  ).join("");
  return `<p class="sub">你已开通，还差最后一步：选择你的专属访问地址。</p>
<div class="panel">
<p class="step">选择专属地址</p>
<p class="lead">给你的实例起个名字</p>
<p class="lead-sub">这是你以后访问它的永久地址。选定后不可更改、永久保留（到期也不会被别人拿走）。</p>
<div class="slug-preview" id="slug-preview" aria-live="polite">
  <span class="preview-name" id="preview-name">你的名字</span>
  <span class="preview-tail">https://<span id="preview-tail-name"></span>.${domain}</span>
</div>
<form id="slug-form" action="#" method="post" novalidate>
<div class="slug-inputwrap">
  <input id="slug" name="slug" type="text" placeholder="yourname" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="${SLUG_MAX_LENGTH}" inputmode="latin" aria-label="专属地址前缀" aria-describedby="slug-msg" aria-invalid="false">
  <span class="slug-state" id="slug-state" aria-hidden="true"></span>
</div>
<p class="slug-count" id="slug-count" aria-hidden="true">0 / ${SLUG_MAX_LENGTH}</p>
<p class="msg" id="slug-msg" role="status"></p>
<ul class="slug-rules" id="slug-rules">${rules}</ul>
<p class="slug-suggest" id="slug-suggest" hidden>
  <span class="suggest-label">已被占用，试试：</span>
</p>
<button class="btn" id="provision" type="submit" disabled>开通</button>
<p class="msg err" id="prov-msg" role="alert" hidden></p>
</form>
</div>`;
}

export const SLUG_FORM_CSS = `
.slug-preview{display:flex;flex-direction:column;gap:3px;padding:13px 14px;background:var(--bg-raised,#1f1f1f);border:1px dashed #333;border-radius:12px;margin:14px 0 16px;overflow-wrap:break-word;line-height:1.5}
.slug-preview .preview-name{font-family:var(--mono);font-size:17px;color:var(--text-muted,#b3b3b3);font-style:italic;word-break:break-all}
.slug-preview .preview-tail{font-family:var(--mono);font-size:12px;color:#5a5a5a;word-break:break-all}
.slug-preview .preview-name{color:var(--text-muted,#b3b3b3);font-style:italic}
.slug-preview.filled .preview-name{color:var(--accent,#1ed760);font-style:normal;font-weight:700}
.slug-preview.ok{border-style:solid;border-color:var(--accent,#1ed760)}
#slug-form{margin:0}
.slug-inputwrap{position:relative;display:flex;align-items:center}
.slug-inputwrap input{flex:1;min-width:0;font-family:var(--mono);font-size:15px;padding:13px 40px 13px 14px;border:1px solid var(--border,#4d4d4d);border-radius:12px;background:var(--bg-raised,#1f1f1f);color:var(--text,#fff);transition:border-color .15s ease,box-shadow .15s ease}
.slug-inputwrap input::placeholder{color:#6b6b6b}
.slug-inputwrap input:focus{outline:none;border-color:var(--accent,#1ed760);box-shadow:0 0 0 3px rgba(30,215,96,.18)}
.slug-inputwrap input.ok{border-color:var(--accent,#1ed760)}
.slug-inputwrap input.bad{border-color:var(--err,#f3727f)}
.slug-state{position:absolute;right:13px;font-size:15px;pointer-events:none}
.slug-state.spin{display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,.2);border-top-color:var(--accent,#1ed760);border-radius:50%;animation:slugspin .7s linear infinite}
@keyframes slugspin{to{transform:rotate(360deg)}}
.slug-state.ok{color:var(--accent,#1ed760)}
.slug-state.bad{color:var(--err,#f3727f)}
.slug-count{font-family:var(--mono);font-size:11px;color:#6b6b6b;text-align:right;margin:6px 2px 0}
.slug-count.over{color:var(--err,#f3727f)}
.msg{font-size:.9rem;margin:10px 0 0;color:var(--text-muted,#b3b3b3)}
.msg.err{color:var(--err,#f3727f)}
.msg.ok{color:var(--accent,#1ed760)}
.slug-rules{list-style:none;padding:0;margin:12px 0 0;display:grid;grid-template-columns:1fr 1fr;gap:6px 16px}
.slug-rules .rule{display:flex;align-items:center;gap:7px;font-size:12px;color:#9a9a9a}
.slug-rules .rule-mark{font-size:11px;width:14px;text-align:center;flex:none}
.slug-rules .rule.pass{color:var(--accent,#1ed760)}
.slug-suggest{margin:12px 0 0}
.suggest-label{font-size:12px;color:#9a9a9a}
.slug-suggest .chip{display:inline-block;font-family:var(--mono);font-size:12px;padding:5px 11px;margin:6px 6px 0 0;border:1px solid var(--accent,#1ed760);border-radius:999px;color:var(--accent,#1ed760);background:none;cursor:pointer}
.slug-suggest .chip:hover{background:rgba(30,215,96,.12)}
.slug-suggest .chip:focus-visible{outline:2px solid var(--accent,#1ed760);outline-offset:2px}
#provision{margin-top:18px;width:100%}
.btn:disabled{opacity:.55;cursor:default;transform:none}
[hidden]{display:none!important}
/* 移动端:小屏规则改单列,预览字号收缩,预览与输入框不再挤同一行。 */
@media (max-width:560px){
  .slug-rules{grid-template-columns:1fr}
  .slug-preview{font-size:13px;padding:11px 12px}
  .slug-inputwrap input{font-size:14px}
}
`;
