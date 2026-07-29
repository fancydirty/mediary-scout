import { computeExpiry, latestExpiry } from "./entitlement.js";
import type { AccountRow, ConnectDb, EntitlementRow } from "./db.js";

/**
 * 发放预付时长(账本式)。
 *
 * 由两条路径共用:admin 手工授予(`POST /api/admin/grant`)与 Paddle webhook
 * 付款入账。抽出来的理由不只是去重 —— 它们的续费语义、幂等语义、账号 upsert
 * 的竞态处理必须**完全一致**。此前 adminGrant 里还手写了一遍「找最新到期」的
 * for 循环,而 entitlement.ts 早就有 latestExpiry();两份实现迟早漂移。
 */

export interface GrantDeps {
  db: ConnectDb;
  now: () => string;
  newAccountId: () => string;
  newEntitlementId: () => string;
}

export interface GrantInput {
  /** 未归一的邮箱(本函数负责 trim + lowercase)。 */
  email: string;
  months: number;
  /** 复用 EntitlementRow 的联合类型,而不是宽泛 string:发放来源是有限集合,
   *  写错值会让账本对不上(也无法按来源统计)。 */
  source: EntitlementRow["source"];
  /** Paddle 交易 ID。幂等键 —— 同一交易重投不会重复入账。
   *  手工授予传 null(schema 的偏唯一索引只覆盖非 null,故多次手工授予都入账)。 */
  paddleTransactionId: string | null;
}

export interface GrantResult {
  accountId: string;
  /** 授予后的最新到期时刻。幂等命中时是**已存在**的到期时刻,不会再叠加一次。 */
  expiresAt: string;
  /** true = 真的入账了;false = 幂等命中(同一 paddle_transaction_id 已入过)。 */
  applied: boolean;
}

/** 账号 upsert,并发安全:UNIQUE 冲突时重读对手插入的行。 */
async function upsertAccount(email: string, deps: GrantDeps): Promise<AccountRow> {
  const existing = await deps.db.getAccountByEmail(email);
  if (existing !== null) return existing;
  try {
    return await deps.db.insertAccount({
      id: deps.newAccountId(),
      email,
      paddle_customer_id: null,
      created_at: deps.now(),
      last_login_at: null,
    });
  } catch (e) {
    // 并发对手赢了这一插:重读它插入的行。读不到说明 UNIQUE 失败另有其因,
    // 那是真异常,不能吞。
    const raced = await deps.db.getAccountByEmail(email);
    if (raced === null) throw e;
    return raced;
  }
}

export async function grantEntitlement(
  input: GrantInput,
  deps: GrantDeps,
): Promise<GrantResult> {
  // 邮箱归一:Paddle 回传的大小写不一定与注册时一致,不归一会给同一个人建两个
  // 账号(付了钱却在另一个账号下)。
  const email = input.email.trim().toLowerCase();
  const now = deps.now();
  const account = await upsertAccount(email, deps);

  const ents = await deps.db.listEntitlements(account.id);
  const expiresAt = computeExpiry({
    currentExpiry: latestExpiry(ents),
    months: input.months,
    now,
  });

  const applied = await deps.db.insertEntitlement({
    id: deps.newEntitlementId(),
    account_id: account.id,
    expires_at: expiresAt,
    source: input.source,
    paddle_transaction_id: input.paddleTransactionId,
    months: input.months,
    created_at: now,
  });

  if (!applied) {
    // 幂等命中(同一 paddle_transaction_id 已入过账)。**必须回读**而不是返回
    // 上面算出的 expiresAt —— 那个值是「假设本次入账」算出来的,比真实到期多
    // 一个周期。Paddle 重投很常见,回错值会让控制台显示比实际更长的有效期。
    const after = await deps.db.listEntitlements(account.id);
    return { accountId: account.id, expiresAt: latestExpiry(after) ?? expiresAt, applied: false };
  }
  return { accountId: account.id, expiresAt, applied: true };
}
