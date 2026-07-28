import { describe, expect, it } from "vitest";
import { handleRequest, type RouteDeps } from "./routes.js";
import { createMemoryConnectDb, type ConnectDb } from "./db.js";
import type { CfApi } from "./cf-api.js";
import { buildSessionCookie, SESSION_COOKIE } from "./session.js";

const BASE = "https://mediaryconnect.app";
const SECRET = "f".repeat(64);
const NOW = "2026-07-28T00:00:00.000Z";
const CF_TOKEN = "cf-connector-token-abc";

function makeCf(calls: string[]): CfApi {
  const boom = (n: string) => async () => {
    throw new Error(`unexpected ${n}`);
  };
  return {
    createTunnel: boom("createTunnel") as never,
    getTunnelToken: async (tid: string) => {
      calls.push(`getTunnelToken:${tid}`);
      return CF_TOKEN;
    },
    putTunnelIngress: boom("putTunnelIngress") as never,
    createDnsCname: boom("createDnsCname") as never,
    createAccessApp: boom("createAccessApp") as never,
    deleteTunnel: boom("deleteTunnel") as never,
    deleteDnsRecord: boom("deleteDnsRecord") as never,
    deleteAccessApp: boom("deleteAccessApp") as never,
  };
}

function setup(cfCalls: string[] = []): { deps: RouteDeps; db: ConnectDb } {
  const db = createMemoryConnectDb();
  const deps: RouteDeps = {
    db,
    cf: makeCf(cfCalls),
    adminToken: "admin-tok",
    rootDomain: "mediaryconnect.app",
    tokenWrapKeyHex: "a".repeat(64),
    now: () => NOW,
    newInviteId: () => "inv_x",
    newEndpointId: () => "ep_x",
    newAuditId: () => "aud_x",
    newInviteCode: () => "code_x",
    newAccountId: () => "act_x",
    newEntitlementId: () => "ent_x",
    sessionSecret: SECRET,
    sendMagicLink: async () => {},
  };
  return { deps, db };
}

async function cookieFor(accountId: string): Promise<string> {
  const c = await buildSessionCookie(accountId, { secret: SECRET, ttlMs: 3600_000, now: Date.parse(NOW) });
  return `${SESSION_COOKIE}=${c.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))![1]}`;
}

/** 给账号种一个 active endpoint(付费开通后的形态)。 */
async function seedEndpoint(db: ConnectDb, accountId: string): Promise<void> {
  await db.insertAccount({
    id: accountId, email: `${accountId}@example.com`, paddle_customer_id: null,
    created_at: NOW, last_login_at: NOW,
  });
  await db.insertEndpoint({
    id: "ep_1", invite_id: "inv_1", slug: "alice", hostname: "alice.mediaryconnect.app",
    cf_tunnel_id: "tid-1", cf_access_app_id: null, cf_access_policy_id: null,
    cf_dns_record_id: "rec-1", status: "active", token_sha256: "x",
    token_ciphertext: null, token_shown_at: null, last_seen_at: null,
    created_at: NOW, revoked_at: null, account_id: accountId,
  });
}

