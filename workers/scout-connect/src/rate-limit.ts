/**
 * `/api/slug/check` 的限流(内存滑动窗口)。
 *
 * 为什么限流:这个端点**登录即可访问**,且每个查询可能触发上百次 D1 查重
 * (suggestSlugs 最坏 102 次串行)。不限流的话,任一登录用户能无限枚举全站
 * slug 占用情况 —— 这既是隐私泄露面,也是 D1 资源放大器。
 *
 * **内存而非 D1 表**:worker 是无状态多实例的,内存窗口**挡不住真正的分布式
 * 滥用**(限了个寂寞)。但它挡住的是最常见的情形 —— 同一个用户快速连点、
 * 或写脚本单点猛刷。真正的纵深是 429 + 让用户知道别再试,而不是假装防得住
 * 全网分布式攻击。诚实标注这个边界。
 *
 * 单实例 worker 的内存窗口对「同一用户、同一实例」有效;多实例时各算各的,
 * 限流强度自然放宽 —— 这是有意的:宁可限得偏松也不误伤正常用户连点。
 */

export interface RateLimiter {
  /** 是否允许这次请求。允许则消耗一个配额。 */
  allow(key: string): boolean;
}

export function createRateLimiter(input: {
  /** 窗口内允许的请求数。 */
  limit: number;
  /** 窗口长度(毫秒)。 */
  windowMs: number;
  /** 当前时间(注入,便于测试)。 */
  now: () => number;
}): RateLimiter {
  const hits = new Map<string, number[]>();
  return {
    allow(key) {
      const now = input.now();
      const cutoff = now - input.windowMs;
      const list = (hits.get(key) ?? []).filter((t) => t > cutoff);
      // 顺手 prune:Map 会随不同 key 单调增长,长寿命 worker + 大量账号下
      // 空闲 key 永久占内存。每次访问时清一次当前 key,并**惰性清理**其它
      // 已全部过期的 key(不做定时器,worker 无常驻定时器习惯)。
      if (list.length === 0) {
        // 这个 key 窗口内已无记录 —— 但下面还要 push,所以不能删自己,
        // 只在"被拒/不 push"时才可能删。真正的清理交给下面的 sweep。
      }
      if (list.length >= input.limit) {
        hits.set(key, list);
        return false;
      }
      list.push(now);
      hits.set(key, list);
      // 惰性 sweep:Map 超过一定规模时,清掉窗口外且空的 key。
      // 阈值避免每次都全表扫描 —— 只在真的攒多了才清一次。
      if (hits.size > 1024) {
        for (const [k, v] of hits) {
          const alive = v.filter((t) => t > cutoff);
          if (alive.length === 0) hits.delete(k);
          else hits.set(k, alive);
        }
      }
      return true;
    },
  };
}

/** slug/check 的默认限流参数:10 次 / 分钟 / 账号。
 *  正常用户连点几次查重远到不了这个量;脚本猛刷会立刻撞墙。 */
export const SLUG_CHECK_RATE_LIMIT = 10;
export const SLUG_CHECK_RATE_WINDOW_MS = 60_000;

/**
 * 发信入口(/api/auth/magic、/waitlist)的限流参数。
 *
 * **为什么需要**:Turnstile 门禁已在生产关闭 —— `challenges.cloudflare.com`
 * 在中国大陆不可靠,挡住的是真实用户而非脚本(登录进不去=付不了钱,
 * 报名进不去=拿不到内测用户)。门禁代码保留(sitekey 一配就恢复),
 * 但既然它现在不生效,发信入口必须有替代防线,否则这是个公开的
 * 「触发发邮件」放大面 —— 有人能刷爆 Resend 配额,或拿我们的域名发垃圾邮件。
 *
 * **双维度**:
 * - 按 IP:挡同一来源的脚本猛刷。窗口放宽到 10 分钟 5 次 —— 正常人
 *   收不到信会重试 1-2 次,家庭 NAT 后可能有几个人共用出口 IP。
 * - 按邮箱:挡「换 IP 但轰同一个人」的骚扰(用别人邮箱刷登录信)。
 *   同一邮箱 10 分钟 2 次 —— 魔法链接 15 分钟有效,正常人不需要更多。
 *
 * 两个维度**都要过**才放行。内存窗口的分布式局限见本文件顶部说明。
 */
export const SIGNUP_IP_RATE_LIMIT = 5;
export const SIGNUP_EMAIL_RATE_LIMIT = 2;
export const SIGNUP_RATE_WINDOW_MS = 600_000; // 10 分钟

// ─────────────────────────────────────────────────────────────────────────
// 跨实例限流(D1)
// ─────────────────────────────────────────────────────────────────────────

/**
 * 跨实例限流所需的最小能力。刻意只声明 hitAndCount 而不复用 ConnectDb ——
 * 限流不该能碰其它表,窄接口让这条约束由类型系统保证(传进来的即便是完整的
 * ConnectDb,在这里也只看得见这一个方法)。
 */
export interface RateLimitStore {
  /** 记一次命中,并返回**含本次**在窗口内的命中数。 */
  hitAndCount(bucket: string, key: string, at: string, windowStart: string): Promise<number>;
}

/**
 * 跨实例限流判定。
 *
 * **为什么不用内存**:Worker 每次请求可能落在不同隔离实例上,各有一份内存
 * 计数。生产实测同一邮箱连打 5 次得到 `429 202 429 202 202` —— 代码逻辑
 * 正确,拦不拦全看请求落到哪个实例,实际拦截率约 40%。发信入口是公开的
 * 「触发发邮件」放大面,需要真正一致的计数。
 *
 * **fail open**:D1 抛错时**放行**而不是拒绝。理由:限流是防滥用的加固,
 * 不是安全边界;D1 抖动时宁可短暂放宽,也不能让正常用户登不进来
 * (登录进不去 = 付不了钱)。与 Turnstile 的 fail closed 相反 —— 那是
 * 人机验证,放过等于门形同虚设;这里放过只是少了一层速率保护。
 * 抛错必须留日志,否则 D1 挂了会静默失去全部限流而无人知情。
 */
export async function checkRateLimit(input: {
  store: RateLimitStore;
  bucket: string;
  key: string;
  limit: number;
  windowMs: number;
  now: () => number;
}): Promise<{ allowed: boolean }> {
  // 时间计算也放进 try:now() 返回非有限值时 toISOString() 抛 RangeError,
  // 若在 try 之外就会 500 —— 那正是本函数声明要避免的失败模式。
  // fail open 的边界必须覆盖**整个函数**,而不只是 store 调用。
  try {
    const nowMs = input.now();
    const at = new Date(nowMs).toISOString();
    const windowStart = new Date(nowMs - input.windowMs).toISOString();
    const count = await input.store.hitAndCount(input.bucket, input.key, at, windowStart);
    return { allowed: count <= input.limit };
  } catch (e) {
    console.error("rate limit store failed (failing open), bucket:", input.bucket, e);
    return { allowed: true };
  }
}
