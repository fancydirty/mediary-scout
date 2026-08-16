import { describe, expect, it } from "vitest";
import { paymentSuccessPage } from "./payment-success-page.js";

describe("paymentSuccessPage (server-confirmed Alipay state)", () => {
  it("starts in a neutral confirmation state and is never indexable", () => {
    const html = paymentSuccessPage();
    expect(html).toContain("付款确认中");
    expect(html).toContain('name="robots" content="noindex"');
    expect(html).not.toContain("付款成功");
  });

  it("reads only our opaque order id and polls our session-bound status API", () => {
    const html = paymentSuccessPage();
    expect(html).toContain('URLSearchParams(location.search).get("order")');
    expect(html).toContain("/api/alipay/orders/");
    expect(html).toContain("/status");
    for (const untrusted of ["trade_status", "total_amount", "out_trade_no", "seller_id", "sign"]) {
      expect(html, `must not read ${untrusted}`).not.toContain(`.get("${untrusted}")`);
    }
  });

  it("renders the complete local state vocabulary and redirects only after fulfillment", () => {
    const html = paymentSuccessPage();
    for (const status of ["pending", "paid_unfulfilled", "fulfilled", "closed", "expired"]) {
      expect(html).toContain(status);
    }
    expect(html).toContain('window.location.href = "/console"');
    expect(html).toContain("付款已确认，正在开通权益");
  });

  it("provides manual console, retry, refund-policy, and support exits", () => {
    const html = paymentSuccessPage();
    expect(html).toContain('href="/console"');
    expect(html).toContain('href="/buy"');
    expect(html).toContain('href="/refund"');
    expect(html).toContain('href="/contact"');
  });

  it("aborts hung polling even when AbortSignal.timeout is unavailable", () => {
    const html = paymentSuccessPage();
    expect(html).toContain("new AbortController()");
    expect(html).toContain("controller.abort()");
    expect(html).toContain("clearTimeout(requestTimeout)");
    expect(html).not.toContain("? AbortSignal.timeout(8000) : undefined");
  });
});