describe("POST /api/claim-code (登录用户签发取件码)", () => {
  it("401 without session", async () => {
    const { deps } = setup();
    const res = await handleRequest(
      new Request(`${BASE}/api/claim-code`, { method: "POST" }),
      deps,
    );
    expect(res.status).toBe(401);
  });

  it("issues a short-lived code for the session account's active endpoint", async () => {
    const cfCalls: string[] = [];
    const { deps, db } = setup(cfCalls);
    await seedEndpoint(db, "act_1");
    const res = await handleRequest(
      new Request(`${BASE}/api/claim-code`, {
        method: "POST",
        headers: { cookie: await cookieFor("act_1") },
      }),
      deps,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code?: string; expires_at?: string };
    expect(typeof body.code).toBe("string");
    expect(body.code!.length).toBeGreaterThan(0);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("404 when the account has no active endpoint (not provisioned yet)", async () => {
    const { deps, db } = setup();
    await db.insertAccount({
      id: "act_2", email: "act_2@example.com", paddle_customer_id: null,
      created_at: NOW, last_login_at: NOW,
    });
    const res = await handleRequest(
      new Request(`${BASE}/api/claim-code`, {
        method: "POST",
        headers: { cookie: await cookieFor("act_2") },
      }),
      deps,
    );
    expect(res.status).toBe(404);
  });

  it("fails closed (500, no throw) when deps.now() is malformed → NaN", async () => {
    const { deps, db } = setup();
    await seedEndpoint(db, "act_1");
    const badDeps: RouteDeps = { ...deps, now: () => "not-a-date" };
    const res = await handleRequest(
      new Request(`${BASE}/api/claim-code`, {
        method: "POST",
        headers: { cookie: await cookieFor("act_1") },
      }),
      badDeps,
    );
    // new Date(NaN).toISOString() 会抛 RangeError;显式 finite 守卫把它变成
    // 受控的 500 而不是裸崩。
    expect(res.status).toBe(500);
  });
});

describe("POST /api/claim/exchange (脚本凭码换 token,无 session)", () => {
  async function issueCode(deps: RouteDeps, accountId: string): Promise<string> {
    const res = await handleRequest(
      new Request(`${BASE}/api/claim-code`, {
        method: "POST",
        headers: { cookie: await cookieFor(accountId) },
      }),
      deps,
    );
    return ((await res.json()) as { code: string }).code;
  }

  it("valid code → 200 { hostname, token } fetched from CF", async () => {
    const cfCalls: string[] = [];
    const { deps, db } = setup(cfCalls);
    await seedEndpoint(db, "act_1");
    const code = await issueCode(deps, "act_1");

    const res = await handleRequest(
      new Request(`${BASE}/api/claim/exchange`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      }),
      deps,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hostname?: string; token?: string };
    expect(body.hostname).toBe("alice.mediaryconnect.app");
    expect(body.token).toBe(CF_TOKEN);
    expect(cfCalls).toEqual(["getTunnelToken:tid-1"]);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("fails closed (500) on malformed now instead of misreporting 400 expired", async () => {
    const cfCalls: string[] = [];
    const { deps, db } = setup(cfCalls);
    await seedEndpoint(db, "act_1");
    const code = await issueCode(deps, "act_1");
    const badDeps: RouteDeps = { ...deps, now: () => "not-a-date" };
    const res = await handleRequest(
      new Request(`${BASE}/api/claim/exchange`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      }),
      badDeps,
    );
    // now 畸形是服务端问题,应 500,而非把有效码误判成 400 过期。
    expect(res.status).toBe(500);
  });

  it("code is reusable within its window (脚本重试/换机器)", async () => {
    const cfCalls: string[] = [];
    const { deps, db } = setup(cfCalls);
    await seedEndpoint(db, "act_1");
    const code = await issueCode(deps, "act_1");
    const one = await handleRequest(
      new Request(`${BASE}/api/claim/exchange`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      }), deps);
    const two = await handleRequest(
      new Request(`${BASE}/api/claim/exchange`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      }), deps);
    expect(one.status).toBe(200);
    expect(two.status).toBe(200);
  });

  it("garbage / forged code → 400", async () => {
    const { deps, db } = setup();
    await seedEndpoint(db, "act_1");
    const res = await handleRequest(
      new Request(`${BASE}/api/claim/exchange`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "garbage.forged.code.x" }),
      }), deps);
    expect(res.status).toBe(400);
  });

  it("a login/session token cannot be exchanged as a claim code (purpose separation)", async () => {
    const { deps, db } = setup();
    await seedEndpoint(db, "act_1");
    // 拿 session cookie 的值(purpose=login)当 claim code
    const sessionVal = (await cookieFor("act_1")).replace(`${SESSION_COOKIE}=`, "");
    const res = await handleRequest(
      new Request(`${BASE}/api/claim/exchange`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: sessionVal }),
      }), deps);
    expect(res.status).toBe(400);
  });

  it("endpoint revoked after code issued → 403 (no token for a dead tunnel)", async () => {
    const cfCalls: string[] = [];
    const { deps, db } = setup(cfCalls);
    await seedEndpoint(db, "act_1");
    const code = await issueCode(deps, "act_1");
    await db.markEndpointRevoked("ep_1", NOW);
    const res = await handleRequest(
      new Request(`${BASE}/api/claim/exchange`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      }), deps);
    expect(res.status).toBe(403);
    expect(cfCalls).toHaveLength(0); // 不给已撤销的取 token
  });
});
