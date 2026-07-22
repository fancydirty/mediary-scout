import { connection, NextResponse } from "next/server";
import { loadSettingsAttentionSummary } from "../../../../lib/settings-attention-server";

/** Lightweight badge/inbox payload. Poll-friendly; never throws to the client. */
export async function GET() {
  await connection();
  try {
    const summary = await loadSettingsAttentionSummary();
    return NextResponse.json({
      count: summary.count,
      severity: summary.severity,
      items: summary.items,
    });
  } catch (error) {
    console.error("[settings/attention] failed:", error);
    return NextResponse.json({ count: 0, severity: null, items: [] });
  }
}
