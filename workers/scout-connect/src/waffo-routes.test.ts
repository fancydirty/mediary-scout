import { describe, expect, it, vi } from "vitest";
import { handleRequest, type RouteDeps } from "./routes.js";
import { createMemoryConnectDb, type ConnectDb } from "./db.js";
import { buildSessionCookie } from "./session.js";
import type { CfApi } from "./cf-api.js";
import type { WaffoApi, WaffoWebhookEvent } from "./waffo-api.js";

const NOW = "2026-10-02T10:00:00.000Z";
const SECRET = "f".repeat(64);

function fakeCf(): CfApi {
  return {
    async createTunnel() { return { tunnelId: "tid", token: "token" }; },
    async getTunnelToken() { return "token"; },
    async putTunnelIngress() {},
    async createDnsCname() { return { recordId: "rec" }; },
    async createAccessApp() { return { appId: "app", policyId: "policy" }; },
    async deleteTunnel() {},
    async deleteDnsRecord() {},
    async deleteAccessApp() {},
  };
}

function api(overrides: Partial<WaffoApi> = {}): WaffoApi {
  return {
    config: {
      merchantId: "MER_TEST", storeId: "STO_TEST", environment: "test", privateKey: "key",
      productQuarter: "PROD_Q", productYear: "PROD_Y", productTwoYears: "PROD_2Y",
    },
    async createSession() {
      return { checkoutUrl: "https://checkout.test/session", sessionId: "cs_1", expiresAt: "2026-10-02T10:30:00.000Z" };
    },
    async verifyWebhook() {
      return { eventType: "order.completed", mode: "test", storeId: "STO_TEST", data: {} };
    },
    async queryPayments() { return []; },
    ...overrides,
  };
}

function deps(db: ConnectDb, overrides: Partial<RouteDeps> = {}): RouteDeps {
  let id = 0;
  const next = (prefix: string) => () => `${prefix}_${++id}`;
  return {
    db,
    cf: fakeCf(),
    adminToken: "admin",
    rootDomain: "mediaryconnect.app",
    tokenWrapKeyHex: "00".repeat(32),
    now: () => NOW,
    newInviteId: next("inv"),
    newEndpointId: next("ep"),
    newAuditId: next("aud"),
    newInviteCode: next("code"),
    newAccountId: next("act"),
    newEntitlementId: next("ent"),
    sessionSecret: SECRET,
    sendMagicLink: async () => {},
    waffoApi: api(),
    waffoEnvironment: "test",
    waffoStoreId: "STO_TEST",
    waffoProducts: { quarter: "PROD_Q", year: "PROD_Y", two_years: "PROD_2Y" },
    ...overrides,
  };
}

async function loggedIn(db: ConnectDb, accountId = "act_1"): Promise<string> {
  await db.insertAccount({
    id: accountId,
    email: "buyer@example.com",
    paddle_customer_id: null,
    created_at: NOW,
    last_login_at: null,
  });
  return buildSessionCookie(accountId, { secret: SECRET, ttlMs: 3600_000, now: Date.parse(NOW) });
}

function completedEvent(externalId: string, overrides: Record<string, unknown> = {}): WaffoWebhookEvent {
  return {
    id: "evt_1",
    eventType: "order.completed",
    mode: "test",
    storeId: "STO_TEST",
    data: {
      orderId: "ORD_1",
      paymentId: "PAY_1",
      orderMerchantExternalId: externalId,
      currency: "CNY",
      listPrice: { total: "45.00" },
      paymentStatus: "succeeded",
      ...overrides,
    },
  };
}

