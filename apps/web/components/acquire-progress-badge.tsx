"use client";

import Link from "next/link";
import { LoaderCircle } from "lucide-react";
import { RequestedBadge } from "./request-state";
import { useActiveRun } from "../lib/use-active-run";
import { inlineProgressView } from "../lib/inline-progress";

/**
 * Production inline acquire progress. While THIS card's run is actively running,
 * show a live progress bar + step (real /api/activity data, reusing the demo's
 * elegant inline visual), still clickable through to 活动. Queued / not-yet-matched
 * / finished → the existing static 已请求 pill (AcquiringPoller's router.refresh
 * flips it to 已获取 on finish).
 */
export function AcquireProgressBadge({
  tmdbId,
  seasonNumber = null,
  storageId,
  title,
}: {
  tmdbId: number;
  seasonNumber?: number | null;
  storageId?: string | undefined;
  title?: string | undefined;
}) {
  const run = useActiveRun(tmdbId, seasonNumber, storageId);
  const view = inlineProgressView(run);

  if (!view.running) {
    return <RequestedBadge title={title} storageId={storageId} />;
  }

  const href = storageId ? `/activity?w=${encodeURIComponent(storageId)}` : "/activity";
  return (
    <Link
      className="demo-playback acquire-progress"
      href={href}
      title="查看获取进度（活动）"
      role="status"
      aria-live="polite"
    >
      <span className="demo-playback-bar">
        <span className="demo-playback-fill" style={{ width: `${view.percent}%` }} />
      </span>
      <span className="demo-playback-step">
        <LoaderCircle size={14} className="spin" aria-hidden />
        <span>{view.step}</span>
      </span>
    </Link>
  );
}
