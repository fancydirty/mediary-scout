import { connection, NextResponse } from "next/server";
import {
  isMultiUserEnabled,
  getBootstrapState,
  hasLoginPassword,
} from "../../../../lib/workflow-runtime";

/** Tells the /login page whether the instance is unclaimed (→ show the context-aware
 *  claim screen) and whether the default account already owns a library (→ "接管"
 *  copy vs "创建"). Read-only; safe before any auth.
 *
 *  `singleUser` lets the page render a password-only form: in single-user mode the
 *  account is always acct_default, so there is no username to ask an end user for.
 *
 *  `connection()` FIRST: reads runtime env (MEDIA_TRACK_MULTI_USER) + the DB at request
 *  time. Without it, cacheComponents prerenders the handler at BUILD time (multi-user
 *  off) and serves a baked {needsClaim:false} forever → the owner can never claim →
 *  locked out. (Caught in prod live e2e. `export const dynamic` is disallowed under
 *  cacheComponents, so the opt-in is connection().) */
export async function GET() {
  await connection();
  if (!isMultiUserEnabled()) {
    return NextResponse.json({
      needsClaim: false,
      hasExistingLibrary: false,
      singleUser: true,
      // "unknown"（DB 读不出来）按**已设密码**上报：服务端远程读路径此时是
      // fail-closed 的，若这里报「无需登录」，用户会被引到一条走不通的路。
      // 宁可显示登录框（顶多多输一次密码），也不要误导。
      passwordSet: (await hasLoginPassword()) !== false,
    });
  }
  return NextResponse.json({ ...(await getBootstrapState()), singleUser: false });
}
