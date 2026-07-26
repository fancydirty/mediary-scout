import { isDemoMode } from "../../../../lib/demo-mode";
import { NextResponse, type NextRequest } from "next/server";
import { buildThrottleKey } from "../../../../lib/login-throttle";
import {
  SESSION_COOKIE_NAME,
  isMultiUserEnabled,
  isCookieSecure,
  hasLoginPassword,
  loginAccount,
} from "../../../../lib/workflow-runtime";

const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // 30 days, seconds

/** Authenticate username+password → set the signed httpOnly session cookie. */
export async function POST(request: NextRequest) {
  if (isDemoMode()) return Response.json({ error: "演示站只读" }, { status: 403 });
  // 多用户一律可登录；单用户仅在已设密码后开放登录（未设密码时无密码可验）。
  // hasLoginPassword() 读不出状态时返回 "unknown"，此时放行到 loginAccount——
  // 那里会因为拿不到有效 hash 而失败，不会误发 session。
  if (!isMultiUserEnabled() && (await hasLoginPassword()) === false) {
    return NextResponse.json({ error: "这台实例未设置访问密码，无需登录。" }, { status: 404 });
  }
  const body = (await request.json().catch(() => ({}))) as { username?: unknown; password?: unknown };
  const username = typeof body.username === "string" ? body.username : "";
  const password = typeof body.password === "string" ? body.password : "";
  // 限流身份必须与登录身份一致。单用户模式忽略用户名（永远登录 acct_default），
  // 所以限流也不能按用户名分桶——否则攻击者每次换个用户名就换一个桶，
  // 限流形同虚设而每次仍要付一次 scrypt 的代价。
  const throttleIdentity = isMultiUserEnabled() ? username : "";
  const result = await loginAccount(
    username,
    password,
    buildThrottleKey(request.headers, throttleIdentity),
  );
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 401 });
  }
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE_NAME, result.signedCookie, {
    httpOnly: true,
    sameSite: "lax",
    secure: isCookieSecure(request),
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
  return response;
}
