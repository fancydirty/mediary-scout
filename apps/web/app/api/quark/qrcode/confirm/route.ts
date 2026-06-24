import { isDemoMode } from "../../../../../lib/demo-mode";
import { NextResponse, type NextRequest } from "next/server";
import { completeQuarkQrLogin, StorageOwnedByOtherAccountError } from "../../../../../lib/workflow-runtime";

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (isDemoMode()) return NextResponse.json({ error: "演示站只读" }, { status: 403 });
  // Parse the body OUTSIDE the business try/catch: invalid/missing JSON is a
  // client error (400), not an infra failure (502). Empty body → missing ticket.
  const body = (await request.json().catch(() => null)) as { serviceTicket?: string } | null;
  if (!body?.serviceTicket) {
    return NextResponse.json({ ok: false, error: "missing serviceTicket" }, { status: 400 });
  }
  try {
    const result = await completeQuarkQrLogin(body.serviceTicket);
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
