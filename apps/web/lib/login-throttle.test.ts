import { beforeEach, describe, expect, it } from "vitest";
import {
  checkLoginAllowed,
  recordLoginFailure,
  recordLoginSuccess,
  buildThrottleKey,
  normalizeThrottleKey,
  MAX_KEY_PART,
  _resetLoginThrottleForTest,
  _bucketCountForTest,
  _setMaxBucketsForTest,
} from "./login-throttle";

const K = "owner1|1.2.3.4";
const T0 = 1_000_000;

beforeEach(() => _resetLoginThrottleForTest());

describe("login throttle", () => {
  it("allows the first attempts, then locks after 5 failures within the window", () => {
    expect(checkLoginAllowed(K, T0).allowed).toBe(true);
    for (let i = 0; i < 5; i++) {
      expect(checkLoginAllowed(K, T0).allowed).toBe(true);
      recordLoginFailure(K, T0);
    }
    const verdict = checkLoginAllowed(K, T0);
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.retryAfterSec).toBeGreaterThan(0);
  });

  it("stays locked until lockedUntil, then allows again", () => {
    for (let i = 0; i < 5; i++) recordLoginFailure(K, T0);
    expect(checkLoginAllowed(K, T0 + 1000).allowed).toBe(false); // inside 1min lock
    expect(checkLoginAllowed(K, T0 + 61_000).allowed).toBe(true); // after first lock
  });

  it("escalates lock duration for repeat offenders (exponential backoff)", () => {
    for (let i = 0; i < 5; i++) recordLoginFailure(K, T0);
    const firstLockUntil = T0 + 60_000;
    // fail again right after first lock expires → second lock should be longer (2x)
    for (let i = 0; i < 5; i++) recordLoginFailure(K, firstLockUntil);
    const v = checkLoginAllowed(K, firstLockUntil);
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.retryAfterSec).toBeGreaterThan(60); // > 1min ⇒ escalated
  });

  it("clears the bucket on successful login", () => {
    for (let i = 0; i < 4; i++) recordLoginFailure(K, T0);
    recordLoginSuccess(K);
    // after success, a fresh 5 failures are required to lock again
    for (let i = 0; i < 4; i++) recordLoginFailure(K, T0 + 1000);
    expect(checkLoginAllowed(K, T0 + 1000).allowed).toBe(true);
  });

  it("resets the failure count after the fixed window passes", () => {
    for (let i = 0; i < 4; i++) recordLoginFailure(K, T0);
    // 16 minutes later (> 15min window) — old failures no longer count
    const later = T0 + 16 * 60_000;
    recordLoginFailure(K, later);
    expect(checkLoginAllowed(K, later).allowed).toBe(true);
  });

  it("tracks keys independently", () => {
    for (let i = 0; i < 5; i++) recordLoginFailure("owner1|9.9.9.9", T0);
    expect(checkLoginAllowed("owner1|9.9.9.9", T0).allowed).toBe(false);
    expect(checkLoginAllowed("owner1|1.1.1.1", T0).allowed).toBe(true); // different ip
    expect(checkLoginAllowed("owner2|9.9.9.9", T0).allowed).toBe(true); // different user
  });

  // Regression tests for security fixes
  it("D1 fix: lock survives window expiry (no escape by one throwaway guess)", () => {
    const K = "attacker|evil";
    let t = T0;
    // Climb to lock #6 (30 min cap) — each lock must end before the next starts
    for (let lock = 1; lock <= 6; lock++) {
      for (let i = 0; i < 5; i++) recordLoginFailure(K, t);
      const v = checkLoginAllowed(K, t);
      expect(v.allowed).toBe(false);
      if (!v.allowed) t += v.retryAfterSec * 1000; // advance to lock end
    }
    // Now we're at the end of lock #6. Re-trigger lock #6 to get fresh windowStart.
    const lockStart = t;
    for (let i = 0; i < 5; i++) recordLoginFailure(K, lockStart);
    const lock6 = checkLoginAllowed(K, lockStart);
    expect(lock6.allowed).toBe(false);
    if (!lock6.allowed) expect(lock6.retryAfterSec).toBe(1800); // 30 min
    // Advance past WINDOW (15 min) but still inside the 30-min lock
    const probeTime = lockStart + (15 * 60 * 1000 + 1000);
    expect(checkLoginAllowed(K, probeTime).allowed).toBe(false); // still locked
    recordLoginFailure(K, probeTime); // attacker sends one throwaway guess
    expect(checkLoginAllowed(K, probeTime).allowed).toBe(false); // MUST stay locked
  });

  it("D2 fix: map size is hard-capped even when every bucket is fresh", () => {
    // 全部条目同一时刻创建 ⇒ 无一"过期"，清扫扫不掉任何东西。
    // 这正是硬上限必须靠驱逐（而非仅清扫）兜底的场景。
    const CAP = 50;
    _setMaxBucketsForTest(CAP);
    for (let i = 0; i < CAP + 200; i++) recordLoginFailure(`user${i}|ip`, T0);
    expect(_bucketCountForTest()).toBeLessThanOrEqual(CAP);
  });

  it("D2 fix: eviction never drops a locked-out attacker to make room", () => {
    const CAP = 50;
    _setMaxBucketsForTest(CAP);
    const VICTIM = "attacker|1.1.1.1";
    for (let i = 0; i < 5; i++) recordLoginFailure(VICTIM, T0); // 锁定该 key
    expect(checkLoginAllowed(VICTIM, T0).allowed).toBe(false);
    // 攻击者试图用海量新 key 把自己的锁挤出内存
    for (let i = 0; i < CAP + 200; i++) recordLoginFailure(`flood${i}|ip`, T0);
    expect(checkLoginAllowed(VICTIM, T0).allowed).toBe(false); // 锁必须还在
    expect(_bucketCountForTest()).toBeLessThanOrEqual(CAP);
  });

  it("D2 fix: cap holds even when every existing bucket is locked (refuse new allocation)", () => {
    const CAP = 20;
    _setMaxBucketsForTest(CAP);
    // 把上限内的每个 key 都打到锁定状态 ⇒ 清扫无可清、驱逐无可驱
    for (let i = 0; i < CAP; i++) {
      for (let j = 0; j < 5; j++) recordLoginFailure(`locked${i}|ip`, T0);
    }
    expect(_bucketCountForTest()).toBeLessThanOrEqual(CAP);
    // 再灌新 key：必须拒绝分配而不是无条件 set() 突破上限
    for (let i = 0; i < 200; i++) recordLoginFailure(`overflow${i}|ip`, T0);
    expect(_bucketCountForTest()).toBeLessThanOrEqual(CAP);
    // 且已有的锁不能被冲掉
    expect(checkLoginAllowed("locked0|ip", T0).allowed).toBe(false);
  });

  it("saturation must DENY unknown keys, not let them bypass the throttle", () => {
    // 回归：曾经饱和时 recordLoginFailure 直接 return ⇒ 新 key 永远建不了桶
    // ⇒ checkLoginAllowed 永远 allowed ⇒ 攻击者轮换 key 既绕过限流，
    // 又让每次请求都跑一遍 memory-hard scrypt，把限流器变成 CPU 放大器。
    const CAP = 10;
    _setMaxBucketsForTest(CAP);
    for (let i = 0; i < CAP; i++) {
      for (let j = 0; j < 5; j++) recordLoginFailure(`locked${i}|ip`, T0);
    }
    // 全部条目锁定中 ⇒ 饱和。任意未知 key 必须被拒，且给出可重试时间。
    const v = checkLoginAllowed("brand-new|9.9.9.9", T0);
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.retryAfterSec).toBeGreaterThan(0);
  });

  it("saturation lifts once locks expire (new keys allowed again)", () => {
    const CAP = 10;
    _setMaxBucketsForTest(CAP);
    for (let i = 0; i < CAP; i++) {
      for (let j = 0; j < 5; j++) recordLoginFailure(`locked${i}|ip`, T0);
    }
    expect(checkLoginAllowed("brand-new|9.9.9.9", T0).allowed).toBe(false);
    // 首轮锁 60s，过后不再饱和 → 恢复正常放行
    expect(checkLoginAllowed("brand-new|9.9.9.9", T0 + 61_000).allowed).toBe(true);
  });

  it("pins MAX_LOCK_MS constant (30 min cap is reachable and enforced)", () => {
    const K = "repeat|offender";
    let t = T0;
    // Climb the ladder: 1, 2, 4, 8, 16, 32min — but capped at 30
    const expected = [60, 120, 240, 480, 960, 1800, 1800]; // 32min capped to 30
    for (let lock = 1; lock <= 7; lock++) {
      for (let i = 0; i < 5; i++) recordLoginFailure(K, t);
      const v = checkLoginAllowed(K, t);
      expect(v.allowed).toBe(false);
      if (!v.allowed) {
        expect(v.retryAfterSec).toBe(expected[lock - 1]);
        t += v.retryAfterSec * 1000; // advance to lock end
      }
    }
  });

  it("pins WINDOW_MS constant (failures just inside 15min still count)", () => {
    const K = "slow|attacker";
    for (let i = 0; i < 4; i++) recordLoginFailure(K, T0);
    // One more failure at 14 min (just inside window) → should lock
    recordLoginFailure(K, T0 + 14 * 60_000);
    expect(checkLoginAllowed(K, T0 + 14 * 60_000).allowed).toBe(false);
  });
});

