import { isDemoMode } from "../../../../../lib/demo-mode";
import { NextResponse, type NextRequest } from "next/server";
import { completePan123QrLogin, StorageOwnedByOtherAccountError } from "../../../../../lib/workflow-runtime";

// The ~90-day 123 login token is a JWT (eyJ… header.payload.signature) — the
// poll hands it to the browser verbatim, and it IS the final credential (no
// 天翼-style exchange). Validate the JWT shape before touching the runtime.
// Length cap BEFORE the regex (mirrors status route's uniID cap): this is an
// unauthenticated endpoint — without it a malicious MB-sized eyJ… body gets
// full-regex-scanned and shipped verbatim in a Bearer header upstream. A real
// 90-day token is ~500 bytes; 4096 is ample headroom.
const MAX_TOKEN_LENGTH = 4096;
const PAN123_TOKEN_SHAPE = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function isValidPan123Token(token: string): boolean {
  return token.length > 0 && token.length <= MAX_TOKEN_LENGTH && PAN123_TOKEN_SHAPE.test(token);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (isDemoMode()) return NextResponse.json({ ok: false, error: "演示站只读" }, { status: 403 });
  // Parse the body OUTSIDE the business try/catch: invalid/missing JSON is a
  // client error (400), not an infra failure (502) — mirrors tianyi's confirm.
  const body = (await request.json().catch(() => null)) as { token?: unknown } | null;
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  if (!isValidPan123Token(token)) {
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
