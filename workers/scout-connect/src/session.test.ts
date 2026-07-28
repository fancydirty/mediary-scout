import { describe, expect, it } from "vitest";
import {
  SESSION_COOKIE,
  buildSessionCookie,
  clearSessionCookie,
  parseSessionCookie,
  sessionCookieValue,
} from "./session.js";

const SECRET = "c".repeat(64);

describe("session cookie (魔法链接登录态)", () => {
  it("builds a Set-Cookie with HttpOnly, Secure, SameSite=Lax, Path=/", async () => {
    const cookie = await buildSessionCookie("act_123", { secret: SECRET, ttlMs: 3600_000 });
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toMatch(/Max-Age=\d+/);
  });

  it("round-trips: a cookie built for an account parses back to that account", async () => {
    const now = 1_800_000_000_000;
    const cookie = await buildSessionCookie("act_abc", { secret: SECRET, ttlMs: 3600_000, now });
    const value = sessionCookieValue(cookie);
    const parsed = await parseSessionCookie(
      `other=x; ${SESSION_COOKIE}=${value}; foo=bar`,
      { secret: SECRET, now: now + 1000 },
    );
    expect(parsed).toEqual({ ok: true, accountId: "act_abc" });
  });

  it("rejects an expired session", async () => {
    const now = 1_800_000_000_000;
    const cookie = await buildSessionCookie("act_abc", { secret: SECRET, ttlMs: 1000, now });
    const value = sessionCookieValue(cookie);
    const parsed = await parseSessionCookie(`${SESSION_COOKIE}=${value}`, {
      secret: SECRET,
      now: now + 2000,
    });
    expect(parsed.ok).toBe(false);
  });

  it("rejects a forged session (wrong secret)", async () => {
    const cookie = await buildSessionCookie("act_abc", { secret: SECRET, ttlMs: 3600_000 });
    const value = sessionCookieValue(cookie);
    const parsed = await parseSessionCookie(`${SESSION_COOKIE}=${value}`, {
      secret: "d".repeat(64),
    });
    expect(parsed.ok).toBe(false);
  });

  it("returns not-authenticated when the cookie is absent", async () => {
    const parsed = await parseSessionCookie("other=x; foo=bar", { secret: SECRET });
    expect(parsed).toEqual({ ok: false, reason: "absent" });
  });

  it("returns not-authenticated for a null cookie header", async () => {
    const parsed = await parseSessionCookie(null, { secret: SECRET });
    expect(parsed).toEqual({ ok: false, reason: "absent" });
  });

  it("clearSessionCookie expires the cookie", () => {
    const cookie = clearSessionCookie();
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    expect(cookie).toContain("Max-Age=0");
  });
});
