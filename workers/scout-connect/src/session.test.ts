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

  it("uses the __Host- prefix, which no sibling subdomain can plant on the apex", async () => {
    // A <slug>.<root> page may set `Domain=<root>` cookies; browsers refuse that for
    // __Host- names, which must stay host-only, Secure and Path=/.
    expect(SESSION_COOKIE).toBe("__Host-mc_session");
    const cookie = await buildSessionCookie("act_123", { secret: SECRET, ttlMs: 3600_000 });
    expect(cookie.startsWith("__Host-mc_session=")).toBe(true);
    expect(cookie).not.toMatch(/domain=/i);
    expect(clearSessionCookie().startsWith("__Host-mc_session=;")).toBe(true);
  });

  it("ignores a plain mc_session cookie even when the browser lists it first", async () => {
    // Chrome sends a sibling's `mc_session=…; Domain=<root>; Path=/api` ahead of the
    // apex's own cookie on /api requests.
    const now = 1_800_000_000_000;
    const victim = sessionCookieValue(await buildSessionCookie("act_victim", { secret: SECRET, ttlMs: 3600_000, now }));
    const planted = sessionCookieValue(await buildSessionCookie("act_attacker", { secret: SECRET, ttlMs: 3600_000, now }));
    const parsed = await parseSessionCookie(`mc_session=${planted}; ${SESSION_COOKIE}=${victim}`, {
      secret: SECRET,
      now: now + 1000,
    });
    expect(parsed).toEqual({ ok: true, accountId: "act_victim" });
    const plantedOnly = await parseSessionCookie(`mc_session=${planted}`, { secret: SECRET, now: now + 1000 });
    expect(plantedOnly).toEqual({ ok: false, reason: "absent" });
  });

  it("clearSessionCookie expires the cookie", () => {
    const cookie = clearSessionCookie();
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    expect(cookie).toContain("Max-Age=0");
  });
});
