import { NextResponse, type NextRequest } from "next/server";

/**
 * §7 P1 auth gate (Next 16 "proxy" convention, formerly middleware). Only active
 * when MEDIA_TRACK_MULTI_USER=1; otherwise every request passes through
 * (single-user, no login — P0 behavior).
 *
 * This does cheap PRESENCE gating for the redirect UX (runs on the Edge runtime,
 * no DB access). The authoritative check — signature + session row + expiry — is
 * server-side in getCurrentAccountId(), which returns a no-data sentinel for an
 * invalid/expired cookie, so reads fail closed even if a stale cookie slips past.
 */
const SESSION_COOKIE_NAME = "mt_session";
const HANDLER_GUARDED_API_PREFIXES = ["/api/health", "/api/workflows/", "/api/agent/"];

export function proxy(request: NextRequest): NextResponse {
  if (process.env.MEDIA_TRACK_MULTI_USER !== "1") {
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
