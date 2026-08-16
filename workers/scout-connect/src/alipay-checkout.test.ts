import { describe, expect, it } from "vitest";
import type { AlipayApi, PagePayInput } from "./alipay-api.js";
import { createMemoryConnectDb, type ConnectDb, type PaymentOrderRow } from "./db.js";
import { buildSessionCookie } from "./session.js";
import { handleRequest, type RouteDeps } from "./routes.js";

const BASE = "https://mediaryconnect.app";
const NOW = "2026-08-16T08:00:00.000Z";
const SECRET = "a".repeat(64);

function fakeAlipayApi(pagePayCalls: PagePayInput[]): AlipayApi {
  return {
    async pagePayForm(input) {
      pagePayCalls.push(input);
      return `<!doctype html><form method="post" action="https://openapi.alipay.com/gateway.do"><input name="out_trade_no" value="${input.outTradeNo}"></form>`;
    },
    async queryTrade(outTradeNo) {
      return {
        code: "10000",
        out_trade_no: outTradeNo,
        trade_status: "WAIT_BUYER_PAY",
      };
    },
    async closeTrade() {
      throw new Error("close is not part of the checkout-shell test");
    },
    async refundTrade() {
      throw new Error("refund is not part of the checkout-shell test");
    },
    async queryRefund() {
      throw new Error("refund query is not part of the checkout-shell test");
    },
    async verifyNotification() {
      return false;
    },
  };
}

function setup(overrides: Partial<RouteDeps> = {}): {
  db: ConnectDb;
  deps: RouteDeps;
  pagePayCalls: PagePayInput[];
} {
  const db = createMemoryConnectDb();
  const pagePayCalls: PagePayInput[] = [];
  let id = 0;
  const deps: RouteDeps = {
    db,
    cf: {} as never,
    adminToken: "admin",
    rootDomain: "mediaryconnect.app",
    tokenWrapKeyHex: "b".repeat(64),
    now: () => NOW,
    newInviteId: () => `inv_${++id}`,
    newEndpointId: () => `ep_${++id}`,
    newAuditId: () => `aud_${++id}`,
    newInviteCode: () => `code_${++id}`,
    newAccountId: () => `act_${++id}`,
    newEntitlementId: () => `ent_${++id}`,
    newPaymentOrderId: () => `ord_${++id}`,
    newAlipayOutTradeNo: () => `MC20260816${String(++id).padStart(8, "0")}`,
    newCheckoutToken: () => `checkout-secret-${++id}`,
    sessionSecret: SECRET,
    sendMagicLink: async () => {},
    alipayApi: fakeAlipayApi(pagePayCalls),
    ...overrides,
  };
  return { db, deps, pagePayCalls };
}

async function seedAccount(db: ConnectDb, id: string, email = `${id}@example.com`): Promise<void> {
  await db.insertAccount({
    id,
    email,
    paddle_customer_id: null,
    created_at: NOW,
    last_login_at: null,
  });
}

async function cookieFor(accountId: string): Promise<string> {
  return buildSessionCookie(accountId, {
    secret: SECRET,
    ttlMs: 60 * 60_000,
    now: Date.parse(NOW),
  });
}

async function createCheckout(deps: RouteDeps, body: unknown, cookie?: string): Promise<Response> {
  return handleRequest(
    new Request(`${BASE}/api/alipay/checkout`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cookie === undefined ? {} : { cookie }),
      },
      body: JSON.stringify(body),
    }),
    deps,
  );
}

async function createdOrder(
  db: ConnectDb,
  response: Response,
): Promise<{ order: PaymentOrderRow; checkoutUrl: string }> {
  const body = (await response.json()) as { order_id: string; checkout_url: string };
  const order = await db.getPaymentOrderById(body.order_id);
  expect(order).not.toBeNull();
  return { order: order!, checkoutUrl: body.checkout_url };
}

