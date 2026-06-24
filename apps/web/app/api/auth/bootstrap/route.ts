import { connection } from "next/server";
import { NextResponse } from "next/server";
import { isMultiUserEnabled, getBootstrapState } from "../../../../lib/workflow-runtime";

/** Tells the /login page whether the instance is unclaimed (→ show the context-aware
 *  claim screen) and whether the default account already owns a library (→ "接管"
 *  copy vs "创建"). Read-only; safe before any auth.
 *
 *  `connection()` FIRST: reads runtime env (MEDIA_TRACK_MULTI_USER) + the DB at request
 *  time. Without it, cacheComponents prerenders the handler at BUILD time (multi-user
 *  off) and serves a baked {needsClaim:false} forever → the owner can never claim →
 *  locked out. (Caught in prod live e2e. `export const dynamic` is disallowed under
 *  cacheComponents, so the opt-in is connection().) */
export async function GET() {
  await connection();
  if (!isMultiUserEnabled()) {
    return NextResponse.json({ needsClaim: false, hasExistingLibrary: false });
  }
  return NextResponse.json(await getBootstrapState());
}
