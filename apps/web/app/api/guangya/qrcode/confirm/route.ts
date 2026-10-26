import { NextResponse, type NextRequest } from "next/server";
import { GuangYaDeviceLogin } from "@media-track/workflow";
import { isDemoMode } from "../../../../../lib/demo-mode";

/**
 * Redeem an approved 光鸭 device code and bind the drive.
 *
 * Polls once more rather than trusting the client's word that it was approved:
 * the check is the token endpoint itself, so a forged "confirmed" gains nothing.
 * The tokens are exchanged and persisted here and never travel to the page.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  if (isDemoMode()) return NextResponse.json({ error: "演示站只读" }, { status: 403 });

  // Parse outside the business try/catch: invalid/missing JSON is a client error
  // (400), not an infra failure (502). The type check matters because
  // `request.json()` is `any` — `{deviceCode:{}}` would sail past a truthiness
  // test and blow up inside string handling as a 502.
  const body = (await request.json().catch(() => null)) as { deviceCode?: unknown } | null;
  if (typeof body?.deviceCode !== "string" || !body.deviceCode.trim()) {
    return NextResponse.json({ ok: false, error: "missing deviceCode" }, { status: 400 });
  }

  // Loaded lazily: token/status have no business pulling in the DB layer.
  let runtime: typeof import("../../../../../lib/workflow-runtime");
  try {
    runtime = await import("../../../../../lib/workflow-runtime");
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error) }, { status: 502 });
  }

  const login = new GuangYaDeviceLogin();
  let tokens: { accessToken: string; refreshToken: string };
  try {
    const result = await login.poll(body.deviceCode);
    if (result.status === "pending") {
      return NextResponse.json({ ok: false, error: "还没在光鸭里确认登录" }, { status: 409 });
    }
    if (result.status === "expired") {
      return NextResponse.json({ ok: false, error: "授权码已过期，请重新获取" }, { status: 410 });
    }
    tokens = { accessToken: result.accessToken, refreshToken: result.refreshToken };
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }

  try {
    const { providerUid } = await runtime.connectGuangYa(tokens.accessToken, tokens.refreshToken);
    return NextResponse.json({ ok: true, providerUid });
  } catch (error) {
    if (error instanceof runtime.StorageOwnedByOtherAccountError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 409 });
    }
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "登录失败" },
      { status: 502 },
    );
  }
}
