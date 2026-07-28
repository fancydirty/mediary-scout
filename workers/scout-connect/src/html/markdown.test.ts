import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown.js";

// 极小 Markdown 渲染器：只支持合规页面实际用到的子集
// （h1/h2/h3、段落、无序列表、链接、粗体、行内代码、hr）。
// 刻意不支持 HTML 透传——.md 里的尖括号必须被转义，
// 这样内容文件永远不可能变成 XSS 注入面。
describe("renderMarkdown", () => {
  it("renders headings h1-h3", () => {
    const html = renderMarkdown("# Title One\n\n## Title Two\n\n### Title Three");
    expect(html).toContain("<h1>Title One</h1>");
    expect(html).toContain("<h2>Title Two</h2>");
    expect(html).toContain("<h3>Title Three</h3>");
  });

  it("renders paragraphs and unordered lists (CJK blocks carry the zh class)", () => {
    const html = renderMarkdown("第一段。\n\n- 甲\n- 乙\n\n第二段。");
    expect(html).toContain('<p class="zh">第一段。</p>');
    expect(html).toContain('<ul class="zh">');
    expect(html).toContain("<li>甲</li>");
    expect(html).toContain("<li>乙</li>");
    expect(html).toContain('<p class="zh">第二段。</p>');
  });

  it("renders links, bold and inline code (English block stays unclassed)", () => {
    const html = renderMarkdown("See [Paddle](https://paddle.com) with **bold** and `code`.");
    expect(html).toContain('<a href="https://paddle.com">Paddle</a>');
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<p>See");
  });

  it("escapes raw HTML — content files can never become an XSS surface", () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=y>');
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes HTML inside link text and href, and rejects non-http(s) hrefs", () => {
    // javascript: 协议链接不能生成 <a>——降级为纯文本。
    const html = renderMarkdown("[x](javascript:alert(1))");
    expect(html).not.toContain("<a ");
    expect(html).toContain("x");
    const html2 = renderMarkdown('[<b>y</b>](https://ok.example/?a=1&b=2)');
    expect(html2).toContain("&lt;b&gt;y&lt;/b&gt;");
    expect(html2).toContain('href="https://ok.example/?a=1&amp;b=2"');
  });

  it("does not process markdown syntax inside code spans", () => {
    // `[x](https://a)` 里的链接语法必须原样呈现——code 的意义就是字面量。
    const html = renderMarkdown("用 `[x](https://a.example)` 与 `**bold**` 语法。");
    expect(html).toContain("<code>[x](https://a.example)</code>");
    expect(html).toContain("<code>**bold**</code>");
    expect(html).not.toContain("<code><a");
    expect(html).not.toContain("<code><strong>");
  });

  it("renders hr", () => {
    expect(renderMarkdown("上\n\n---\n\n下")).toContain("<hr>");
  });

  it("tags CJK-majority blocks with class=zh for the bilingual (EN-above-中文) layout", () => {
    // 英文主、中文次：中文块自动加 .zh，模板据此渲成略暗的次级色。
    const html = renderMarkdown(
      "Full refund within 14 days.\n\n自付款起 14 天内可全额退款。",
    );
    expect(html).toContain("<p>Full refund within 14 days.</p>");
    expect(html).toContain('<p class="zh">自付款起 14 天内可全额退款。</p>');
  });

  it("tags CJK headings and list items too", () => {
    const html = renderMarkdown("## How to request\n\n## 如何申请\n\n- English item\n\n- 中文条目");
    expect(html).toContain("<h2>How to request</h2>");
    expect(html).toContain('<h2 class="zh">如何申请</h2>');
    expect(html).toContain('<ul class="zh"><li>中文条目</li></ul>');
    expect(html).toContain("<ul><li>English item</li></ul>");
  });
});
