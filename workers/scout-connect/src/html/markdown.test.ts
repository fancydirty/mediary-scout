import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown.js";

// 极小 Markdown 渲染器：只支持合规页面实际用到的子集
// （h1/h2/h3、段落、无序列表、链接、粗体、行内代码、hr）。
// 刻意不支持 HTML 透传——.md 里的尖括号必须被转义，
// 这样内容文件永远不可能变成 XSS 注入面。
describe("renderMarkdown", () => {
  it("renders headings h1-h3", () => {
    const html = renderMarkdown("# 标题一\n\n## 标题二\n\n### 标题三");
    expect(html).toContain("<h1>标题一</h1>");
    expect(html).toContain("<h2>标题二</h2>");
    expect(html).toContain("<h3>标题三</h3>");
  });

  it("renders paragraphs and unordered lists", () => {
    const html = renderMarkdown("第一段。\n\n- 甲\n- 乙\n\n第二段。");
    expect(html).toContain("<p>第一段。</p>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>甲</li>");
    expect(html).toContain("<li>乙</li>");
    expect(html).toContain("<p>第二段。</p>");
  });

  it("renders links, bold and inline code", () => {
    const html = renderMarkdown("看 [Paddle](https://paddle.com) 与 **重点** 与 `code`。");
    expect(html).toContain('<a href="https://paddle.com">Paddle</a>');
    expect(html).toContain("<strong>重点</strong>");
    expect(html).toContain("<code>code</code>");
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
});
