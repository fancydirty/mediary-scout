import { describe, expect, it, vi } from "vitest";
import { handleRequest, type RouteDeps } from "./routes.js";
import { createMemoryConnectDb } from "./db.js";
import { SESSION_COOKIE, sessionCookieValue } from "./session.js";

const BASE = "https://mediaryconnect.app";
const SESSION_SECRET = "e".repeat(64);

function setup(overrides: Partial<RouteDeps> = {}): { deps: RouteDeps; sent: Array<{ to: string; url: string }> } {
  const db = createMemoryConnectDb();
  const sent: Array<{ to: string; url: string }> = [];
  const deps: RouteDeps = {
    db,
    cf: {} as never,
    adminToken: "admin-tok",
    rootDomain: "mediaryconnect.app",
    tokenWrapKeyHex: "a".repeat(64),
    now: () => "2026-07-28T00:00:00.000Z",
    newInviteId: () => "inv_x",
    newEndpointId: () => "ep_x",
    newAuditId: () => "aud_x",
    newInviteCode: () => "code_x",
    newAccountId: () => "act_new",
    newEntitlementId: () => "ent_new",
    sessionSecret: SESSION_SECRET,
    sendMagicLink: async (to: string, url: string) => {
      sent.push({ to, url });
    },
    ...overrides,
  };
  return { deps, sent };
}

describe("POST /api/auth/magic (魔法链接请求)", () => {
  it("always returns 202 and does not reveal whether the email exists", async () => {
    const { deps, sent } = setup();
    const res = await handleRequest(
      new Request(`${BASE}/api/auth/magic`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "nobody@example.com" }),
      }),
      deps,
    );
    expect(res.status).toBe(202);
    // 即使邮箱不存在也发信(注册即登录):不泄露邮箱是否已注册。
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("nobody@example.com");
    expect(sent[0]!.url).toContain("/auth/callback?t=");
  });

  it("rejects an invalid email with 400", async () => {
    const { deps, sent } = setup();
    const res = await handleRequest(
      new Request(`${BASE}/api/auth/magic`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "not-an-email" }),
      }),
      deps,
    );
    expect(res.status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  it("normalizes email to lowercase before signing the link", async () => {
    const { deps, sent } = setup();
    await handleRequest(
      new Request(`${BASE}/api/auth/magic`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "  MixedCase@Example.COM  " }),
      }),
      deps,
    );
    expect(sent[0]!.to).toBe("mixedcase@example.com");
  });
});

describe("POST /api/auth/magic Turnstile gate", () => {
  it("gate on + missing token → 400, no email sent", async () => {
    const { deps, sent } = setup({
      turnstileSitekey: "0x4AAAAAAD-test",
      turnstileSecret: "secret-fixture",
    });
    const res = await handleRequest(
      new Request(`${BASE}/api/auth/magic`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "a@example.com" }),
      }),
      deps,
    );
    expect(res.status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  it("gate off (no turnstile config) → no token required, email sent", async () => {
    const { deps, sent } = setup();
    const res = await handleRequest(
      new Request(`${BASE}/api/auth/magic`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "a@example.com" }),
      }),
      deps,
    );
    expect(res.status).toBe(202);
    expect(sent).toHaveLength(1);
  });
});

describe("GET /auth/callback (魔法链接落地)", () => {
  it("valid token → creates account on first login, sets session cookie, 302 to /console", async () => {
    const { deps } = setup();
    // 先请求一个魔法链接拿到真实 token
    const captured: string[] = [];
    deps.sendMagicLink = async (_to, url) => {
      captured.push(new URL(url).searchParams.get("t")!);
    };
    await handleRequest(
      new Request(`${BASE}/api/auth/magic`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "alice@example.com" }),
      }),
      deps,
    );
    const token = captured[0]!;
    const res = await handleRequest(
      new Request(`${BASE}/auth/callback?t=${encodeURIComponent(token)}`),
      deps,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/console");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${SESSION_COOKIE}=`);
    expect(sessionCookieValue(setCookie).length).toBeGreaterThan(0);
    // 账号被创建了
    const acct = await deps.db.getAccountByEmail("alice@example.com");
    expect(acct).not.toBeNull();
  });

  it("second login for the same email reuses the account (no duplicate)", async () => {
    const { deps } = setup();
    await deps.db.insertAccount({
      id: "act_existing",
      email: "bob@example.com",
      paddle_customer_id: null,
      created_at: "2026-01-01T00:00:00.000Z",
      last_login_at: null,
    });
    const captured: string[] = [];
    deps.sendMagicLink = async (_to, url) => {
      captured.push(new URL(url).searchParams.get("t")!);
    };
    await handleRequest(
      new Request(`${BASE}/api/auth/magic`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "bob@example.com" }),
      }),
      deps,
    );
    const res = await handleRequest(
      new Request(`${BASE}/auth/callback?t=${encodeURIComponent(captured[0]!)}`),
      deps,
    );
    expect(res.status).toBe(302);
    const acct = await deps.db.getAccountByEmail("bob@example.com");
    expect(acct!.id).toBe("act_existing"); // 复用,没有新建
  });

  it("expired/forged token → 400, no session", async () => {
    const { deps } = setup();
    const res = await handleRequest(
      new Request(`${BASE}/auth/callback?t=garbage.token.here.x`),
      deps,
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("a session cookie (login purpose) cannot be replayed as a magic-link token", async () => {
    // 用 session cookie 的值当 callback token → 应被 purpose 校验挡下
    // (callback 期望 purpose=magic，session 是 purpose=login)。
    const { deps } = setup();
    const captured: string[] = [];
    deps.sendMagicLink = async (_to, url) => { captured.push(new URL(url).searchParams.get("t")!); };
    await handleRequest(
      new Request(`${BASE}/api/auth/magic`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "carol@example.com" }),
      }),
      deps,
    );
    // 先正常登录拿到 session
    const login = await handleRequest(
      new Request(`${BASE}/auth/callback?t=${encodeURIComponent(captured[0]!)}`),
      deps,
    );
    const sessionValue = sessionCookieValue(login.headers.get("set-cookie") ?? "");
    // 拿 session 值当 magic token 回放
    const replay = await handleRequest(
      new Request(`${BASE}/auth/callback?t=${encodeURIComponent(sessionValue)}`),
      deps,
    );
    expect(replay.status).toBe(400);
  });
});
