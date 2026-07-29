/**
 * Paddle webhook 事件解析:从 `transaction.completed` 算出该发多少个月。
 *
 * payload 形状取自 sandbox 真实通知(不是照文档猜):
 *   { event_id, event_type, occurred_at, notification_id,
 *     data: { id, status, customer_id, custom_data, currency_code,
 *             details: { totals: {...} },
 *             items: [{ price: { id, custom_data, product_id }, quantity }] } }
 */

import type { EntitlementRow } from "./db.js";

/**
 * price_id → 月数白名单。**这是权威**,`custom_data.months` 只做交叉校验。
 *
 * 为什么不直接信 payload 里的 custom_data:那是可以在 Paddle 后台改的值,
 * 而后台权限与代码权限是两套。白名单保证「后台被改/被入侵也不会凭空多发时长」。
 * 反过来 custom_data 也不能不看 —— 它能抓到「后台改了价而代码忘了同步」:
 * 两者不一致时拒绝并要求人工核对,比静默按其中一个执行安全。
 *
 * sandbox 与 live 的 price_id 完全不同(两套独立环境),故按环境分别列出。
 */
export interface PriceMonthsMap {
  readonly [priceId: string]: number;
}

/** sandbox 的四个 one-time price(2026-07-29 建)。 */
export const SANDBOX_PRICE_MONTHS: PriceMonthsMap = {
  pri_01kypfzv2jqg2qv0g25bn05v28: 3, // 季度 ¥45
  pri_01kypfzvbkhp0a7npjg87ptxpb: 12, // 年度 ¥108
  pri_01kypfzvpf02z5731sbnva3n82: 24, // 两年 ¥188
  pri_01kypfzvyvgmytaefznh4npsz7: 12, // 创始价 ¥88
};

export type ParseFailure =
  | "not_completed"
  | "no_items"
  | "unknown_price"
  | "months_out_of_range"
  | "months_mismatch"
  | "no_email";

export interface ParsedGrant {
  months: number;
  email: string;
  transactionId: string;
  source: EntitlementRow["source"];
}

export type ParseResult =
  | { ok: true; grant: ParsedGrant }
  | { ok: false; reason: ParseFailure; detail: string };

interface TxnItem {
  price?: { id?: unknown; custom_data?: unknown } | null;
  quantity?: unknown;
}

/**
 * 取 custom_data.months 用于交叉校验。
 *
 * 关键区分:**「没声明」与「声明了但对不上」是两件事**。
 * - 返回 null = 压根没有可比的声明(缺字段、非整数、非数字)→ 跳过交叉校验,
 *   以白名单为准
 * - 返回数字 = 有声明(**即便超出合理范围**)→ 必须与白名单比对
 *
 * 早先这里把 `m > 120` 也归成 null,于是 `months: 999` 被静默忽略、交叉校验
 * 直接跳过 —— 而 999 恰恰是最该报警的情形(后台被改或被伪造)。范围检查放在
 * 累加之后统一做,这里只负责"有没有声明一个数字"。
 */
function readMonthsFromCustomData(custom: unknown): number | null {
  if (typeof custom !== "object" || custom === null) return null;
  const m = (custom as { months?: unknown }).months;
  if (typeof m !== "number" || !Number.isFinite(m) || !Number.isInteger(m)) return null;
  return m;
}

/**
 * 从 `transaction.completed` 的 data 解析出要发放的时长。
 *
 * 邮箱来源优先级:
 *   1. `data.custom_data.account_email` —— 我方创建交易时写入的登录账号邮箱。
 *      **这是权威**:用户可能用另一个邮箱付款(公司卡、家人代付),而时长必须
 *      落在他登录的那个账号上。
 *   2. `data.customer.email` —— 兜底。仅当交易不是我方创建时才可能走到
 *      (比如后台手工建的交易)。
 *
 * 两个都没有 → `no_email`。调用方**不得静默丢弃**:那意味着用户付了钱而
 * 系统不知道该给谁,必须留审计供人工处理。
 */
export function parseTransactionCompleted(
  data: unknown,
  priceMonths: PriceMonthsMap,
): ParseResult {
  if (typeof data !== "object" || data === null) {
    return { ok: false, reason: "not_completed", detail: "data is not an object" };
  }
  const d = data as {
    id?: unknown;
    status?: unknown;
    custom_data?: unknown;
    customer?: { email?: unknown } | null;
    items?: unknown;
  };

  // 只处理真正完成的交易。draft/ready/billed 都还没收到钱。
  if (d.status !== "completed") {
    return { ok: false, reason: "not_completed", detail: `status=${String(d.status)}` };
  }
  const transactionId = typeof d.id === "string" ? d.id : "";
  if (transactionId === "") {
    return { ok: false, reason: "not_completed", detail: "missing transaction id" };
  }

  const items = Array.isArray(d.items) ? (d.items as TxnItem[]) : [];
  if (items.length === 0) {
    return { ok: false, reason: "no_items", detail: "items is empty" };
  }

  // 累加所有条目的月数 × 数量。正常只会有一条(price 的 quantity 上限设为 1),
  // 但按累加处理更稳:将来若允许一次买两段时长,语义天然正确。
  let months = 0;
  for (const item of items) {
    const priceId = typeof item.price?.id === "string" ? item.price.id : "";
    const mapped = priceId === "" ? undefined : priceMonths[priceId];
    if (mapped === undefined) {
      // 未知 price_id:可能是新建了档位但没更新白名单,也可能是伪造。
      // 一律拒绝 —— 凭猜发时长比不发更糟。
      return { ok: false, reason: "unknown_price", detail: `price_id=${priceId}` };
    }
    const declared = readMonthsFromCustomData(item.price?.custom_data);
    if (declared !== null && declared !== mapped) {
      // 后台 custom_data 与代码白名单不一致 → 有人改了价而代码没同步(或反之)。
      // 拒绝并要求人工核对:静默按其中一个执行,会导致账本与实际售卖不符。
      return {
        ok: false,
        reason: "months_mismatch",
        detail: `price_id=${priceId} whitelist=${mapped} custom_data=${declared}`,
      };
    }
    const qty = typeof item.quantity === "number" && Number.isInteger(item.quantity) && item.quantity > 0
      ? item.quantity
      : 1;
    months += mapped * qty;
  }
  if (months < 1 || months > 120) {
    // 与 unknown_price 分开:routes.ts 会用 reason 拼审计 action
    // (paddle.unprocessable.<reason>),混在一起会让告警指向错误的原因。
    // 这类失败通常意味着 quantity 异常或白名单配错,不是"没见过这个 price"。
    return {
      ok: false,
      reason: "months_out_of_range",
      detail: `computed months out of range: ${months}`,
    };
  }

  const custom = typeof d.custom_data === "object" && d.custom_data !== null ? d.custom_data : {};
  const fromCustom = (custom as { account_email?: unknown }).account_email;
  const fromCustomer = d.customer?.email;
  const email =
    typeof fromCustom === "string" && fromCustom.trim() !== ""
      ? fromCustom
      : typeof fromCustomer === "string" && fromCustomer.trim() !== ""
        ? fromCustomer
        : "";
  if (email === "") {
    return { ok: false, reason: "no_email", detail: `txn=${transactionId}` };
  }

  return { ok: true, grant: { months, email, transactionId, source: "paddle" } };
}
