/**
 * 极小 Markdown 渲染器,专供合规页面(条款/隐私/退款/定价/联系)。
 *
 * 只支持这些页面实际用到的子集:h1-h3、段落、无序列表、链接、粗体、
 * 行内代码、hr。**刻意不支持 HTML 透传**:.md 内容里的一切尖括号都被
 * 转义,内容文件永远不可能成为 XSS 注入面——即便未来有人把不可信文本
 * 粘进 .md。链接 href 只放行 http(s),`javascript:` 一类协议降级为纯文本。
 *
 * 为什么不用现成库:worker 的合规页面是构建期就固定的静态内容,
 * 引一个完整 Markdown 库(及其解析器攻击面)不值得;而手写模板字符串
 * 写长法律文本又不可维护。这个 60 行的子集是两者之间的甜点。
 */

import { isZhBlock } from "./lang-split.js";

const ESCAPE_RE = /[&<>"']/g;
const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(text: string): string {
  return text.replace(ESCAPE_RE, (ch) => ESCAPES[ch] ?? ch);
}

/** 行内元素:先整体转义,再在转义后的文本上做受控替换。
 *  顺序:code(内部不再处理)→ 链接 → 粗体。 */
function renderInline(raw: string): string {
  const escaped = escapeHtml(raw);
  // code span 先摘出为占位符：code 的意义就是字面量，链接/粗体语法在
  // 其内部必须原样呈现（round 1 评审抓到占位前的实现会继续处理内部）。
  // 占位符用 \u0000 包裹索引——escapeHtml 之后的文本里不可能自然出现 NUL。
  const codes: string[] = [];
  let out = escaped.replace(/`([^`]+)`/g, (_m, code: string) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });
  // [text](href) — href 只放行 http(s);其余整体降级为纯文本(去掉语法糖)。
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text: string, href: string) => {
    if (/^https?:\/\//i.test(href)) {
      return `<a href="${href}">${text}</a>`;
    }
    return text;
  });
  // **bold**
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // 还原 code span
  out = out.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => `<code>${codes[Number(i)]}</code>`);
  return out;
}

export function renderMarkdown(md: string): string {
  const blocks = md.replace(/\r\n/g, "\n").split(/\n{2,}/);
  const html: string[] = [];
  for (const block of blocks) {
    const trimmed = block.trim();
    if (trimmed === "") continue;
    if (trimmed === "---") {
      html.push("<hr>");
      continue;
    }
    // 双语版式(英文主、中文次):CJK 占多数的块自动加 class="zh"(渲成略暗
    // 次级色)+ lang="zh-Hans"(文档是 lang="en",给屏幕阅读器/分词正确的
    // 发音与断句提示)。作者只需先写英文块、再写中文块,"EN above 中文"
    // 自然成立,无需发明新语法。attr 只在中文块出现,英文块保持原样。
    const zh = isZhBlock(trimmed) ? ' class="zh" lang="zh-Hans"' : "";
    const heading = /^(#{1,3})\s+(.+)$/.exec(trimmed);
    if (heading) {
      const level = heading[1]!.length;
      html.push(`<h${level}${zh}>${renderInline(heading[2]!)}</h${level}>`);
      continue;
    }
    const lines = trimmed.split("\n");
    if (lines.every((l) => /^-\s+/.test(l))) {
      const items = lines
        .map((l) => `<li>${renderInline(l.replace(/^-\s+/, ""))}</li>`)
        .join("");
      html.push(`<ul${zh}>${items}</ul>`);
      continue;
    }
    html.push(`<p${zh}>${renderInline(lines.join(" "))}</p>`);
  }
  return html.join("\n");
}