describe("Waffo checkout routes", () => {
  it("requires login, maps tier server-side, and calls exact Waffo checkout params", async () => {
    const db = createMemoryConnectDb();
    const waffo = api({ createSession: vi.fn(async (input) => ({
      checkoutUrl: "https://checkout.test/q", sessionId: "cs_q", expiresAt: "2026-10-02T10:30:00.000Z",
    })) });
    const routeDeps = deps(db, { waffoApi: waffo });
    const unauthorized = await handleRequest(new Request("https://dev.example/api/checkout", {
      method: "POST", body: JSON.stringify({ tier: "quarter" }), headers: { "content-type": "application/json" },
    }), routeDeps);
    expect(unauthorized.status).toBe(401);
    const cookie = await loggedIn(db);
    const response = await handleRequest(new Request("https://dev.example/api/checkout", {
      method: "POST", body: JSON.stringify({ tier: "quarter" }), headers: { cookie, "content-type": "application/json" },
    }), routeDeps);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ checkoutUrl: "https://checkout.test/q" });
    expect(waffo.createSession).toHaveBeenCalledWith(expect.objectContaining({
      productId: "PROD_Q", productType: "onetime", currency: "CNY", buyerEmail: "buyer@example.com",
      expiresInSeconds: 1800, language: "zh-Hans", metadata: expect.objectContaining({ orderId: expect.any(String) }),
    }));
  });

  it("rejects unknown tier and refuses test environment on production host", async () => {
    const db = createMemoryConnectDb();
    const cookie = await loggedIn(db);
    const routeDeps = deps(db);
    const unknown = await handleRequest(new Request("https://dev.example/api/checkout", {
      method: "POST", body: JSON.stringify({ tier: "month" }), headers: { cookie, "content-type": "application/json" },
    }), routeDeps);
    expect(unknown.status).toBe(400);
    const productionHost = await handleRequest(new Request("https://mediaryconnect.app/api/checkout", {
      method: "POST", body: JSON.stringify({ tier: "quarter" }), headers: { cookie, "content-type": "application/json" },
    }), routeDeps);
    expect(productionHost.status).toBe(503);
  });

  it("turns missing config and Waffo not-approved into stable 503", async () => {
    const db = createMemoryConnectDb();
    const cookie = await loggedIn(db);
    const missing = await handleRequest(new Request("https://dev.example/api/checkout", {
      method: "POST", body: JSON.stringify({ tier: "quarter" }), headers: { cookie, "content-type": "application/json" },
    }), deps(db, { waffoApi: undefined }));
    expect(missing.status).toBe(503);
    const notApproved = Object.assign(new Error("Store is not approved for production payments"), { code: "WAFFO_STORE_NOT_APPROVED" });
    const rejected = await handleRequest(new Request("https://dev.example/api/checkout", {
      method: "POST", body: JSON.stringify({ tier: "quarter" }), headers: { cookie, "content-type": "application/json" },
    }), deps(db, { waffoApi: api({ createSession: vi.fn(async () => { throw notApproved; }) }) }));
    expect(rejected.status).toBe(503);
    expect(await rejected.json()).toEqual({ error: "checkout_not_open" });
  });
});

