import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buyPage } from "./html/buy-page.js";

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

  it("refuses deployment until the 0008 instance-link tables exist", () => {
    expect(deployScript).toContain("SELECT id, poll_secret_sha256 FROM instance_link_requests LIMIT 0");
    expect(deployScript).toContain("SELECT id, credential_sha256 FROM instance_credentials LIMIT 0");
    expect(deployScript).toContain("尚未应用 0008-instance-links.sql");
    expect(deployScript).toContain("请先应用 0008");
  });

  it("refuses deployment until the 0009 revoke_reason column exists", () => {
    expect(deployScript).toContain("SELECT revoke_reason FROM endpoints LIMIT 0");
    expect(deployScript).toContain("尚未应用 0009-endpoint-revoke-reason.sql");
    expect(deployScript).toContain("请先应用 0009");
  });
});

describe("post-deploy /buy self-check", () => {
  // Run the script's own /buy checks against the real rendered pages. The open page's inline
  // script carries the 503 message too, so a text grep for it can never tell open from closed.
  function buyChecksPass(html: string): boolean {
    const start = deployScript.indexOf('if ! printf \'%s\' "$BUY" | grep -q "微信支付"');
    const end = deployScript.indexOf("WEBHOOK=$(");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    try {
      execFileSync("sh", ["-c", `set -eu\nBUY=$1\n${deployScript.slice(start, end)}`, "sh", html], { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  }

  it("passes the page served when Waffo is configured", () => {
    expect(buyChecksPass(buyPage({ waffoConfigured: true }))).toBe(true);
  });

  it("fails the page served when Waffo is not configured", () => {
    expect(buyChecksPass(buyPage({ waffoConfigured: false }))).toBe(false);
  });
});
