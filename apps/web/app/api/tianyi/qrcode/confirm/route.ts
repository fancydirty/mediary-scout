import { isDemoMode } from "../../../../../lib/demo-mode";
import { NextResponse, type NextRequest } from "next/server";
import { completeTianyiQrLogin, StorageOwnedByOtherAccountError } from "../../../../../lib/workflow-runtime";
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
  if (!body?.session || typeof body.session !== "object") {
    return NextResponse.json({ ok: false, error: "missing session" }, { status: 400 });
  }
  if (!body.redirectUrl || typeof body.redirectUrl !== "string") {
    return NextResponse.json({ ok: false, error: "missing redirectUrl" }, { status: 400 });
  }
  try {
    const result = await completeTianyiQrLogin(body.session, body.redirectUrl);
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
