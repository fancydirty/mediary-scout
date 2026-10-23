import { NextResponse, type NextRequest } from "next/server";
import { QuarkQrLoginClient, UC_QR_PROFILE } from "@media-track/workflow";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const token = request.nextUrl.searchParams.get("token") ?? "";
  if (!token) {
    return NextResponse.json({ ok: false, error: "missing token" }, { status: 400 });
  }
  try {
    const result = await new QuarkQrLoginClient({ profile: UC_QR_PROFILE }).pollStatus({ token });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error) }, { status: 502 });
  }
}
