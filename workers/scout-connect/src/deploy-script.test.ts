import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const deployScript = readFileSync(new URL("../scripts/deploy.sh", import.meta.url), "utf8");

describe("deploy cutover guard", () => {
  it("checks for unexpired payable legacy Alipay orders before deploy", () => {
    expect(deployScript).toMatch(/SELECT COUNT\(\*\).*payment_orders/s);
    expect(deployScript).toContain("provider = 'alipay'");
    expect(deployScript).toContain("status IN ('created','form_issued','pending')");
    expect(deployScript).toContain("expires_at >");
    expect(deployScript).toContain("本次发布移除了支付宝 notify/query 路由");
  });

  it("also blocks on paid-but-unfulfilled legacy Alipay orders, whatever their expiry", () => {
    // The old flow stored `paid` before granting time and relied on notify/query retries to finish;
    // this release removes those routes, so such an order would be stranded.
    expect(deployScript).toContain(
      "provider = 'alipay' AND (status = 'paid' OR (status IN ('created','form_issued','pending') AND expires_at > '$NOW_ISO'))",
    );
    expect(deployScript).toContain("已付款未开通");
  });
});
