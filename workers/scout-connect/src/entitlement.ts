import type { ConnectDb } from "./db.js";

/**
 * 预付时长计算(纯函数,决策 #2 预付时长制)。
 *
 * 账本式:每次充值一行 entitlement,业务层用本模块算出新的 expires_at 后写入。
 * 续费语义:未到期从旧到期时刻叠加(不浪费剩余),已过期从当下重启
 * (不把断掉的时间补回来)。
 */

/** 给 ISO 时刻加 N 个自然月,day-of-month 溢出时钳到目标月最后一天。 */
export function addMonths(iso: string, months: number): string {
  const d = new Date(iso);
  const day = d.getUTCDate();
  const target = new Date(d.getTime());
  target.setUTCDate(1); // 先归 1 号,避免 setUTCMonth 的溢出跳月
  target.setUTCMonth(target.getUTCMonth() + months);
  // 钳到目标月的最后一天与原 day 的较小者
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString();
}

export interface ComputeExpiryInput {
  /** 该账号当前最新到期时刻;从未充值为 null。 */
  currentExpiry: string | null;
  months: number;
  now: string;
}

/** 算出本次充值后的新到期时刻。 */
export function computeExpiry(input: ComputeExpiryInput): string {
  const nowMs = Date.parse(input.now);
  const curMs = input.currentExpiry === null ? NaN : Date.parse(input.currentExpiry);
  // 未到期(到期时刻严格晚于当下)→ 从旧到期叠加;否则从当下起算。
  const base =
    Number.isFinite(curMs) && curMs > nowMs ? input.currentExpiry! : input.now;
  return addMonths(base, input.months);
}

/** 账号当前是否在有效期内。null / 坏值一律判为无效(fail closed)。 */
export function isEntitlementActive(latestExpiry: string | null, now: string): boolean {
  if (latestExpiry === null) return false;
  const expMs = Date.parse(latestExpiry);
  if (!Number.isFinite(expMs)) return false;
  return expMs > Date.parse(now);
}

/** 最新到期时刻 = entitlements 里 expires_at 最大者(账本式,每次充值一行)。
 *  原先是 console-page 的私有函数;自助 provision 的门禁也要用,提为共享。 */
export function latestExpiry(
  entitlements: { expires_at: string; refunded_at?: string | null }[],
): string | null {
  let latest: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const e of entitlements) {
    if (e.refunded_at != null) continue;
    const expiresMs = Date.parse(e.expires_at);
    if (!Number.isFinite(expiresMs)) continue;
    if (expiresMs > latestMs) {
      latest = e.expires_at;
      latestMs = expiresMs;
    }
  }
  return latest;
}

/**
 * 从**整本账**重算最新到期时刻(并发安全的核心)。
 *
 * 为什么需要它:`grantEntitlement` 的「读最新到期 → 加 N 个月 → 写入」在并发下
 * 有 lost update —— 两个 webhook 同时进来,都读到同一个 currentExpiry,各自算出
 * 同一个 expires_at,结果**用户付了 24 个月只拿到 12 个月**(已用确定性交错实测
 * 复现)。D1 没有跨请求事务,加不了锁。
 *
 * 解法是让账本自身可重算:`expires_at` 列只是缓存,真值由「所有 months 之和」
 * 决定。按 created_at 顺序把每笔的月数依次叠加,得到的结果与写入顺序无关 ——
 * 无论两个请求谁先谁后,重算出来都一样。
 *
 * 续费语义保持不变:每一步都用 computeExpiry(未到期从旧到期叠加,已过期从
 * 当笔的时刻重启)。
 */
export function recomputeExpiry(
  // 刻意不要 expires_at:它是本函数改写的派生缓存,不该参与计算或排序。
  entitlements: {
    id: string;
    months: number;
    created_at: string;
    refunded_at?: string | null;
  }[],
): string | null {
  const effective = effectiveEntitlements(entitlements);
  if (effective.length === 0) return null;
  // 按创建时间排序。
  //
  // **用 localeCompare 而非 Date.parse 相减**:坏值会让 Date.parse 得 NaN,
  // 比较器返回 NaN 等同于返回 0 → 排序保证静默失效。实测一个坏值就能把
  // 2026-03 排到 2026-01 前面;而 localeCompare 对坏值仍给确定顺序,结果可复现。
  // created_at/expires_at 都是固定宽度的 ISO-8601 UTC,字典序即时间序
  // (本仓 byCreatedAtAsc/Desc 也是这么做的)。
  //
  // **只用内在键排序:created_at 然后 id。刻意不含 expires_at。**
  // expires_at 是本函数自己会改写的**派生缓存**(grant.ts 的收敛会把它写成
  // truth)。把它当排序键意味着「重算结果依赖上一次重算写下的缓存」——
  // 那让本该幂等的重算变成有状态的,同 created_at 时甚至可能因为缓存被改而
  // 在两次重算间得到不同答案。
  // id 是主键,天然全序,足以打破 created_at 相等的平局。
  //
  // 为什么必须有确定的全序:月加法**不满足结合律**
  // (addMonths(addMonths(x,1),1) ≠ addMonths(x,2),月末钳位有损),
  // 所以顺序不同真会算出差一天的到期。而 SQLite 的 ORDER BY 对相等键不保证
  // 稳定(EXPLAIN 显示走 TEMP B-TREE),memory 实现的顺序又与 D1 不同 ——
  // 排序不能指望 DB。
  let acc: string | null = null;
  for (const e of effective) {
    // **跳过 created_at 坏值的行。** 不只是排序问题:坏值会让 addMonths 里的
    // `new Date("BAD")` 变成 Invalid Date,`toISOString()` 抛 RangeError,
    // 冒到 webhook 就是 500 → Paddle 无限重投(测试抓到过)。
    // 账本里出现坏时刻本身是数据事故,但重算的职责是「用能用的数据算出真值」,
    // 而不是整笔崩掉 —— 崩掉会连带让好的那些行也拿不到时长。
    if (!Number.isFinite(Date.parse(e.created_at))) continue;
    if (!Number.isInteger(e.months) || e.months < 1) continue;
    // 以「这笔充值发生的时刻」为 now:已过期就从那一刻重启,未过期则叠加。
    acc = computeExpiry({ currentExpiry: acc, months: e.months, now: e.created_at });
  }
  return acc;
}

/** Keep refunded purchases as history while excluding them from usable time. */
export function effectiveEntitlements<
  T extends { id: string; created_at: string; refunded_at?: string | null },
>(rows: readonly T[]): T[] {
  return rows
    .filter((row) => row.refunded_at == null)
    .sort(
      (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
    );
}

/**
 * Rebuild every non-refunded expiry cache from the immutable ledger inputs.
 * This is shared by grants and refunds so both operations converge under retry.
 */
export async function reconcileEntitlementLedger(
  accountId: string,
  db: ConnectDb,
): Promise<string | null> {
  let expiry: string | null = null;
  for (const row of effectiveEntitlements(await db.listEntitlements(accountId))) {
    if (!Number.isFinite(Date.parse(row.created_at))) continue;
    if (!Number.isInteger(row.months) || row.months < 1) continue;
    expiry = computeExpiry({ currentExpiry: expiry, months: row.months, now: row.created_at });
    if (row.expires_at !== expiry) await db.updateEntitlementExpiry(row.id, expiry);
  }
  return expiry;
}
