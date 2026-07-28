import { describe, expect, it } from "vitest";
import { loginPage } from "./login-page.js";

describe("login page", () => {
  it("is a full dark-themed document with brand bar and favicon", () => {
    const html = loginPage();
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("<title>登录 · Mediary Connect</title>");
    expect(html).toContain("--accent:#1ed760");
    expect(html).toContain("color-scheme:dark");
    expect(html).toContain("CONNECT");
    expect(html).toContain('rel="icon"');
  });

  it("posts to the magic-link endpoint", () => {
    expect(loginPage()).toContain('"/api/auth/magic"');
  });

  it("renders a dark-themed Turnstile widget only when a sitekey is configured", () => {
    const gated = loginPage("0x4AAAAAAD-test_key");
    // widget div (not the always-present .cf-turnstile CSS rule)
    expect(gated).toContain('data-sitekey="0x4AAAAAAD-test_key"');
    expect(gated).toContain('data-theme="dark"');
    expect(gated).toContain("challenges.cloudflare.com");

    const ungated = loginPage();
    expect(ungated).not.toContain("data-sitekey");
    expect(ungated).not.toContain("challenges.cloudflare.com");
  });

  it("normalizes a malformed sitekey to no widget (fail-safe, matches the gate)", () => {
    const html = loginPage('bad"key<inject>');
    expect(html).not.toContain("data-sitekey");
    expect(html).not.toContain("inject");
  });
});
