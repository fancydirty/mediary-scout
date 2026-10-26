import { describe, expect, it } from "vitest";
import { GuangYaDeviceLogin } from "../src/guangya-device-login.js";

// Shapes captured from the real account.guangyapan.com on 2026-10-26.
const STARTED = {
  device_code: "AWrfX1LNTjspJfaJ-kFqU8valueForTests0",
  user_code: "AWrfX1If1brfzKolrA",
  expires_in: 120,
  interval: 2,
  verification_url:
    "https://account.guangyapan.com/__/auth/device/?client_id=aMe-8VSlkrbQXpUR&scope=user%20profile%20sso%20offline",
};

const PENDING = {
  error: "authorization_pending",
  error_code: 4050,
  error_description: "Precondition Required",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function client(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const login = new GuangYaDeviceLogin({
    fetchImpl: async (url, init) => {
      calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
      return handler(url, init);
    },
  });
  return { login, calls };
}

describe("GuangYaDeviceLogin.start", () => {
  it("mints a session from the real response shape", async () => {
    const { login } = client(() => jsonResponse(STARTED));
    const code = await login.start();
    expect(code.deviceCode).toBe(STARTED.device_code);
    expect(code.userCode).toBe(STARTED.user_code);
    expect(code.verificationUrl).toBe(STARTED.verification_url);
    expect(code.expiresIn).toBe(120);
    expect(code.interval).toBe(2);
  });

  // Regression pin for a live 403: sending ANY scope (including "*" and "user")
  // makes the server answer `permission_denied` (7). Omitting it yields the
  // default scopes. A well-meaning "let's be explicit about scope" edit breaks
  // login entirely, so pin the absence.
  it("does not send a scope", async () => {
    const { login, calls } = client(() => jsonResponse(STARTED));
    await login.start();
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body).not.toHaveProperty("scope");
    expect(body["client_id"]).toBeTruthy();
  });

  it("throws with the upstream reason when the server refuses", async () => {
    const { login } = client(() =>
      jsonResponse({ error: "permission_denied", error_description: "client not have scope openid permission" }, 403),
    );
    await expect(login.start()).rejects.toThrow(/permission_denied|scope openid/);
  });

  // OAuth errors often carry only `error`, no `error_description`. Without this
  // fallback the message degrades to a bare "HTTP 403" and the real reason is lost
  // — which is exactly how the scope misconfiguration looked when I hit it.
  it("keeps the OAuth error code when error_description is absent", async () => {
    const { login } = client(() => jsonResponse({ error: "permission_denied" }, 403));
    await expect(login.start()).rejects.toThrow(/permission_denied/);
  });

  // A non-positive expires_in/interval must fall back to the defaults: 0 would
  // time the session out instantly, and a 0 interval would spin the poll loop.
  it.each([
    [{ ...STARTED, expires_in: 0, interval: 0 }],
    [{ ...STARTED, expires_in: -5, interval: -1 }],
  ])("falls back to sane defaults for non-positive timing (%#)", async (body) => {
    const { login } = client(() => jsonResponse(body));
    const code = await login.start();
    expect(code.expiresIn).toBe(120);
    expect(code.interval).toBe(2);
  });

  it("throws when the response is 200 but missing fields", async () => {
    const { login } = client(() => jsonResponse({ device_code: "x" }));
    await expect(login.start()).rejects.toThrow(/GUANGYA_DEVICE_CODE_FAILED/);
  });
});

describe("GuangYaDeviceLogin.poll", () => {
  it("reports pending for authorization_pending", async () => {
    const { login } = client(() => jsonResponse(PENDING, 400));
    expect(await login.poll("dc")).toEqual({ status: "pending" });
  });

  // slow_down is RFC 8628's "you are polling too fast" — it means KEEP WAITING.
  // Treating it as an error would abort a login that is about to succeed.
  it("reports pending for slow_down", async () => {
    const { login } = client(() =>
      jsonResponse({ error: "slow_down", error_description: "Too many requests" }, 400),
    );
    expect(await login.poll("dc")).toEqual({ status: "pending" });
  });

  it.each(["expired_token", "access_denied"])("reports expired for %s", async (error) => {
    const { login } = client(() => jsonResponse({ error }, 400));
    expect(await login.poll("dc")).toEqual({ status: "expired" });
  });

  it("returns both tokens on success", async () => {
    const { login } = client(() =>
      jsonResponse({
        token_type: "Bearer",
        access_token: "at-812-chars",
        refresh_token: "rt-66-chars",
        expires_in: 3600,
        sub: "aj6Qo5l86EF4O2AM",
      }),
    );
    const result = await login.poll("dc");
    expect(result).toEqual({
      status: "confirmed",
      accessToken: "at-812-chars",
      refreshToken: "rt-66-chars",
    });
  });

  it("uses the device_code grant type", async () => {
    const { login, calls } = client(() => jsonResponse({ error: "authorization_pending" }, 400));
    await login.poll("dc-123");
    const body = calls[0]!.body as Record<string, unknown>;
    expect(body["grant_type"]).toBe("urn:ietf:params:oauth:grant-type:device_code");
    expect(body["device_code"]).toBe("dc-123");
  });

  it("treats a 200 with no tokens as a failure, not a confirmation", async () => {
    const { login } = client(() => jsonResponse({ ok: true }));
    await expect(login.poll("dc")).rejects.toThrow(/missing tokens/);
  });

  it("surfaces unknown errors instead of swallowing them", async () => {
    const { login } = client(() => jsonResponse({ error: "invalid_grant", error_description: "bad code" }, 400));
    await expect(login.poll("dc")).rejects.toThrow(/bad code/);
  });
});
