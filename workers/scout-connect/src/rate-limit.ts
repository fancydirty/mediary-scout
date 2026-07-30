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
