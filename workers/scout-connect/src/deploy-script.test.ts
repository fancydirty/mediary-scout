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
});
