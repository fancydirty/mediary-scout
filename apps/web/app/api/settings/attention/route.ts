import { connection, NextResponse, type NextRequest } from "next/server";
import { loadSettingsAttentionSummary } from "../../../../lib/settings-attention-server";
import { resolveGlobalWorkspace } from "../../../../lib/workflow-runtime";

/** Lightweight badge/inbox payload. Poll-friendly; never throws to the client.
 *  Badge polls only need count/severity — pass `items=1` for full inbox items. */
export async function GET(request: NextRequest) {
  try {
    await connection();
    const workspace = await resolveGlobalWorkspace(
      request.nextUrl.searchParams.get("w") ?? undefined,
    );
    const summary = await loadSettingsAttentionSummary(
      workspace.activeStorageId ? { activeStorageId: workspace.activeStorageId } : undefined,
    );
    const includeItems = request.nextUrl.searchParams.get("items") === "1";
    return NextResponse.json({
      count: summary.count,
      severity: summary.severity,
      items: includeItems ? summary.items : [],
    });
  } catch {
    // Fail quiet — badge polls every few seconds; never spam logs or break nav.
    return NextResponse.json({ count: 0, severity: null, items: [] });
  }
}
