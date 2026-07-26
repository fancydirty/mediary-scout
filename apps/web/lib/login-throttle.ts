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
const DEFAULT_MAX_BUCKETS = 10_000; // 内存硬上限（攻击者轮换 username|ip 时的护栏）

const buckets = new Map<string, Bucket>();
/** 生效的桶数上限。仅测试可临时下调以便快速覆盖饱和路径。 */
let maxBuckets = DEFAULT_MAX_BUCKETS;

/** 清扫已死条目（无活跃锁 + 窗口已过）。 */
function sweepDeadBuckets(now: number): void {
  for (const [k, v] of buckets) {
    if (now >= v.lockedUntil && now - v.windowStart > WINDOW_MS) {
      buckets.delete(k);
    }
  }
}

/**
 * 为「新 key」腾出一格容量，返回是否腾到了。
 *
 * 顺序：① 未达上限直接放行 → ② 清扫已死条目 → ③ 仍满则驱逐最老的**未锁定**条目
 * （跳过锁定中的，否则攻击者可用海量新 key 把自己的锁冲掉）。
 * ④ 全部条目都在锁定中 → 腾不出，返回 false，由调用方进入饱和降级。
 */
function makeRoomForNewBucket(now: number): boolean {
  if (buckets.size < maxBuckets) return true;
  sweepDeadBuckets(now);
  if (buckets.size < maxBuckets) return true;
  for (const [k, v] of buckets) {
    if (now < v.lockedUntil) continue; // 锁定中，不驱逐
    buckets.delete(k);
    return true;
  }
  return false;
}

/**
 * 容量是否处于「饱和」——已达上限且没有任何可回收（未锁定）的条目。
 * 该状态只可能出现在成千上万个 key 同时被锁定的真实攻击下。
 */
function isSaturated(now: number): boolean {
  if (buckets.size < maxBuckets) return false;
  for (const v of buckets.values()) {
    if (now >= v.lockedUntil) return false; // 还有可回收的
  }
  return true;
}

export function checkLoginAllowed(key: string, now: number): LoginVerdict {
  const b = buckets.get(key);
  if (b) {
    if (now < b.lockedUntil) {
      return { allowed: false, retryAfterSec: Math.ceil((b.lockedUntil - now) / 1000) };
    }
    return { allowed: true };
  }
  // 未知 key：容量饱和时统一快速拒绝。
  //
  // 否则会出现比内存溢出更糟的后果——新 key 永远建不了桶 ⇒ 永远 allowed ⇒
  // 攻击者只要不断轮换 username|ip 就能既绕过限流、又让每次请求都跑一遍
  // memory-hard 的 scrypt，把限流器变成 CPU 放大器。饱和是全局告警状态，
  // 此时宁可让少数新用户等一会儿（退避时长 = 最短的那个锁），也不能放行。
  if (isSaturated(now)) {
    let soonest = Infinity;
    for (const v of buckets.values()) {
      if (v.lockedUntil < soonest) soonest = v.lockedUntil;
    }
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((soonest - now) / 1000)) };
  }
  return { allowed: true };
}

export function recordLoginFailure(key: string, now: number): void {
  let b = buckets.get(key);
  // 新 key 才占容量；已有 key 直接更新，永不因容量被拒。
  // 腾不出格子时放弃记录——此时 checkLoginAllowed() 已对未知 key 统一拒绝，
  // 不计数不会造成放行（见该函数的饱和分支）。
  if (!b && !makeRoomForNewBucket(now)) {
    return;
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

/** 仅测试用：清空所有限流桶并恢复默认上限。 */
export function _resetLoginThrottleForTest(): void {
  buckets.clear();
  maxBuckets = DEFAULT_MAX_BUCKETS;
}

/** 仅测试用：当前桶数量（用于断言内存上限真的生效）。 */
export function _bucketCountForTest(): number {
  return buckets.size;
}

/**
 * 仅测试用：临时下调桶数上限，以便用几十次循环（而非几万次）覆盖饱和/驱逐路径。
 * 若不下调，覆盖这些路径需灌入上万条记录，在并行测试下会抢占 CPU 并让
 * 同批的 scrypt 集成测试超时。`_resetLoginThrottleForTest()` 会恢复默认值。
 */
export function _setMaxBucketsForTest(n: number): void {
  maxBuckets = n;
}

/** 限流键中 username 与 ip 各自的最大长度（防超长键放大内存占用）。 */
export const MAX_KEY_PART = 64;

/**
 * 组装限流键 `username|ip`（纯函数，便于测试）。
 *
 * IP 取值优先级：`cf-connecting-ip` > `x-forwarded-for` 首段 > `"unknown"`。
 * 经隧道的远程请求由 Cloudflare 注入 `cf-connecting-ip`，客户端伪造不了；
 * `x-forwarded-for` 客户端可随意伪造，仅在无 CF 头（局域网直连）时作为次选，
 * 且局域网本就不是本限流的主要威胁面。两部分均截断到 64 字符，
 * 避免攻击者用超长 username 放大单条桶的内存占用。
 *
 * **不做 `toLowerCase()`**：账号查询是 `WHERE username = ?` 精确匹配
 * （SQLite/Postgres 皆然，`username text UNIQUE`），大小写敏感。若在此折叠大小写，
 * `Owner` 与 `owner` 这两个**不同账号**会共用一个桶——攻击者猛猜 `owner`
 * 就能把 `Owner` 的合法用户锁在门外。限流身份必须与登录身份严格一致。
 */
export function buildThrottleKey(headers: Headers, username: string): string {
  const cfIp = headers.get("cf-connecting-ip")?.trim();
  const xff = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = (cfIp || xff || "unknown").slice(0, MAX_KEY_PART);
  const user = username.trim().slice(0, MAX_KEY_PART);
  return `${user}|${ip}`;
}
