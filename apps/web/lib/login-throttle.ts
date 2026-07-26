/**
 * 登录限流（暴力破解防护）。单进程自托管，用进程内 Map 即可——无需 DB、天然可测。
 * 时钟以 `now` 参数注入，保证测试确定性。远程访问上线前这是登录入口的命门。
 *
 * 注意：这是**固定窗口**（tumbling window）而非滑动窗口——`windowStart` 只在
 * 「窗口过期」或「触发锁定」时前移，不随每次尝试滑动。已知折衷：停在每窗口
 * 4 次失败的低速攻击者不会触发锁定。
 *
 * 单进程假设：docker `web` 单实例 / desktop 单进程。若将来横向扩展成多副本，
 * 限流会退化为「每副本各算一份」（猜测预算 ×N），届时须迁到共享存储。
 */
export type LoginVerdict =
  | { allowed: true }
  | { allowed: false; retryAfterSec: number };

interface Bucket {
  failures: number;    // 当前固定窗口内的连续失败数
  windowStart: number; // 窗口起点（ms）
  lockedUntil: number; // 锁定到该时刻（ms）
  lockCount: number;   // 累计锁定次数（用于指数退避）
}

const WINDOW_MS = 15 * 60 * 1000; // 15 分钟固定窗口
const MAX_FAILURES = 5;           // 窗口内达到此次失败即锁
const BASE_LOCK_MS = 60 * 1000;   // 首次锁 1 分钟
const MAX_LOCK_MS = 30 * 60 * 1000; // 锁定上限 30 分钟
const MAX_BUCKETS = 10_000;       // 内存硬上限（攻击者轮换 username|ip 时的护栏）

const buckets = new Map<string, Bucket>();

/** 清扫已死条目（无活跃锁 + 窗口已过）。 */
function sweepDeadBuckets(now: number): void {
  for (const [k, v] of buckets) {
    if (now >= v.lockedUntil && now - v.windowStart > WINDOW_MS) {
      buckets.delete(k);
    }
  }
}

/**
 * 强制 Map 不超过 MAX_BUCKETS：先清死条目；若仍超限，按插入顺序驱逐最老的，
 * 但**跳过仍在锁定中的条目**（否则攻击者可用海量新 key 冲掉自己的锁）。
 * 全部条目都在锁定中的极端情况下停止驱逐——此时 Map 里全是真实攻击者，
 * 保锁比保内存重要（10k 条 ≈ 1.5MB，可接受）。
 */
function enforceBucketCap(now: number): void {
  if (buckets.size < MAX_BUCKETS) return;
  sweepDeadBuckets(now);
  if (buckets.size < MAX_BUCKETS) return;
  for (const [k, v] of buckets) {
    if (buckets.size < MAX_BUCKETS) break;
    if (now < v.lockedUntil) continue; // 锁定中，不驱逐
    buckets.delete(k);
  }
}

export function checkLoginAllowed(key: string, now: number): LoginVerdict {
  const b = buckets.get(key);
  if (!b) return { allowed: true };
  if (now < b.lockedUntil) {
    return { allowed: false, retryAfterSec: Math.ceil((b.lockedUntil - now) / 1000) };
  }
  return { allowed: true };
}

export function recordLoginFailure(key: string, now: number): void {
  // 内存硬护栏：攻击者轮换 username|ip 时防止 Map 无界增长
  enforceBucketCap(now);
  let b = buckets.get(key);
  // 窗口已过 → 重置失败数与窗口，但保留 lockedUntil（否则锁定时长超过窗口时，
  // 一次废弃猜测即可解锁，退避阶梯上半截形同虚设）与 lockCount（持续升级锁定）
  if (!b || now - b.windowStart > WINDOW_MS) {
    b = { failures: 0, windowStart: now, lockedUntil: b?.lockedUntil ?? 0, lockCount: b?.lockCount ?? 0 };
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

/** 仅测试用：当前桶数量（用于断言内存上限真的生效）。 */
export function _bucketCountForTest(): number {
  return buckets.size;
}

/** 仅测试用：内存硬上限常量（避免测试硬编码魔数与实现脱节）。 */
export const _MAX_BUCKETS_FOR_TEST = MAX_BUCKETS;

/** 限流键中 username 与 ip 各自的最大长度（防超长键放大内存占用）。 */
const MAX_KEY_PART = 64;

/**
 * 组装限流键 `username|ip`（纯函数，便于测试）。
 *
 * IP 取值优先级：`cf-connecting-ip` > `x-forwarded-for` 首段 > `"unknown"`。
 * 经隧道的远程请求由 Cloudflare 注入 `cf-connecting-ip`，客户端伪造不了；
 * `x-forwarded-for` 客户端可随意伪造，仅在无 CF 头（局域网直连）时作为次选，
 * 且局域网本就不是本限流的主要威胁面。两部分均截断到 64 字符，
 * 避免攻击者用超长 username 放大单条桶的内存占用。
 */
export function buildThrottleKey(headers: Headers, username: string): string {
  const cfIp = headers.get("cf-connecting-ip")?.trim();
  const xff = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = (cfIp || xff || "unknown").slice(0, MAX_KEY_PART);
  const user = username.trim().toLowerCase().slice(0, MAX_KEY_PART);
  return `${user}|${ip}`;
}
