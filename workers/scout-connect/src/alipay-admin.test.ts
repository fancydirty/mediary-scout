import { describe, expect, it } from "vitest";
import type {
  AlipayApi,
  AlipayCloseResult,
  AlipayRefundQueryResult,
  AlipayRefundResult,
  AlipayTradeResult,
} from "./alipay-api.js";
import type { CfApi } from "./cf-api.js";
import {
  createMemoryConnectDb,
  type ConnectDb,
  type EndpointRow,
  type PaymentOrderRow,
} from "./db.js";
import { buildSessionCookie } from "./session.js";
import { handleRequest, type RouteDeps } from "./routes.js";

const BASE = "https://mediaryconnect.app";
const NOW = "2026-08-16T08:00:00.000Z";
const SECRET = "f".repeat(64);

interface ApiState {
  refundCalls: Array<{ outTradeNo: string; outRequestNo: string; refundAmount: string }>;
  closeCalls: string[];
  queryCalls: string[];
  refundQueryCalls: Array<{ outTradeNo: string; outRequestNo: string }>;
  refundResult: AlipayRefundResult;
  refundQueryResult: AlipayRefundQueryResult | null;
  closeResult: AlipayCloseResult;
  tradeQueryResult: AlipayTradeResult | null;
}

function apiState(): ApiState {
  return {
    refundCalls: [],
    closeCalls: [],
    queryCalls: [],
    refundQueryCalls: [],
    refundResult: { code: "10000", out_trade_no: "", fund_change: "Y", refund_fee: "108.00" },
    refundQueryResult: null,
    closeResult: { code: "10000" },
    tradeQueryResult: null,
  };
}

function fakeApi(state: ApiState): AlipayApi {
  return {
    async pagePayForm() {
      return "";
    },
    async queryTrade(outTradeNo) {
      state.queryCalls.push(outTradeNo);
      return state.tradeQueryResult;
    },
    async closeTrade(outTradeNo) {
      state.closeCalls.push(outTradeNo);
      return { ...state.closeResult, out_trade_no: state.closeResult.out_trade_no ?? outTradeNo };
    },
    async refundTrade(input) {
      state.refundCalls.push(input);
      return {
        ...state.refundResult,
        out_trade_no: state.refundResult.out_trade_no || input.outTradeNo,
        refund_fee: state.refundResult.refund_fee ?? input.refundAmount,
      };
    },
    async queryRefund(input) {
      state.refundQueryCalls.push(input);
      if (state.refundQueryResult === null) return null;
      return {
        ...state.refundQueryResult,
        out_trade_no: state.refundQueryResult.out_trade_no || input.outTradeNo,
        out_request_no: state.refundQueryResult.out_request_no || input.outRequestNo,
      };
    },
    async verifyNotification() {
      return true;
    },
  };
}

function fakeCf(calls: string[]): CfApi {
  return {
    async createTunnel() { throw new Error("unused"); },
    async getTunnelToken() { throw new Error("unused"); },
    async putTunnelIngress() { throw new Error("unused"); },
    async createDnsCname() { throw new Error("unused"); },
    async createAccessApp() { throw new Error("unused"); },
    async deleteAccessApp(id) { calls.push(`access:${id}`); },
    async deleteDnsRecord(id) { calls.push(`dns:${id}`); },
    async deleteTunnel(id) { calls.push(`tunnel:${id}`); },
  };
}

