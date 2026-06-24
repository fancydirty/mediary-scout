import { isDemoMode } from "../../../../../lib/demo-mode";
import { NextResponse, type NextRequest } from "next/server";
import { completeQuarkQrLogin, StorageOwnedByOtherAccountError } from "../../../../../lib/workflow-runtime";

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (isDemoMode()) return NextResponse.json({ error: "演示站只读" }, { status: 403 });
  try {
    const body = (await request.json()) as { serviceTicket?: string };
    if (!body.serviceTicket) {
      return NextResponse.json({ ok: false, error: "missing serviceTicket" }, { status: 400 });
    }
    const result = await completeQuarkQrLogin(body.serviceTicket);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof StorageOwnedByOtherAccountError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 409 });
    }
    return NextResponse.json(
      { ok: false, error: (error as Error)?.message ?? "登录失败" },
      { status: 502 },
    );
  }
}
