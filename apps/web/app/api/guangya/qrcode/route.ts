import { NextResponse } from "next/server";
import { GuangYaDeviceLogin } from "@media-track/workflow";
import { isDemoMode } from "../../../../lib/demo-mode";

/**
 * Mint a 光鸭 login session. This is the SAME device-code flow the 光鸭 website's
 * 「扫码登录」 button runs (confirmed by capturing its network on 2026-10-26): the
 * page POSTs /v1/auth/device/code and renders the returned `verification_url` as
 * a QR code.
 *
 * State lives entirely on the client — `device_code` is the credential the caller
 * carries to /status and /confirm, exactly like the 夸克/UC QR token. Nothing is
 * stored server-side, so a multi-instance deployment behaves the same as one.
 */
export async function POST(): Promise<NextResponse> {
  if (isDemoMode()) return NextResponse.json({ error: "演示站只读" }, { status: 403 });
  try {
    const code = await new GuangYaDeviceLogin().start();
    return NextResponse.json({ ok: true, ...code });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
