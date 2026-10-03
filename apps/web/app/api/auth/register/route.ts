import { isDemoMode } from "../../../../lib/demo-mode";
import { NextResponse, type NextRequest } from "next/server";
import {
  SESSION_COOKIE_NAME,
  isMultiUserEnabled,
  isCookieSecure,
  registerAccount,
  getBootstrapState,
  isRemoteRequest,
} from "../../../../lib/workflow-runtime";

const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // 30 days, seconds

/** Register a local account → auto-login (set the session cookie). */
export async function POST(request: NextRequest) {
  if (isDemoMode()) return Response.json({ error: "演示站只读" }, { status: 403 });
  if (!isMultiUserEnabled()) {
    return NextResponse.json({ error: "multi-user disabled" }, { status: 404 });
  }
  // 认领（第一个用户接管 acct_default，连同已有的库和网盘）只在局域网：经隧道来的
  // 外网访客不能抢先当站主。认领之后，家人朋友照常可以从外网注册自己的账号。
  if (isRemoteRequest(request.headers) && (await getBootstrapState()).needsClaim) {
    return NextResponse.json(
      { error: "创建站主账号只能在局域网里完成。请在家里的网络打开这台机器的局域网地址认领。" },
      { status: 403 },
    );
  }
  const body = (await request.json().catch(() => ({}))) as { username?: unknown; password?: unknown };
  const username = typeof body.username === "string" ? body.username : "";
  const password = typeof body.password === "string" ? body.password : "";
  const result = await registerAccount(username, password);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
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
