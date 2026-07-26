import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * 单用户密码门的**不纯接线**测试。
 *
 * 纯函数（resolveSingleUserAccount / isRemoteRequest）在 single-user-password.test.ts
 * 里已全组合覆盖；真正出事故的是把它们串起来的那段代码——Emby/Jellyfin 的漏洞
 * 都不在判定函数本身，而在「读不到状态时怎么办」。本文件专测这些故障路径：
 *  - DB 读失败时，远程请求必须 fail-closed（不能因为读不到密码状态就当没设密码）
 *  - session 读失败时，已判定为远程的请求必须 fail-closed
 *  - 属于别的账号的有效 session 不得落进单用户路径
 */

const prevPg = process.env.MEDIA_TRACK_POSTGRES_URL;
const prevMultiUser = process.env.MEDIA_TRACK_MULTI_USER;

const boot = async () => {
  process.env.MEDIA_TRACK_SQLITE_PATH = ":memory:";
  delete process.env.MEDIA_TRACK_POSTGRES_URL;
  delete process.env.MEDIA_TRACK_MULTI_USER; // 单用户
  vi.resetModules();
  return import("./workflow-runtime");
};

/** 装上一个假的 next/headers，模拟「经隧道的远程请求」。 */
const mockRemoteRequest = (cookieValue?: string) => {
  vi.doMock("next/headers", () => ({
    headers: async () => new Headers({ "cf-ray": "8f3abc-LAX" }),
    cookies: async () => ({
      get: (name: string) =>
        name === "mt_session" && cookieValue ? { name, value: cookieValue } : undefined,
    }),
  }));
};

afterEach(() => {
  delete process.env.MEDIA_TRACK_SQLITE_PATH;
  if (prevPg !== undefined) process.env.MEDIA_TRACK_POSTGRES_URL = prevPg;
  if (prevMultiUser !== undefined) {
    process.env.MEDIA_TRACK_MULTI_USER = prevMultiUser;
  } else {
    delete process.env.MEDIA_TRACK_MULTI_USER;
  }
  vi.doUnmock("next/headers");
  vi.resetModules();
});

describe("single-user gate wiring (failure paths)", () => {
  it("远程 + 密码状态读失败 → 必须 fail-closed（不得当作未设密码而放行）", async () => {
    mockRemoteRequest();
    const rt = await boot();
    await rt.setSingleUserPassword("secret-123");

    // 让密码状态读不出来（DB 抖动/连接池耗尽/故障切换）
    const repo = rt.getWorkflowRepository();
    const original = repo.getAccountById.bind(repo);
    repo.getAccountById = async () => {
      throw new Error("DB down");
    };

    const accountId = await rt.getCurrentAccountId();
    repo.getAccountById = original;

    // 读不到状态 ≠ 没设密码。远程匿名访客绝不能拿到 acct_default。
    expect(accountId).toBe("acct_unauthenticated");
  });

  it("远程 + 密码状态读失败 → 写操作必须抛错", async () => {
    mockRemoteRequest();
    const rt = await boot();
    await rt.setSingleUserPassword("secret-123");

    const repo = rt.getWorkflowRepository();
    const original = repo.getAccountById.bind(repo);
    repo.getAccountById = async () => {
      throw new Error("DB down");
    };

    await expect(rt.requireAuthenticatedAccountId()).rejects.toThrow();
    repo.getAccountById = original;
  });

  it("远程 + session 读失败 → 已知是远程，必须 fail-closed", async () => {
    mockRemoteRequest("forged.cookie");
    const rt = await boot();
    await rt.setSingleUserPassword("secret-123");

    const repo = rt.getWorkflowRepository();
    const original = repo.getSession.bind(repo);
    repo.getSession = async () => {
      throw new Error("session store down");
    };

    const accountId = await rt.getCurrentAccountId();
    repo.getSession = original;

    expect(accountId).toBe("acct_unauthenticated");
  });

  it("远程 + 属于别的账号的有效 session → 不得落进单用户路径", async () => {
    // 同一个库可能有多用户时期遗留的账号（MEDIA_TRACK_MULTI_USER 是运行时开关，
    // 可以再切回单用户）。那些账号的 session 不该在单用户模式下被认作站主。
    const rt = await boot();
    // 纯函数层面就应该钉死：只有 acct_default 才算数
    expect(
      rt.resolveSingleUserAccount({
        hasPassword: true,
        isRemote: true,
        sessionAccountId: "acct_someone_else",
      }),
    ).toBe("acct_unauthenticated");
    expect(
      rt.resolveSingleUserAccount({
        hasPassword: true,
        isRemote: true,
        sessionAccountId: "acct_default",
      }),
    ).toBe("acct_default");
  });

  it("LAN + 密码状态读失败 → 保持开放（不因读不到就把本地用户锁死）", async () => {
    vi.doMock("next/headers", () => ({
      headers: async () => new Headers({ "user-agent": "curl" }), // 无 CF 头 = LAN
      cookies: async () => ({ get: () => undefined }),
    }));
    const rt = await boot();
    await rt.setSingleUserPassword("secret-123");

    const repo = rt.getWorkflowRepository();
    const original = repo.getAccountById.bind(repo);
    repo.getAccountById = async () => {
      throw new Error("DB down");
    };

    const accountId = await rt.getCurrentAccountId();
    repo.getAccountById = original;

    // 局域网是可信网段：读不到状态时维持现状行为，不制造运维事故
    expect(accountId).toBe("acct_default");
  });

  it("无请求上下文（in-process worker）→ 直通 acct_default", async () => {
    const rt = await boot();
    await rt.setSingleUserPassword("secret-123");
    // 未 mock next/headers ⇒ 取不到请求作用域，等同后台任务
    expect(await rt.getCurrentAccountId()).toBe("acct_default");
  });
});

