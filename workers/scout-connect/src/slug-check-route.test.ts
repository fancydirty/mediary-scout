import { describe, expect, it } from "vitest";
import { handleRequest, type RouteDeps } from "./routes.js";
import { createMemoryConnectDb, type ConnectDb } from "./db.js";
import { buildSessionCookie, SESSION_COOKIE } from "./session.js";
import { sha256Hex } from "./crypto-token.js";

const BASE = "https://mediaryconnect.app";
const SECRET = "f".repeat(64);

function deps(): RouteDeps {
  return {
    db: createMemoryConnectDb(),
    cf: {} as never,
    adminToken: "t",
    rootDomain: "mediaryconnect.app",
    tokenWrapKeyHex: "a".repeat(64),
    now: () => "2026-07-28T00:00:00.000Z",
    newInviteId: () => "inv_x",
    newEndpointId: () => "ep_x",
    newAuditId: () => "aud_x",
    newInviteCode: () => "code_x",
    newAccountId: () => "act_x",
    newEntitlementId: () => "ent_x",
    sessionSecret: SECRET,
    sendMagicLink: async () => {},
    sendInstanceLinkEmail: async () => {},
  };
}

async function cookie(): Promise<string> {
  const c = await buildSessionCookie("act_1", { secret: SECRET, ttlMs: 3600_000, now: Date.parse("2026-07-28T00:00:00.000Z") });
  return `${SESSION_COOKIE}=${c.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`))![1]}`;
}

async function bearer(db: ConnectDb, credential = `ic_${"a".repeat(43)}`): Promise<string> {
  await db.insertAccount({
    id: "act_1", email: "owner@example.com", paddle_customer_id: null,
    created_at: "2026-07-28T00:00:00.000Z", last_login_at: null,
  });
  await db.insertInstanceCredential({
    id: "icr_slug", account_id: "act_1", credential_sha256: await sha256Hex(credential),
    link_request_id: "ilr_slug", created_at: "2026-07-28T00:00:00.000Z", last_used_at: null, revoked_at: null,
  });
  return credential;
}

describe("GET /api/slug/check", () => {
  it("401 without session", async () => {
    const res = await handleRequest(new Request(`${BASE}/api/slug/check?s=alice`), deps());
    expect(res.status).toBe(401);
  });

  it("available for a fresh slug", async () => {
    const res = await handleRequest(
      new Request(`${BASE}/api/slug/check?s=charlie`, { headers: { cookie: await cookie() } }),
      deps(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: true });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("works with only an instance bearer credential", async () => {
    const d = deps();
    const credential = await bearer(d.db);
    const res = await handleRequest(new Request(`${BASE}/api/slug/check?s=charlie`, {
      headers: { authorization: `Bearer ${credential}` },
    }), d);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: true });
  });

  it("taken slug (including revoked) returns unavailable + suggestions", async () => {
    const d = deps();
    // 一条 revoked 的 endpoint 也占用 slug（永久保留）
    await d.db.insertEndpoint({
      id: "ep_1", invite_id: "inv_1", slug: "alice", hostname: "alice.mediaryconnect.app",
      cf_tunnel_id: "t", cf_access_app_id: null, cf_access_policy_id: null,
      cf_dns_record_id: "d", status: "revoked", token_sha256: "x",
      token_ciphertext: null, token_shown_at: null, last_seen_at: null,
      created_at: "2026-01-01T00:00:00.000Z", revoked_at: "2026-02-01T00:00:00.000Z", account_id: null, grace_until: null, suspended_at: null, purge_after: null, revoke_reason: null,
    });
    const res = await handleRequest(
      new Request(`${BASE}/api/slug/check?s=alice`, { headers: { cookie: await cookie() } }),
      d,
    );
    const body = (await res.json()) as { available: boolean; reason?: string; suggestions?: string[] };
    expect(body.available).toBe(false);
    expect(body.reason).toBe("taken");
    expect(body.suggestions!.length).toBeGreaterThan(0);
  });

  // An instance on the older wizard knows nothing about `restorable`: it shows the name form and
  // only submits a name the check calls available. The account's own restorable name must pass,
  // or the owner can only pick a new name and the reserved one is retired for good.
  it("reports the account's own restorable slug as available, but not an admin-revoked one", async () => {
    const d = deps();
    const row = (id: string, slug: string, accountId: string, reason: "expired" | "admin") => ({
      id, invite_id: null, slug, hostname: `${slug}.mediaryconnect.app`,
      cf_tunnel_id: "t", cf_access_app_id: null, cf_access_policy_id: null,
      cf_dns_record_id: "d", status: "revoked" as const, token_sha256: `x-${id}`,
      token_ciphertext: null, token_shown_at: null, last_seen_at: null,
      created_at: "2026-01-01T00:00:00.000Z", revoked_at: "2026-02-01T00:00:00.000Z", account_id: accountId,
      grace_until: null, suspended_at: null, purge_after: null, revoke_reason: reason,
    });
    await d.db.insertAccount({ id: "act_1", email: "owner@example.com", paddle_customer_id: null, created_at: "2026-01-01T00:00:00.000Z", last_login_at: null });
    await d.db.insertEndpoint(row("ep_own", "fam", "act_1", "expired"));
    await d.db.insertAccount({ id: "act_2", email: "other@example.com", paddle_customer_id: null, created_at: "2026-01-01T00:00:00.000Z", last_login_at: null });
    await d.db.insertEndpoint(row("ep_other", "bob", "act_2", "expired"));
    const check = async (s: string) => {
      const res = await handleRequest(new Request(`${BASE}/api/slug/check?s=${s}`, { headers: { cookie: await cookie() } }), d);
      return (await res.json()) as { available: boolean; reason?: string };
    };
    expect(await check("fam")).toEqual({ available: true });
    expect((await check("bob")).reason).toBe("taken");

    const admin = deps();
    await admin.db.insertAccount({ id: "act_1", email: "owner@example.com", paddle_customer_id: null, created_at: "2026-01-01T00:00:00.000Z", last_login_at: null });
    await admin.db.insertEndpoint(row("ep_admin", "fam", "act_1", "admin"));
    const res = await handleRequest(new Request(`${BASE}/api/slug/check?s=fam`, { headers: { cookie: await cookie() } }), admin);
    expect(((await res.json()) as { reason?: string }).reason).toBe("taken");
  });

  it("reserved slug returns unavailable", async () => {
    const res = await handleRequest(
      new Request(`${BASE}/api/slug/check?s=admin`, { headers: { cookie: await cookie() } }),
      deps(),
    );
    const body = (await res.json()) as { available: boolean; reason?: string };
    expect(body.available).toBe(false);
    expect(body.reason).toBe("reserved");
  });
});
