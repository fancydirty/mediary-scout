import { describe, expect, it, vi } from "vitest";
import {
  SLUG_CHECK_RATE_LIMIT,
  SLUG_CHECK_RATE_WINDOW_MS,
  createRateLimiter,
  checkRateLimit,
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

describe("checkRateLimit(跨实例 / D1)", () => {
  /** 内存假 store,行为等价于 D1 的那条 INSERT+COUNT。 */
  function fakeStore() {
    const rows: Array<{ bucket: string; key: string; at: string }> = [];
    return {
      rows,
      async hitAndCount(bucket: string, key: string, at: string, windowStart: string) {
        rows.push({ bucket, key, at });
        return rows.filter((r) => r.bucket === bucket && r.key === key && r.at > windowStart).length;
      },
    };
  }
  const base = Date.parse("2026-08-01T00:00:00.000Z");

  it("窗口内第 N+1 次被拒(limit=2)", async () => {
    const store = fakeStore();
    const args = { store, bucket: "b", key: "k", limit: 2, windowMs: 60_000 };
    let t = base;
    const r1 = await checkRateLimit({ ...args, now: () => (t += 1000) });
    const r2 = await checkRateLimit({ ...args, now: () => (t += 1000) });
    const r3 = await checkRateLimit({ ...args, now: () => (t += 1000) });
    expect([r1.allowed, r2.allowed, r3.allowed]).toEqual([true, true, false]);
  });

  it("不同 bucket / 不同 key 各自独立计数", async () => {
    const store = fakeStore();
    let t = base;
    const mk = (bucket: string, key: string) =>
      checkRateLimit({ store, bucket, key, limit: 1, windowMs: 60_000, now: () => (t += 1000) });
    expect((await mk("ip", "1.1.1.1")).allowed).toBe(true);
    expect((await mk("ip", "1.1.1.1")).allowed).toBe(false);
    // 换 key → 独立
    expect((await mk("ip", "2.2.2.2")).allowed).toBe(true);
    // 换 bucket → 独立
    expect((await mk("email", "1.1.1.1")).allowed).toBe(true);
  });

  it("窗口滑过后重新放行", async () => {
    const store = fakeStore();
    const args = { store, bucket: "b", key: "k", limit: 1, windowMs: 60_000 };
    expect((await checkRateLimit({ ...args, now: () => base })).allowed).toBe(true);
    expect((await checkRateLimit({ ...args, now: () => base + 1000 })).allowed).toBe(false);
    // 61 秒后,先前那次已滑出窗口
    expect((await checkRateLimit({ ...args, now: () => base + 61_000 })).allowed).toBe(true);
  });

  // 关键行为:D1 抖动不能让用户登不进来(登录进不去 = 付不了钱)。
  it("store 抛错 → fail OPEN(放行)并留日志", async () => {
    const err = { async hitAndCount() { throw new Error("d1 down"); } };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const r = await checkRateLimit({
        store: err, bucket: "b", key: "k", limit: 1, windowMs: 60_000, now: () => base,
      });
      expect(r.allowed).toBe(true);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  // 这条是本次改造的**理由**:内存限流器在多实例下各算各的。
  it("跨「实例」共享同一 store 时计数一致(内存限流器做不到的事)", async () => {
    const store = fakeStore();
    const args = { store, bucket: "signup_ip", key: "9.9.9.9", limit: 2, windowMs: 600_000 };
    let t = base;
    // 模拟三个不同 worker 实例各处理一次请求 —— 它们共享 D1,所以计数累加
    const results = [];
    for (let i = 0; i < 3; i++) {
      results.push((await checkRateLimit({ ...args, now: () => (t += 1000) })).allowed);
    }
    expect(results).toEqual([true, true, false]);
  });
});
