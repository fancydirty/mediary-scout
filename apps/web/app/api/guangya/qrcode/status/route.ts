import { NextResponse, type NextRequest } from "next/server";
import { GuangYaDeviceLogin } from "@media-track/workflow";

/**
 * One poll tick against the 光鸭 device-code flow: `pending` | `expired`.
 *
 * ⚠️ This route deliberately NEVER returns the tokens. If it did, the browser
 * would briefly hold a live credential and have to post it back — strictly worse
 * than the server reading it once. `confirmed` is only a signal for the UI to
 * call POST /confirm, which polls once more server-side and binds the drive, so
 * the access/refresh pair never leaves the server.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const deviceCode = request.nextUrl.searchParams.get("deviceCode") ?? "";
  if (!deviceCode.trim()) {
    return NextResponse.json({ ok: false, error: "missing deviceCode" }, { status: 400 });
  }
  try {
    const result = await new GuangYaDeviceLogin().poll(deviceCode);
    return NextResponse.json({ ok: true, status: result.status });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