describe("POST /api/alipay/checkout", () => {
  it("binds a fixed server-side tier to the logged-in account and ignores client amounts", async () => {
    const { db, deps } = setup();
    await seedAccount(db, "act_buyer", "buyer@example.com");
    const response = await createCheckout(
      deps,
      { tier: "quarter", total_amount: "0.01", months: 999 },
      await cookieFor("act_buyer"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const { order, checkoutUrl } = await createdOrder(db, response);
    expect(order).toMatchObject({
      account_id: "act_buyer",
      provider: "alipay",
      months: 3,
      total_amount: "45.00",
      status: "created",
    });
    expect(order.checkout_token_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(order.checkout_token_sha256).not.toContain("checkout-secret");
    expect(checkoutUrl).toMatch(/^\/alipay\/checkout\?checkout=/);
  });

  it("supports all three unchanged prices", async () => {
    const { db, deps } = setup();
    await seedAccount(db, "act_buyer");
    const cookie = await cookieFor("act_buyer");
    for (const [tier, months, amount] of [
      ["quarter", 3, "45.00"],
      ["year", 12, "108.00"],
      ["two_year", 24, "188.00"],
    ] as const) {
      const { order } = await createdOrder(db, await createCheckout(deps, { tier }, cookie));
      expect(order).toMatchObject({ months, total_amount: amount });
    }
  });

  it("rejects unauthenticated, deleted-account, and unknown-tier requests", async () => {
    const { db, deps } = setup();
    expect((await createCheckout(deps, { tier: "quarter" })).status).toBe(401);
    expect(
      (await createCheckout(deps, { tier: "quarter" }, await cookieFor("act_missing"))).status,
    ).toBe(401);

    await seedAccount(db, "act_buyer");
    const cookie = await cookieFor("act_buyer");
    for (const tier of [undefined, "", "cheap", "__proto__", 12]) {
      expect((await createCheckout(deps, { tier }, cookie)).status, String(tier)).toBe(400);
    }
  });

  it("fails closed when Alipay is not configured", async () => {
    const { db, deps } = setup({ alipayApi: undefined });
    await seedAccount(db, "act_buyer");
    const response = await createCheckout(deps, { tier: "quarter" }, await cookieFor("act_buyer"));
    expect(response.status).toBe(503);
    expect(await db.getPaymentOrderById("ord_1")).toBeNull();
  });
});

describe("GET /alipay/checkout", () => {
  it("loads the hashed capability, reuses one out_trade_no, and returns an Alipay-only form", async () => {
    const { db, deps, pagePayCalls } = setup();
    await seedAccount(db, "act_buyer");
    const created = await createdOrder(
      db,
      await createCheckout(deps, { tier: "year" }, await cookieFor("act_buyer")),
    );

    for (let i = 0; i < 2; i += 1) {
      const response = await handleRequest(new Request(`${BASE}${created.checkoutUrl}`), deps);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-security-policy")).toContain(
        "form-action https://openapi.alipay.com",
      );
      expect(await response.text()).toContain("https://openapi.alipay.com/gateway.do");
    }

    expect(pagePayCalls).toHaveLength(2);
    expect(pagePayCalls[0]).toEqual({
      outTradeNo: created.order.out_trade_no,
      totalAmount: "108.00",
      subject: "Mediary Connect 年度",
      notifyUrl: "https://mediaryconnect.app/api/alipay/notify",
      returnUrl: `https://mediaryconnect.app/payment-success?order=${created.order.id}`,
    });
    expect(pagePayCalls[1]?.outTradeNo).toBe(pagePayCalls[0]?.outTradeNo);
    expect((await db.getPaymentOrderById(created.order.id))?.status).toBe("form_issued");
  });

  it("rejects missing, unknown, expired, and terminal capabilities", async () => {
    const { db, deps } = setup();
    await seedAccount(db, "act_buyer");
    expect((await handleRequest(new Request(`${BASE}/alipay/checkout`), deps)).status).toBe(404);
    expect(
      (await handleRequest(new Request(`${BASE}/alipay/checkout?checkout=unknown`), deps)).status,
    ).toBe(404);

    const expired = await createdOrder(
      db,
      await createCheckout(deps, { tier: "quarter" }, await cookieFor("act_buyer")),
    );
    deps.now = () => "2026-08-16T08:21:00.000Z";
    expect((await handleRequest(new Request(`${BASE}${expired.checkoutUrl}`), deps)).status).toBe(410);

    deps.now = () => NOW;
    const closed = await createdOrder(
      db,
      await createCheckout(deps, { tier: "quarter" }, await cookieFor("act_buyer")),
    );
    await db.updatePaymentOrder(closed.order.id, { status: "closed", closed_at: NOW });
    expect((await handleRequest(new Request(`${BASE}${closed.checkoutUrl}`), deps)).status).toBe(409);
  });
});

describe("GET /api/alipay/orders/:id/status", () => {
  it("is session-bound and maps only local order state", async () => {
    const { db, deps } = setup();
    await seedAccount(db, "act_owner");
    await seedAccount(db, "act_other");
    const ownerCookie = await cookieFor("act_owner");
    const created = await createdOrder(
      db,
      await createCheckout(deps, { tier: "two_year" }, ownerCookie),
    );
    const statusUrl = `${BASE}/api/alipay/orders/${created.order.id}/status`;

    expect((await handleRequest(new Request(statusUrl), deps)).status).toBe(401);
    expect(
      (
        await handleRequest(
          new Request(statusUrl, { headers: { cookie: await cookieFor("act_other") } }),
          deps,
        )
      ).status,
    ).toBe(404);

    const owned = async (): Promise<Record<string, unknown>> => {
      const response = await handleRequest(
        new Request(statusUrl, { headers: { cookie: ownerCookie } }),
        deps,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      return response.json() as Promise<Record<string, unknown>>;
    };

    expect(await owned()).toEqual({ status: "pending" });
    await db.updatePaymentOrder(created.order.id, { status: "paid", paid_at: NOW });
    expect(await owned()).toEqual({ status: "fulfilled" });
    expect(await db.listEntitlements("act_owner")).toHaveLength(1);
  });

  it("reports closed and expired without trusting browser fields", async () => {
    const { db, deps } = setup();
    await seedAccount(db, "act_owner");
    const cookie = await cookieFor("act_owner");
    const created = await createdOrder(db, await createCheckout(deps, { tier: "quarter" }, cookie));
    const requestStatus = () =>
      handleRequest(
        new Request(`${BASE}/api/alipay/orders/${created.order.id}/status?trade_status=TRADE_SUCCESS`, {
          headers: { cookie },
        }),
        deps,
      );

    await db.updatePaymentOrder(created.order.id, { status: "closed", closed_at: NOW });
    expect(await (await requestStatus()).json()).toEqual({ status: "closed" });

    const second = await createdOrder(db, await createCheckout(deps, { tier: "quarter" }, cookie));
    deps.now = () => "2026-08-16T08:21:00.000Z";
    const response = await handleRequest(
      new Request(`${BASE}/api/alipay/orders/${second.order.id}/status`, { headers: { cookie } }),
      deps,
    );
    expect(await response.json()).toEqual({ status: "expired" });
  });
});
