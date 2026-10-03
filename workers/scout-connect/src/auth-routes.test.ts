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
    sendInstanceLinkEmail: async () => {},
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

  it("normalizes a space-padded / mixed-case rootDomain in the magic link URL", async () => {
    const { deps, sent } = setup({ rootDomain: "  MediaryConnect.APP  " });
    await handleRequest(
      new Request(`${BASE}/api/auth/magic`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "a@example.com" }),
      }),
      deps,
    );
    expect(sent[0]!.url).toMatch(/^https:\/\/mediaryconnect\.app\/auth\/callback\?t=/);
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

/** 走一遍 /api/auth/magic,拿到真实的魔法链接 token。 */
async function magicToken(deps: RouteDeps, email: string): Promise<string> {
  const captured: string[] = [];
  const original = deps.sendMagicLink;
  deps.sendMagicLink = async (_to, url) => {
    captured.push(new URL(url).searchParams.get("t")!);
  };
  await handleRequest(
    new Request(`${BASE}/api/auth/magic`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    }),
    deps,
  );
  deps.sendMagicLink = original;
  return captured[0]!;
}

const SAME_ORIGIN = { origin: BASE, "sec-fetch-site": "same-origin" };

/** 确认页上的「继续登录」按钮发出的请求。 */
function confirmLogin(token: string, headers: Record<string, string> = SAME_ORIGIN): Request {
  return new Request(`${BASE}/auth/callback`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ t: token }),
  });
}

describe("魔法链接落地:GET 只显示确认页,本站页面 POST 才登录", () => {
  it("GET shows who is about to sign in and signs nobody in, even when another site sent the visitor", async () => {
    // Login CSRF: any page can navigate a visitor to /auth/callback?t=<its own token>.
    const { deps } = setup();
    const token = await magicToken(deps, "alice@example.com");
    const res = await handleRequest(
      new Request(`${BASE}/auth/callback?t=${encodeURIComponent(token)}`, {
        headers: { "sec-fetch-site": "cross-site" },
      }),
      deps,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("alice@example.com");
    // The page reads the token from the address bar; it is never written into the HTML.
    expect(body).not.toContain(token);
    expect(res.headers.get("set-cookie")).toBeNull();
    // magic token 在 ?t= query 里:页面不能经 Referer 把它带出去,也不能被缓存。
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await deps.db.getAccountByEmail("alice@example.com")).toBeNull();
  });

  it("HEAD does not set a cookie either", async () => {
    const { deps } = setup();
    const token = await magicToken(deps, "alice@example.com");
    const res = await handleRequest(
      new Request(`${BASE}/auth/callback?t=${encodeURIComponent(token)}`, { method: "HEAD" }),
      deps,
    );
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("POST from this origin creates the account on first login and sets the session cookie", async () => {
    const { deps } = setup();
    const token = await magicToken(deps, "alice@example.com");
    const res = await handleRequest(confirmLogin(token), deps);
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
    expect(sessionCookieValue(setCookie).length).toBeGreaterThan(0);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await deps.db.getAccountByEmail("alice@example.com")).not.toBeNull();
  });

  it("POST from another origin is refused without signing anyone in", async () => {
    const { deps } = setup();
    const token = await magicToken(deps, "alice@example.com");
    const res = await handleRequest(
      confirmLogin(token, { origin: "https://evil.mediaryconnect.app", "sec-fetch-site": "same-site" }),
      deps,
    );
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await deps.db.getAccountByEmail("alice@example.com")).toBeNull();
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
    const res = await handleRequest(confirmLogin(await magicToken(deps, "bob@example.com")), deps);
    expect(res.status).toBe(200);
    const acct = await deps.db.getAccountByEmail("bob@example.com");
    expect(acct!.id).toBe("act_existing"); // 复用,没有新建
  });

  it("concurrent first-login for same email does not 500 (race-safe upsert)", async () => {
    // 模拟并发:getAccountByEmail 恒返回 null(两个请求都以为要新建),
    // 但第二次 insertAccount 撞 UNIQUE。upsertAccount 应捕获后重读而非 500。
    const { deps } = setup();
    let insertCount = 0;
    const realInsert = deps.db.insertAccount.bind(deps.db);
    const stored: Record<string, unknown> = {};
    deps.db.getAccountByEmail = async (email: string) => {
      // 第一次读返回 null；被"对手"插入后（stored 有值）才返回。
      return (stored[email] as never) ?? null;
    };
    deps.db.insertAccount = async (row) => {
      insertCount += 1;
      if (insertCount === 1) {
        stored[row.email] = { ...row };
        return realInsert(row);
      }
      throw new Error("UNIQUE constraint failed: accounts.email");
    };
    // 第一次登录建号
    const first = await handleRequest(confirmLogin(await magicToken(deps, "race@example.com")), deps);
    expect(first.status).toBe(200);
    // 强制走"新建"分支：先让 getAccountByEmail 返回 null，
    // 再让 insert 抛 UNIQUE，但重读时（stored 已恢复）拿到行。
    const secondToken = await magicToken(deps, "race@example.com");
    let readCount = 0;
    deps.db.getAccountByEmail = async (email: string) => {
      readCount += 1;
      if (readCount === 1) return null; // 第一次读：以为要新建
      return (stored[email] as never) ?? null; // 重读：拿到对手插的
    };
    const secondLogin = await handleRequest(confirmLogin(secondToken), deps);
    // 关键：撞 UNIQUE 后重读命中，登录成功，而不是 500。
    expect(secondLogin.status).toBe(200);
  });

  it("expired/forged token → 400 on both the page and the confirm, no session", async () => {
    const { deps } = setup();
    const page = await handleRequest(new Request(`${BASE}/auth/callback?t=garbage.token.here.x`), deps);
    expect(page.status).toBe(400);
    expect(page.headers.get("set-cookie")).toBeNull();
    const confirm = await handleRequest(confirmLogin("garbage.token.here.x"), deps);
    expect(confirm.status).toBe(400);
    expect(confirm.headers.get("set-cookie")).toBeNull();
  });

  it("a session cookie (login purpose) cannot be replayed as a magic-link token", async () => {
    // 用 session cookie 的值当 callback token → 应被 purpose 校验挡下
    // (callback 期望 purpose=magic，session 是 purpose=login)。
    const { deps } = setup();
    const login = await handleRequest(confirmLogin(await magicToken(deps, "carol@example.com")), deps);
    const sessionValue = sessionCookieValue(login.headers.get("set-cookie") ?? "");
    const replay = await handleRequest(confirmLogin(sessionValue), deps);
    expect(replay.status).toBe(400);
  });
});
