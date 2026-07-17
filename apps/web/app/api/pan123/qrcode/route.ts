import { isDemoMode } from "../../../../lib/demo-mode";
import { NextResponse } from "next/server";
import { Pan123QrLoginClient } from "@media-track/workflow";

// 123网盘 QR generate. Unlike 天翼 there is NO stateful cookie jar to round-trip:
// the session is just { uniID, qrcodeContent } — /status only needs the uniID
// and /confirm only needs the token the poll returns.
export async function POST(): Promise<NextResponse> {
  if (isDemoMode()) return NextResponse.json({ error: "演示站只读" }, { status: 403 });
  try {
    const session = await new Pan123QrLoginClient().getQrSession();
    return NextResponse.json({ ok: true, session });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error) }, { status: 502 });
  }
}