describe("buildThrottleKey", () => {
  it("prefers cf-connecting-ip over the client-spoofable x-forwarded-for", () => {
    // 攻击者伪造 XFF 想换一个限流桶；CF 注入的头才是可信来源
    const h = new Headers({
      "cf-connecting-ip": "203.0.113.7",
      "x-forwarded-for": "1.2.3.4, 5.6.7.8",
    });
    expect(buildThrottleKey(h, "owner")).toBe("owner|203.0.113.7");
  });

  it("falls back to the first x-forwarded-for hop, then to 'unknown'", () => {
    expect(buildThrottleKey(new Headers({ "x-forwarded-for": "9.9.9.9, 8.8.8.8" }), "owner")).toBe(
      "owner|9.9.9.9",
    );
    expect(buildThrottleKey(new Headers(), "owner")).toBe("owner|unknown");
  });

  it("trims but preserves username case so throttle identity matches login identity", () => {
    // 账号查询是 WHERE username = ? 精确匹配（大小写敏感），
    // 若在此折叠大小写，Owner 与 owner 这两个不同账号会共用一个桶
    expect(buildThrottleKey(new Headers({ "cf-connecting-ip": "1.1.1.1" }), "  OwNeR  ")).toBe(
      "OwNeR|1.1.1.1",
    );
    const upper = buildThrottleKey(new Headers({ "cf-connecting-ip": "1.1.1.1" }), "Owner");
    const lower = buildThrottleKey(new Headers({ "cf-connecting-ip": "1.1.1.1" }), "owner");
    expect(upper).not.toBe(lower); // 不同账号 → 不同桶
  });

  it("caps both parts so huge inputs can't bloat a bucket", () => {
    const huge = "A".repeat(100_000);
    const key = buildThrottleKey(new Headers({ "cf-connecting-ip": huge }), huge);
    expect(key.length).toBeLessThanOrEqual(2 * MAX_KEY_PART + 1);
  });

  it("long usernames sharing a 64-char prefix must not collide (cross-user DoS)", () => {
    // 注册未限制用户名长度；若截断只取前缀，两个长用户名会共用一个桶，
    // 攻击者据此可锁死别人的账号。
    const prefix = "B".repeat(200);
    const h = new Headers({ "cf-connecting-ip": "1.1.1.1" });
    const a = buildThrottleKey(h, `${prefix}-alice`);
    const b = buildThrottleKey(h, `${prefix}-bob`);
    expect(a).not.toBe(b);
    expect(a.length).toBeLessThanOrEqual(2 * MAX_KEY_PART + 1);
  });

  it("normalizeThrottleKey bounds explicitly supplied keys too", () => {
    const huge = "C".repeat(50_000);
    expect(normalizeThrottleKey(huge).length).toBeLessThanOrEqual(MAX_KEY_PART);
    expect(normalizeThrottleKey("   ")).toBe("unknown");
    // 同前缀的长键同样不能塌成一个
    expect(normalizeThrottleKey(`${huge}x`)).not.toBe(normalizeThrottleKey(`${huge}y`));
  });

  it("key parts stay within MAX_KEY_PART across magnitudes of input length", () => {
    // head 长度必须随「长度数字的位数」收缩，否则超长输入会顶破上限
    for (const n of [65, 100, 1_000, 100_000, 5_000_000]) {
      const out = normalizeThrottleKey("D".repeat(n));
      expect(out.length).toBeLessThanOrEqual(MAX_KEY_PART);
    }
  });

  it("_setMaxBucketsForTest rejects values that would break the invariants", () => {
    // 0/负数会让空 Map 也判定为饱和 → 退避时长算成 Infinity
    expect(() => _setMaxBucketsForTest(0)).toThrow(RangeError);
    expect(() => _setMaxBucketsForTest(-1)).toThrow(RangeError);
    expect(() => _setMaxBucketsForTest(1.5)).toThrow(RangeError);
    expect(() => _setMaxBucketsForTest(1)).not.toThrow();
  });
});
