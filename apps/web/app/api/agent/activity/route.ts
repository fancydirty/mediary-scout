import { NextResponse, type NextRequest } from "next/server";
import { agentApiGuard } from "../../../../lib/agent-api/guard";
import { getOwnerAccountId } from "../../../../lib/agent-api/owner";
import { getWorkflowRepository, notificationWindowSince } from "../../../../lib/workflow-runtime";

export async function GET(request: NextRequest) {
  const denied = await agentApiGuard(request);
  if (denied) {
    return denied;
  }
  const accountId = await getOwnerAccountId();
  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get("limit")) || 20, 100);

  const repository = getWorkflowRepository();
  const activeRuns = await repository.listActiveWorkflowRuns(accountId);
  const notifications = await repository.listNotifications({
    accountId,
    since: notificationWindowSince(),
    limit,
  });

  const active = activeRuns.map((snapshot) => ({
    workflowRunId: snapshot.workflowRun.id,
    status: snapshot.workflowRun.status,
    kind: snapshot.workflowRun.kind,
    title: snapshot.title.title,
    seasonNumber: snapshot.season.seasonNumber,
    startedAt: snapshot.workflowRun.startedAt,
    connectedStorageId: snapshot.connectedStorageId ?? null,
  }));

  const recent = notifications.map((notification) => ({
    id: notification.id,
    kind: notification.kind,
    title: notification.title,
    body: notification.body,
    createdAt: notification.createdAt,
  }));

  return NextResponse.json({ active, recent });
}
