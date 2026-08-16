import { describe, expect, it } from "vitest";
import type { AlipayApi, AlipayTradeResult } from "./alipay-api.js";
import {
  acceptAlipayNotification,
  acceptAlipayPayment,
  compensateAlipayOrder,
  fulfillAlipayOrder,
  type AlipayServiceDeps,
} from "./alipay-service.js";
import { createMemoryConnectDb, type ConnectDb, type PaymentOrderRow } from "./db.js";

const NOW = "2026-08-16T08:00:00.000Z";

function api(overrides: Partial<AlipayApi> = {}): AlipayApi {
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
    async verifyNotification() {
      return true;
    },
    ...overrides,
  };
}

function serviceDeps(
  db: ConnectDb,
  overrides: Partial<AlipayServiceDeps> = {},
): AlipayServiceDeps {
  let accountId = 0;
  let entitlementId = 0;
  return {
    db,
    alipayApi: api(),
    alipayAppId: "app-connect",
    alipaySellerId: "seller-connect",
    now: () => NOW,
    newAccountId: () => `act_new_${++accountId}`,
    newEntitlementId: () => `ent_${++entitlementId}`,
    ...overrides,
  };
}

function order(overrides: Partial<PaymentOrderRow> = {}): PaymentOrderRow {
  return {
    id: "ord_1",
    checkout_token_sha256: "a".repeat(64),
    account_id: "act_1",
    provider: "alipay",
    out_trade_no: "MC202608160001",
    trade_no: null,
    months: 3,
    total_amount: "45.00",
    status: "form_issued",
    created_at: NOW,
    expires_at: "2026-08-16T08:20:00.000Z",
    paid_at: null,
    fulfilled_at: null,
    closed_at: null,
    refunded_at: null,
    refund_request_no: null,
    last_notify_id: null,
    ...overrides,
  };
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

function paidQuery(row: PaymentOrderRow, overrides: Partial<AlipayTradeResult> = {}): AlipayTradeResult {
  return {
    code: "10000",
    msg: "Success",
    out_trade_no: row.out_trade_no,
    trade_no: "2026081622000000000001",
    trade_status: "TRADE_SUCCESS",
    total_amount: row.total_amount,
    ...overrides,
  };
}

describe("Alipay evidence and fulfillment", () => {
  it("marks paid then grants the unchanged entitlement exactly once", async () => {
    const db = createMemoryConnectDb();
    const row = await seed(db);
    const deps = serviceDeps(db);

    const first = await acceptAlipayPayment(
      {
        outTradeNo: row.out_trade_no,
        tradeNo: "trade_1",
        totalAmount: "45.0",
        notifyId: "notify_1",
      },
      deps,
    );
    const replay = await acceptAlipayPayment(
      {
        outTradeNo: row.out_trade_no,
        tradeNo: "trade_1",
        totalAmount: "45.00",
        notifyId: "notify_1",
      },
      deps,
    );

    expect(first.status).toBe("fulfilled");
    expect(replay.status).toBe("fulfilled");
    expect(await db.getPaymentOrderById(row.id)).toMatchObject({
      status: "fulfilled",
      trade_no: "trade_1",
      last_notify_id: "notify_1",
      paid_at: NOW,
      fulfilled_at: NOW,
    });
    expect(await db.listEntitlements(row.account_id)).toHaveLength(1);
    expect(await db.getEntitlementByPayment("alipay", row.out_trade_no)).toMatchObject({
      account_id: row.account_id,
      months: 3,
      source: "alipay",
    });
  });

  it("keeps a durable paid state when grant fails, then repairs on retry", async () => {
    const base = createMemoryConnectDb();
    const row = await seed(base);
    let fail = true;
    const flaky: ConnectDb = {
      ...base,
      async insertEntitlement(entitlement) {
        if (fail) {
          fail = false;
          throw new Error("simulated D1 write failure");
        }
        return base.insertEntitlement(entitlement);
      },
    };
    const deps = serviceDeps(flaky);

    await expect(
      acceptAlipayPayment(
        { outTradeNo: row.out_trade_no, tradeNo: "trade_1", totalAmount: "45.00" },
        deps,
      ),
    ).rejects.toThrow(/simulated D1/i);
    expect((await base.getPaymentOrderById(row.id))?.status).toBe("paid");

    await expect(compensateAlipayOrder(row.id, deps)).resolves.toMatchObject({ status: "fulfilled" });
    expect(await base.listEntitlements(row.account_id)).toHaveLength(1);
  });

  it("exposes paid_unfulfilled state while a persistent grant failure is still retryable", async () => {
    const base = createMemoryConnectDb();
    const row = await seed(base, order({ status: "paid", trade_no: "trade_1", paid_at: NOW }));
    const unavailable: ConnectDb = {
      ...base,
      async insertEntitlement() {
        throw new Error("D1 still unavailable");
      },
    };
    const result = await compensateAlipayOrder(row.id, serviceDeps(unavailable));
    expect(result.status).toBe("paid");
    expect(await base.listEntitlements(row.account_id)).toEqual([]);
  });

  it("notify and query racing converge on one entitlement", async () => {
    const db = createMemoryConnectDb();
    const row = await seed(db);
    const deps = serviceDeps(db, {
      alipayApi: api({ async queryTrade() { return paidQuery(row); } }),
    });
    const params = new URLSearchParams({
      app_id: "app-connect",
      seller_id: "seller-connect",
      out_trade_no: row.out_trade_no,
      trade_no: "2026081622000000000001",
      total_amount: "45.00",
      trade_status: "TRADE_SUCCESS",
      notify_id: "notify_race",
      sign: "verified-by-fake",
    });

    await Promise.all([acceptAlipayNotification(params, deps), compensateAlipayOrder(row.id, deps)]);
    expect((await db.getPaymentOrderById(row.id))?.status).toBe("fulfilled");
    expect(await db.listEntitlements(row.account_id)).toHaveLength(1);
  });

  it("rejects wrong amount and a conflicting provider trade number", async () => {
    const db = createMemoryConnectDb();
    const row = await seed(db);
    const deps = serviceDeps(db);
    await expect(
      acceptAlipayPayment(
        { outTradeNo: row.out_trade_no, tradeNo: "trade_1", totalAmount: "0.01" },
        deps,
      ),
    ).rejects.toThrow(/amount/i);
    await acceptAlipayPayment(
      { outTradeNo: row.out_trade_no, tradeNo: "trade_1", totalAmount: "45.00" },
      deps,
    );
    await expect(
      acceptAlipayPayment(
        { outTradeNo: row.out_trade_no, tradeNo: "trade_other", totalAmount: "45.00" },
        deps,
      ),
    ).rejects.toThrow(/trade/i);
  });

  it("fulfill refuses an order that has no verified paid state", async () => {
    const db = createMemoryConnectDb();
    const row = await seed(db);
    await expect(fulfillAlipayOrder(row, serviceDeps(db))).rejects.toThrow(/paid/i);
    expect(await db.listEntitlements(row.account_id)).toEqual([]);
  });
});

describe("signed query compensation", () => {
  it("accepts signed paid evidence only after exact amount matching", async () => {
    const db = createMemoryConnectDb();
    const row = await seed(db);
    const result = await compensateAlipayOrder(
      row.id,
      serviceDeps(db, { alipayApi: api({ async queryTrade() { return paidQuery(row); } }) }),
    );
    expect(result.status).toBe("fulfilled");
  });

  it("does not terminal-cache WAIT_BUYER_PAY and sees success on the next call", async () => {
    const db = createMemoryConnectDb();
    const row = await seed(db);
    let calls = 0;
    const deps = serviceDeps(db, {
      alipayApi: api({
        async queryTrade() {
          calls += 1;
          return calls === 1
            ? paidQuery(row, { trade_status: "WAIT_BUYER_PAY" })
            : paidQuery(row);
        },
      }),
    });

    expect((await compensateAlipayOrder(row.id, deps)).status).toBe("pending");
    expect((await compensateAlipayOrder(row.id, deps)).status).toBe("fulfilled");
    expect(calls).toBe(2);
  });

  it("maps a verified closed result without granting", async () => {
    const db = createMemoryConnectDb();
    const row = await seed(db);
    const result = await compensateAlipayOrder(
      row.id,
      serviceDeps(db, {
        alipayApi: api({
          async queryTrade() {
            return paidQuery(row, { trade_status: "TRADE_CLOSED" });
          },
        }),
      }),
    );
    expect(result.status).toBe("closed");
    expect(await db.listEntitlements(row.account_id)).toEqual([]);
  });

  it("rejects a paid query response with the wrong amount", async () => {
    const db = createMemoryConnectDb();
    const row = await seed(db);
    await expect(
      compensateAlipayOrder(
        row.id,
        serviceDeps(db, {
          alipayApi: api({ async queryTrade() { return paidQuery(row, { total_amount: "44.99" }); } }),
        }),
      ),
    ).rejects.toThrow(/amount/i);
    expect((await db.getPaymentOrderById(row.id))?.status).not.toBe("fulfilled");
  });
});
