import { isDemoMode } from "../../../../../lib/demo-mode";
import { NextResponse, type NextRequest } from "next/server";
import { completePan123QrLogin, StorageOwnedByOtherAccountError } from "../../../../../lib/workflow-runtime";

// The ~90-day 123 login token is a JWT (eyJ… header.payload.signature) — the
// poll hands it to the browser verbatim, and it IS the final credential (no
// 天翼-style exchange). Validate the JWT shape before touching the runtime.
const PAN123_TOKEN_SHAPE = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (isDemoMode()) return NextResponse.json({ error: "演示站只读" }, { status: 403 });
  // Parse the body OUTSIDE the business try/catch: invalid/missing JSON is a
  // client error (400), not an infra failure (502) — mirrors tianyi's confirm.
  const body = (await request.json().catch(() => null)) as { token?: unknown } | null;
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  if (!token || !PAN123_TOKEN_SHAPE.test(token)) {
    return NextResponse.json({ ok: false, error: "缺少或非法的登录 token" }, { status: 400 });
  }
  try {
    const result = await completePan123QrLogin(token);
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
