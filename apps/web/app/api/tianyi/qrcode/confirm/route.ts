import { isDemoMode } from "../../../../../lib/demo-mode";
import { NextResponse, type NextRequest } from "next/server";
import { completeTianyiQrLogin, StorageOwnedByOtherAccountError } from "../../../../../lib/workflow-runtime";
import { validateTianyiQrSession, validateTianyiRedirectUrl } from "../../../../../lib/tianyi-qr-session";
import type { TianyiQrSession } from "@media-track/workflow";

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (isDemoMode()) return NextResponse.json({ error: "演示站只读" }, { status: 403 });
  // Parse the body OUTSIDE the business try/catch: invalid/missing JSON is a
  // client error (400), not an infra failure (502). The session here must be the
  // component's FRESHEST copy (its cookie jar updated from the last /status
  // response) — a stale jar can drop a cookie 天翼 rotated mid-poll and fail the
  // getSessionForPC exchange on the real network.
  const body = (await request.json().catch(() => null)) as {
    session?: TianyiQrSession;
    redirectUrl?: string;
  } | null;
  const sessionValid = validateTianyiQrSession(body?.session);
  if (!sessionValid.ok) {
    return NextResponse.json({ ok: false, error: sessionValid.error }, { status: 400 });
  }
  const redirectValid = validateTianyiRedirectUrl(body?.redirectUrl);
  if (!redirectValid.ok) {
    return NextResponse.json({ ok: false, error: redirectValid.error }, { status: 400 });
  }
  try {
    const result = await completeTianyiQrLogin(body!.session as TianyiQrSession, body!.redirectUrl as string);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof StorageOwnedByOtherAccountError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 409 });
    }
    return NextResponse.json(
      { ok: false, error: (error as Error)?.message || "登录失败" },
      { status: 502 },
    );
  }
}
