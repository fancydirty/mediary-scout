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
    async listPaidTransactionIds() {
      return [];
    },
    async getTransactionStatus() {
      return null;
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
    paddlePriceMonths: SANDBOX_PRICE_MONTHS,
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
        async listPaidTransactionIds() {
          return [];
        },
        async getTransactionStatus() {
          return null;
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

describe("白名单未配置时 checkout 也 fail-closed", () => {
  // 回落 sandbox 的后果:用户拿 live price_id 结账被判 400「未知档位」,
  // 而真正的问题是我方配置没同步 —— 503 才是诚实的状态码。
  it.each([
    ["undefined", undefined],
    ["空对象(误注入)", {}],
  ])("白名单%s → 503(而非把合法 price 判成 400)", async (_name, map) => {
    const { db, deps, calls } = setup({ paddlePriceMonths: map });
    await seedAccount(db, "act_np", "np@example.com");
    const res = await post(deps, { price_id: YEAR_PRICE }, await cookieFor("act_np"));
    expect(res.status).toBe(503);
    expect(calls, "不该碰 Paddle").toEqual([]);
  });
});

describe("外部调用必须有超时", () => {
  // 没有超时,上游抖动会让请求挂住并占用 worker 并发额度、放大故障面。
  // 同仓其它外部调用(cf-api 10s、magic-link 5s、turnstile 5s)都设了,
  // 这里原先是唯一的例外。
  it("createTransaction 带 AbortSignal 超时", async () => {
    const { createPaddleApi } = await import("./paddle-api.js");
    let seenSignal: unknown = undefined;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: { signal?: unknown }) => {
      seenSignal = init?.signal;
      return new Response(
        JSON.stringify({ data: { id: "txn_t", checkout: { url: "https://x/buy?_ptxn=txn_t" } } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof globalThis.fetch;
    try {
      const api = createPaddleApi({ apiKey: "k", environment: "sandbox" });
      await api.createTransaction({
        priceId: YEAR_PRICE,
        accountEmail: "a@b.c",
        checkoutUrl: "https://x/buy",
      });
    } finally {
      globalThis.fetch = origFetch;
    }
    expect(seenSignal, "必须传 signal").toBeInstanceOf(AbortSignal);
  });

  it("sandbox 与 production 打不同的 base URL", async () => {
    const { createPaddleApi } = await import("./paddle-api.js");
    const seen: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: unknown) => {
      seen.push(String(url));
      return new Response(
        JSON.stringify({ data: { id: "t", checkout: { url: "https://x/buy?_ptxn=t" } } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof globalThis.fetch;
    try {
      for (const env of ["sandbox", "production"]) {
        await createPaddleApi({ apiKey: "k", environment: env }).createTransaction({
          priceId: YEAR_PRICE,
          accountEmail: "a@b.c",
          checkoutUrl: "https://x/buy",
        });
      }
    } finally {
      globalThis.fetch = origFetch;
    }
    expect(seen[0]).toContain("sandbox-api.paddle.com");
    expect(seen[1]).toBe("https://api.paddle.com/transactions");
  });
});

describe("服务器时钟畸形时 fail-closed(不伪装成未登录)", () => {
  // 裸 Date.parse(deps.now()) 在 now 坏值时得 NaN → session 总被判无效 → 401,
  // 误导排障(以为用户没登录,真正的问题是服务器时钟)。本仓已有两处
  // `server time unavailable` 的先例,这条契约要统一。
  it.each(["NOT-A-DATE", "", "2026-13-45T99:99:99Z"])(
    "now()=%s 时返回 500 server time unavailable,而非 401",
    async (badNow) => {
      const { db, deps } = setup({ now: () => badNow });
      await seedAccount(db, "act_clock", "clock@example.com");
      const res = await handleRequest(
        new Request(`${BASE}/api/checkout`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            // cookie 用正常时刻签发,确保"无效"只可能来自坏 now
            cookie: await cookieFor("act_clock"),
          },
          body: JSON.stringify({ price_id: YEAR_PRICE }),
        }),
        deps,
      );
      expect(res.status, `now=${badNow} 不该是 401`).toBe(500);
      expect(await res.text()).toContain("server time unavailable");
    },
  );

  // 同一守卫覆盖所有走 session 的路由,不只是新加的 checkout。
  it("其它 session 路由同样 fail-closed(不是只修了 checkout)", async () => {
    const { db, deps } = setup({ now: () => "BAD" });
    await seedAccount(db, "act_c2", "c2@example.com");
    const cookie = await cookieFor("act_c2");
    for (const path of ["/console", "/api/slug/check?s=abc"]) {
      const res = await handleRequest(
        new Request(`${BASE}${path}`, { headers: { cookie } }),
        deps,
      );
      expect(res.status, `${path} 应 fail-closed`).toBe(500);
    }
  });
});

describe("GET /api/transaction/:id/status(结账轮询)", () => {
  async function seedMe(db: ConnectDb): Promise<string> {
    await db.insertAccount({
      id: "act_me", email: "me@example.com", paddle_customer_id: null,
      created_at: NOW, last_login_at: null,
    });
    return buildSessionCookie("act_me", { secret: SECRET, ttlMs: 3600_000, now: Date.parse(NOW) });
  }

  it("未登录 → 401", async () => {
    const { deps } = setup();
    const res = await handleRequest(new Request(`${BASE}/api/transaction/txn_aaaaaaaaaaaaaaaaaaaaaaaaaa/status`), deps);
    expect(res.status).toBe(401);
  });

  it("归属校验:不是自己的交易 → 404(不泄露存在性)", async () => {
    const { deps } = setup();
    const cookie = await seedMe(deps.db);
    const fake = deps.paddleApi as unknown as { getTransactionStatus: () => unknown };
    fake.getTransactionStatus = async () => ({ status: "completed", paidAt: NOW, accountEmail: "other@example.com" });
    const res = await handleRequest(
      new Request(`${BASE}/api/transaction/txn_bbbbbbbbbbbbbbbbbbbbbbbbbb/status`, { headers: { cookie } }),
      deps,
    );
    expect(res.status).toBe(404);
  });

  it("自己的交易 completed → 200 返回状态与 paid_at", async () => {
    const { deps } = setup();
    const cookie = await seedMe(deps.db);
    const fake = deps.paddleApi as unknown as { getTransactionStatus: () => unknown };
    fake.getTransactionStatus = async () => ({ status: "completed", paidAt: NOW, accountEmail: "me@example.com" });
    const res = await handleRequest(
      new Request(`${BASE}/api/transaction/txn_cccccccccccccccccccccccccc/status`, { headers: { cookie } }),
      deps,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("completed");
    expect(body.paid_at).toBe(NOW);
  });

  it("ready(微信确认前)→ 200 返回 ready,前端继续轮询", async () => {
    const { deps } = setup();
    const cookie = await seedMe(deps.db);
    const fake = deps.paddleApi as unknown as { getTransactionStatus: () => unknown };
    fake.getTransactionStatus = async () => ({ status: "ready", paidAt: null, accountEmail: "me@example.com" });
    const res = await handleRequest(
      new Request(`${BASE}/api/transaction/txn_cccccccccccccccccccccccccc/status`, { headers: { cookie } }),
      deps,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>).status).toBe("ready");
  });

  it("Paddle 上游抖动 → 503", async () => {
    const { deps } = setup();
    const cookie = await seedMe(deps.db);
    const fake = deps.paddleApi as unknown as { getTransactionStatus: () => unknown };
    fake.getTransactionStatus = async () => { throw new Error("upstream boom"); };
    const res = await handleRequest(
      new Request(`${BASE}/api/transaction/txn_cccccccccccccccccccccccccc/status`, { headers: { cookie } }),
      deps,
    );
    expect(res.status).toBe(503);
  });

  it("交易不存在 → 404", async () => {
    const { deps } = setup();
    const cookie = await seedMe(deps.db);
    const fake = deps.paddleApi as unknown as { getTransactionStatus: () => unknown };
    fake.getTransactionStatus = async () => null;
    const res = await handleRequest(
      new Request(`${BASE}/api/transaction/txn_dddddddddddddddddddddddddd/status`, { headers: { cookie } }),
      deps,
    );
    expect(res.status).toBe(404);
  });

  it("D1 入账记录(webhook 观测结果)→ completed,不查 Paddle", async () => {
    const { deps } = setup();
    const cookie = await seedMe(deps.db);
    const fake = deps.paddleApi as unknown as { getTransactionStatus: () => unknown };
    let paddleCalled = false;
    fake.getTransactionStatus = async () => { paddleCalled = true; return null; };
    const { grantEntitlement } = await import("./grant.js");
    await grantEntitlement(
      { email: "me@example.com", months: 3, source: "paddle", paddleTransactionId: "txn_eeeeeeeeeeeeeeeeeeeeeeeeee" },
      { db: deps.db, now: () => NOW, newAccountId: () => "act_new", newEntitlementId: () => "ent_1" },
    );
    const res = await handleRequest(
      new Request(`${BASE}/api/transaction/txn_eeeeeeeeeeeeeeeeeeeeeeeeee/status`, { headers: { cookie } }),
      deps,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>).status).toBe("completed");
    expect(paddleCalled).toBe(false);
  });

  it("入账给了别人 → 404", async () => {
    const { deps } = setup();
    const cookie = await seedMe(deps.db);
    const { grantEntitlement } = await import("./grant.js");
    await grantEntitlement(
      { email: "other@example.com", months: 3, source: "paddle", paddleTransactionId: "txn_bbbbbbbbbbbbbbbbbbbbbbbbbb" },
      { db: deps.db, now: () => NOW, newAccountId: () => "act_new", newEntitlementId: () => "ent_2" },
    );
    const res = await handleRequest(
      new Request(`${BASE}/api/transaction/txn_bbbbbbbbbbbbbbbbbbbbbbbbbb/status`, { headers: { cookie } }),
      deps,
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /api/transaction/:id/status —— 边界(Copilot round 1)", () => {
  async function seedMe(db: ConnectDb): Promise<string> {
    await db.insertAccount({
      id: "act_me2", email: "me@example.com", paddle_customer_id: null,
      created_at: NOW, last_login_at: null,
    });
    return buildSessionCookie("act_me2", { secret: SECRET, ttlMs: 3600_000, now: Date.parse(NOW) });
  }
  const T26 = "txn_aaaaaaaaaaaaaaaaaaaaaaaaaa";

  it("畸形交易 ID(非 txn_ 格式)→ 404 而非 500", async () => {
    // decodeURIComponent 对畸形百分号编码会抛 URIError。格式校验在前,
    // 客户端错误不该变 500。
    const { deps } = setup();
    const cookie = await seedMe(deps.db);
    const res = await handleRequest(
      new Request(`${BASE}/api/transaction/%E0%A4%A/status`, { headers: { cookie } }),
      deps,
    );
    expect(res.status).toBe(404);
  });

  it("accountEmail 为 null(异常/伪造)→ 404,不让猜 ID 的人查", async () => {
    // 创建交易必写 custom_data.account_email。null 只可能是异常,拒绝。
    const { deps } = setup();
    const cookie = await seedMe(deps.db);
    const fake = deps.paddleApi as unknown as { getTransactionStatus: () => unknown };
    fake.getTransactionStatus = async () => ({ status: "paid", paidAt: NOW, accountEmail: null });
    const res = await handleRequest(
      new Request(`${BASE}/api/transaction/${T26}/status`, { headers: { cookie } }),
      deps,
    );
    expect(res.status).toBe(404);
  });

  it("Paddle 5xx → 503 而非 404(上游故障要可重试)", async () => {
    const { deps } = setup();
    const cookie = await seedMe(deps.db);
    const fake = deps.paddleApi as unknown as { getTransactionStatus: () => unknown };
    fake.getTransactionStatus = async () => { throw new Error("paddle getTransactionStatus failed: 500"); };
    const res = await handleRequest(
      new Request(`${BASE}/api/transaction/${T26}/status`, { headers: { cookie } }),
      deps,
    );
    expect(res.status).toBe(503);
  });
});
