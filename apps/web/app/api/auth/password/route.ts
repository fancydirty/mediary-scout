import { NextResponse, type NextRequest } from "next/server";
import { isDemoMode } from "../../../../lib/demo-mode";
import {
  isMultiUserEnabled,
  hasLoginPassword,
  setSingleUserPassword,
  clearSingleUserPassword,
  requireAuthenticatedAccountId,
  isRemoteRequest,
  UnauthenticatedAccountError,
} from "../../../../lib/workflow-runtime";

/**
 * 单用户实例设置/更新/清除访问密码。
 *
 * 授权模型：**已设密码后**，改密与清密都必须是已认证请求
 * （`requireAuthenticatedAccountId()` 对远程无 session 会抛错；局域网视为可信）。
 * 尚未设密码时首次设置无从要求凭据，所以**只接受局域网请求**——这与「局域网可信」
 * 的整体设计一致：能碰到局域网端口的人本来就能读写全部数据；经隧道来的外网请求
 * 在这一刻一律拒绝（否则谁先找到公网地址谁就能抢先设密码）。
 *
 * 这里**不再**写 `mt_auth_required` flag cookie。它当初只服务一件事：proxy 的
 * 旧规则 `passwordSet && isRemote`。那条规则已被删除（远程一律要 session，
 * 见 proxy.ts 的注释），全仓库再无任何读取方，写下去只会留一个会过期、会与
 * 真实状态漂移的假状态源。密码状态的唯一权威读法是 `GET /api/auth/bootstrap`
 * → `hasLoginPassword()`（login/page.tsx 用的就是它）。
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
  const passwordState = await hasLoginPassword();
  if (passwordState === false && isRemoteRequest(request.headers)) {
    // 第一次设置只在局域网：隧道接通、站主还没设密码的这段时间里，谁先在外网打开
    // 这个地址谁就能设上密码、登进来拿到网盘凭据和模型 key。
    return NextResponse.json(
      { error: "第一次设置访问密码只能在局域网里完成。请在家里的网络打开这台机器的局域网地址设置。" },
      { status: 403 },
    );
  }
  if (passwordState !== false) {
    try {
      await requireAuthenticatedAccountId();
    } catch (error) {
      // 外网没登录就来改密/清密：是 401，不是服务器出错。
      if (error instanceof UnauthenticatedAccountError) {
        return NextResponse.json({ error: error.message }, { status: 401 });
      }
      throw error;
    }
  }

  if (body.clear === true) {
    await clearSingleUserPassword();
    return NextResponse.json({ ok: true, passwordSet: false });
  }

  const password = typeof body.password === "string" ? body.password : "";
  const result = await setSingleUserPassword(password);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json({ ok: true, passwordSet: true });
}

