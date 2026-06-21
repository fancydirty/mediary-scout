import { connection, NextResponse, type NextRequest } from "next/server";
import {
  ensureDemoSeeded,
  getWorkflowRepository,
  notificationWindowSince,
  resolveGlobalWorkspace,
} from "../../../../lib/workflow-runtime";

/**
 * Lightweight feed metadata for the 通知 nav unread badge: the recent notification
 * timestamps, newest first. The client compares them against its localStorage
 * lastSeen to compute the unread count + mark NEW items — no server-side per-user
 * read state (the "按浏览器消费" model). Scoped to the active drive via `?w`.
 */
export async function GET(request: NextRequest) {
  // Request-time only: keep this out of build-time prerender (it reads the DB).
  await connection();
  const repository = getWorkflowRepository();
  await ensureDemoSeeded(repository);
  const { accountId, connectedStorageId } = await resolveGlobalWorkspace(
    request.nextUrl.searchParams.get("w") ?? undefined,
  );
  // Mirror the 通知 page's 7-day window so the unread badge can't count items the
  // page won't show (otherwise the badge would be unclearable).
  const notifications = await repository.listNotifications({
    limit: 50,
    accountId,
    connectedStorageId,
    since: notificationWindowSince(),
  });
  return NextResponse.json({ createdAts: notifications.map((notification) => notification.createdAt) });
}
