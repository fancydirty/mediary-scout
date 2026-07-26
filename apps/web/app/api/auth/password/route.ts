import { NextResponse, type NextRequest } from "next/server";
import { isDemoMode } from "../../../../lib/demo-mode";
import {
  isMultiUserEnabled,
  hasLoginPassword,
  setSingleUserPassword,
  clearSingleUserPassword,
  requireAuthenticatedAccountId,
} from "../../../../lib/workflow-runtime";

/** flag cookie 名与有效期。仅用于 proxy 的重定向 UX，非安全判据。 */
const AUTH_REQUIRED_COOKIE = "mt_auth_required";
const FLAG_MAX_AGE = 365 * 24 * 60 * 60;

/**
 * 单用户实例设置/更新/清除访问密码。
 *
 * 授权模型：**已设密码后**，改密与清密都必须是已认证请求
 * （`requireAuthenticatedAccountId()` 对远程无 session 会抛错；局域网视为可信）。
 * 尚未设密码时实例本来就全开放，首次设置无从要求凭据——这与「局域网可信」
 * 的整体设计一致：能碰到局域网端口的人本来就能读写全部数据。
 *
 * 同时维护 `mt_auth_required` flag cookie 供 Edge 层 proxy 做重定向判断。
 */
export async function POST(request: NextRequest) {
  if (isDemoMode()) {
    return NextResponse.json({ error: "演示站只读" }, { status: 403 });
  }
  if (isMultiUserEnabled()) {
    // 多用户有自己的改密路径（changeOwnPassword / resetUserPassword）
    return NextResponse.json({ error: "多用户模式请在账号设置中改密" }, { status: 400 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    password?: unknown;
    clear?: unknown;
  };

  // 已设密码 → 后续变更必须已认证。状态读不出来（"unknown"）时同样要求认证，
  // 宁可让本地用户多登录一次，也不能让远程匿名请求清掉密码。
  if ((await hasLoginPassword()) !== false) {
    await requireAuthenticatedAccountId();
  }

  if (body.clear === true) {
    await clearSingleUserPassword();
    const res = NextResponse.json({ ok: true, passwordSet: false });
    res.cookies.set(AUTH_REQUIRED_COOKIE, "", { path: "/", maxAge: 0 });
    return res;
  }

  const password = typeof body.password === "string" ? body.password : "";
  const result = await setSingleUserPassword(password);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  const res = NextResponse.json({ ok: true, passwordSet: true });
  res.cookies.set(AUTH_REQUIRED_COOKIE, "1", {
    path: "/",
    // 故意 NOT httpOnly：设置页要读它来显示当前状态。它不是安全判据——
    // 权威判定在服务端 getCurrentAccountId()，伪造这个 cookie 不会绕过任何东西。
    httpOnly: false,
    sameSite: "lax",
    maxAge: FLAG_MAX_AGE,
  });
  return res;
}

