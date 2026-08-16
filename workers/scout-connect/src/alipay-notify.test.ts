import { describe, expect, it } from "vitest";
import type { AlipayApi, AlipayTradeResult } from "./alipay-api.js";
import { createMemoryConnectDb, type ConnectDb, type PaymentOrderRow } from "./db.js";
import { buildSessionCookie } from "./session.js";
import { handleRequest, type RouteDeps } from "./routes.js";

const BASE = "https://mediaryconnect.app";
const NOW = "2026-08-16T08:00:00.000Z";
const SECRET = "c".repeat(64);

function order(overrides: Partial<PaymentOrderRow> = {}): PaymentOrderRow {
  return {
    id: "ord_notify",
    checkout_token_sha256: "d".repeat(64),
    account_id: "act_buyer",
    provider: "alipay",
    out_trade_no: "MC202608160099",
    trade_no: null,
    months: 12,
    total_amount: "108.00",
    status: "form_issued",
    created_at: NOW,
    expires_at: "2026-08-16T08:20:00.000Z",
    paid_at: null,
    fulfilled_at: null,
    closed_at: null,
    refunded_at: null,
    refund_request_no: null,
    last_notify_id: null,
    last_queried_at: null,
    ...overrides,
  };
}

function fakeApi(overrides: Partial<AlipayApi> = {}): AlipayApi {
  return {
    async pagePayForm() {
      return "";
    },
    async queryTrade() {
      return null;
    },
    async closeTrade() {
      throw new Error("unused");
    },
    async refundTrade() {
      throw new Error("unused");
    },
    async queryRefund() {
      throw new Error("unused");
    },
    async verifyNotification(params) {
      return params.get("sign") !== "bad";
    },
    ...overrides,
  };
}

function setup(
  overrides: Partial<RouteDeps> = {},
  suppliedDb?: ConnectDb,
): { db: ConnectDb; deps: RouteDeps } {
  const db = suppliedDb ?? createMemoryConnectDb();
  let id = 0;
  const deps: RouteDeps = {
    db,
    cf: {} as never,
    adminToken: "admin",
    rootDomain: "mediaryconnect.app",
    tokenWrapKeyHex: "e".repeat(64),
    now: () => NOW,
    newInviteId: () => `inv_${++id}`,
    newEndpointId: () => `ep_${++id}`,
    newAuditId: () => `aud_${++id}`,
    newInviteCode: () => `code_${++id}`,
    newAccountId: () => `act_${++id}`,
    newEntitlementId: () => `ent_${++id}`,
    sessionSecret: SECRET,
    sendMagicLink: async () => {},
    alipayApi: fakeApi(),
    alipayAppId: "app-connect",
    alipaySellerId: "seller-connect",
    ...overrides,
  };
  return { db, deps };
}

async function seed(db: ConnectDb, row = order()): Promise<PaymentOrderRow> {
  await db.insertAccount({
    id: row.account_id,
    email: "buyer@example.com",
    paddle_customer_id: null,
    created_at: NOW,
    last_login_at: null,
  });
  return db.insertPaymentOrder(row);
}

function notifyParams(row: PaymentOrderRow, overrides: Record<string, string> = {}): URLSearchParams {
  return new URLSearchParams({
    app_id: "app-connect",
    seller_id: "seller-connect",
    out_trade_no: row.out_trade_no,
    trade_no: "2026081622000000000099",
    total_amount: row.total_amount,
    trade_status: "TRADE_SUCCESS",
    notify_id: "notify_99",
    sign_type: "RSA2",
    sign: "valid",
    ...overrides,
  });
}

async function postNotify(deps: RouteDeps, params: URLSearchParams): Promise<Response> {
  return handleRequest(
    new Request(`${BASE}/api/alipay/notify`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    }),
    deps,
  );
}

async function cookieFor(accountId: string): Promise<string> {
  return buildSessionCookie(accountId, { secret: SECRET, ttlMs: 60 * 60_000, now: Date.parse(NOW) });
}

function paidQuery(row: PaymentOrderRow): AlipayTradeResult {
  return {
    code: "10000",
    out_trade_no: row.out_trade_no,
    trade_no: "2026081622000000000099",
    trade_status: "TRADE_SUCCESS",
    total_amount: row.total_amount,
  };
}

