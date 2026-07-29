import { describe, expect, it } from "vitest";
import { createMemoryConnectDb, type ConnectDb } from "./db.js";
import { buildSessionCookie } from "./session.js";
import { handleRequest, type RouteDeps } from "./routes.js";
import { isKnownPriceId, type PaddleApi } from "./paddle-api.js";
import { SANDBOX_PRICE_MONTHS } from "./paddle-event.js";

const BASE = "https://mediaryconnect.app";
const NOW = "2026-07-29T12:00:00.000Z";
const SECRET = "f".repeat(64);
const YEAR_PRICE = "pri_01kypfzvbkhp0a7npjg87ptxpb";

function fakeApi(calls: unknown[]): PaddleApi {
  return {
    async createTransaction(input) {
      calls.push(input);
      return {
        transactionId: "txn_new",
        checkoutUrl: "https://mediaryconnect.app/buy?_ptxn=txn_new",
      };
    },
  };
}

function setup(over: Partial<RouteDeps> = {}): {
  db: ConnectDb;
  deps: RouteDeps;
  calls: unknown[];
} {
  const db = createMemoryConnectDb();
  const calls: unknown[] = [];
  let n = 0;
  const deps: RouteDeps = {
    db,
    cf: {} as never,
    adminToken: "admin",
    rootDomain: "mediaryconnect.app",
    tokenWrapKeyHex: "a".repeat(64),
    now: () => NOW,
    newInviteId: () => `inv_${++n}`,
    newEndpointId: () => `ep_${n}`,
    newAuditId: () => `aud_${++n}`,
    newInviteCode: () => `code_${n}`,
    newAccountId: () => `act_${++n}`,
    newEntitlementId: () => `ent_${++n}`,
    sessionSecret: SECRET,
    sendMagicLink: async () => {},
    paddleApi: fakeApi(calls),
    ...over,
  };
  return { db, deps, calls };
}

async function seedAccount(db: ConnectDb, id: string, email: string): Promise<void> {
  await db.insertAccount({
    id,
    email,
    paddle_customer_id: null,
    created_at: NOW,
    last_login_at: null,
  });
}

async function cookieFor(accountId: string): Promise<string> {
  return buildSessionCookie(accountId, { secret: SECRET, ttlMs: 3600_000, now: Date.parse(NOW) });
}

