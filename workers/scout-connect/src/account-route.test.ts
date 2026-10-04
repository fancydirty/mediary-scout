import { describe, expect, it } from "vitest";
import { createMemoryConnectDb, type ConnectDb, type EndpointRow } from "./db.js";
import { handleRequest, type RouteDeps } from "./routes.js";
import { buildSessionCookie } from "./session.js";

const NOW = "2026-10-03T00:00:00.000Z";
const SECRET = "a".repeat(64);

function deps(
  db: ConnectDb,
  configured = true,
  products: { quarter: string; year: string; two_years: string } = { quarter: "q", year: "y", two_years: "2y" },
): RouteDeps {
  return {
    db,
    cf: {} as never,
    adminToken: "admin",
    rootDomain: "mediaryconnect.app",
    tokenWrapKeyHex: "0".repeat(64),
    now: () => NOW,
    newInviteId: () => "inv_1",
    newEndpointId: () => "ep_1",
    newAuditId: () => "aud_1",
    newInviteCode: () => "code_1",
    newAccountId: () => "act_new",
    newEntitlementId: () => "ent_new",
    sessionSecret: SECRET,
    sendMagicLink: async () => {},
    sendInstanceLinkEmail: async () => {},
    ...(configured
      ? {
          waffoApi: {} as never,
          waffoEnvironment: "test" as const,
          waffoStoreId: "store",
          waffoProducts: products,
        }
      : {}),
  };
}

async function accountCookie(db: ConnectDb): Promise<string> {
  await db.insertAccount({
    id: "act_1",
    email: "owner@example.com",
    paddle_customer_id: null,
    created_at: NOW,
    last_login_at: NOW,
  });
  return buildSessionCookie("act_1", { secret: SECRET, ttlMs: 3600_000, now: Date.parse(NOW) });
}