function setup(): {
  db: ConnectDb;
  deps: RouteDeps;
  api: ApiState;
  cfCalls: string[];
} {
  const db = createMemoryConnectDb();
  const api = apiState();
  const cfCalls: string[] = [];
  let id = 0;
  const deps: RouteDeps = {
    db,
    cf: fakeCf(cfCalls),
    adminToken: "admin-token",
    rootDomain: "mediaryconnect.app",
    tokenWrapKeyHex: "a".repeat(64),
    now: () => NOW,
    newInviteId: () => `inv_${++id}`,
    newEndpointId: () => `ep_${++id}`,
    newAuditId: () => `aud_${++id}`,
    newInviteCode: () => `code_${++id}`,
    newAccountId: () => `act_${++id}`,
    newEntitlementId: () => `ent_${++id}`,
    newAlipayRefundRequestNo: () => `RF_TEST_${++id}`,
    sessionSecret: SECRET,
    sendMagicLink: async () => {},
    alipayApi: fakeApi(api),
    alipayAppId: "app-connect",
    alipaySellerId: "seller-connect",
  };
  return { db, deps, api, cfCalls };
}

function paymentOrder(overrides: Partial<PaymentOrderRow> = {}): PaymentOrderRow {
  return {
    id: "ord_refund",
    checkout_token_sha256: "b".repeat(64),
    account_id: "act_buyer",
    provider: "alipay",
    out_trade_no: "MC_REFUND_1",
    trade_no: "trade_refund_1",
    months: 12,
    total_amount: "108.00",
    status: "fulfilled",
    created_at: NOW,
    expires_at: "2026-08-16T08:20:00.000Z",
    paid_at: NOW,
    fulfilled_at: NOW,
    closed_at: null,
    refunded_at: null,
    refund_request_no: null,
    last_notify_id: "notify_1",
    ...overrides,
  };
}

async function seedAccount(db: ConnectDb, id = "act_buyer", email = "buyer@example.com"): Promise<void> {
  await db.insertAccount({ id, email, paddle_customer_id: null, created_at: NOW, last_login_at: null });
}

async function seedFulfilled(db: ConnectDb, row = paymentOrder()): Promise<PaymentOrderRow> {
  if ((await db.getAccountById(row.account_id)) === null) await seedAccount(db, row.account_id);
  await db.insertPaymentOrder(row);
  await db.insertEntitlement({
    id: `ent_${row.id}`,
    account_id: row.account_id,
    expires_at: "2027-08-16T08:00:00.000Z",
    source: "alipay",
    paddle_transaction_id: null,
    payment_provider: "alipay",
    payment_transaction_id: row.out_trade_no,
    refunded_at: null,
    months: row.months,
    created_at: row.created_at,
  });
  return row;
}

async function seedEndpoint(db: ConnectDb, accountId = "act_buyer"): Promise<EndpointRow> {
  return db.insertEndpoint({
    id: "ep_paid",
    invite_id: null,
    slug: "buyer",
    hostname: "buyer.mediaryconnect.app",
    cf_tunnel_id: "tun_1",
    cf_access_app_id: null,
    cf_access_policy_id: null,
    cf_dns_record_id: "dns_1",
    status: "active",
    token_sha256: "c".repeat(64),
    token_ciphertext: null,
    token_shown_at: null,
    last_seen_at: null,
    created_at: NOW,
    revoked_at: null,
    account_id: accountId,
    grace_until: null,
    suspended_at: null,
    purge_after: null,
  });
}

