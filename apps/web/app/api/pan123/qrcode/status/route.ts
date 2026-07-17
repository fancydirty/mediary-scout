import { NextResponse, type NextRequest } from "next/server";
import { Pan123QrLoginClient } from "@media-track/workflow";

// 123's uniID is a url-safe UUID (36 chars observed live) — validate loosely
// (shape + length cap) so a server-side format tweak doesn't 400 real polls.
const UNI_ID_SHAPE = /^[0-9A-Za-z_-]+$/;
const MAX_UNI_ID_LENGTH = 128;

// POST like tianyi's status route, but WITHOUT the session round-trip: 123's
// poll is stateless — the uniID alone identifies the QR, and a confirmed poll
// carries the ~90-day token directly (no cookie jar, no exchange hop).
export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = (await request.json().catch(() => null)) as { uniID?: unknown } | null;
  const uniID = typeof body?.uniID === "string" ? body.uniID : "";
  if (!uniID || uniID.length > MAX_UNI_ID_LENGTH || !UNI_ID_SHAPE.test(uniID)) {
    return NextResponse.json({ ok: false, error: "缺少或非法的 uniID" }, { status: 400 });
  }
  try {
    const result = await new Pan123QrLoginClient().pollStatus({ uniID });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error) }, { status: 502 });
  }
}