describe("GET /api/account", () => {
  it("returns the exact account snapshot and ordered tiers", async () => {
    const db = createMemoryConnectDb();
    const cookie = await accountCookie(db);
    await db.insertEntitlement({
      id: "ent_1",
      account_id: "act_1",
      expires_at: "2027-01-03T00:00:00.000Z",
      source: "manual",
      paddle_transaction_id: null,
      payment_provider: null,
      payment_transaction_id: null,
      refunded_at: null,
      months: 12,
      created_at: NOW,
    });
    const response = await handleRequest(new Request("https://dev.example/api/account", { headers: { cookie } }), deps(db));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      email: "owner@example.com",
      active: true,
      expiresAt: "2027-01-03T00:00:00.000Z",
      endpoint: null,
      restorable: null,
      checkoutOpen: true,
      tiers: [
        { id: "quarter", label: "季度", months: 3, price: "45.00", featured: false },
        { id: "year", label: "年度", months: 12, price: "108.00", featured: true },
        { id: "two_years", label: "两年", months: 24, price: "188.00", featured: false },
      ],
    });
  });

  it("requires authentication and reports checkoutOpen false when runtime is unavailable", async () => {
    const db = createMemoryConnectDb();
    const noAuth = await handleRequest(new Request("https://dev.example/api/account"), deps(db));
    expect(noAuth.status).toBe(401);
    const cookie = await accountCookie(db);
    const response = await handleRequest(new Request("https://dev.example/api/account", { headers: { cookie } }), deps(db, false));
    expect(response.status).toBe(200);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({ checkoutOpen: false });
  });

  it("lists only tiers with a configured Waffo product, and stays closed when none is", async () => {
    const db = createMemoryConnectDb();
    const cookie = await accountCookie(db);
    const partial = await handleRequest(
      new Request("https://dev.example/api/account", { headers: { cookie } }),
      deps(db, true, { quarter: "", year: "y", two_years: "  " }),
    );
    expect(await partial.json()).toMatchObject({
      checkoutOpen: true,
      tiers: [{ id: "year", label: "年度", months: 12, price: "108.00", featured: true }],
    });
    const none = await handleRequest(
      new Request("https://dev.example/api/account", { headers: { cookie } }),
      deps(db, true, { quarter: "", year: "", two_years: "" }),
    );
    expect(await none.json()).toMatchObject({ checkoutOpen: false, tiers: [] });
  });

  function endpoint(overrides: Partial<EndpointRow> & Pick<EndpointRow, "id" | "slug" | "status">): EndpointRow {
    return {
      invite_id: null,
      hostname: `${overrides.slug}.mediaryconnect.app`,
      cf_tunnel_id: "tun-1",
      cf_access_app_id: null,
      cf_access_policy_id: null,
      cf_dns_record_id: "dns-1",
      token_sha256: "sha",
      token_ciphertext: null,
      token_shown_at: null,
      last_seen_at: null,
      created_at: NOW,
      revoked_at: overrides.status === "active" ? null : "2026-09-01T00:00:00.000Z",
      account_id: "act_1",
      grace_until: null,
      suspended_at: null,
      purge_after: null,
      revoke_reason: null,
      ...overrides,
    };
  }

  it("reports the live endpoint's tunnel id", async () => {
    const db = createMemoryConnectDb();
    const cookie = await accountCookie(db);
    await db.insertEndpoint(endpoint({ id: "ep_live", slug: "fam", status: "active", cf_tunnel_id: "tun-live" }));
    const body = (await (await handleRequest(
      new Request("https://dev.example/api/account", { headers: { cookie } }),
      deps(db),
    )).json()) as { endpoint: { tunnelId?: string } | null };
    expect(body.endpoint?.tunnelId).toBe("tun-live");
  });

  it("reports a restorable address when the account has no live endpoint, active or not", async () => {
    const expired = createMemoryConnectDb();
    const expiredCookie = await accountCookie(expired);
    await expired.insertEntitlement({
      id: "ent_old", account_id: "act_1", expires_at: "2026-01-01T00:00:00.000Z", source: "manual",
      paddle_transaction_id: null, payment_provider: null, payment_transaction_id: null,
      refunded_at: null, months: 3, created_at: NOW,
    });
    await expired.insertEndpoint(endpoint({ id: "ep_exp", slug: "fam", status: "revoked", revoke_reason: "expired" }));
    const expiredBody = await (await handleRequest(
      new Request("https://dev.example/api/account", { headers: { cookie: expiredCookie } }),
      deps(expired),
    )).json();
    expect(expiredBody).toMatchObject({
      active: false,
      endpoint: null,
      restorable: { slug: "fam", hostname: "fam.mediaryconnect.app" },
    });

    const current = createMemoryConnectDb();
    const currentCookie = await accountCookie(current);
    await current.insertEntitlement({
      id: "ent_now", account_id: "act_1", expires_at: "2027-01-03T00:00:00.000Z", source: "manual",
      paddle_transaction_id: null, payment_provider: null, payment_transaction_id: null,
      refunded_at: null, months: 12, created_at: NOW,
    });
    await current.insertEndpoint(endpoint({ id: "ep_ref", slug: "fam", status: "revoked", revoke_reason: "refunded" }));
    const currentBody = await (await handleRequest(
      new Request("https://dev.example/api/account", { headers: { cookie: currentCookie } }),
      deps(current),
    )).json();
    expect(currentBody).toMatchObject({
      restorable: { slug: "fam", hostname: "fam.mediaryconnect.app" },
    });

    const admin = createMemoryConnectDb();
    const adminCookie = await accountCookie(admin);
    await admin.insertEndpoint(endpoint({ id: "ep_admin", slug: "fam", status: "revoked", revoke_reason: "admin" }));
    expect(await (await handleRequest(
      new Request("https://dev.example/api/account", { headers: { cookie: adminCookie } }),
      deps(admin),
    )).json()).toMatchObject({ restorable: null });

    const live = createMemoryConnectDb();
    const liveCookie = await accountCookie(live);
    await live.insertEndpoint(endpoint({ id: "ep_live", slug: "fam", status: "active", revoke_reason: null }));
    await live.insertEndpoint(endpoint({
      id: "ep_old", slug: "old-fam", status: "revoked", revoke_reason: "expired", account_id: "act_1",
    }));
    expect(await (await handleRequest(
      new Request("https://dev.example/api/account", { headers: { cookie: liveCookie } }),
      deps(live),
    )).json()).toMatchObject({ restorable: null });
  });
});
