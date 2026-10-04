import { describe, expect, it, vi } from "vitest";
import { createMemoryConnectDb, type ConnectDb } from "./db.js";
import { buildSessionCookie, SESSION_COOKIE, sessionCookieValue } from "./session.js";
import { handleRequest, type RouteDeps } from "./routes.js";
import type { CfApi } from "./cf-api.js";
import type { WaffoApi } from "./waffo-api.js";

// Every customer instance is served on <slug>.<root>, and its owner controls
// what that origin serves. A page there is same-site with the apex, so the
// SameSite=Lax session cookie still rides along on its POSTs to the apex, and a
// text/plain body skips the CORS preflight. SIBLING models that page.
const HOST = "https://dev.example";
const SIBLING = "https://evil.dev.example";
const NOW = "2026-10-03T00:00:00.000Z";
const FUTURE = "2027-10-03T00:00:00.000Z";
const SECRET = "f".repeat(64);

function setup() {
  const db = createMemoryConnectDb();
  const cfCalls: string[] = [];
  const cf: CfApi = {
    async createTunnel(name: string) {
      cfCalls.push(`createTunnel:${name}`);
      return { tunnelId: `tid-${name}`, token: "tok" };
    },
    async getTunnelToken() {
      cfCalls.push("getTunnelToken");
      return "tok";
    },
    async putTunnelIngress() {
      cfCalls.push("ingress");
    },
    async createDnsCname(slug: string) {
      cfCalls.push(`dns:${slug}`);
      return { recordId: `rec-${slug}` };
    },
    async createAccessApp() {
      return { appId: "app", policyId: "policy" };
    },
    async deleteTunnel() {},
    async deleteDnsRecord() {},
    async deleteAccessApp() {},
  };
  const createSession = vi.fn(async () => ({
    checkoutUrl: "https://checkout.test/s",
    sessionId: "cs_1",
    expiresAt: "2026-10-03T00:30:00.000Z",
  }));
  const waffoApi: WaffoApi = {
    config: {
      merchantId: "MER_TEST", storeId: "STO_TEST", environment: "test", privateKey: "key",
      productQuarter: "PROD_Q", productYear: "PROD_Y", productTwoYears: "PROD_2Y",
    },
    createSession,
    async verifyWebhook() {
      return { eventType: "order.completed", mode: "test", storeId: "STO_TEST", data: {} };
    },
    async queryPayments() {
      return [];
    },
  };
  let seq = 0;
  const next = (prefix: string) => () => `${prefix}_${++seq}`;
  const deps: RouteDeps = {
    db,
    cf,
    adminToken: "admin",
    rootDomain: "mediaryconnect.app",
    tokenWrapKeyHex: "a".repeat(64),
    now: () => NOW,
    newInviteId: next("inv"),
    newEndpointId: next("ep"),
    newAuditId: next("aud"),
    newInviteCode: next("code"),
    newAccountId: next("act"),
    newEntitlementId: next("ent"),
    sessionSecret: SECRET,
    sendMagicLink: async () => {},
    sendInstanceLinkEmail: async () => {},
    waffoApi,
    waffoEnvironment: "test",
    waffoStoreId: "STO_TEST",
    waffoProducts: { quarter: "PROD_Q", year: "PROD_Y", two_years: "PROD_2Y" },
  };
  return { db, deps, cfCalls, createSession };
}

/** A paying account that has not provisioned its instance yet. */
async function payingAccount(db: ConnectDb, id = "act_1"): Promise<string> {
  await db.insertAccount({
    id, email: `${id}@example.com`, paddle_customer_id: null, created_at: NOW, last_login_at: NOW,
  });
  await db.insertEntitlement({
    id: `ent_${id}`, account_id: id, expires_at: FUTURE, source: "manual", paddle_transaction_id: null,
    payment_provider: null, payment_transaction_id: null, refunded_at: null, months: 12, created_at: NOW,
  });
  return buildSessionCookie(id, { secret: SECRET, ttlMs: 3600_000, now: Date.parse(NOW) });
}

