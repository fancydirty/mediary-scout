import { connection, NextResponse, type NextRequest } from "next/server";
import { loadSettingsAttentionSummary } from "../../../../lib/settings-attention-server";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** Lightweight badge/inbox payload. Poll-friendly; never throws to the client.
 *  Badge polls only need count/severity — pass `items=1` for full inbox items. */
export async function GET(request: NextRequest) {
  try {
    await connection();
    const summary = await loadSettingsAttentionSummary({
      w: request.nextUrl.searchParams.get("w"),
    });
    const includeItems = request.nextUrl.searchParams.get("items") === "1";
    return NextResponse.json(
      {
        count: summary.count,
        severity: summary.severity,
        items: includeItems ? summary.items : [],
      },
      { headers: NO_STORE },
    );
  } catch {
    // Fail quiet — badge polls every few seconds; never spam logs or break nav.
    return NextResponse.json({ count: 0, severity: null, items: [] }, { headers: NO_STORE });
  }
}