async function post(
  deps: RouteDeps,
  body: unknown,
  cookie?: string,
): Promise<Response> {
  return handleRequest(
    new Request(`${BASE}/api/checkout`, {
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

describe("POST /api/checkout", () => {
  // 这个端点存在的**唯一理由**:webhook 需要 custom_data.account_email 才知道
  // 这笔钱属于谁。实测确认 transaction.completed 的 payload 里没有嵌套 customer
  // 对象(只有 customer_id),所以「从 payload 直接拿邮箱」这条路不存在。
  // 没有这个端点,真实付款的结果是 no_email + 零入账 + 200(Paddle 不再重投)。
  it("创建交易时把登录账号邮箱写进 custom_data", async () => {
    const { db, deps, calls } = setup();
    await seedAccount(db, "act_1", "buyer@example.com");
    const res = await post(deps, { price_id: YEAR_PRICE }, await cookieFor("act_1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      checkout_url: "https://mediaryconnect.app/buy?_ptxn=txn_new",
      transaction_id: "txn_new",
    });
    expect(calls).toEqual([
      {
        priceId: YEAR_PRICE,
        accountEmail: "buyer@example.com",
        checkoutUrl: "https://mediaryconnect.app/buy",
      },
    ]);
  });

  // 邮箱取自**登录账号**而非请求体:用户可能用公司卡/家人的卡付款,
  // 但时长必须落在他登录的账号上。
  it("邮箱来自 session 对应的账号,不接受请求体里的邮箱", async () => {
    const { db, deps, calls } = setup();
    await seedAccount(db, "act_2", "real@example.com");
    await post(
      deps,
      { price_id: YEAR_PRICE, account_email: "attacker@example.com" },
      await cookieFor("act_2"),
    );
    expect((calls[0] as { accountEmail: string }).accountEmail).toBe("real@example.com");
  });

  it("未登录 → 401", async () => {
    const { deps, calls } = setup();
    const res = await post(deps, { price_id: YEAR_PRICE });
    expect(res.status).toBe(401);
    expect(calls, "不该碰 Paddle").toEqual([]);
  });

  it("session 有效但账号已删 → 401", async () => {
    const { deps } = setup();
    const res = await post(deps, { price_id: YEAR_PRICE }, await cookieFor("act_ghost"));
    expect(res.status).toBe(401);
  });

  // 让客户端随便传 price_id 等于允许任何人拿更便宜的 price 结账。
  it("未知 price_id → 400,不碰 Paddle", async () => {
    const { db, deps, calls } = setup();
    await seedAccount(db, "act_3", "b@example.com");
    for (const pid of ["pri_fake", "", "toString", "__proto__", "constructor"]) {
      const res = await post(deps, { price_id: pid }, await cookieFor("act_3"));
      expect(res.status, `price_id=${pid}`).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  it("缺 price_id → 400", async () => {
    const { db, deps } = setup();
    await seedAccount(db, "act_4", "c@example.com");
    expect((await post(deps, {}, await cookieFor("act_4"))).status).toBe(400);
  });

  it("未配置 Paddle API → 503(配置缺失,不是代码故障)", async () => {
    const { db, deps } = setup({ paddleApi: undefined });
    await seedAccount(db, "act_5", "d@example.com");
    const res = await post(deps, { price_id: YEAR_PRICE }, await cookieFor("act_5"));
    expect(res.status).toBe(503);
  });

  it("Paddle 失败 → 502,不回显上游内容", async () => {
    const { db, deps } = setup({
      paddleApi: {
        async createTransaction() {
          throw new Error("paddle createTransaction failed: 403 forbidden secret=abc");
        },
      },
    });
    await seedAccount(db, "act_6", "e@example.com");
    const res = await post(deps, { price_id: YEAR_PRICE }, await cookieFor("act_6"));
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain("forbidden");
    expect(text).not.toContain("secret=abc");
  });

  it("checkoutUrl 用请求的 origin(不硬编码域名)", async () => {
    const { db, deps, calls } = setup();
    await seedAccount(db, "act_7", "f@example.com");
    await handleRequest(
      new Request("https://beta.mediaryconnect.app/api/checkout", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: await cookieFor("act_7") },
        body: JSON.stringify({ price_id: YEAR_PRICE }),
      }),
      deps,
    );
    expect((calls[0] as { checkoutUrl: string }).checkoutUrl).toBe(
      "https://beta.mediaryconnect.app/buy",
    );
  });

  it("GET 不被路由", async () => {
    const { deps } = setup();
    const res = await handleRequest(new Request(`${BASE}/api/checkout`), deps);
    expect(res.status).toBe(404);
  });
});

describe("isKnownPriceId", () => {
  it("白名单内放行", () => {
    expect(isKnownPriceId(YEAR_PRICE, SANDBOX_PRICE_MONTHS)).toBe(true);
  });

  // 与 webhook 侧同一个坑:下标访问会命中 Object.prototype。
  it.each(["toString", "valueOf", "constructor", "__proto__", "hasOwnProperty"])(
    "原型链属性不算白名单:%s",
    (evil) => {
      expect(isKnownPriceId(evil, SANDBOX_PRICE_MONTHS)).toBe(false);
    },
  );

  it("空串与未知 id 拒绝", () => {
    expect(isKnownPriceId("", SANDBOX_PRICE_MONTHS)).toBe(false);
    expect(isKnownPriceId("pri_nope", SANDBOX_PRICE_MONTHS)).toBe(false);
  });
});
