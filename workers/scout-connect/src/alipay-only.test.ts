import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { COMPLIANCE_MARKDOWN } from "./html/compliance-content.gen.js";

const workerRoot = resolve(import.meta.dirname, "..");
const activeFiles = [
  "README.md",
  "src/env.ts",
  "src/index.ts",
  "src/routes.ts",
  "src/http.ts",
  "src/html/buy-page.ts",
  "src/html/payment-success-page.ts",
  "src/html/console-page.ts",
  "src/html/home-page.ts",
  "src/html/compliance-page.ts",
  "src/content/pricing.md",
  "src/content/refund.md",
  "src/content/terms.md",
  "src/content/privacy.md",
  "src/content/contact.md",
  "scripts/deploy.sh",
  "wrangler.jsonc",
] as const;

describe("Alipay-only active checkout tree", () => {
  it("contains no active Paddle route, config, SDK, or merchant-of-record copy", () => {
    const active = activeFiles
      .map((file) => `${file}\n${readFileSync(resolve(workerRoot, file), "utf8")}`)
      .join("\n");
    expect(active).not.toMatch(
      /PADDLE_|Paddle\.Checkout|cdn\.paddle\.com|\/api\/paddle\/webhook|Merchant of Record/,
    );
  });

  it("has no Paddle runtime modules or route tests", () => {
    for (const file of [
      "src/paddle-api.ts",
      "src/paddle-event.ts",
      "src/paddle-signature.ts",
      "src/paddle-checkout.test.ts",
      "src/paddle-webhook.test.ts",
    ]) {
      expect(existsSync(resolve(workerRoot, file)), file).toBe(false);
    }
  });

  it("describes Alipay as the only checkout processor", () => {
    expect(COMPLIANCE_MARKDOWN.pricing).toContain("支付宝");
    expect(COMPLIANCE_MARKDOWN.pricing).not.toContain("Paddle");
    expect(COMPLIANCE_MARKDOWN.terms).not.toContain("Merchant of Record");
    expect(COMPLIANCE_MARKDOWN.refund).toContain("原支付宝订单号或交易号");
  });

  it("preflights remote Alipay secrets and D1 schema before changing production traffic", () => {
    const deploy = readFileSync(resolve(workerRoot, "scripts/deploy.sh"), "utf8");
    const deployAt = deploy.indexOf("npx wrangler deploy");
    expect(deployAt).toBeGreaterThan(0);
    for (const marker of [
      "wrangler secret list",
      "ALIPAY_APP_ID",
      "ALIPAY_PRIVATE_KEY",
      "ALIPAY_ALIPAY_PUBLIC_KEY",
      "ALIPAY_SELLER_ID",
      "payment_orders",
      "payment_provider",
      "refund_request_no",
    ]) {
      const markerAt = deploy.indexOf(marker);
      expect(markerAt, marker).toBeGreaterThan(0);
      expect(markerAt, marker).toBeLessThan(deployAt);
    }
  });
});
