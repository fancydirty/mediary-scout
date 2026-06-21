import { isDemoMode } from "../../../../lib/demo-mode";
import { NextResponse, type NextRequest } from "next/server";
import { getCurrentAccountId, getWorkflowRepository } from "../../../../lib/workflow-runtime";

/**
 * Manually retry a terminally FAILED acquisition (user action from the activity
 * page). Resets the run to immediately-claimable queued so the worker re-runs it.
 * Returns { status: "retried" | "not_retriable" } — not_retriable when the run is
 * not in a failed state (already queued/running/succeeded).
 */
export async function POST(request: NextRequest) {
  if (isDemoMode()) return Response.json({ error: "演示站只读" }, { status: 403 });
  const body = (await request.json().catch(() => ({}))) as { runId?: unknown };
  const runId = typeof body.runId === "string" ? body.runId : null;
  if (!runId) {
    return NextResponse.json({ error: "runId required" }, { status: 400 });
  }
  const result = await getWorkflowRepository().retryFailedWorkflowRun(runId, await getCurrentAccountId());
  return NextResponse.json(result);
}
