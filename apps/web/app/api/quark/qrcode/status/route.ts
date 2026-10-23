import { NextResponse, type NextRequest } from "next/server";
import { QuarkQrLoginClient } from "@media-track/workflow";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const token = request.nextUrl.searchParams.get("token") ?? "";
  if (!token) {
    return NextResponse.json({ ok: false, error: "missing token" }, { status: 400 });
  }
  try {
    const result = await new QuarkQrLoginClient().pollStatus({ token });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error) }, { status: 502 });
  }
}
