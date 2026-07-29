import { describe, expect, it } from "vitest";
import { createMemoryConnectDb, type ConnectDb } from "./db.js";
import { handleRequest, type RouteDeps } from "./routes.js";

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
  it("累加月数超范围 → 独立的 months_out_of_range,而非 unknown_price", async () => {
    const { db, deps } = setup();
    const body = eventBody({}, { items: [{ price: { id: YEAR_PRICE }, quantity: 11 }] });
    const res = await post(deps, body, await signed(body));
    expect(await res.json()).toMatchObject({ unprocessable: "months_out_of_range" });
    const audits = await db.listAudits();
    expect(audits.some((a) => a.action === "paddle.unprocessable.months_out_of_range")).toBe(true);
    expect(audits.some((a) => a.action === "paddle.unprocessable.unknown_price")).toBe(false);
  });

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
