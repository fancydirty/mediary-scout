import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * loginAccount 限流集成测试。复用既有 `:memory:` SQLite boot 模式
 * （同 guangya-connect.test.ts），真实跑 workflow-runtime，仅隔离网络无关部分。
 * 负载断言：
 *  - 连续 5 次错误密码 → 第 6 次返回「尝试过于频繁」（且不再验密）。
 *  - 锁定期间即使密码正确也被挡。
 *  - 缺失账号与存在账号耗时同量级（无枚举时序预言机）。
 *
 * ⚠️ 超时：每个用例要跑 6+ 次 scrypt 验密（memory-hard，单次 ~50-80ms），
 * 在全量并行下与其它测试争抢 CPU 会远超 vitest 默认的 5s。故显式放宽到 30s——
 * 这不是「慢测试」，而是密码学原语的固有成本。
 */
const CRYPTO_TIMEOUT_MS = 30_000;

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
  // 原值为 undefined 时必须删除而非跳过，否则 MEDIA_TRACK_MULTI_USER=1
  // 会泄漏给后续测试文件，造成与执行顺序相关的失败
  if (prevMultiUser !== undefined) {
    process.env.MEDIA_TRACK_MULTI_USER = prevMultiUser;
  } else {
    delete process.env.MEDIA_TRACK_MULTI_USER;
  }
  vi.resetModules();
});

describe("loginAccount throttling (integration)", () => {
  beforeEach(async () => {
    const { _resetLoginThrottleForTest } = await import("./login-throttle");
    _resetLoginThrottleForTest();
  });

  it(
    "locks after 5 wrong passwords and blocks the 6th (even the correct one)",
    async () => {
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
    },
    CRYPTO_TIMEOUT_MS,
  );

  it(
    "successful login after reset works and is independent per username",
    async () => {
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
    },
    CRYPTO_TIMEOUT_MS,
  );

  it(
    "no timing oracle: missing account takes same time as existing (both hit scrypt)",
    async () => {
      const rt = await boot();
      await rt.registerAccount("exists", "password-123");

      // Warm both paths (JIT + scrypt buffers)
      await rt.loginAccount("exists", "wrong");
      await rt.loginAccount("missing", "wrong");

      // 交错测量 + 取中位数：两条路径在同一时间窗口内轮流跑，
      // 这样 CI 抢占/降频会同等影响两者而不是只压到某一段；
      // 中位数再滤掉个别离群点。否则「先测 A 再测 B」很容易假阳性。
      const trials = 7;
      const existsSamples: number[] = [];
      const missingSamples: number[] = [];
      for (let i = 0; i < trials; i++) {
        const a = process.hrtime.bigint();
        await rt.loginAccount("exists", "wrong");
        existsSamples.push(Number(process.hrtime.bigint() - a) / 1e6);

        const b = process.hrtime.bigint();
        await rt.loginAccount("missing", "wrong");
        missingSamples.push(Number(process.hrtime.bigint() - b) / 1e6);
      }
      const median = (xs: number[]) => {
        const s = [...xs].sort((p, q) => p - q);
        return s[Math.floor(s.length / 2)]!;
      };
      const existsMs = median(existsSamples);
      const missingMs = median(missingSamples);

      // 两条路径都要走完 scrypt（~50-80ms）。比值 < 10 即说明没有短路；
      // 修复前缺失账号是 0.0026ms vs 存在 54ms（约 20000×），差了三个数量级，
      // 所以哪怕环境噪声让比值飘到 2-3，也仍能稳稳判定。
      const ratio = Math.max(existsMs, missingMs) / Math.min(existsMs, missingMs);
      expect(ratio).toBeLessThan(10);
    },
    CRYPTO_TIMEOUT_MS,
  );
});
