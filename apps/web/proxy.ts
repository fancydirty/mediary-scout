import { NextResponse, type NextRequest } from "next/server";

/**
 * §7 P1 auth gate (Next 16 "proxy" convention, formerly middleware).
 *
 * 两种门禁形态：
 *  - 多用户（`MEDIA_TRACK_MULTI_USER=1`）：处处需要 session（现状不变）。
 *  - 单用户：**凡是经隧道来的远程请求都门禁**，与是否设过密码无关；局域网直通，零摩擦。
 *
 * 远程门禁不再看 `mt_auth_required`。旧规则是 `passwordSet && isRemote`，于是一台
 * 尚未设密码的实例对公网匿名访客完全放行——这与服务端 getCurrentAccountId() 修复后的
 * 判定相矛盾：服务端会返回 acct_unauthenticated 哨兵，而 proxy 却不把人送去 /login，
 * 结果远程站主看到的是一个没有任何出口的空页面。两侧必须同规则：**远程一律要 session**。
 *
 * 未设密码的远程访客因此落到 /login，那里提供「设置访问密码」表单（app/login/page.tsx）,
 * 站主可以就地设密码并登录，不会被锁死。
 *
 * This does cheap PRESENCE gating for the redirect UX (runs on the Edge runtime,
 * no DB access). The authoritative check — signature + session row + expiry — is
 * server-side in getCurrentAccountId(), which returns a no-data sentinel for an
 * invalid/expired cookie, so reads fail closed even if a stale cookie slips past.
 */
const SESSION_COOKIE_NAME = "mt_session";
const HANDLER_GUARDED_API_PREFIXES = ["/api/health", "/api/workflows/", "/api/agent/"];

/** 经隧道的远程请求判定。与 workflow-runtime.isRemoteRequest() 保持一致：
 *  用 cf-ray/cdn-loop 而非仅 cf-connecting-ip（后者可被 zone 规则删除 → fail-open）。 */
function isRemoteRequest(request: NextRequest): boolean {
  return (
    request.headers.has("cf-ray") ||
    request.headers.has("cdn-loop") ||
    request.headers.has("cf-connecting-ip")
  );
}

export function proxy(request: NextRequest): NextResponse {
  const multiUser = process.env.MEDIA_TRACK_MULTI_USER === "1";
  const gated = multiUser || isRemoteRequest(request);
  if (!gated) {
    return NextResponse.next();
  }
  if (HANDLER_GUARDED_API_PREFIXES.some((prefix) => request.nextUrl.pathname.startsWith(prefix))) {
    return NextResponse.next();
  }
  const hasSession = Boolean(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (hasSession) {
    return NextResponse.next();
  }
  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  // Gate pages; exclude the auth API, the login page, Next internals and assets.
  matcher: ["/((?!api/auth|login|_next/static|_next/image|favicon.ico).*)"],
};
