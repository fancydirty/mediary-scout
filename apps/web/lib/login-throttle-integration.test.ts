import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * loginAccount 限流集成测试。复用既有 `:memory:` SQLite boot 模式
 * （同 guangya-connect.test.ts），真实跑 workflow-runtime，仅隔离网络无关部分。
 * 负载断言：
 *  - 连续 5 次错误密码 → 第 6 次返回「尝试过于频繁」（且不再验密）。
 *  - 锁定期间即使密码正确也被挡。
 *  - 重置后正确密码可登录。
 */

const prevPg = process.env.MEDIA_TRACK_POSTGRES_URL;
const prevMultiUser = process.env.MEDIA_TRACK_MULTI_USER;

const boot = async () => {
  process.env.MEDIA_TRACK_SQLITE_PATH = ":memory:";
  delete process.env.MEDIA_TRACK_POSTGRES_URL;
  process.env.MEDIA_TRACK_MULTI_USER = "1"; // 登录路由/账号体系启用
  vi.resetModules();
  return import("./workflow-runtime");
};

afterEach(() => {
  delete process.env.MEDIA_TRACK_SQLITE_PATH;
  if (prevPg !== undefined) process.env.MEDIA_TRACK_POSTGRES_URL = prevPg;
  if (prevMultiUser !== undefined) process.env.MEDIA_TRACK_MULTI_USER = prevMultiUser;
  vi.resetModules();
});

describe("loginAccount throttling (integration)", () => {
  beforeEach(async () => {
    const { _resetLoginThrottleForTest } = await import("./login-throttle");
    _resetLoginThrottleForTest();
  });

  it("locks after 5 wrong passwords and blocks the 6th (even the correct one)", async () => {
    const rt = await boot();
    await rt.registerAccount("owner1", "password-123");

    for (let i = 0; i < 5; i++) {
      const r = await rt.loginAccount("owner1", "wrong-password");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("用户名或密码不正确");
    }

    // 第 6 次：不再验密，直接限流
    const locked = await rt.loginAccount("owner1", "wrong-password");
    expect(locked.ok).toBe(false);
    if (!locked.ok) expect(locked.error).toContain("尝试过于频繁");

    // 锁定期间正确密码同样被挡
    const blocked = await rt.loginAccount("owner1", "password-123");
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error).toContain("尝试过于频繁");
  });

  it("successful login after reset works and is independent per username", async () => {
    const rt = await boot();
    await rt.registerAccount("owner1", "password-123");

    for (let i = 0; i < 5; i++) await rt.loginAccount("owner1", "wrong-password");
    // 另一个用户名不受影响
    const other = await rt.loginAccount("someone-else", "wrong-password");
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.error).toContain("用户名或密码不正确");

    const { _resetLoginThrottleForTest } = await import("./login-throttle");
    _resetLoginThrottleForTest();
    const ok = await rt.loginAccount("owner1", "password-123");
    expect(ok.ok).toBe(true);
  });

  it("no timing oracle: missing account takes same time as existing (both hit scrypt)", async () => {
    const rt = await boot();
    await rt.registerAccount("exists", "password-123");

    const trials = 5;
    // Warm both paths
    await rt.loginAccount("exists", "wrong");
    await rt.loginAccount("missing", "wrong");

    const t1 = process.hrtime.bigint();
    for (let i = 0; i < trials; i++) await rt.loginAccount("exists", "wrong");
    const existsMs = Number(process.hrtime.bigint() - t1) / 1e6 / trials;

    const t2 = process.hrtime.bigint();
    for (let i = 0; i < trials; i++) await rt.loginAccount("missing", "wrong");
    const missingMs = Number(process.hrtime.bigint() - t2) / 1e6 / trials;

    // Both should be in the same ballpark (scrypt ~50-80ms). Ratio < 10× means no short-circuit.
    const ratio = Math.max(existsMs, missingMs) / Math.min(existsMs, missingMs);
    expect(ratio).toBeLessThan(10); // was ~20000× before fix, now should be ~1-2×
  });
});
