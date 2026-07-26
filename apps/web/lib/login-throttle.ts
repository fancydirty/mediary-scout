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
 * 为「新 key」腾出一格容量，返回是否允许分配。
 *
 * 顺序：① 未达上限直接放行 → ② 清扫已死条目 → ③ 仍满则按插入顺序驱逐最老的
 * **未锁定**条目（跳过锁定中的，否则攻击者可用海量新 key 把自己的锁冲掉）。
 *
 * ④ 若全部条目都在锁定中（无可驱逐），**拒绝分配新桶**而不是无条件 `set()`。
 * 拒绝是安全的：新 key 尚无失败记录，丢掉它只是让那一次失败不计数，
 * 已存在的锁不受影响；反之无条件 set() 会让 Map 突破上限。
 * 饱和只可能发生在 10k 个 key 同时处于锁定中的真实攻击下，此时保锁优先。
 */
function makeRoomForNewBucket(now: number): boolean {
  if (buckets.size < MAX_BUCKETS) return true;
  sweepDeadBuckets(now);
  if (buckets.size < MAX_BUCKETS) return true;
  for (const [k, v] of buckets) {
    if (now < v.lockedUntil) continue; // 锁定中，不驱逐
    buckets.delete(k);
    return true;
  }
  return false; // 全部锁定 → 拒绝新分配（保住已有的锁与内存上限）
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
  let b = buckets.get(key);
  // 新 key 才需要占用容量；已有 key 直接更新，永不因容量被拒
  if (!b && !makeRoomForNewBucket(now)) {
    return; // 容量饱和（全部条目锁定中）→ 放弃记录，绝不突破上限
  }
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
