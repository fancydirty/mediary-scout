import { NextResponse, type NextRequest } from "next/server";

/**
 * §7 P1 auth gate (Next 16 "proxy" convention, formerly middleware).
 *
 * 两种门禁形态：
 *  - 多用户（`MEDIA_TRACK_MULTI_USER=1`）：处处需要 session（现状不变）。
 *  - 单用户：**仅当**实例已设访问密码（`mt_auth_required` flag cookie）**且**
 *    请求来自隧道（带 Cloudflare 头）时才门禁；局域网直通，零摩擦。
 *
 * This does cheap PRESENCE gating for the redirect UX (runs on the Edge runtime,
 * no DB access). The authoritative check — signature + session row + expiry — is
 * server-side in getCurrentAccountId(), which returns a no-data sentinel for an
 * invalid/expired cookie, so reads fail closed even if a stale cookie slips past.
 *
 * `mt_auth_required` 只是 UX 提示（把 legit 远程用户引到 /login），**不是**安全判据：
 * 它非 httpOnly、可被伪造或删除。删掉它只会让远程用户看到空数据页而非登录页，
 * 因为服务端 getCurrentAccountId() 自己读 DB 里的密码状态 + CF 头，不看这个 flag。
 */
const SESSION_COOKIE_NAME = "mt_session";
const AUTH_REQUIRED_COOKIE = "mt_auth_required";
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
  const passwordSet = Boolean(request.cookies.get(AUTH_REQUIRED_COOKIE)?.value);
  const gated = multiUser || (passwordSet && isRemoteRequest(request));
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
