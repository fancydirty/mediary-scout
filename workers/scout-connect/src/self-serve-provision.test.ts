import { describe, expect, it } from "vitest";
import { createMemoryConnectDb, type ConnectDb } from "./db.js";
import { buildSessionCookie } from "./session.js";
import { handleRequest, type RouteDeps } from "./routes.js";

const BASE = "https://mediaryconnect.app";
const NOW = "2026-07-28T12:00:00.000Z";
const SECRET = "f".repeat(64);

function setup(cfCalls: string[] = []): { deps: RouteDeps; db: ConnectDb } {
  const db = createMemoryConnectDb();
  let epSeq = 0;
  const deps: RouteDeps = {
    db,
    cf: {
      async createTunnel(name: string) {
        cfCalls.push(`createTunnel:${name}`);
        return { tunnelId: `tid-${name}`, token: `tok-${name}` };
      },
      async putTunnelIngress(tunnelId: string) {
        cfCalls.push(`ingress:${tunnelId}`);
      },
      async createDnsCname(slug: string) {
        cfCalls.push(`dns:${slug}`);
        return { recordId: `rec-${slug}` };
      },
      async deleteTunnel(tunnelId: string) {
        cfCalls.push(`deleteTunnel:${tunnelId}`);
      },
      async deleteDnsRecord(recordId: string) {
        cfCalls.push(`deleteDns:${recordId}`);
      },
      async deleteAccessApp() {},
      async getTunnelToken() {
        return "cf-token";
      },
    } as never,
    adminToken: "t",
    rootDomain: "mediaryconnect.app",
    tokenWrapKeyHex: "a".repeat(64),
    now: () => NOW,
    newInviteId: () => "inv_x",
    newEndpointId: () => `ep_${++epSeq}`,
    newAuditId: () => `aud_${epSeq}`,
    newInviteCode: () => "code_x",
    newAccountId: () => "act_x",
    newEntitlementId: () => "ent_x",
    sessionSecret: SECRET,
    sendMagicLink: async () => {},
  };
  return { deps, db };
}

async function cookieFor(accountId: string): Promise<string> {
  return buildSessionCookie(accountId, { secret: SECRET, ttlMs: 3600_000, now: Date.parse(NOW) });
}

async function seedAccount(db: ConnectDb, id: string, expiresAt: string | null): Promise<void> {
  await db.insertAccount({
    id,
    email: `${id}@example.com`,
    paddle_customer_id: null,
    created_at: NOW,
    last_login_at: NOW,
  });
  if (expiresAt !== null) {
    await db.insertEntitlement({
      id: `ent_${id}`,
      account_id: id,
      expires_at: expiresAt,
      source: "manual",
      paddle_transaction_id: null,
      months: 12,
      created_at: NOW,
    });
  }
}

const FUTURE = "2027-07-28T12:00:00.000Z";
const PAST = "2026-01-01T00:00:00.000Z";

function post(slug: string, cookie?: string): Request {
  return new Request(`${BASE}/api/provision`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify({ slug }),
  });
}

describe("POST /api/provision (自助开通)", () => {
  it("401 without session", async () => {
    const { deps } = setup();
    const res = await handleRequest(post("alice"), deps);
    expect(res.status).toBe(401);
  });

  it("402 without any entitlement — and burns ZERO CF calls", async () => {
    const cfCalls: string[] = [];
    const { deps, db } = setup(cfCalls);
    await seedAccount(db, "act_1", null);
    const res = await handleRequest(post("alice", await cookieFor("act_1")), deps);
    expect(res.status).toBe(402);
    expect(cfCalls).toHaveLength(0);
  });

  it("402 with an EXPIRED entitlement — zero CF calls", async () => {
    const cfCalls: string[] = [];
    const { deps, db } = setup(cfCalls);
    await seedAccount(db, "act_1", PAST);
    const res = await handleRequest(post("alice", await cookieFor("act_1")), deps);
    expect(res.status).toBe(402);
    expect(cfCalls).toHaveLength(0);
  });

  it("400 on an invalid/reserved slug — zero CF calls", async () => {
    const cfCalls: string[] = [];
    const { deps, db } = setup(cfCalls);
    await seedAccount(db, "act_1", FUTURE);
    const cookie = await cookieFor("act_1");
    expect((await handleRequest(post("Admin!", cookie), deps)).status).toBe(400);
    expect((await handleRequest(post("admin", cookie), deps)).status).toBe(400);
    expect(cfCalls).toHaveLength(0);
  });

  it("success: 200 { hostname }, endpoint gets account_id and NO invite_id", async () => {
    const { deps, db } = setup();
    await seedAccount(db, "act_1", FUTURE);
    const res = await handleRequest(post("alice", await cookieFor("act_1")), deps);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ hostname: "alice.mediaryconnect.app" });
    // 响应绝不含 token/agentPrompt(决策 #10/#12)
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("token");
    expect(raw).not.toContain("agentPrompt");
    expect(raw).not.toContain("tok-");

    const ep = await db.getActiveEndpointByAccountId("act_1");
    expect(ep?.account_id).toBe("act_1");
    expect(ep?.invite_id).toBeNull();
    expect(ep?.slug).toBe("alice");
    // token 不落库
    expect(ep?.token_ciphertext).toBeNull();
  });

  it("409 slug taken when another endpoint owns the slug", async () => {
    const { deps, db } = setup();
    await seedAccount(db, "act_1", FUTURE);
    await seedAccount(db, "act_2", FUTURE);
    expect((await handleRequest(post("alice", await cookieFor("act_1")), deps)).status).toBe(200);
    const res = await handleRequest(post("alice", await cookieFor("act_2")), deps);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error?: string }).error).toBe("slug taken");
  });

  it("409 already provisioned when the account already has a live endpoint", async () => {
    const { deps, db } = setup();
    await seedAccount(db, "act_1", FUTURE);
    const cookie = await cookieFor("act_1");
    expect((await handleRequest(post("alice", cookie), deps)).status).toBe(200);
    const res = await handleRequest(post("second", cookie), deps);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error?: string }).error).toBe("already provisioned");
  });

  it("401 on a stale session whose account no longer exists (fail closed)", async () => {
    const { deps } = setup();
    const res = await handleRequest(post("alice", await cookieFor("act_ghost")), deps);
    expect(res.status).toBe(401);
  });

  it("invite provisioning still works unchanged (regression: the old path)", async () => {
    const { deps, db } = setup();
    await db.insertInvite({
      id: "inv_1",
      code: "code_1",
      invitee_label: null,
      email: "invitee@example.com",
      slug: null,
      status: "pending",
      created_at: NOW,
      provisioned_at: null,
      revoked_at: null,
    });
    const res = await handleRequest(
      new Request(`${BASE}/api/admin/invites/inv_1/provision`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer t" },
        body: JSON.stringify({ slug: "bob" }),
      }),
      deps,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // 邀请流保留旧返回形状(reveal 流还活着)
    expect(body.hostname).toBe("bob.mediaryconnect.app");
    expect(typeof body.token).toBe("string");
    const ep = await db.getEndpointByInviteId("inv_1");
    expect(ep?.invite_id).toBe("inv_1");
    expect(ep?.account_id).toBeNull();
  });
});