function post(path: string, headers: Record<string, string>, body?: unknown): Request {
  return new Request(`${HOST}${path}`, {
    method: "POST",
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const siblingHeaders = (cookie: string) => ({
  cookie,
  origin: SIBLING,
  "sec-fetch-site": "same-site",
  "content-type": "text/plain;charset=UTF-8",
});

describe("session-cookie POSTs reject other origins (sibling <slug> subdomains)", () => {
  it("rejects a sibling page's POST /api/checkout without creating an order", async () => {
    const { db, deps, createSession } = setup();
    const cookie = await payingAccount(db);
    const res = await handleRequest(post("/api/checkout", siblingHeaders(cookie), { tier: "quarter" }), deps);
    expect(res.status).toBe(403);
    expect(createSession).not.toHaveBeenCalled();
    const orders = await db.listPaymentOrdersForReconciliation("waffo", {
      unpaidSinceIso: "2000-01-01T00:00:00.000Z", settledSinceIso: "2000-01-01T00:00:00.000Z", limit: 100,
    });
    expect(orders).toHaveLength(0);
  });

  it("rejects a sibling page's POST /api/provision with zero Cloudflare calls", async () => {
    const { db, deps, cfCalls } = setup();
    const cookie = await payingAccount(db);
    const res = await handleRequest(post("/api/provision", siblingHeaders(cookie), { slug: "chosen-by-attacker" }), deps);
    expect(res.status).toBe(403);
    expect(cfCalls).toHaveLength(0);
    expect(await db.getActiveEndpointByAccountId("act_1")).toBeNull();
  });

  it("rejects a sibling page's POST /api/claim-code", async () => {
    const { db, deps } = setup();
    const cookie = await payingAccount(db);
    const res = await handleRequest(post("/api/claim-code", siblingHeaders(cookie)), deps);
    expect(res.status).toBe(403);
  });

  it("rejects by Origin when the browser sends no Fetch Metadata", async () => {
    const { db, deps, createSession } = setup();
    const cookie = await payingAccount(db);
    const res = await handleRequest(post("/api/checkout", { cookie, origin: SIBLING }, { tier: "quarter" }), deps);
    expect(res.status).toBe(403);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("rejects an opaque Origin: null", async () => {
    const { db, deps } = setup();
    const cookie = await payingAccount(db);
    const res = await handleRequest(post("/api/checkout", { cookie, origin: "null" }, { tier: "quarter" }), deps);
    expect(res.status).toBe(403);
  });

  it("rejects Sec-Fetch-Site: cross-site even if the cookie somehow arrived", async () => {
    const { db, deps } = setup();
    const cookie = await payingAccount(db);
    const res = await handleRequest(post("/api/checkout", { cookie, "sec-fetch-site": "cross-site" }, { tier: "quarter" }), deps);
    expect(res.status).toBe(403);
  });

  it("a session cookie planted by a sibling subdomain cannot switch the account", async () => {
    // The sibling sets `mc_session=<its own login>; Domain=<root>; Path=/api`, which the
    // browser lists first. The victim's own same-origin click must still act as the victim.
    const { db, deps } = setup();
    const victim = sessionCookieValue(await payingAccount(db, "act_victim"));
    const attacker = sessionCookieValue(await payingAccount(db, "act_attacker"));
    await db.insertEndpoint({
      id: "ep_attacker", invite_id: null, slug: "attacker", hostname: "attacker.mediaryconnect.app",
      cf_tunnel_id: "tid-attacker", cf_access_app_id: null, cf_access_policy_id: null,
      cf_dns_record_id: "rec-attacker", status: "active", token_sha256: "x",
      token_ciphertext: null, token_shown_at: null, last_seen_at: null,
      created_at: NOW, revoked_at: null, account_id: "act_attacker", grace_until: null, suspended_at: null, purge_after: null, revoke_reason: null,
    });
    const res = await handleRequest(post("/api/claim-code", {
      cookie: `mc_session=${attacker}; ${SESSION_COOKIE}=${victim}`,
      origin: HOST,
      "sec-fetch-site": "same-origin",
    }), deps);
    // The victim has no instance yet; a 200 here would be a claim code for the attacker's tunnel.
    expect(res.status).toBe(404);
  });

  it("still serves this origin's own pages", async () => {
    const { db, deps, createSession, cfCalls } = setup();
    const cookie = await payingAccount(db);
    const own = { cookie, origin: HOST, "sec-fetch-site": "same-origin", "content-type": "application/json" };
    const checkout = await handleRequest(post("/api/checkout", own, { tier: "quarter" }), deps);
    expect(checkout.status).toBe(200);
    expect(createSession).toHaveBeenCalledTimes(1);
    const provision = await handleRequest(post("/api/provision", own, { slug: "alice" }), deps);
    expect(provision.status).toBeLessThan(300);
    expect(cfCalls).toContain("dns:alice");
    const claim = await handleRequest(post("/api/claim-code", own), deps);
    expect(claim.status).toBe(200);
  });

  it("still serves a client that sends neither Origin nor Fetch Metadata", async () => {
    const { db, deps, createSession } = setup();
    const cookie = await payingAccount(db);
    const res = await handleRequest(post("/api/checkout", { cookie, "content-type": "application/json" }, { tier: "quarter" }), deps);
    expect(res.status).toBe(200);
    expect(createSession).toHaveBeenCalledTimes(1);
  });
});
