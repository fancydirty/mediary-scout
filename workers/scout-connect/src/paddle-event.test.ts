import { describe, expect, it } from "vitest";
import {
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

  it("多条目累加(将来若允许一次买两段时长)", () => {
    const r = parseTransactionCompleted(
      txnData({
        items: [
          { price: { id: YEAR_PRICE }, quantity: 1 },
          { price: { id: QUARTER_PRICE }, quantity: 1 },
        ],
      }),
      SANDBOX_PRICE_MONTHS,
    );
    expect(r.ok && r.grant.months).toBe(15);
  });

  it("quantity 参与计算,畸形值按 1", () => {
    expect(
      (() => {
        const r = parseTransactionCompleted(
          txnData({ items: [{ price: { id: QUARTER_PRICE }, quantity: 2 }] }),
          SANDBOX_PRICE_MONTHS,
        );
        return r.ok && r.grant.months;
      })(),
    ).toBe(6);
    for (const q of [0, -1, 1.5, "2", null, undefined]) {
      const r = parseTransactionCompleted(
        txnData({ items: [{ price: { id: QUARTER_PRICE }, quantity: q }] }),
        SANDBOX_PRICE_MONTHS,
      );
      expect(r.ok && r.grant.months, `quantity=${String(q)}`).toBe(3);
    }
  });

  it("累加结果超出 [1,120] 时拒绝,reason 与 unknown_price 区分", () => {
    const r = parseTransactionCompleted(
      txnData({ items: [{ price: { id: YEAR_PRICE }, quantity: 11 }] }), // 132 个月
      SANDBOX_PRICE_MONTHS,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // 这类失败意味着 quantity 异常或白名单配错,不是"没见过这个 price"。
    // reason 会被拼成审计 action,混淆会让告警失准。
    expect(r.reason).toBe("months_out_of_range");
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
  it("四个档位与定价页一致(季3/年12/两年24/创始12)", () => {
    expect(Object.values(SANDBOX_PRICE_MONTHS).sort((a, b) => a - b)).toEqual([3, 12, 12, 24]);
  });
});
