import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { proxy } from "./proxy";
import type { NextRequest } from "next/server";

/**
 * proxy 门禁判定的全组合覆盖。
 *
 * 这是「远程要登录、局域网免登录」的 Edge 侧实现，也是 Emby/Jellyfin 出事故的
 * 同一类判定。它只做 UX 层的重定向（权威判定在服务端 getCurrentAccountId()），
 * 但判错方向仍有代价：
 *  - 远程 + 已设密码 + 无 session 却放行 → 用户看到空数据页而不是登录页（体验坏）
 *  - 局域网被误判成需登录 → 本地用户凭空多一道门（回归）
 */

// 本套件断言的是单用户行为。必须显式关掉多用户开关：若被 runner 设置或从
// 别的测试文件泄漏进来，proxy 会走「处处门禁」分支，断言就在悄悄测另一件事。
const prevMultiUser = process.env.MEDIA_TRACK_MULTI_USER;
beforeAll(() => {
  delete process.env.MEDIA_TRACK_MULTI_USER;
});
afterAll(() => {
  if (prevMultiUser !== undefined) {
    process.env.MEDIA_TRACK_MULTI_USER = prevMultiUser;
  } else {
    delete process.env.MEDIA_TRACK_MULTI_USER;
  }
});

const makeRequest = (opts: {
  path?: string;
  cf?: boolean;
  passwordSet?: boolean;
  session?: boolean;
}): NextRequest => {
  const headers = new Headers();
  if (opts.cf) headers.set("cf-ray", "8f3abc-LAX");
  const cookies = new Map<string, { name: string; value: string }>();
  if (opts.passwordSet) cookies.set("mt_auth_required", { name: "mt_auth_required", value: "1" });
  if (opts.session) cookies.set("mt_session", { name: "mt_session", value: "sess.sig" });
  const url = new URL(`http://localhost:3000${opts.path ?? "/"}`);
  return {
    headers,
    cookies: { get: (name: string) => cookies.get(name) },
    nextUrl: {
      pathname: url.pathname,
      clone: () => new URL(url.toString()),
      search: "",
    },
  } as unknown as NextRequest;
};

/** 判定结果：是否被重定向到 /login。 */
const redirectsToLogin = (req: NextRequest): boolean => {
  const res = proxy(req);
  return res.status >= 300 && res.status < 400 && (res.headers.get("location") ?? "").includes("/login");
};

describe("proxy gate — single-user mode (multi-user off)", () => {
  it("未设密码：LAN 与远程一律直通（与现状一致）", () => {
    expect(redirectsToLogin(makeRequest({}))).toBe(false);
    expect(redirectsToLogin(makeRequest({ cf: true }))).toBe(false);
  });

  it("已设密码 + 局域网（无 CF 头）→ 直通，零摩擦", () => {
    expect(redirectsToLogin(makeRequest({ passwordSet: true }))).toBe(false);
  });

  it("已设密码 + 远程（有 CF 头）+ 无 session → 重定向到登录", () => {
    expect(redirectsToLogin(makeRequest({ passwordSet: true, cf: true }))).toBe(true);
  });

  it("已设密码 + 远程 + 有 session → 直通", () => {
    expect(redirectsToLogin(makeRequest({ passwordSet: true, cf: true, session: true }))).toBe(false);
  });

  it("三个 CF 头任一存在都算远程", () => {
    for (const header of ["cf-ray", "cdn-loop", "cf-connecting-ip"]) {
      const req = makeRequest({ passwordSet: true });
      req.headers.set(header, "x");
      expect(redirectsToLogin(req)).toBe(true);
    }
  });

  it("handler 自守的 API 前缀不被重定向（否则会把 JSON 端点变成 HTML 跳转）", () => {
    for (const path of ["/api/health", "/api/workflows/run", "/api/agent/step"]) {
      expect(redirectsToLogin(makeRequest({ passwordSet: true, cf: true, path }))).toBe(false);
    }
  });
});

describe("proxy gate — multi-user mode", () => {
  it("多用户：无 session 一律重定向，与来源和密码 flag 无关", () => {
    process.env.MEDIA_TRACK_MULTI_USER = "1";
    try {
      expect(redirectsToLogin(makeRequest({}))).toBe(true); // LAN 也要登录
      expect(redirectsToLogin(makeRequest({ cf: true }))).toBe(true);
      expect(redirectsToLogin(makeRequest({ session: true }))).toBe(false);
    } finally {
      delete process.env.MEDIA_TRACK_MULTI_USER;
    }
  });
});
