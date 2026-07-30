import { describe, expect, it } from "vitest";
import { createMemoryConnectDb, type ConnectDb } from "./db.js";
import { handleRequest, type RouteDeps } from "./routes.js";
import { SANDBOX_PRICE_MONTHS } from "./paddle-event.js";

const BASE = "https://mediaryconnect.app";
const NOW = "2026-07-29T12:00:00.000Z";
const SECRET = "pdl_ntfset_test_secret";
const YEAR_PRICE = "pri_01kypfzvbkhp0a7npjg87ptxpb"; // 12 个月

function setup(over: Partial<RouteDeps> = {}): { db: ConnectDb; deps: RouteDeps } {
  const db = createMemoryConnectDb();
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
    sessionSecret: "f".repeat(64),
    sendMagicLink: async () => {},
    paddleWebhookSecret: SECRET,
    paddlePriceMonths: SANDBOX_PRICE_MONTHS,
    ...over,
  };
  return { db, deps };
}

async function signed(body: string, secret = SECRET, tsMs = Date.parse(NOW)): Promise<string> {
  const ts = String(Math.floor(tsMs / 1000));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${ts}:${body}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `ts=${ts};h1=${hex}`;
}

function eventBody(over: Record<string, unknown> = {}, dataOver: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event_id: "evt_1",
    event_type: "transaction.completed",
    occurred_at: NOW,
    notification_id: "ntf_1",
    data: {
      id: "txn_abc",
      status: "completed",
      customer_id: "ctm_1",
      currency_code: "CNY",
      custom_data: { account_email: "buyer@example.com" },
      details: { totals: { total: "10800", grand_total: "10800" } },
      items: [{ price: { id: YEAR_PRICE, custom_data: { months: 12 } }, quantity: 1 }],
      ...dataOver,
    },
    ...over,
  });
}

