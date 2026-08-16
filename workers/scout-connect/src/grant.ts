import { computeExpiry, latestExpiry, reconcileEntitlementLedger } from "./entitlement.js";
import type { AccountRow, ConnectDb, EntitlementRow } from "./db.js";

/**
 * 发放预付时长(账本式)。
 *
 * 由两条路径共用:admin 手工授予(`POST /api/admin/grant`)与支付订单入账。
 * 抽出来的理由不只是去重 —— 它们的续费语义、幂等语义、账号 upsert
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
  /** Existing payment account. When supplied, email must match it exactly after normalization. */
  accountId?: string;
  /** 未归一的邮箱(本函数负责 trim + lowercase)。 */
  email: string;
  months: number;
  /** 复用 EntitlementRow 的联合类型,而不是宽泛 string:发放来源是有限集合,
   *  写错值会让账本对不上(也无法按来源统计)。 */
  source: EntitlementRow["source"];
  /** Payment-scoped idempotency pair. Manual grants use two nulls. */
  paymentProvider?: EntitlementRow["payment_provider"];
  paymentTransactionId?: string | null;
}

export interface GrantResult {
  accountId: string;
  /** 授予后的最新到期时刻。幂等命中时是**已存在**的到期时刻,不会再叠加一次。 */
  expiresAt: string;
  /** true = 真的入账了;false = 幂等命中(同一支付交易已入过)。 */
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

async function resolveAccount(input: GrantInput, email: string, deps: GrantDeps): Promise<AccountRow> {
  if (input.accountId === undefined) return upsertAccount(email, deps);
  const account = await deps.db.getAccountById(input.accountId);
  if (account === null) throw new Error("payment account not found");
  if (account.email.trim().toLowerCase() !== email) {
    throw new Error("payment account email mismatch");
  }
  return account;
}

export async function grantEntitlement(
  input: GrantInput,
  deps: GrantDeps,
): Promise<GrantResult> {
  // 邮箱归一:输入大小写不一定与注册时一致,不归一会给同一个人建两个账号。
  const email = input.email.trim().toLowerCase();
  const now = deps.now();
  const account = await resolveAccount(input, email, deps);
  const paymentProvider = input.paymentProvider ?? null;
  const paymentTransactionId = input.paymentTransactionId ?? null;
  if ((paymentProvider === null) !== (paymentTransactionId === null)) {
    throw new Error("payment provider and transaction id must be supplied together");
  }

  const ents = await deps.db.listEntitlements(account.id);
  const expiresAt = computeExpiry({
    currentExpiry: latestExpiry(ents),
    months: input.months,
    now,
  });

  const entitlementId = deps.newEntitlementId();
  const applied = await deps.db.insertEntitlement({
    id: entitlementId,
    account_id: account.id,
    expires_at: expiresAt,
    source: input.source,
    paddle_transaction_id: paymentProvider === "paddle" ? paymentTransactionId : null,
    payment_provider: paymentProvider,
    payment_transaction_id: paymentTransactionId,
    refunded_at: null,
    months: input.months,
    created_at: now,
  });

  if (!applied) {
    // 幂等命中(同一支付交易已入过账)。**必须回读**而不是返回
    // 上面算出的 expiresAt —— 那个值是「假设本次入账」算出来的,比真实到期多
    // 一个周期。支付通知重投很常见,回错值会让控制台显示比实际更长的有效期。
    // **重投要有自愈能力。** 上一次的并发收敛可能在 insert 之后、update
    // 之前失败。统一重建每个有效缓存，既修复旧错误，也正确排除退款行。
    const truth = await reconcileEntitlementLedger(account.id, deps.db);
    return {
      accountId: account.id,
      expiresAt: truth ?? expiresAt,
      applied: false,
    };
  }

  // **并发安全:写入后从整本账重算,并在需要时修正本行。**
  // 「读最新到期 → 加 N 个月 → 写」在并发下有 lost update:两个 webhook 同时
  // 进来会读到同一个 currentExpiry,各自算出同一个 expires_at,结果用户付了
  // 24 个月只拿到 12 个月(已用确定性交错实测复现)。D1 没有跨请求事务,加不了锁。
  // 重算的结果与写入顺序无关,所以两个并发请求最终都会收敛到正确值。
  const truth = await reconcileEntitlementLedger(account.id, deps.db);
  return { accountId: account.id, expiresAt: truth ?? expiresAt, applied: true };
}