describe("Waffo webhook and status compensation", () => {
  it("verifies, fulfills once, and ignores duplicate delivery", async () => {
    const db = createMemoryConnectDb();
    const cookie = await loggedIn(db);
    const routeDeps = deps(db, { waffoApi: api() });
    const checkout = await handleRequest(new Request("https://dev.example/api/checkout", {
      method: "POST", body: JSON.stringify({ tier: "quarter" }), headers: { cookie, "content-type": "application/json" },
    }), routeDeps);
    const created = await checkout.json() as { orderId: string };
    const order = await db.getPaymentOrderById(created.orderId);
    const waffo = api({ verifyWebhook: vi.fn(async () => completedEvent(order!.out_trade_no)) });
    const webhookDeps = deps(db, { waffoApi: waffo });
    const request = () => new Request("https://dev.example/api/waffo/webhook", {
      method: "POST", body: "{}", headers: { "x-waffo-signature": "t=1,v1=sig" },
    });
    expect((await handleRequest(request(), webhookDeps)).status).toBe(200);
    expect((await handleRequest(request(), webhookDeps)).status).toBe(200);
    expect((await db.listEntitlements("act_1"))).toHaveLength(1);
    expect((await db.getPaymentOrderById(created.orderId))?.status).toBe("fulfilled");
  });

  it("ignores an order.completed event without our external order id", async () => {
    const db = createMemoryConnectDb();
    await loggedIn(db);
    const waffo = api({ verifyWebhook: vi.fn(async () => ({
      eventType: "order.completed", mode: "test", storeId: "STO_TEST",
      data: {
        orderId: "ORD_OUTSIDE_SITE", paymentId: "PAY_OUTSIDE_SITE", currency: "CNY",
        listPrice: { total: "45.00" }, paymentStatus: "succeeded",
      },
    })) });
    const response = await handleRequest(new Request("https://dev.example/api/waffo/webhook", {
      method: "POST", body: "{}", headers: { "x-waffo-signature": "t=1,v1=sig" },
    }), deps(db, { waffoApi: waffo }));
    expect(response.status).toBe(200);
    expect(await db.listEntitlements("act_1")).toHaveLength(0);
    expect(await db.listPaymentOrdersForReconciliation("waffo", "2020-01-01T00:00:00.000Z")).toHaveLength(0);
  });

  it("rejects bad signature, mode/store mismatch, and amount mismatch", async () => {
    const db = createMemoryConnectDb();
    await loggedIn(db);
    const badSignature = api({ verifyWebhook: vi.fn(async () => { throw new Error("bad signature"); }) });
    const base = deps(db, { waffoApi: badSignature });
    const request = () => new Request("https://dev.example/api/waffo/webhook", { method: "POST", body: "{}", headers: { "x-waffo-signature": "bad" } });
    expect((await handleRequest(request(), base)).status).toBe(401);
    const mode = api({ verifyWebhook: vi.fn(async () => ({ ...completedEvent("missing"), mode: "prod" as const })) });
    expect((await handleRequest(request(), deps(db, { waffoApi: mode }))).status).toBe(400);
    const store = api({ verifyWebhook: vi.fn(async () => ({ ...completedEvent("missing"), storeId: "STO_OTHER" })) });
    expect((await handleRequest(request(), deps(db, { waffoApi: store }))).status).toBe(400);
  });

  it("maps a stale webhook timestamp verification error to 401", async () => {
    const db = createMemoryConnectDb();
    const stale = api({ verifyWebhook: vi.fn(async () => { throw new Error("Webhook timestamp outside tolerance window"); }) });
    const request = new Request("https://dev.example/api/waffo/webhook", {
      method: "POST", body: "{}", headers: { "x-waffo-signature": "t=1,v1=sig" },
    });
    expect((await handleRequest(request, deps(db, { waffoApi: stale }))).status).toBe(401);
  });

  it("queries a succeeded payment for the owner and fulfills even after local expiry", async () => {
    const db = createMemoryConnectDb();
    const cookie = await loggedIn(db);
    const order = await db.insertPaymentOrder({
      id: "ord_expired", checkout_token_sha256: "a".repeat(64), account_id: "act_1", provider: "waffo",
      out_trade_no: "MC_expired", trade_no: null, waffo_session_id: "cs", waffo_order_id: null,
      months: 3, total_amount: "45.00", status: "created", created_at: "2026-09-01T00:00:00.000Z",
      expires_at: "2026-09-01T00:30:00.000Z", paid_at: null, fulfilled_at: null, closed_at: null,
      refunded_at: null, refund_request_no: null, last_notify_id: null, last_queried_at: null,
    });
    const waffo = api({ queryPayments: vi.fn(async () => [{ id: "PAY_Q", orderId: "ORD_Q", status: "succeeded", amount: { amount: "4500", currency: "CNY", display: "45.00" }, testMode: true, orderMerchantExternalId: order.out_trade_no }]) });
    const response = await handleRequest(new Request(`https://dev.example/api/orders/${order.id}/status`, { headers: { cookie } }), deps(db, { waffoApi: waffo }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "fulfilled" });
  });

  it("chooses an older succeeded payment when the newest payment failed", async () => {
    const db = createMemoryConnectDb();
    const cookie = await loggedIn(db);
    const order = await db.insertPaymentOrder({
      id: "ord_multiple", checkout_token_sha256: "b".repeat(64), account_id: "act_1", provider: "waffo",
      out_trade_no: "MC_multiple", trade_no: null, waffo_session_id: "cs", waffo_order_id: null,
      months: 3, total_amount: "45.00", status: "created", created_at: NOW,
      expires_at: "2026-10-02T10:30:00.000Z", paid_at: null, fulfilled_at: null, closed_at: null,
      refunded_at: null, refund_request_no: null, last_notify_id: null, last_queried_at: null,
    });
    const payments = [
      { id: "PAY_NEW", orderId: "ORD_NEW", status: "failed", amount: { amount: "4500", currency: "CNY", display: "45.00" }, testMode: true, orderMerchantExternalId: order.out_trade_no },
      { id: "PAY_OLD", orderId: "ORD_OLD", status: "succeeded", amount: { amount: "4500", currency: "CNY", display: "45.00" }, testMode: true, orderMerchantExternalId: order.out_trade_no },
    ];
    const waffo = api({ queryPayments: vi.fn(async () => payments) });
    const response = await handleRequest(new Request(`https://dev.example/api/orders/${order.id}/status`, { headers: { cookie } }), deps(db, { waffoApi: waffo }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "fulfilled" });
  });

  it("lets a fully refunded payment win over a succeeded payment", async () => {
    const db = createMemoryConnectDb();
    const cookie = await loggedIn(db);
    const order = await db.insertPaymentOrder({
      id: "ord_refund_first", checkout_token_sha256: "c".repeat(64), account_id: "act_1", provider: "waffo",
      out_trade_no: "MC_refund_first", trade_no: null, waffo_session_id: "cs", waffo_order_id: null,
      months: 3, total_amount: "45.00", status: "created", created_at: NOW,
      expires_at: "2026-10-02T10:30:00.000Z", paid_at: null, fulfilled_at: null, closed_at: null,
      refunded_at: null, refund_request_no: null, last_notify_id: null, last_queried_at: null,
    });
    const waffo = api({ queryPayments: vi.fn(async () => [
      { id: "PAY_SUCCEEDED", orderId: "ORD_SUCCEEDED", status: "succeeded", amount: { amount: "4500", currency: "CNY", display: "45.00" }, testMode: true, orderMerchantExternalId: order.out_trade_no },
      { id: "PAY_REFUNDED", orderId: "ORD_REFUNDED", status: "succeeded", amount: { amount: "4500", currency: "CNY", display: "45.00" }, refundedAmount: { amount: "4500", currency: "CNY", display: "45.00" }, isFullyRefunded: true, testMode: true, orderMerchantExternalId: order.out_trade_no },
    ]) });
    const response = await handleRequest(new Request(`https://dev.example/api/orders/${order.id}/status`, { headers: { cookie } }), deps(db, { waffoApi: waffo }));
    expect(response.status).toBe(200);
    expect(["pending", "expired", "closed"]).toContain((await response.json() as { status: string }).status);
    expect(await db.listEntitlements("act_1")).toHaveLength(0);
  });

  it("acknowledges a full refund webhook for an unpaid order without touching the ledger", async () => {
    const db = createMemoryConnectDb();
    await loggedIn(db);
    const order = await db.insertPaymentOrder({
      id: "ord_refund_webhook", checkout_token_sha256: "d".repeat(64), account_id: "act_1", provider: "waffo",
      out_trade_no: "MC_refund_webhook", trade_no: null, waffo_session_id: "cs", waffo_order_id: null,
      months: 3, total_amount: "45.00", status: "created", created_at: NOW,
      expires_at: "2026-10-02T10:30:00.000Z", paid_at: null, fulfilled_at: null, closed_at: null,
      refunded_at: null, refund_request_no: null, last_notify_id: null, last_queried_at: null,
    });
    const waffo = api({ verifyWebhook: vi.fn(async () => ({
      eventType: "refund.succeeded", mode: "test", storeId: "STO_TEST",
      data: { orderMerchantExternalId: order.out_trade_no, refundedAmount: "45.00" },
    })) });
    const response = await handleRequest(new Request("https://dev.example/api/waffo/webhook", {
      method: "POST", body: "{}", headers: { "x-waffo-signature": "t=1,v1=sig" },
    }), deps(db, { waffoApi: waffo }));
    expect(response.status).toBe(200);
    expect(await db.listEntitlements("act_1")).toHaveLength(0);
    expect((await db.getPaymentOrderById(order.id))?.status).toBe("created");
  });

  it("returns a non-error status when status compensation sees a full refund on an unpaid order", async () => {
    const db = createMemoryConnectDb();
    const cookie = await loggedIn(db);
    const order = await db.insertPaymentOrder({
      id: "ord_refund_status", checkout_token_sha256: "e".repeat(64), account_id: "act_1", provider: "waffo",
      out_trade_no: "MC_refund_status", trade_no: null, waffo_session_id: "cs", waffo_order_id: null,
      months: 3, total_amount: "45.00", status: "created", created_at: NOW,
      expires_at: "2026-10-02T10:30:00.000Z", paid_at: null, fulfilled_at: null, closed_at: null,
      refunded_at: null, refund_request_no: null, last_notify_id: null, last_queried_at: null,
    });
    const waffo = api({ queryPayments: vi.fn(async () => [{
      id: "PAY_REFUNDED_STATUS", orderId: "ORD_REFUNDED_STATUS", status: "succeeded",
      amount: { amount: "4500", currency: "CNY", display: "45.00" },
      refundedAmount: { amount: "4500", currency: "CNY", display: "45.00" }, isFullyRefunded: true,
      testMode: true, orderMerchantExternalId: order.out_trade_no,
    }]) });
    const response = await handleRequest(new Request(`https://dev.example/api/orders/${order.id}/status`, { headers: { cookie } }), deps(db, { waffoApi: waffo }));
    expect(response.status).toBe(200);
    expect(["pending", "expired", "closed"]).toContain((await response.json() as { status: string }).status);
    expect(await db.listEntitlements("act_1")).toHaveLength(0);
  });
});
