import { describe, expect, it } from "vitest";
import { handleRequest, type RouteDeps } from "./routes.js";
import { createMemoryConnectDb } from "./db.js";
import { buildSessionCookie, SESSION_COOKIE } from "./session.js";

const BASE = "https://mediaryconnect.app";
const SESSION_SECRET = "f".repeat(64);

function baseDeps(): RouteDeps {
  return {
    db: createMemoryConnectDb(),
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
    sendMagicLink: async () => {},
  };
}

async function sessionCookieHeader(accountId: string): Promise<string> {
  const setCookie = await buildSessionCookie(accountId, {
    secret: SESSION_SECRET,
    ttlMs: 3600_000,
    now: Date.parse("2026-07-28T00:00:00.000Z"),
  });
  return `${SESSION_COOKIE}=${setCookie.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))![1]}`;
}

describe("GET /console (登录后控制台)", () => {
  it("redirects to /login when no session", async () => {
    const res = await handleRequest(new Request(`${BASE}/console`), baseDeps());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  it("redirects to /login when the session is forged", async () => {
    const res = await handleRequest(
      new Request(`${BASE}/console`, { headers: { cookie: `${SESSION_COOKIE}=garbage.x.y.z` } }),
      baseDeps(),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  it("shows the account email and entitlement status for an active account", async () => {
    const deps = baseDeps();
    await deps.db.insertAccount({
      id: "act_1",
      email: "alice@example.com",
      paddle_customer_id: null,
      created_at: "2026-01-01T00:00:00.000Z",
      last_login_at: "2026-07-28T00:00:00.000Z",
    });
    await deps.db.insertEntitlement({
      id: "ent_1",
      account_id: "act_1",
      expires_at: "2027-07-28T00:00:00.000Z",
      source: "founding",
      paddle_transaction_id: null,
      months: 12,
      created_at: "2026-07-28T00:00:00.000Z",
    });
    const res = await handleRequest(
      new Request(`${BASE}/console`, { headers: { cookie: await sessionCookieHeader("act_1") } }),
      deps,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("alice@example.com");
    expect(html).toContain("有效");        // 状态显示
    expect(html).toContain("2027");         // 到期年份
  });

  it("sets Cache-Control: no-store on the authenticated console page", async () => {
    const deps = baseDeps();
    await deps.db.insertAccount({
      id: "act_c", email: "c@example.com", paddle_customer_id: null,
      created_at: "2026-01-01T00:00:00.000Z", last_login_at: null,
    });
    const res = await handleRequest(
      new Request(`${BASE}/console`, { headers: { cookie: await sessionCookieHeader("act_c") } }),
      deps,
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("shows an expired/none state for an account with no active entitlement", async () => {
    const deps = baseDeps();
    await deps.db.insertAccount({
      id: "act_2",
      email: "bob@example.com",
      paddle_customer_id: null,
      created_at: "2026-01-01T00:00:00.000Z",
      last_login_at: null,
    });
    const res = await handleRequest(
      new Request(`${BASE}/console`, { headers: { cookie: await sessionCookieHeader("act_2") } }),
      deps,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("bob@example.com");
    expect(html).toMatch(/未开通|已过期|无有效/);
  });

  it("a session for a deleted account redirects to /login (stale cookie fails closed)", async () => {
    const res = await handleRequest(
      new Request(`${BASE}/console`, { headers: { cookie: await sessionCookieHeader("act_ghost") } }),
      baseDeps(),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });
});