describe("POST /api/alipay/notify", () => {
  it("returns exactly success only after verified fulfillment", async () => {
    const { db, deps } = setup();
    const row = await seed(db);

    const response = await postNotify(deps, notifyParams(row));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe("success");
    expect((await db.getPaymentOrderById(row.id))?.status).toBe("fulfilled");
    expect(await db.listEntitlements(row.account_id)).toHaveLength(1);

    expect((await postNotify(deps, notifyParams(row))).status).toBe(200);
    expect(await db.listEntitlements(row.account_id)).toHaveLength(1);
  });

  it("rejects bad signature, app, seller, amount, order, and non-paid state", async () => {
    const cases: Array<[string, Record<string, string>]> = [
      ["signature", { sign: "bad" }],
      ["app", { app_id: "other-app" }],
      ["seller", { seller_id: "other-seller" }],
      ["amount", { total_amount: "0.01" }],
      ["order", { out_trade_no: "MC_UNKNOWN" }],
      ["state", { trade_status: "WAIT_BUYER_PAY" }],
    ];
    for (const [label, change] of cases) {
      const { db, deps } = setup();
      const row = await seed(db);
      const response = await postNotify(deps, notifyParams(row, change));
      expect(response.status, label).toBe(400);
      expect(await response.text(), label).not.toBe("success");
      expect(await db.listEntitlements(row.account_id), label).toEqual([]);
    }
  });

  it("acknowledges signed refund or other business events without granting payment rights", async () => {
    const eventShapes = [
      { out_biz_no: "refund_business_1" },
      { gmt_refund: "2026-08-16 16:10:00" },
      { refund_fee: "108.00" },
    ];
    for (const eventShape of eventShapes) {
      const { db, deps } = setup();
      const row = await seed(db);
      const response = await postNotify(deps, notifyParams(row, eventShape));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("success");
      expect((await db.getPaymentOrderById(row.id))?.status).toBe("form_issued");
      expect(await db.listEntitlements(row.account_id)).toEqual([]);
    }
  });

  it("returns retryable failure when config or fulfillment storage is unavailable", async () => {
    const missing = setup({ alipayAppId: undefined });
    const missingRow = await seed(missing.db);
    const missingResponse = await postNotify(missing.deps, notifyParams(missingRow));
    expect(missingResponse.status).toBe(503);
    expect(await missingResponse.text()).not.toBe("success");

    const base = createMemoryConnectDb();
    let fail = true;
    const flaky: ConnectDb = {
      ...base,
      async insertEntitlement(entitlement) {
        if (fail) {
          fail = false;
          throw new Error("D1 unavailable");
        }
        return base.insertEntitlement(entitlement);
      },
    };
    const configured = setup({}, flaky);
    const row = await seed(base);
    const first = await postNotify(configured.deps, notifyParams(row));
    expect(first.status).toBe(503);
    expect(await first.text()).not.toBe("success");
    expect((await base.getPaymentOrderById(row.id))?.status).toBe("paid");
    const retry = await postNotify(configured.deps, notifyParams(row));
    expect(retry.status).toBe(200);
    expect(await retry.text()).toBe("success");
  });
});

describe("owned order status query compensation", () => {
  it("uses a signed query result to fulfill, returning only the minimal state", async () => {
    const row = order();
    const { db, deps } = setup({
      alipayApi: fakeApi({ async queryTrade() { return paidQuery(row); } }),
    });
    await seed(db, row);
    const response = await handleRequest(
      new Request(`${BASE}/api/alipay/orders/${row.id}/status`, {
        headers: { cookie: await cookieFor(row.account_id) },
      }),
      deps,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "fulfilled" });
    expect(await db.listEntitlements(row.account_id)).toHaveLength(1);
  });

  it("keeps WAIT_BUYER_PAY queryable and retries on the next poll", async () => {
    const row = order();
    let calls = 0;
    const { db, deps } = setup({
      alipayApi: fakeApi({
        async queryTrade() {
          calls += 1;
          return calls === 1 ? { ...paidQuery(row), trade_status: "WAIT_BUYER_PAY" } : paidQuery(row);
        },
      }),
    });
    await seed(db, row);
    const request = async () =>
      handleRequest(
        new Request(`${BASE}/api/alipay/orders/${row.id}/status`, {
          headers: { cookie: await cookieFor(row.account_id) },
        }),
        deps,
      );
    expect(await (await request()).json()).toEqual({ status: "pending" });
    deps.now = () => "2026-08-16T08:00:03.000Z";
    expect(await (await request()).json()).toEqual({ status: "fulfilled" });
    expect(calls).toBe(2);
  });

  it("returns no-store 503 for an unverifiable query response and retries later", async () => {
    const row = order();
    const { db, deps } = setup({
      alipayApi: fakeApi({ async queryTrade() { throw new Error("signature invalid"); } }),
    });
    await seed(db, row);
    const response = await handleRequest(
      new Request(`${BASE}/api/alipay/orders/${row.id}/status`, {
        headers: { cookie: await cookieFor(row.account_id) },
      }),
      deps,
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await db.listEntitlements(row.account_id)).toEqual([]);
  });

  it("notify and query racing still grant one entitlement", async () => {
    const row = order();
    const { db, deps } = setup({
      alipayApi: fakeApi({ async queryTrade() { return paidQuery(row); } }),
    });
    await seed(db, row);
    const [notify, status] = await Promise.all([
      postNotify(deps, notifyParams(row)),
      handleRequest(
        new Request(`${BASE}/api/alipay/orders/${row.id}/status`, {
          headers: { cookie: await cookieFor(row.account_id) },
        }),
        deps,
      ),
    ]);
    expect(notify.status).toBe(200);
    expect(status.status).toBe(200);
    expect(await db.listEntitlements(row.account_id)).toHaveLength(1);
  });
});
