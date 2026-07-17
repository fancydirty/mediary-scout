import { isDemoMode } from "../../../../lib/demo-mode";
import { NextResponse } from "next/server";
import { TianyiQrLoginClient } from "@media-track/workflow";

// The returned session carries the STATEFUL login cookie jar (session.cookies)
// harvested from unifyLoginForPC — the browser must round-trip it through
// /status (which returns an UPDATED jar each poll) and finally /confirm.
export async function POST(): Promise<NextResponse> {
  if (isDemoMode()) return NextResponse.json({ error: "演示站只读" }, { status: 403 });
  try {
    const session = await new TianyiQrLoginClient().getQrSession();
    return NextResponse.json({ ok: true, session });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error) }, { status: 502 });
  }
}
