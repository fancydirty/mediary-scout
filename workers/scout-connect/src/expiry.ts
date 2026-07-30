/**
 * 到期状态机(纯函数部分):时间边界计算。
 *
 * 业务语义(spec `2026-07-29-capacity-billing-expiry-slug-design.md`):
 *   到期 → 7 天宽限(服务照常)→ 宽限期满**立即删 DNS + 删隧道**,释放 CF 配额。
 *   slug 是 DB 里的一行,不占配额;隧道才占。续期后重跑一次 connect.sh 即恢复,
 *   slug 与域名不变。
 *
 * 把状态推进算成纯函数,cron 的 `scheduled` handler 只是把这些结果落到
 * DB/CF/邮件 —— 时间边界最容易算错,必须能脱离 worker 单独测试。
 */

export const GRACE_PERIOD_DAYS = 7;

const DAY_MS = 24 * 60 * 60_000;

/** 到期时刻(N 个 entitlement 中 expires_at 最大者)过期 N 天后的宽限截止。
 *  坏值返回 null 而非抛错 —— 与本模块 phaseOf/daysLeftInGrace 的
 *  fail-closed 契约一致:DB 里的坏时刻是数据事故,不该让整个状态机崩掉。 */
export function graceUntil(expiry: string): string | null {
  const ms = Date.parse(expiry);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + GRACE_PERIOD_DAYS * DAY_MS).toISOString();
}

export type ExpiryPhase =
  | "active" // 未到期
  | "grace" // 宽限期中(到期已过,宽限未满)
  | "expired"; // 宽限已满(该回收了)

/**
 * 算某 endpoint 此刻处于哪个阶段。
 *
 * `latestExpiry` 是该账号最新到期时刻(null = 从未付费)。
 * `now` 必须取一次传入 —— cron 一轮里若多次取当下,边界附近会算出矛盾的状态。
 *
 * 坏值一律 fail-closed 到 "expired"(宁可多回收也不漏回收):
 * 一个算不出到期的账号,继续占用隧道配额才是最坏情形。
 */
export function phaseOf(latestExpiry: string | null, now: string): ExpiryPhase {
  if (latestExpiry === null) return "expired";
  const expMs = Date.parse(latestExpiry);
  const nowMs = Date.parse(now);
  // now 或 expiry 任一为 NaN → 无法判断,偏保守判 expired。
  // 但**绝不因时钟坏就真删** —— scheduled handler 对 NaN now 要先卡掉(见下)。
  if (!Number.isFinite(expMs) || !Number.isFinite(nowMs)) return "expired";
  if (nowMs < expMs) return "active";
  // 截止瞬间仍是宽限期(<=):否则宽限期实际只有 6 天 23:59:59,
  // 与条款承诺的「7 天宽限」差一毫秒。
  if (nowMs <= expMs + GRACE_PERIOD_DAYS * DAY_MS) return "grace";
  return "expired";
}

/** 距到期还剩的整天数(active 阶段)。负数返回 0。 */
export function daysUntilExpiry(latestExpiry: string, now: string): number {
  const ms = Date.parse(latestExpiry) - Date.parse(now);
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.ceil(ms / DAY_MS));
}

/** 宽限期还剩的整天数(grace 阶段)。负数返回 0。 */
export function daysLeftInGrace(latestExpiry: string, now: string): number {
  const ms = Date.parse(latestExpiry) + GRACE_PERIOD_DAYS * DAY_MS - Date.parse(now);
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.ceil(ms / DAY_MS));
}

/** 是否到了该发提醒邮件的节点(到期前第 7 天或第 1 天)。 */
export function reminderKind(latestExpiry: string, now: string): "7d" | "1d" | null {
  const days = daysUntilExpiry(latestExpiry, now);
  if (days === 7) return "7d";
  if (days === 1) return "1d";
  return null;
}
