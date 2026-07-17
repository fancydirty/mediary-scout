import { NextResponse, type NextRequest } from "next/server";
import { TianyiQrLoginClient, type TianyiQrSession } from "@media-track/workflow";
import { validateTianyiQrSession } from "../../../../../lib/tianyi-qr-session";

// POST (not GET like quark): the 天翼 poll needs the WHOLE session (uuid/paramId/
// lt/… + the stateful cookie jar) — too rich for query params. The response
// carries pollStatus's UPDATED jar; the component must store it back into its
// session before the next poll / the final confirm (rolling round-trip).
export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = (await request.json().catch(() => null)) as { session?: TianyiQrSession } | null;
  const session = body?.session;
  const valid = validateTianyiQrSession(session);
  if (!valid.ok) {
    return NextResponse.json({ ok: false, error: valid.error }, { status: 400 });
  }
  try {
    const result = await new TianyiQrLoginClient().pollStatus(session as TianyiQrSession);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error) }, { status: 502 });
  }
}
