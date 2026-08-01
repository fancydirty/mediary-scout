import { describe, expect, it } from "vitest";
import { paymentSuccessPage } from "./payment-success-page";

describe("payment-success-page", () => {
  it("包含 noindex meta 标签", () => {
    const html = paymentSuccessPage();
    expect(html).toContain('name="robots"');
    expect(html).toContain('content="noindex"');
  });

  it("标题是「付款确认中」而非「支付成功」", () => {
    const html = paymentSuccessPage();
    expect(html).toContain("<title>付款确认中 · Mediary Connect</title>");
  });

  it("包含延迟捕获提示「最多约 10 分钟」", () => {
    const html = paymentSuccessPage();
    expect(html).toContain("最多约 10 分钟");
  });

  it("包含进入控制台的 CTA 链接", () => {
    const html = paymentSuccessPage();
    expect(html).toContain('href="/console"');
  });

  it("正文断言使用「付款已完成」而非「支付成功」", () => {
    const html = paymentSuccessPage();
    expect(html).toContain("付款已完成");
    expect(html).not.toContain("支付成功");
  });

  it("SVG 图标带 aria-hidden 提升无障碍语义", () => {
    const html = paymentSuccessPage();
    expect(html).toContain('aria-hidden="true"');
  });
});