function adminRequest(path: string, method = "POST", body?: unknown, authorized = true): Request {
  return new Request(`${BASE}${path}`, {
    method,
    headers: {
      ...(authorized ? { authorization: "Bearer admin-token" } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function cookieFor(accountId: string): Promise<string> {
  return buildSessionCookie(accountId, { secret: SECRET, ttlMs: 60 * 60_000, now: Date.parse(NOW) });
}

describe("admin full Alipay refund", () => {
  it("refunds the exact amount, removes that entitlement, and revokes when no time remains", async () => {
    const { db, deps, api, cfCalls } = setup();
    const row = await seedFulfilled(db);
    await seedEndpoint(db);

    const response = await handleRequest(
      adminRequest("/api/admin/alipay/refund", "POST", { order_id: row.id }),
      deps,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "refunded", order_id: row.id });
    expect(api.refundCalls).toEqual([
      { outTradeNo: row.out_trade_no, outRequestNo: expect.stringMatching(/^RF_TEST_/), refundAmount: "108.00" },
    ]);
    expect((await db.getPaymentOrderById(row.id))?.status).toBe("refunded");
    expect((await db.listEntitlements(row.account_id))[0]?.refunded_at).toBe(NOW);
    expect((await db.getEndpointById("ep_paid"))?.status).toBe("revoked");
    expect(cfCalls).toEqual(["dns:dns_1", "tunnel:tun_1"]);

    const replay = await handleRequest(
      adminRequest("/api/admin/alipay/refund", "POST", { order_id: row.id }),
      deps,
    );
    expect(replay.status).toBe(200);
    expect(api.refundCalls).toHaveLength(1);
  });

  it("refunds only one stacked purchase and keeps an entitled endpoint active", async () => {
    const { db, deps, api, cfCalls } = setup();
    const first = await seedFulfilled(db, paymentOrder({ id: "ord_first", out_trade_no: "MC_FIRST", total_amount: "45.00", months: 3 }));
    await seedFulfilled(db, paymentOrder({
      id: "ord_second",
      checkout_token_sha256: "d".repeat(64),
      out_trade_no: "MC_SECOND",
      trade_no: "trade_2",
      created_at: "2026-08-16T08:00:01.000Z",
    }));
    await seedEndpoint(db);
    api.refundResult.refund_fee = "45.00";

    const response = await handleRequest(
      adminRequest("/api/admin/alipay/refund", "POST", { order_id: first.id }),
      deps,
    );
    expect(response.status).toBe(200);
    expect((await db.getEndpointById("ep_paid"))?.status).toBe("active");
    expect(cfCalls).toEqual([]);
    const effective = (await db.listEntitlements("act_buyer")).filter((entry) => entry.refunded_at === null);
    expect(effective).toHaveLength(1);
    expect(effective[0]?.payment_transaction_id).toBe("MC_SECOND");
  });

  it("persists a refund request and confirms a pending response through refund query", async () => {
    const { db, deps, api } = setup();
    const row = await seedFulfilled(db);
    api.refundResult.fund_change = "N";
    api.refundQueryResult = null;

    const started = await handleRequest(
      adminRequest("/api/admin/alipay/refund", "POST", { order_id: row.id }),
      deps,
    );
    expect(started.status).toBe(202);
    const startedBody = (await started.json()) as { refund_request_no: string };
    expect((await db.getPaymentOrderById(row.id))?.refund_request_no).toBe(startedBody.refund_request_no);

    api.refundQueryResult = {
      code: "10000",
      out_trade_no: row.out_trade_no,
      out_request_no: startedBody.refund_request_no,
      refund_status: "REFUND_SUCCESS",
      refund_amount: row.total_amount,
      total_amount: row.total_amount,
    };
    const confirmed = await handleRequest(
      adminRequest(`/api/admin/alipay/refund/${startedBody.refund_request_no}`, "GET"),
      deps,
    );
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toMatchObject({ status: "refunded", order_id: row.id });
  });

  it("rejects a refund-query amount mismatch without removing entitlement", async () => {
    const { db, deps, api } = setup();
    const row = await seedFulfilled(db);
    api.refundResult.fund_change = "N";
    const started = await handleRequest(
      adminRequest("/api/admin/alipay/refund", "POST", { order_id: row.id }),
      deps,
    );
    const requestNo = ((await started.json()) as { refund_request_no: string }).refund_request_no;
    api.refundQueryResult = {
      code: "10000",
      out_trade_no: row.out_trade_no,
      out_request_no: requestNo,
      refund_status: "REFUND_SUCCESS",
      refund_amount: "0.01",
      total_amount: row.total_amount,
    };
    const response = await handleRequest(
      adminRequest(`/api/admin/alipay/refund/${requestNo}`, "GET"),
      deps,
    );
    expect(response.status).toBe(502);
    expect((await db.getPaymentOrderById(row.id))?.status).toBe("fulfilled");
    expect((await db.listEntitlements(row.account_id))[0]?.refunded_at).toBeNull();
  });

  it("repairs a failed endpoint revoke without issuing a second external refund", async () => {
    const { db, deps, api } = setup();
    const row = await seedFulfilled(db);
    await seedEndpoint(db);
    let failTunnel = true;
    const calls: string[] = [];
    deps.cf = {
      ...fakeCf(calls),
      async deleteTunnel(id) {
        calls.push(`tunnel:${id}`);
        if (failTunnel) {
          failTunnel = false;
          throw new Error("temporary Cloudflare failure");
        }
      },
    };

    const request = () =>
      handleRequest(adminRequest("/api/admin/alipay/refund", "POST", { order_id: row.id }), deps);
    expect((await request()).status).toBe(502);
    expect((await db.getPaymentOrderById(row.id))?.status).toBe("refunded");
    expect((await db.getEndpointById("ep_paid"))?.status).toBe("revoke_failed");

    expect((await request()).status).toBe(200);
    expect((await db.getEndpointById("ep_paid"))?.status).toBe("revoked");
    expect(api.refundCalls).toHaveLength(1);
    expect(calls.filter((call) => call.startsWith("tunnel:"))).toHaveLength(2);
  });

  it("requires admin auth and hides unknown orders", async () => {
    const { deps, api } = setup();
    expect(
      (await handleRequest(adminRequest("/api/admin/alipay/refund", "POST", { order_id: "ord_x" }, false), deps)).status,
    ).toBe(401);
    expect(
      (await handleRequest(adminRequest("/api/admin/alipay/refund", "POST", { order_id: "ord_x" }), deps)).status,
    ).toBe(404);
    expect(api.refundCalls).toEqual([]);
  });
});

describe("logged-in Alipay close", () => {
  it("closes an owned unpaid order", async () => {
    const { db, deps, api } = setup();
    await seedAccount(db);
    const row = paymentOrder({ status: "form_issued", trade_no: null, paid_at: null, fulfilled_at: null });
    await db.insertPaymentOrder(row);
    const response = await handleRequest(
      new Request(`${BASE}/api/alipay/orders/${row.id}/close`, {
        method: "POST",
        headers: { cookie: await cookieFor(row.account_id) },
      }),
      deps,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "closed" });
    expect(api.closeCalls).toEqual([row.out_trade_no]);
    expect((await db.getPaymentOrderById(row.id))?.status).toBe("closed");
  });

  it("queries and fulfills instead of closing an already-paid order", async () => {
    const { db, deps, api } = setup();
    await seedAccount(db);
    const row = paymentOrder({ status: "paid", fulfilled_at: null });
    await db.insertPaymentOrder(row);
    api.tradeQueryResult = {
      code: "10000",
      out_trade_no: row.out_trade_no,
      trade_no: row.trade_no!,
      trade_status: "TRADE_SUCCESS",
      total_amount: row.total_amount,
    };
    const response = await handleRequest(
      new Request(`${BASE}/api/alipay/orders/${row.id}/close`, {
        method: "POST",
        headers: { cookie: await cookieFor(row.account_id) },
      }),
      deps,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ status: "fulfilled" });
    expect(api.queryCalls).toEqual([row.out_trade_no]);
    expect(api.closeCalls).toEqual([]);
    expect(await db.listEntitlements(row.account_id)).toHaveLength(1);
  });

  it("does not expose another account's order", async () => {
    const { db, deps, api } = setup();
    await seedAccount(db);
    await seedAccount(db, "act_other", "other@example.com");
    const row = paymentOrder({ status: "form_issued", trade_no: null, paid_at: null, fulfilled_at: null });
    await db.insertPaymentOrder(row);
    const response = await handleRequest(
      new Request(`${BASE}/api/alipay/orders/${row.id}/close`, {
        method: "POST",
        headers: { cookie: await cookieFor("act_other") },
      }),
      deps,
    );
    expect(response.status).toBe(404);
    expect(api.closeCalls).toEqual([]);
  });
});
