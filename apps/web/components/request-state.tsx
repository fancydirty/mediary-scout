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
 *  NOT done, only accepted). Shared by the badge-style acquire controls.
 *  When `activityHref` is given the pill becomes a link to the live 活动 page —
 *  so the real, persistent progress is one click away instead of a manual nav
 *  (the 投产 acquisition-feedback gap the author flagged: "真实情况要去活动里看"). */
export function RequestedBadge({
  title,
  activityHref,
}: {
  title?: string | undefined;
  activityHref?: string | undefined;
}) {
  const inner = (
    <>
      <LoaderCircle size={12} className="spin" aria-hidden />
      已请求
    </>
  );
  if (activityHref) {
    return (
      <Link className="hub-badge tone-green" href={activityHref} title={title ?? "查看获取进度（活动）"}>
        {inner}
      </Link>
    );
  }
  return (
    <span className="hub-badge tone-green" title={title}>
      {inner}
    </span>
  );
}
