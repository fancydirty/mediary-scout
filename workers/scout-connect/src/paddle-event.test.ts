import { describe, expect, it } from "vitest";
import {
  LIVE_PRICE_MONTHS,
  MAX_WEBHOOK_MONTHS,
  parseTransactionCompleted,
  SANDBOX_PRICE_MONTHS,
  type PriceMonthsMap,
} from "./paddle-event.js";

const YEAR_PRICE = "pri_01kypfzvbkhp0a7npjg87ptxpb"; // 年度 ¥108 / 12 个月
const QUARTER_PRICE = "pri_01kypfzv2jqg2qv0g25bn05v28"; // 季度 ¥45 / 3 个月

/** 真实 payload 的 data 部分(形状取自 sandbox 通知,非文档臆测)。 */
function txnData(over: Record<string, unknown> = {}): unknown {
  return {
    id: "txn_01kypg4pmc3ks3251rhdvgv8dx",
    status: "completed",
    customer_id: "ctm_x",
    currency_code: "CNY",
    custom_data: { account_email: "buyer@example.com" },
    details: { totals: { total: "10800", grand_total: "10800" } },
    items: [
      { price: { id: YEAR_PRICE, custom_data: { months: 12, plan: "year" } }, quantity: 1 },
    ],
    ...over,
  };
}

