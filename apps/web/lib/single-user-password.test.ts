import { afterEach, describe, expect, it, vi } from "vitest";

const prevPg = process.env.MEDIA_TRACK_POSTGRES_URL;
const prevMultiUser = process.env.MEDIA_TRACK_MULTI_USER;

const boot = async () => {
  process.env.MEDIA_TRACK_SQLITE_PATH = ":memory:";
  delete process.env.MEDIA_TRACK_POSTGRES_URL;
  delete process.env.MEDIA_TRACK_MULTI_USER; // 单用户
  vi.resetModules();
  return import("./workflow-runtime");
};

afterEach(() => {
  delete process.env.MEDIA_TRACK_SQLITE_PATH;
  if (prevPg !== undefined) process.env.MEDIA_TRACK_POSTGRES_URL = prevPg;
  // 原值为 undefined 时必须删除而非跳过，否则会把值泄漏给后续测试文件
  if (prevMultiUser !== undefined) {
    process.env.MEDIA_TRACK_MULTI_USER = prevMultiUser;
  } else {
    delete process.env.MEDIA_TRACK_MULTI_USER;
  }
  vi.resetModules();
});

describe("single-user password gate", () => {
  it("未设密码时 hasLoginPassword=false", async () => {
    const rt = await boot();
    expect(await rt.hasLoginPassword()).toBe(false);
  });

  it("resolveSingleUserAccount：未设密码 → 一律开放；设密码 → LAN 开放、远程需 session", async () => {
    const rt = await boot();
    // 纯函数，覆盖全部内外/有无 session 组合（这是本 plan 的安全核心判定）
    expect(rt.resolveSingleUserAccount({ hasPassword: false, isRemote: false, sessionAccountId: null })).toBe("acct_default");
    expect(rt.resolveSingleUserAccount({ hasPassword: false, isRemote: true, sessionAccountId: null })).toBe("acct_default");
    expect(rt.resolveSingleUserAccount({ hasPassword: true, isRemote: false, sessionAccountId: null })).toBe("acct_default"); // LAN 免登录
    expect(rt.resolveSingleUserAccount({ hasPassword: true, isRemote: true, sessionAccountId: null })).toBe("acct_unauthenticated"); // 远程无 session → 哨兵
    expect(rt.resolveSingleUserAccount({ hasPassword: true, isRemote: true, sessionAccountId: "acct_default" })).toBe("acct_default"); // 远程已登录 → 放行
  });

  it("isRemoteRequest：任一 CF 头即远程（不只靠 cf-connecting-ip——它可被 zone 配置删除）", async () => {
    const rt = await boot();
    expect(rt.isRemoteRequest(new Headers({ "cf-ray": "8f3-abc" }))).toBe(true);
    expect(rt.isRemoteRequest(new Headers({ "cdn-loop": "cloudflare" }))).toBe(true);
    expect(rt.isRemoteRequest(new Headers({ "cf-connecting-ip": "1.2.3.4" }))).toBe(true);
    expect(rt.isRemoteRequest(new Headers({ "user-agent": "curl" }))).toBe(false); // LAN 无 CF 头
    expect(rt.isRemoteRequest(new Headers())).toBe(false);
  });

  it("单用户设密码后可用密码登录 acct_default（用户名任意/空均视为 default）", async () => {
    const rt = await boot();
    await rt.setSingleUserPassword("secret-123");
    const bad = await rt.loginAccount("", "nope-nope");
    expect(bad.ok).toBe(false);
    const ok = await rt.loginAccount("", "secret-123");
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.accountId).toBe("acct_default");
  });

  it("单用户未设密码时不能登录（没有密码可验证，不该发出 session）", async () => {
    const rt = await boot();
    const r = await rt.loginAccount("", "anything");
    expect(r.ok).toBe(false);
  });

  it("单用户登录同样受限流保护（连续失败后锁定）", async () => {
    const rt = await boot();
    const { _resetLoginThrottleForTest } = await import("./login-throttle");
    _resetLoginThrottleForTest();
    await rt.setSingleUserPassword("secret-123");
    for (let i = 0; i < 5; i++) {
      const r = await rt.loginAccount("", "wrong-password");
      expect(r.ok).toBe(false);
    }
    const locked = await rt.loginAccount("", "secret-123"); // 正确密码也应被挡
    expect(locked.ok).toBe(false);
    if (!locked.ok) expect(locked.error).toContain("尝试过于频繁");
  });
});
