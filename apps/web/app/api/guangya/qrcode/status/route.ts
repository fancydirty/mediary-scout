import { NextResponse, type NextRequest } from "next/server";
import { GuangYaDeviceLogin } from "@media-track/workflow";
import { isDemoMode } from "../../../../../lib/demo-mode";

/**
 * One poll tick for the 光鸭 device-code login — and, on approval, the binding.
 *
 * ⚠️ Why this route also BINDS instead of delegating to a separate /confirm:
 * the `device_code` is **single-use** — RFC 8628 says the first successful
 * `/v1/auth/token` call redeems it, and 光鸭 follows that (verified: a second
 * poll on a redeemed code returns `expired`). So a "status says confirmed, then
 * confirm exchanges again" split silently breaks: the status call would consume
 * the code and the confirm call would find it dead. There is also no
 * non-consuming "has it been approved?" probe on this server (all of
 * /v1/auth/device/{status,check,info} are 404).
 *
 * Consequences for the contract:
 *  - `pending` / `expired` are the only statuses this route reports.
 *  - On approval it binds immediately and returns `confirmed` + the uid. The
 *    tokens are exchanged and persisted here and never travel to the browser.
 *  - A bind failure is reported as an error (502/409), NOT as "keep waiting" —
 *    the code is already spent, so waiting would hang forever.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  // Gate BEFORE polling: this call consumes the single-use device_code upstream,
  // so a demo-mode visitor could otherwise burn a real visitor's code (and make
  // us send outbound token requests on their behalf).
  if (isDemoMode()) {
    return NextResponse.json({ ok: false, error: "演示站只读" }, { status: 403 });
  }
  const deviceCode = request.nextUrl.searchParams.get("deviceCode") ?? "";
  if (!deviceCode.trim()) {
    return NextResponse.json({ ok: false, error: "missing deviceCode" }, { status: 400 });
  }

  const result = await pollOnce(deviceCode);
  if ("error" in result) return result.error;

  if (result.poll.status === "pending") {
    return NextResponse.json({ ok: true, status: "pending" });
  }
  if (result.poll.status === "expired") {
    return NextResponse.json({ ok: true, status: "expired" });
  }

  // Approved. The code is now spent — binding must happen on THIS request.
  let runtime: typeof import("../../../../../lib/workflow-runtime");
  try {
    runtime = await import("../../../../../lib/workflow-runtime");
  } catch (error) {
    return NextResponse.json({ ok: false, error: messageOf(error) }, { status: 502 });
  }

  try {
    const { providerUid } = await runtime.connectGuangYa(
      result.poll.accessToken,
      result.poll.refreshToken,
    );
    return NextResponse.json({ ok: true, status: "confirmed", providerUid });
  } catch (error) {
    if (error instanceof runtime.StorageOwnedByOtherAccountError) {
      // Distinct from pending: the user DID approve, this account just can't be
      // bound here. The UI must show this, not go back to "waiting".
      return NextResponse.json({ ok: false, error: error.message || "该光鸭账号已被其他用户连接" }, { status: 409 });
    }
    return NextResponse.json({ ok: false, error: messageOf(error) }, { status: 502 });
  }
}

async function pollOnce(
  deviceCode: string,
): Promise<
  | { poll: Awaited<ReturnType<GuangYaDeviceLogin["poll"]>> }
  | { error: NextResponse }
> {
  try {
    return { poll: await new GuangYaDeviceLogin().poll(deviceCode) };
  } catch (error) {
    return { error: NextResponse.json({ ok: false, error: messageOf(error) }, { status: 502 }) };
  }
}

/** An Error with an EMPTY message yields "" and the UI renders a blank "❌ ".
 *  Fall through message → name → generic. */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message.trim() || error.name || "登录失败";
  const text = String(error).trim();
  return text || "登录失败";
}
