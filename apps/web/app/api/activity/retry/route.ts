import { isDemoMode } from "../../../../lib/demo-mode";
import { NextResponse, type NextRequest } from "next/server";
import { getCurrentAccountId, getWorkflowRepository } from "../../../../lib/workflow-runtime";
import { isQueueClaimableKind } from "@media-track/workflow";
import type { RetryRefusalReason } from "../../../../lib/activity-view";


/**
 * Manually retry a terminally FAILED acquisition (user action from the activity
 * page). Resets the run to immediately-claimable queued so the worker re-runs it.
 * Returns { status: "retried" | "not_retriable" }. When not_retriable, `reason`
 * distinguishes the two causes so the UI can say something true:
 *  - "kind_not_retriable": the run's kind has no queue claimer (patrol runs), so
 *    requeueing it would strand it in `queued` forever and block the season. The
 *    user's actual remedy is to trigger a patrol, not to retry this run.
 *  - "not_failed": the run isn't in a failed state (already queued/running/done).
 */
export async function POST(request: NextRequest) {
  if (isDemoMode()) return Response.json({ error: "演示站只读" }, { status: 403 });
  const body = (await request.json().catch(() => ({}))) as { runId?: unknown };
  const runId = typeof body.runId === "string" ? body.runId : null;
  if (!runId) {
    return NextResponse.json({ error: "runId required" }, { status: 400 });
  }
  const repository = getWorkflowRepository();
  const accountId = await getCurrentAccountId();
  const result = await repository.retryFailedWorkflowRun(runId, accountId);
  if (result.status === "retried") {
    return NextResponse.json(result);
  }
  // Read the run back only on the refusal path (keeps the happy path a single
  // query) to tell the two causes apart for the UI message.
  const snapshot = await repository.getWorkflowRunSnapshot(runId, accountId);
  // Status is checked FIRST: a patrol that is currently running was refused for
  // its status, not its kind, so claiming "巡检任务不能重试" would be the wrong
  // explanation. Only a run that IS failed and whose kind has no claimer gets the
  // kind-specific message. Unreadable run (cross-account / pruned) → the vague
  // one, which is also the right direction for not leaking existence.
  const reason: RetryRefusalReason =
    snapshot &&
    snapshot.workflowRun.status === "failed" &&
    !isQueueClaimableKind(snapshot.workflowRun.kind)
      ? "kind_not_retriable"
      : "not_failed";
  return NextResponse.json({ ...result, reason });
}