async function post(
  deps: RouteDeps,
  body: string,
  header?: string,
): Promise<Response> {
  return handleRequest(
    new Request(`${BASE}/api/paddle/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(header === undefined ? {} : { "paddle-signature": header }),
      },
      body,
    }),
    deps,
  );
}

describe("POST /api/paddle/webhook", () => {
  it("合法签名的 transaction.completed → 发放时长", async () => {
    const { db, deps } = setup();
    const body = eventBody();
    const res = await post(deps, body, await signed(body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      applied: true,
      expires_at: "2027-07-29T12:00:00.000Z",
    });
    const acct = await db.getAccountByEmail("buyer@example.com");
    expect(acct).not.toBeNull();
    const ents = await db.listEntitlements(acct!.id);
    expect(ents.length).toBe(1);
    expect(ents[0]?.months).toBe(12);
    expect(ents[0]?.paddle_transaction_id).toBe("txn_abc");
    expect(ents[0]?.source).toBe("paddle");
  });

  // fail closed 的关键:未配密钥必须 503(让 Paddle 重投),绝不 200
  // —— 200 会让它停止重试,而我们压根没入账,用户付的钱就丢了。
  it("未配置 secret → 503(让 Paddle 重投,不可 200)", async () => {
    const { db, deps } = setup({ paddleWebhookSecret: undefined });
    const body = eventBody();
    const res = await post(deps, body, await signed(body));
    expect(res.status).toBe(503);
    expect(await db.getAccountByEmail("buyer@example.com")).toBeNull();
  });

  it.each([
    ["空白 secret", "   "],
    ["空串 secret", ""],
  ])("%s 同样 503", async (_name, sec) => {
    const { deps } = setup({ paddleWebhookSecret: sec });
    const body = eventBody();
    const res = await post(deps, body, await signed(body));
    expect(res.status).toBe(503);
  });

  it("签名错误 → 401,不入账", async () => {
    const { db, deps } = setup();
    const body = eventBody();
    const res = await post(deps, body, await signed(body, "wrong_secret"));
    expect(res.status).toBe(401);
    expect(await db.getAccountByEmail("buyer@example.com")).toBeNull();
  });

  it("缺签名头 → 401", async () => {
    const { deps } = setup();
    const res = await post(deps, eventBody());
    expect(res.status).toBe(401);
  });

  // body 改一个字节签名就该失配 —— 证明验签真的覆盖了内容。
  it("body 被篡改 → 401(哪怕只多一个空格)", async () => {
    const { db, deps } = setup();
    const body = eventBody();
    const header = await signed(body);
    const res = await post(deps, body + " ", header);
    expect(res.status).toBe(401);
    expect(await db.getAccountByEmail("buyer@example.com")).toBeNull();
  });

  // 攻击者拿到旧的合法请求重放,时间窗要挡住。
  it("超出时间窗 → 401", async () => {
    const { deps } = setup();
    const body = eventBody();
    const stale = await signed(body, SECRET, Date.parse(NOW) - 10 * 60_000);
    expect((await post(deps, body, stale)).status).toBe(401);
  });

  // 幂等是命门:Paddle 明确会重投,重复入账等于白送时长。
  it("同一交易重投只入账一次", async () => {
    const { db, deps } = setup();
    const body = eventBody();
    const header = await signed(body);
    const first = await post(deps, body, header);
    expect((await first.json()) as { applied: boolean }).toMatchObject({ applied: true });
    const replay = await post(deps, body, header);
    expect(replay.status).toBe(200);
    const rj = (await replay.json()) as { applied: boolean; expires_at: string };
    expect(rj.applied, "重投必须识别为幂等").toBe(false);
    // 重投返回的到期时刻必须是已存在的那个,不能又叠加一年
    expect(rj.expires_at).toBe("2027-07-29T12:00:00.000Z");
    const acct = await db.getAccountByEmail("buyer@example.com");
    const ents = await db.listEntitlements(acct!.id);
    expect(ents.length, "只应有一条时长").toBe(1);
  });

  // reason 会被拼成审计 action(paddle.unprocessable.<reason>),
  // 与 unknown_price 混在一起会让告警指向错误的原因。
  it("白名单值超过 MAX_WEBHOOK_MONTHS → months_out_of_range(独立 reason)", async () => {
    const { db, deps } = setup({ paddlePriceMonths: { pri_absurd: 36 } });
    const body = eventBody({}, { items: [{ price: { id: "pri_absurd" }, quantity: 1 }] });
    const res = await post(deps, body, await signed(body));
    expect(await res.json()).toMatchObject({ unprocessable: "months_out_of_range" });
    const audits = await db.listAudits();
    expect(audits.some((a) => a.action === "paddle.unprocessable.months_out_of_range")).toBe(true);
    expect(audits.some((a) => a.action === "paddle.unprocessable.unknown_price")).toBe(false);
  });

  // quantity>1 在更早一道防线被拦(bad_quantity),买 1 年拿 10 年的路径已封。
  it("quantity=10 被 bad_quantity 拦下,不产生 120 个月", async () => {
    const { db, deps } = setup();
    const body = eventBody({}, { items: [{ price: { id: YEAR_PRICE }, quantity: 10 }] });
    const res = await post(deps, body, await signed(body));
    expect(await res.json()).toMatchObject({ unprocessable: "bad_quantity" });
    expect(await db.getAccountByEmail("buyer@example.com")).toBeNull();
  });

  // JSON.parse("null") 返回 null → event.event_type 抛 TypeError → 500 → 无限重投。
  it.each(['null', '123', '"str"', "[]", "true"])(
    "非对象 JSON payload(%s)归到畸形分支而非 500",
    async (raw) => {
      const { deps } = setup();
      const res = await post(deps, raw, await signed(raw));
      expect(res.status, `raw=${raw}`).toBe(200);
    },
  );

  it("未知 price_id → 200 + 审计,不入账", async () => {
    const { db, deps } = setup();
    const body = eventBody({}, { items: [{ price: { id: "pri_fake" }, quantity: 1 }] });
    const res = await post(deps, body, await signed(body));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ unprocessable: "unknown_price" });
    expect(await db.getAccountByEmail("buyer@example.com")).toBeNull();
    const audits = await db.listAudits();
    expect(audits.some((a) => a.action === "paddle.unprocessable.unknown_price")).toBe(true);
  });

  it("月数与白名单不一致 → 200 + 审计,不入账", async () => {
    const { db, deps } = setup();
    const body = eventBody(
      {},
      { items: [{ price: { id: YEAR_PRICE, custom_data: { months: 999 } }, quantity: 1 }] },
    );
    const res = await post(deps, body, await signed(body));
    expect(await res.json()).toMatchObject({ unprocessable: "months_mismatch" });
    expect(await db.getAccountByEmail("buyer@example.com")).toBeNull();
  });

  // 有人付了钱而系统不知道该给谁 —— 必须留下能追查的审计。
  it("拿不到邮箱 → 200 但审计里记全 txn id(需人工处理)", async () => {
    const { db, deps } = setup();
    const body = eventBody({}, { custom_data: null, customer: null });
    const res = await post(deps, body, await signed(body));
    expect(await res.json()).toMatchObject({ unprocessable: "no_email" });
    const audits = await db.listAudits();
    const a = audits.find((x) => x.action === "paddle.unprocessable.no_email");
    expect(a, "必须有审计").toBeDefined();
    expect(a?.detail_json).toContain("txn_abc");
  });

  it("非 completed 状态不发时长", async () => {
    const { db, deps } = setup();
    const body = eventBody({}, { status: "billed" });
    const res = await post(deps, body, await signed(body));
    expect(res.status).toBe(200);
    expect(await db.getAccountByEmail("buyer@example.com")).toBeNull();
  });

  // 只记 event_id 的话,人工核查退款时无法关联到是哪一笔付款、退了多少。
  it("adjustment.created(退款)审计里记全交易关联信息", async () => {
    const { db, deps } = setup();
    const body = JSON.stringify({
      event_id: "evt_adj",
      event_type: "adjustment.created",
      data: {
        id: "adj_1",
        action: "refund",
        transaction_id: "txn_abc",
        customer_id: "ctm_9",
      },
    });
    const res = await post(deps, body, await signed(body));
    expect(res.status).toBe(200);
    const a = (await db.listAudits()).find((x) => x.action === "paddle.adjustment");
    expect(a).toBeDefined();
    const d = JSON.parse(a!.detail_json!) as Record<string, unknown>;
    expect(d).toMatchObject({
      event_id: "evt_adj",
      adjustment_id: "adj_1",
      transaction_id: "txn_abc",
      adjustment_action: "refund",
      customer_id: "ctm_9",
    });
  });

  it("adjustment 缺字段时审计记 null 而不报错", async () => {
    const { db, deps } = setup();
    const body = JSON.stringify({ event_id: "e", event_type: "adjustment.created", data: {} });
    expect((await post(deps, body, await signed(body))).status).toBe(200);
    const a = (await db.listAudits()).find((x) => x.action === "paddle.adjustment");
    const d = JSON.parse(a!.detail_json!) as Record<string, unknown>;
    expect(d.transaction_id).toBeNull();
  });

  it("未订阅的事件类型礼貌 200,不入账", async () => {
    const { db, deps } = setup();
    const body = JSON.stringify({
      event_id: "evt_x",
      event_type: "subscription.created",
      data: {},
    });
    const res = await post(deps, body, await signed(body));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ignored: "subscription.created" });
  });

  // 200 是对的(重投也解析不出来),但必须留审计 —— 否则只会看到
  // 「Paddle 说投递成功而我们没入账」却无从查起。
  it("验签通过但 JSON 畸形 → 200 且留审计(唯一排障线索)", async () => {
    const { db, deps } = setup();
    const body = "{not json";
    const res = await post(deps, body, await signed(body));
    expect(res.status).toBe(200);
    const audits = await db.listAudits();
    const a = audits.find((x) => x.action === "paddle.unprocessable.malformed_json");
    expect(a, "必须有审计").toBeDefined();
    expect(a?.detail_json).toContain("bytes");
  });

  // 审计不可用时不能把请求变成 500 —— 那会触发对一个永远解析不了的 body 的
  // 无限重投。
  it("JSON 畸形且审计写入也失败时仍返回 200", async () => {
    const { db, deps } = setup();
    const noAudit: ConnectDb = {
      ...db,
      async insertAudit() {
        throw new Error("audit table unavailable");
      },
    };
    const body = "{not json";
    const res = await post({ ...deps, db: noAudit }, body, await signed(body));
    expect(res.status).toBe(200);
  });

  // DB 故障是可重试的,必须 503 让 Paddle 重投,否则这笔付款永久丢失。
  it("入账时 DB 故障 → 503(可重试),不回显内部错误", async () => {
    const { db, deps } = setup();
    const failing: ConnectDb = {
      ...db,
      async insertEntitlement() {
        throw new Error("D1_ERROR: connection lost at table entitlements");
      },
    };
    const body = eventBody();
    const res = await post({ ...deps, db: failing }, body, await signed(body));
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).not.toContain("D1_ERROR");
    expect(text).not.toContain("entitlements");
  });

  it("续费叠加:第二笔不同交易从旧到期累加", async () => {
    const { db, deps } = setup();
    const b1 = eventBody({ event_id: "e1" }, { id: "txn_1" });
    await post(deps, b1, await signed(b1));
    const b2 = eventBody({ event_id: "e2" }, { id: "txn_2" });
    const res = await post(deps, b2, await signed(b2));
    expect((await res.json()) as { expires_at: string }).toMatchObject({
      expires_at: "2028-07-29T12:00:00.000Z", // 2027 + 12 个月
    });
    const acct = await db.getAccountByEmail("buyer@example.com");
    expect((await db.listEntitlements(acct!.id)).length).toBe(2);
  });

  it("live 白名单可注入(sandbox price 在 live 下被拒)", async () => {
    const { deps } = setup({ paddlePriceMonths: { pri_live_only: 12 } });
    const body = eventBody();
    const res = await post(deps, body, await signed(body));
    expect(await res.json()).toMatchObject({ unprocessable: "unknown_price" });
  });

  it("GET 不被路由(只接受 POST)", async () => {
    const { deps } = setup();
    const res = await handleRequest(new Request(`${BASE}/api/paddle/webhook`), deps);
    expect(res.status).toBe(404);
  });
});

describe("时间基准:用事件的 occurred_at 而非投递到达时刻", () => {
  // Paddle 重试是指数退避,失败后可能几小时后才成功投递。若按到达时刻算,
  // 一笔「到期前 1 分钟成交」的续费会被当成「已过期 → 从当下重启」,
  // 用户白丢那段延迟的时长(延迟 24h 就丢 24h)。
  it("延迟投递的续费仍从旧到期叠加(不被当成已过期重启)", async () => {
    const { db, deps } = setup();
    // 先有一笔到 2026-08-01 到期的时长
    const acct = await db.insertAccount({
      id: "act_pre",
      email: "buyer@example.com",
      paddle_customer_id: null,
      created_at: "2026-07-01T00:00:00.000Z",
      last_login_at: null,
    });
    await db.insertEntitlement({
      id: "ent_pre",
      account_id: acct.id,
      expires_at: "2026-08-01T00:00:00.000Z",
      source: "manual",
      paddle_transaction_id: null,
      months: 1,
      created_at: "2026-07-01T00:00:00.000Z",
    });
    // 成交时刻在到期之前;但 now() 是到期之后(模拟投递延迟)
    const occurred = "2026-07-31T23:00:00.000Z";
    const body = eventBody({ occurred_at: occurred }, { id: "txn_late" });
    const lateNow = "2026-08-02T00:00:00.000Z";
    const res = await post(
      { ...deps, now: () => lateNow },
      body,
      await signed(body, SECRET, Date.parse(lateNow)),
    );
    expect(res.status).toBe(200);
    // 从旧到期 2026-08-01 叠加 12 个月 → 2027-08-01
    // (若按 lateNow 算会是 2027-08-02,白丢一天)
    expect((await res.json()) as { expires_at: string }).toMatchObject({
      expires_at: "2027-08-01T00:00:00.000Z",
    });
  });

  it("occurred_at 缺失/畸形时回落 now(不阻断入账)", async () => {
    for (const occurred of [undefined, "", "not-a-date", 12345]) {
      const { deps } = setup();
      const body = eventBody({ occurred_at: occurred }, { id: `txn_${String(occurred)}` });
      const res = await post(deps, body, await signed(body));
      expect(res.status, `occurred_at=${String(occurred)}`).toBe(200);
      expect((await res.json()) as { applied: boolean }).toMatchObject({ applied: true });
    }
  });

  // 离谱的 occurred_at 不该把到期推到很远(防上游 bug;payload 已验签,非攻击面)。
  it("occurred_at 偏离当下过远时回落 now", async () => {
    const { deps } = setup();
    const body = eventBody({ occurred_at: "2099-01-01T00:00:00.000Z" }, { id: "txn_future" });
    const res = await post(deps, body, await signed(body));
    // 回落 NOW(2026-07-29)+12 个月,而不是 2100
    expect((await res.json()) as { expires_at: string }).toMatchObject({
      expires_at: "2027-07-29T12:00:00.000Z",
    });
  });
});

describe("审计写入必须 best-effort(不可把不可重试的失败变成无限重投)", () => {
  it("解析失败且审计写入也失败时仍返回 200", async () => {
    const { db, deps } = setup();
    const noAudit: ConnectDb = {
      ...db,
      async insertAudit() {
        throw new Error("audit unavailable");
      },
    };
    const body = eventBody({}, { items: [{ price: { id: "pri_fake" }, quantity: 1 }] });
    const res = await post({ ...deps, db: noAudit }, body, await signed(body));
    expect(res.status, "审计故障不该变成 500 → 那会无限重投").toBe(200);
    expect(await res.json()).toMatchObject({ unprocessable: "unknown_price" });
  });

  it("畸形 JSON 的审计记录真实字节数(非 UTF-16 长度)", async () => {
    const { db, deps } = setup();
    const body = '{"x":"退款政策"'; // 非 ASCII,字节数 > length
    const res = await post(deps, body, await signed(body));
    expect(res.status).toBe(200);
    const a = (await db.listAudits()).find(
      (x) => x.action === "paddle.unprocessable.malformed_json",
    );
    const d = JSON.parse(a!.detail_json!) as { bytes: number };
    expect(d.bytes, "应为真实字节数").toBe(new TextEncoder().encode(body).byteLength);
    expect(d.bytes).toBeGreaterThan(body.length);
  });
});

describe("入账与审计的失败要分开处置", () => {
  // 入账已成功时,审计写不进去不该推翻既成事实。返回 503 会让 Paddle 重投,
  // 语义上等于"明明成功了却说失败"。
  it("入账成功但审计失败 → 仍 200(不让 Paddle 重投)", async () => {
    const { db, deps } = setup();
    let calls = 0;
    const flaky: ConnectDb = {
      ...db,
      async insertAudit(row) {
        calls++;
        throw new Error("audit unavailable");
      },
    };
    const body = eventBody();
    const res = await post({ ...deps, db: flaky }, body, await signed(body));
    expect(res.status).toBe(200);
    expect((await res.json()) as { applied: boolean }).toMatchObject({ applied: true });
    expect(calls, "确实尝试过写审计").toBeGreaterThan(0);
    // 关键:钱真的变成了时长
    const acct = await db.getAccountByEmail("buyer@example.com");
    expect((await db.listEntitlements(acct!.id)).length).toBe(1);
  });

  // 退款事件本身可处理,只是暂时写不进审计 → 503 让重投。退款审计是后续
  // 停用处置的唯一依据,丢了就查不到某人为什么被停。
  it("退款事件审计失败 → 503(可重试),而非 unhandled 500", async () => {
    const { db, deps } = setup();
    const noAudit: ConnectDb = {
      ...db,
      async insertAudit() {
        throw new Error("audit unavailable");
      },
    };
    const body = JSON.stringify({
      event_id: "e",
      event_type: "adjustment.created",
      data: { id: "adj", transaction_id: "txn_x", action: "refund" },
    });
    const res = await post({ ...deps, db: noAudit }, body, await signed(body));
    expect(res.status).toBe(503);
    // 契约:不回显内部错误文本。响应文案刻意与内部异常消息不同 ——
    // 否则将来改了内部消息,这条契约会悄悄失效。
    const text = await res.text();
    expect(text).not.toContain("audit unavailable");
    expect(text).toContain("temporarily unavailable");
  });

  it("畸形 quantity → 200 + bad_quantity 审计,不入账", async () => {
    const { db, deps } = setup();
    const body = eventBody({}, { items: [{ price: { id: YEAR_PRICE }, quantity: 0 }] });
    const res = await post(deps, body, await signed(body));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ unprocessable: "bad_quantity" });
    expect(await db.getAccountByEmail("buyer@example.com")).toBeNull();
    const audits = await db.listAudits();
    expect(audits.some((a) => a.action === "paddle.unprocessable.bad_quantity")).toBe(true);
  });
});

describe("白名单未配置时必须 fail-closed(否则 live 上线即丢钱)", () => {
  // 原实现在 paddlePriceMonths 缺失时回落 SANDBOX_PRICE_MONTHS。而 index.ts
  // 压根没注入它 —— 于是 live 上线后真实 price_id 会被判 unknown_price →
  // 返回 200(不可重试)→ Paddle 停止重投 → **真实付款静默丢失**。
  // 503 把「白名单没同步」这种可恢复的配置错误,从不可恢复的丢钱里救回来。
  it("webhook 在白名单缺失时返回 503(可重试),不入账", async () => {
    const { db, deps } = setup({ paddlePriceMonths: undefined });
    const body = eventBody();
    const res = await post(deps, body, await signed(body));
    expect(res.status).toBe(503);
    expect(await db.getAccountByEmail("buyer@example.com")).toBeNull();
  });

  it("白名单为空对象时同样 503(空表 = 未配置)", async () => {
    const { deps } = setup({ paddlePriceMonths: undefined });
    const body = eventBody();
    expect((await post(deps, body, await signed(body))).status).toBe(503);
  });
});

describe("priceMonthsFor —— 按环境选白名单,绝不跨环境回落", () => {
  it("sandbox 得到 sandbox 表", async () => {
    const { priceMonthsFor, SANDBOX_PRICE_MONTHS: sandbox } = await import("./paddle-event.js");
    expect(priceMonthsFor("sandbox")).toBe(sandbox);
    expect(priceMonthsFor(" SANDBOX ")).toBe(sandbox); // 大小写/空白不敏感
  });

  // live 白名单还没填(上线前必须填)。返回 null 让调用方 fail-closed,
  // 而不是悄悄用 sandbox 的 price_id —— 那些 id 在 live 根本不存在。
  it.each([undefined, "production", "live", ""])(
    "非 sandbox 环境(%s)在 live 表为空时返回 null",
    async (env) => {
      const { priceMonthsFor } = await import("./paddle-event.js");
      expect(priceMonthsFor(env)).toBeNull();
    },
  );

  it("绝不把 sandbox 表交给非 sandbox 环境", async () => {
    const { priceMonthsFor, SANDBOX_PRICE_MONTHS: sandbox } = await import("./paddle-event.js");
    for (const env of [undefined, "production", "live"]) {
      expect(priceMonthsFor(env), `env=${String(env)}`).not.toBe(sandbox);
    }
  });
});
