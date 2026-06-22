import { LoaderCircle } from "lucide-react";
import Link from "next/link";
import type { RequestTrackingActionResult } from "../app/actions";

/**
 * A request is "locked" once it has been queued, is already tracked, or has an
 * active workflow — in every case the acquire control should stop offering to
 * re-queue. Shared so the four acquire components agree on the exact set of
 * terminal/in-flight statuses instead of each re-listing them.
 */
export function isLockedResult(result: RequestTrackingActionResult | null): boolean {
  return (
    result?.status === "requested" ||
    result?.status === "already_tracked" ||
    result?.status === "active_workflow"
  );
}

/** The standalone "已请求" pill shown after a request is queued (spinner — it is
 *  NOT done, only accepted). Shared by the badge-style acquire controls. It links
 *  to the live 活动 page so the real, persistent progress is one click away instead
 *  of a manual nav (the 投产 feedback gap the author flagged: "真实情况要去活动里看").
 *  The href is built inline (mirrors workflow's globalNavHref) — NOT imported from
 *  the @media-track/workflow barrel, which would drag pg/postgres into this client
 *  bundle and break the Next build. */
export function RequestedBadge({
  title,
  storageId,
}: {
  title?: string | undefined;
  /** Active drive — scopes the 活动 link with ?w so leaving keeps the drive. */
  storageId?: string | undefined;
}) {
  const href = storageId ? `/activity?w=${encodeURIComponent(storageId)}` : "/activity";
  return (
    <Link className="hub-badge tone-green" href={href} title={title ?? "查看获取进度（活动）"}>
      <LoaderCircle size={12} className="spin" aria-hidden />
      已请求
    </Link>
  );
}
