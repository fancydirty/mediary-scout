import { isDemoMode } from "../../../../../lib/demo-mode";
import { NextResponse, type NextRequest } from "next/server";
import { completePan115QrLogin, StorageOwnedByOtherAccountError } from "../../../../../lib/workflow-runtime";

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (isDemoMode()) return NextResponse.json({ error: "演示站只读" }, { status: 403 });
  // Parse the body OUTSIDE the business try/catch: invalid/missing JSON is a
  // client error (400), not an infra failure (502). Empty body → missing params.
  const body = (await request.json().catch(() => null)) as {
    session?: { uid?: string; time?: number; sign?: string };
    app?: string;
  } | null;
  const { uid, time, sign } = body?.session ?? {};
  if (!uid || !sign || typeof time !== "number") {
    return NextResponse.json({ ok: false, error: "missing session params" }, { status: 400 });
  }
  try {
    const result = await completePan115QrLogin({
      session: { uid, time, sign, qrcodeContent: "" },
      ...(body!.app === undefined ? {} : { app: body!.app }),
    });
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
