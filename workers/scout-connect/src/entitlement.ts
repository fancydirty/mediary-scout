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
export function latestExpiry(entitlements: { expires_at: string }[]): string | null {
  let latest: string | null = null;
  for (const e of entitlements) {
    if (latest === null || Date.parse(e.expires_at) > Date.parse(latest)) {
      latest = e.expires_at;
    }
  }
  return latest;
}
