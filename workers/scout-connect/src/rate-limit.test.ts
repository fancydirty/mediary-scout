import { describe, expect, it } from "vitest";
import {
  SLUG_CHECK_RATE_LIMIT,
  SLUG_CHECK_RATE_WINDOW_MS,
  createRateLimiter,
} from "./rate-limit.js";

describe("rate limiter —— 滑动窗口", () => {
  it("窗口内限额用完后拒绝,窗口滑动后恢复", () => {
    let now = 0;
    const limiter = createRateLimiter({ limit: 3, windowMs: 1000, now: () => now });
    expect(limiter.allow("u1")).toBe(true);
    expect(limiter.allow("u1")).toBe(true);
    expect(limiter.allow("u1")).toBe(true);
    expect(limiter.allow("u1"), "第 4 次超限").toBe(false);
    // 窗口滑动
    now = 1001;
    expect(limiter.allow("u1"), "窗口过后恢复").toBe(true);
  });

  it("不同 key 独立计数", () => {
    let now = 0;
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000, now: () => now });
    expect(limiter.allow("u1")).toBe(true);
    expect(limiter.allow("u2"), "另一个 key 不受影响").toBe(true);
    expect(limiter.allow("u1")).toBe(false);
  });

  it("默认参数:10 次 / 分钟", () => {
    expect(SLUG_CHECK_RATE_LIMIT).toBe(10);
    expect(SLUG_CHECK_RATE_WINDOW_MS).toBe(60_000);
  });

  // Copilot round-2:Map 单调增长,长寿命 worker 需要 prune。
  it("大量一次性 key 后,过期 key 仍能被正确放行(sweep 不破坏语义)", () => {
    let now = 0;
    const limiter = createRateLimiter({ limit: 5, windowMs: 1000, now: () => now });
    // 制造大量一次性 key(超过 sweep 阈值 1024)
    for (let i = 0; i < 1100; i++) limiter.allow("k" + i);
    // 时间推过窗口,再触发一次 allow(带 sweep)
    now = 2000;
    limiter.allow("trigger");
    // 无法直接读 Map size(封装了),但可验证行为:老 key 的配额已重置
    // (若没清理,老 key 的记录仍在但已过期,allow 仍应放行 —— 语义正确即可)
    expect(limiter.allow("k0"), "过期 key 应重新放行").toBe(true);
  });

  // 内存窗口挡不住分布式滥用,这个边界必须写清 —— 不能假装防得住。
  it("诚实标注:这是单实例内存窗口,非分布式防护", () => {
    // 两个独立 limiter 实例不共享状态 —— 这正是多实例 worker 的真实行为。
    const a = createRateLimiter({ limit: 1, windowMs: 1000, now: () => 0 });
    const b = createRateLimiter({ limit: 1, windowMs: 1000, now: () => 0 });
    expect(a.allow("u1")).toBe(true);
    // 「另一个实例」不知道 a 已经限过一次 —— 文档里写的边界,这里实测确认。
    expect(b.allow("u1")).toBe(true);
  });
});
