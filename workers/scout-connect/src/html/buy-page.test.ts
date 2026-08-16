import { describe, expect, it } from "vitest";
import { createMemoryConnectDb } from "../db.js";
import { handleRequest } from "../routes.js";
import { buyPage } from "./buy-page.js";

describe("buyPage (Alipay-only)", () => {
  it("renders all unchanged tiers and only the Alipay checkout path", () => {
    const html = buyPage({ alipayConfigured: true });
    for (const text of ["支付宝支付", "¥45", "¥108", "¥188", "3 个月", "12 个月", "24 个月"]) {
      expect(html).toContain(text);
    }
    expect(html).toContain("/api/alipay/checkout");
    expect(html).toContain("checkout_url");
    expect(html).not.toContain("total_amount");
    expect(html).not.toContain("Paddle");
    expect(html).not.toContain("paddle.com");
  });

  it("only submits a tier id and follows the same-origin checkout URL", () => {
    const html = buyPage({ alipayConfigured: true });
    expect(html).toMatch(/JSON\.stringify\(\{\s*tier:\s*tier\s*\}\)/);
    expect(html).toMatch(/location\.href\s*=\s*data\.checkout_url/);
  });

  it("fails visibly and disables purchase when server-side Alipay is not configured", () => {
    const html = buyPage({ alipayConfigured: false });
    expect(html).toContain("支付宝结账暂未开放");
    expect(html).toContain("disabled");
    expect(html).not.toContain('fetch("/api/alipay/checkout"');
  });

  it("is noindex, works without JavaScript messaging, and links to policies/support", () => {
    const html = buyPage({ alipayConfigured: true });
    expect(html).toContain('name="robots" content="noindex"');
    expect(html).toContain("<noscript>");
    expect(html).toContain('href="/refund"');
    expect(html).toContain('href="/contact"');
  });
});

describe("Alipay checkout CSP", () => {
  const deps = {
    db: createMemoryConnectDb(),
    cf: {} as never,
    adminToken: "admin",
    rootDomain: "mediaryconnect.app",
    now: () => "2026-08-16T08:00:00.000Z",
    alipayApi: { pagePayForm: async () => "" },
  } as never;

  it("/buy keeps a first-party-only policy and contains no Paddle allowlist", async () => {
    const response = await handleRequest(new Request("https://mediaryconnect.app/buy"), deps);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).not.toContain("paddle.com");
    expect(csp).toContain("form-action 'self'");
  });

  it("ordinary pages do not gain the Alipay form-action exception", async () => {
    for (const path of ["/", "/terms", "/refund"]) {
      const response = await handleRequest(new Request(`https://mediaryconnect.app${path}`), deps);
      const csp = response.headers.get("content-security-policy") ?? "";
      expect(csp, path).not.toContain("form-action https://openapi.alipay.com");
    }
  });
});