/**
 * 「未设密码 ⇒ 远程也全开放」是本仓库最严重的一个洞。
 *
 * 旧实现在判定远程之前就先 `if (hasPassword === false) return acct_default`，
 * 于是一个**匿名公网访客**经隧道进来即拿到站主身份：整个媒体库、五个网盘的
 * 凭据、LLM key 全部可读，且写路径也放行——`requireAuthenticatedAccountId()`
 * 只拦哨兵 `acct_unauthenticated`，而这条路径压根产不出哨兵。
 *
 * 这在 Cloudflare Access 挡在前面时尚可存活；本分支移除了 Access，它就变成
 * 一个活的公网洞。新规则：**远程一律需要 session，与密码状态无关**；
 * 局域网维持开放（既定的可信网段设计）。
 */
describe("未设密码 + 远程 = 必须 fail-closed（移除 Access 后的公网洞）", () => {
  it("纯函数：未设密码 + 远程 + 无 session → 哨兵，绝不是 acct_default", async () => {
    const rt = await boot();
    expect(
      rt.resolveSingleUserAccount({ hasPassword: false, isRemote: true, sessionAccountId: null }),
    ).toBe("acct_unauthenticated");
  });

  it("纯函数：未设密码 + 局域网 → 保持开放（可信网段设计不变）", async () => {
    const rt = await boot();
    expect(
      rt.resolveSingleUserAccount({ hasPassword: false, isRemote: false, sessionAccountId: null }),
    ).toBe("acct_default");
  });

  it("纯函数：状态未知/已设密码的既有组合不受影响", async () => {
    const rt = await boot();
    // LAN 一律开放
    expect(
      rt.resolveSingleUserAccount({ hasPassword: true, isRemote: false, sessionAccountId: null }),
    ).toBe("acct_default");
    expect(
      rt.resolveSingleUserAccount({ hasPassword: "unknown", isRemote: false, sessionAccountId: null }),
    ).toBe("acct_default");
    // 远程：只认 acct_default 自己的 session
    expect(
      rt.resolveSingleUserAccount({ hasPassword: true, isRemote: true, sessionAccountId: null }),
    ).toBe("acct_unauthenticated");
    expect(
      rt.resolveSingleUserAccount({ hasPassword: "unknown", isRemote: true, sessionAccountId: null }),
    ).toBe("acct_unauthenticated");
    expect(
      rt.resolveSingleUserAccount({ hasPassword: false, isRemote: true, sessionAccountId: "acct_default" }),
    ).toBe("acct_default");
    expect(
      rt.resolveSingleUserAccount({ hasPassword: true, isRemote: true, sessionAccountId: "acct_default" }),
    ).toBe("acct_default");
  });

  /**
   * 接线测试，不可省。`getCurrentAccountId()` 自己也有一份
   * `if (hasPassword === false) return DEFAULT_ACCOUNT_ID` 的短路，位置在调用
   * 纯函数**之前**。只修纯函数会让上面那些断言全绿、而真实请求路径依旧裸奔。
   */
  it("接线：未设密码 + 远程匿名请求 → getCurrentAccountId 必须返回哨兵", async () => {
    mockRemoteRequest(); // 有 cf-ray，无 session cookie
    const rt = await boot();
    // 刻意不设密码：全新实例的真实状态
    expect(await rt.hasLoginPassword()).toBe(false);
    expect(await rt.getCurrentAccountId()).toBe("acct_unauthenticated");
  });

  it("接线：未设密码 + 远程匿名请求 → 写路径必须抛错", async () => {
    mockRemoteRequest();
    const rt = await boot();
    expect(await rt.hasLoginPassword()).toBe(false);
    await expect(rt.requireAuthenticatedAccountId()).rejects.toThrow();
  });

  it("接线：未设密码 + 局域网 → 仍然直通 acct_default（不得回归）", async () => {
    vi.doMock("next/headers", () => ({
      headers: async () => new Headers({ "user-agent": "curl" }), // 无 CF 头 = LAN
      cookies: async () => ({ get: () => undefined }),
    }));
    const rt = await boot();
    expect(await rt.hasLoginPassword()).toBe(false);
    expect(await rt.getCurrentAccountId()).toBe("acct_default");
  });
});