describe("parseTransactionCompleted", () => {
  it("正常年付交易 → 12 个月,邮箱取 custom_data.account_email", () => {
    const r = parseTransactionCompleted(txnData(), SANDBOX_PRICE_MONTHS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.grant).toEqual({
      months: 12,
      email: "buyer@example.com",
      transactionId: "txn_01kypg4pmc3ks3251rhdvgv8dx",
      source: "paddle",
    });
  });

  it("季付 → 3 个月", () => {
    const r = parseTransactionCompleted(
      txnData({
        items: [{ price: { id: QUARTER_PRICE, custom_data: { months: 3 } }, quantity: 1 }],
      }),
      SANDBOX_PRICE_MONTHS,
    );
    expect(r.ok && r.grant.months).toBe(3);
  });

  // 只处理真收到钱的交易。
  it.each(["draft", "ready", "billed", "canceled", "past_due"])(
    "status=%s 不发时长",
    (status) => {
      const r = parseTransactionCompleted(txnData({ status }), SANDBOX_PRICE_MONTHS);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toBe("not_completed");
    },
  );

  // 白名单是权威:未知 price 宁可不发,也不凭猜。
  it("未知 price_id 拒绝(可能是新档位没同步,也可能是伪造)", () => {
    const r = parseTransactionCompleted(
      txnData({ items: [{ price: { id: "pri_unknown" }, quantity: 1 }] }),
      SANDBOX_PRICE_MONTHS,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("unknown_price");
  });

  // 这是白名单 + 交叉校验的核心价值:抓「后台改了价而代码没同步」。
  it("custom_data.months 与白名单不一致时拒绝", () => {
    const r = parseTransactionCompleted(
      txnData({
        items: [{ price: { id: YEAR_PRICE, custom_data: { months: 999 } }, quantity: 1 }],
      }),
      SANDBOX_PRICE_MONTHS,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("months_mismatch");
    expect(r.detail).toContain("whitelist=12");
    expect(r.detail).toContain("custom_data=999");
  });

  // 伪造 custom_data 抬高月数必须无效 —— 白名单说了算。
  it("伪造的 custom_data 无法抬高月数", () => {
    const r = parseTransactionCompleted(
      txnData({
        items: [{ price: { id: YEAR_PRICE, custom_data: { months: 120 } }, quantity: 1 }],
      }),
      SANDBOX_PRICE_MONTHS,
    );
    expect(r.ok, "不一致就该拒绝,而不是取较大值").toBe(false);
  });

  it("custom_data 没声明数字时以白名单为准(不阻断)", () => {
    for (const custom of [null, undefined, {}, { months: "12" }, { months: 1.5 }]) {
      const r = parseTransactionCompleted(
        txnData({ items: [{ price: { id: YEAR_PRICE, custom_data: custom }, quantity: 1 }] }),
        SANDBOX_PRICE_MONTHS,
      );
      expect(r.ok, `custom=${JSON.stringify(custom)}`).toBe(true);
      expect(r.ok && r.grant.months).toBe(12);
    }
  });

  // 0 与 999 同类:都是「声明了数字但与白名单不符」,该报警而非静默忽略。
  it("custom_data.months 为 0 也算不一致(不是畸形忽略)", () => {
    const r = parseTransactionCompleted(
      txnData({ items: [{ price: { id: YEAR_PRICE, custom_data: { months: 0 } }, quantity: 1 }] }),
      SANDBOX_PRICE_MONTHS,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("months_mismatch");
  });

  // 多 items(哪怕同一 price 重复)会累加月数,是一条放大路径。
  // 产品上不存在「一次买两段时长」,故直接拒绝。
  it("多条目一律拒绝(累加是放大路径)", () => {
    const r = parseTransactionCompleted(
      txnData({
        items: [
          { price: { id: YEAR_PRICE }, quantity: 1 },
          { price: { id: QUARTER_PRICE }, quantity: 1 },
        ],
      }),
      SANDBOX_PRICE_MONTHS,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("too_many_items");
  });

  it("同一 price 重复两次也拒绝", () => {
    const r = parseTransactionCompleted(
      txnData({
        items: [
          { price: { id: YEAR_PRICE }, quantity: 1 },
          { price: { id: YEAR_PRICE }, quantity: 1 },
        ],
      }),
      SANDBOX_PRICE_MONTHS,
    );
    expect(r.ok).toBe(false);
  });

  // quantity=10 曾能把 12 个月放大到 120(买 1 年拿 10 年),而 120 恰好等于旧上限。
  // 唯一防线是 Paddle 后台的 quantity.maximum=1 —— 那在 Paddle 侧,不在我们代码里。
  it("quantity 必须恰好是 1(>1 是放大路径)", () => {
    for (const q of [2, 10, 11, 100]) {
      const r = parseTransactionCompleted(
        txnData({ items: [{ price: { id: QUARTER_PRICE }, quantity: q }] }),
        SANDBOX_PRICE_MONTHS,
      );
      expect(r.ok, `quantity=${q} 应被拒`).toBe(false);
      if (r.ok) continue;
      expect(r.reason).toBe("bad_quantity");
    }
  });

  // 收钱路径不做「默认放行」:早先畸形 quantity 被当成 1 继续发时长,那是在
  // 上游或集成异常时替它猜,可能过发。宁可拒绝 + 留审计等人工核对。
  it("畸形 quantity 一律拒绝,不当成 1", () => {
    for (const q of [0, -1, 1.5, "2", null, undefined, NaN]) {
      const r = parseTransactionCompleted(
        txnData({ items: [{ price: { id: QUARTER_PRICE }, quantity: q }] }),
        SANDBOX_PRICE_MONTHS,
      );
      expect(r.ok, `quantity=${String(q)} 应被拒`).toBe(false);
      if (r.ok) continue;
      expect(r.reason).toBe("bad_quantity");
    }
  });

  // 上限收到实际最长档位(24)而非 adminGrant 的 120:webhook 来源不可信。
  it("超出 MAX_WEBHOOK_MONTHS 的白名单值被拒(reason 独立)", () => {
    const r = parseTransactionCompleted(
      txnData({ items: [{ price: { id: "pri_absurd" }, quantity: 1 }] }),
      { pri_absurd: 36 }, // 白名单里配了个超过 24 的值
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("months_out_of_range");
  });

  it("恰好 24 个月(两年档)通过", () => {
    const r = parseTransactionCompleted(
      txnData({ items: [{ price: { id: "pri_01kypfzvpf02z5731sbnva3n82" }, quantity: 1 }] }),
      SANDBOX_PRICE_MONTHS,
    );
    expect(r.ok && r.grant.months).toBe(24);
  });

  // account_email 是权威:用户可能用公司卡/家人的卡付款,但时长必须落在他
  // 登录的那个账号上。
  it("account_email 优先于 customer.email", () => {
    const r = parseTransactionCompleted(
      txnData({
        custom_data: { account_email: "login@example.com" },
        customer: { email: "payer@example.com" },
      }),
      SANDBOX_PRICE_MONTHS,
    );
    expect(r.ok && r.grant.email).toBe("login@example.com");
  });

  it("没有 account_email 时回落 customer.email", () => {
    const r = parseTransactionCompleted(
      txnData({ custom_data: null, customer: { email: "payer@example.com" } }),
      SANDBOX_PRICE_MONTHS,
    );
    expect(r.ok && r.grant.email).toBe("payer@example.com");
  });

  // 真实历史通知里 custom_data 就是 null。付了钱却不知道给谁 → 必须留审计,
  // 绝不能静默丢弃。
  it("两个邮箱来源都没有 → no_email(调用方须留审计,不可静默丢弃)", () => {
    const r = parseTransactionCompleted(
      txnData({ custom_data: null, customer: null }),
      SANDBOX_PRICE_MONTHS,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("no_email");
    expect(r.detail).toContain("txn_");
  });

  it("非对象 data 安全拒绝(null/undefined/字符串/数字)", () => {
    for (const data of [null, undefined, "string", 42] as unknown[]) {
      const r = parseTransactionCompleted(data, SANDBOX_PRICE_MONTHS);
      expect(r.ok, `data=${String(data)}`).toBe(false);
    }
  });

  it("空 items 拒绝", () => {
    const r = parseTransactionCompleted(txnData({ items: [] }), SANDBOX_PRICE_MONTHS);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("no_items");
  });

  it("白名单可注入(sandbox 与 live 的 price_id 不同)", () => {
    const live: PriceMonthsMap = { pri_live_year: 12 };
    const r = parseTransactionCompleted(
      txnData({ items: [{ price: { id: "pri_live_year" }, quantity: 1 }] }),
      live,
    );
    expect(r.ok && r.grant.months).toBe(12);
    // sandbox 的 id 在 live 白名单里就该被拒
    expect(parseTransactionCompleted(txnData(), live).ok).toBe(false);
  });
});

describe("SANDBOX_PRICE_MONTHS", () => {
  it("三个档位与定价页一致(季3/年12/两年24)", () => {
    // 原来是四档(含创始价 ¥88 → 12 个月)。创始价从未真正实现(无席位计数、
    // entitlements 不记录成交价),PR #209 已从所有页面撤下,现在白名单也关闭。
    expect(Object.values(SANDBOX_PRICE_MONTHS).sort((a, b) => a - b)).toEqual([3, 12, 24]);
  });
});

describe("原型链污染:未知 price_id 不得命中 Object.prototype", () => {
  // priceMonths 是普通对象字面量,原型链上有 toString/valueOf/constructor/__proto__。
  // `priceMonths["toString"]` 返回 function 而非 undefined → 逃过 unknown_price;
  // 随后 `function * 1 = NaN`,而 `NaN < 1` 与 `NaN > 24` **两边都是 false**
  // → 连范围检查也逃过,最终产出 months=NaN。实测复现过。
  it.each(["toString", "valueOf", "constructor", "__proto__", "hasOwnProperty", "isPrototypeOf"])(
    "price_id=%s 被判为 unknown_price(而非 NaN 月数)",
    (evil) => {
      const r = parseTransactionCompleted(
        txnData({ items: [{ price: { id: evil }, quantity: 1 }] }),
        SANDBOX_PRICE_MONTHS,
      );
      expect(r.ok, `${evil} 必须被拒`).toBe(false);
      if (r.ok) return;
      expect(r.reason).toBe("unknown_price");
    },
  );

  it("白名单值本身畸形时也拒(非整数/负数/NaN)", () => {
    for (const bad of [0, -1, 1.5, NaN, Infinity]) {
      const r = parseTransactionCompleted(
        txnData({ items: [{ price: { id: "pri_bad" }, quantity: 1 }] }),
        { pri_bad: bad },
      );
      expect(r.ok, `白名单值=${bad}`).toBe(false);
    }
  });
});

describe("items 元素为 null 不得抛错(500 → 无限重投)", () => {
  it("items:[null] 安全归到 unknown_price", () => {
    const r = parseTransactionCompleted(txnData({ items: [null] }), SANDBOX_PRICE_MONTHS);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("unknown_price");
  });

  it.each([[[{}]], [[{ price: null }]], [[{ price: {} }]]])(
    "畸形 item 结构安全拒绝:%j",
    (items) => {
      const r = parseTransactionCompleted(txnData({ items }), SANDBOX_PRICE_MONTHS);
      expect(r.ok).toBe(false);
    },
  );
});

describe("价格白名单 = 最后一道闸", () => {
  const FOUNDING_LIVE = "pri_01kyrw1773tc65xxdtgqcqyfpk";
  const FOUNDING_SANDBOX = "pri_01kypfzvyvgmytaefznh4npsz7";

  it("创始价 ¥88 不在任何白名单里", () => {
    // 它在 Paddle 侧仍是 active,所以只要白名单放它进来就真能被买 ——
    // ¥88 买 12 个月,比年度档便宜 ¥20,而我们既不知情也拦不住。
    // 产品侧从未实现席位计数,entitlements 也不记录成交价,「前 100 席」无法执行。
    expect(LIVE_PRICE_MONTHS).not.toHaveProperty(FOUNDING_LIVE);
    expect(SANDBOX_PRICE_MONTHS).not.toHaveProperty(FOUNDING_SANDBOX);
  });

  it("live 与 sandbox 档位一一对应", () => {
    // 两边月数集合必须相同。不一致会让 sandbox 测通的路径到 live 变成 400,
    // 那类差异最难查 —— 因为所有自动化测试都是绿的。
    expect(Object.values(SANDBOX_PRICE_MONTHS).sort()).toEqual(
      Object.values(LIVE_PRICE_MONTHS).sort(),
    );
  });

  it("只有三档,且是 3 / 12 / 24 个月", () => {
    expect(Object.values(LIVE_PRICE_MONTHS).sort((a, b) => a - b)).toEqual([3, 12, 24]);
  });

  it("每档月数都在 webhook 上限内", () => {
    for (const months of Object.values(LIVE_PRICE_MONTHS)) {
      expect(months).toBeLessThanOrEqual(MAX_WEBHOOK_MONTHS);
    }
  });
});
