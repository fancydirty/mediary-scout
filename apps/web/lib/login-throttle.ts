/**
 * 登录限流（暴力破解防护）。单进程自托管，用进程内 Map 即可——无需 DB、天然可测。
 * 时钟以 `now` 参数注入，保证测试确定性。远程访问上线前这是登录入口的命门。
 */
export type LoginVerdict =
  | { allowed: true }
  | { allowed: false; retryAfterSec: number };

interface Bucket {
  failures: number;    // 当前滑动窗口内的连续失败数
  windowStart: number; // 窗口起点（ms）
  lockedUntil: number; // 锁定到该时刻（ms）
  lockCount: number;   // 累计锁定次数（用于指数退避）
}

const WINDOW_MS = 15 * 60 * 1000; // 15 分钟滑动窗口
const MAX_FAILURES = 5;           // 窗口内达到此次失败即锁
const BASE_LOCK_MS = 60 * 1000;   // 首次锁 1 分钟
const MAX_LOCK_MS = 30 * 60 * 1000; // 锁定上限 30 分钟

const buckets = new Map<string, Bucket>();

export function checkLoginAllowed(key: string, now: number): LoginVerdict {
  const b = buckets.get(key);
  if (!b) return { allowed: true };
  if (now < b.lockedUntil) {
    return { allowed: false, retryAfterSec: Math.ceil((b.lockedUntil - now) / 1000) };
  }
  return { allowed: true };
}

export function recordLoginFailure(key: string, now: number): void {
  let b = buckets.get(key);
  // 窗口已过 → 重置失败数与窗口，但保留 lockCount 以持续升级锁定
  if (!b || now - b.windowStart > WINDOW_MS) {
    b = { failures: 0, windowStart: now, lockedUntil: 0, lockCount: b?.lockCount ?? 0 };
  }
  b.failures += 1;
  if (b.failures >= MAX_FAILURES) {
    b.lockCount += 1;
    const lockMs = Math.min(BASE_LOCK_MS * 2 ** (b.lockCount - 1), MAX_LOCK_MS);
    b.lockedUntil = now + lockMs;
    b.failures = 0;      // 为下一轮计数清零
    b.windowStart = now;
  }
  buckets.set(key, b);
}

export function recordLoginSuccess(key: string): void {
  buckets.delete(key);
}

/** 仅测试用：清空所有限流桶。 */
export function _resetLoginThrottleForTest(): void {
  buckets.clear();
}
