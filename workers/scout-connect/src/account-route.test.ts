import { describe, expect, it } from "vitest";
import { createMemoryConnectDb, type ConnectDb } from "./db.js";
import { handleRequest, type RouteDeps } from "./routes.js";
import { buildSessionCookie } from "./session.js";

const NOW = "2026-10-03T00:00:00.000Z";
const SECRET = "a".repeat(64);

function deps(db: ConnectDb, configured = true): RouteDeps {
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
          waffoProducts: { quarter: "q", year: "y", two_years: "2y" },
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
});
