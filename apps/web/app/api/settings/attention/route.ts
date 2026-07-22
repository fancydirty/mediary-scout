import { connection, NextResponse, type NextRequest } from "next/server";
import { loadSettingsAttentionSummary } from "../../../../lib/settings-attention-server";
import { resolveGlobalWorkspace } from "../../../../lib/workflow-runtime";

/** Lightweight badge/inbox payload. Poll-friendly; never throws to the client. */
export async function GET(request: NextRequest) {
  await connection();
  try {
    const workspace = await resolveGlobalWorkspace(
      request.nextUrl.searchParams.get("w") ?? undefined,
    );
    const summary = await loadSettingsAttentionSummary(
      workspace.activeStorageId ? { activeStorageId: workspace.activeStorageId } : undefined,
    );
    return NextResponse.json({
      count: summary.count,
      severity: summary.severity,
      items: summary.items,
    });
  } catch {
    // Fail quiet — badge polls every few seconds; never spam logs or break nav.
    return NextResponse.json({ count: 0, severity: null, items: [] });
  }
}
