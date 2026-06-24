"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { RequestedBadge } from "./request-state";
import { useActiveRun } from "../lib/use-active-run";
import { inlineProgressView, trickleDisplayPercent } from "../lib/inline-progress";

/**
 * Smoothly trickle the displayed bar forward between server updates. Server progress
 * only advances on a real agent tool call, but a single step (e.g. a ~90s search) can
 * dominate the run — so without this the bar sits frozen and looks empty. We anchor on
 * the last server percent (+ when it changed) and ease toward a soft ceiling; a ~400ms
 * re-render drives it while the CSS `width` transition bridges each step. `max(server,
 * trickle)` + rebasing only when the server value rises keeps it monotonic (no rewind).
 */
function useTrickledPercent(serverPercent: number, running: boolean, runKey: string): number {
  const anchor = useRef({ percent: serverPercent, atMs: Date.now(), key: runKey });
  const [, force] = useState(0);
  if (anchor.current.key !== runKey || serverPercent > anchor.current.percent) {
    anchor.current = { percent: serverPercent, atMs: Date.now(), key: runKey };
  }
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => force((n) => n + 1), 400);
    return () => clearInterval(id);
  }, [running]);
  const elapsed = Date.now() - anchor.current.atMs;
  return Math.max(serverPercent, trickleDisplayPercent(anchor.current.percent, elapsed));
}

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
  // Hooks must run unconditionally — compute the trickled width before any early return.
  const displayPercent = useTrickledPercent(view.percent, view.running, run?.runId ?? "none");

  if (!view.running) {
    return <RequestedBadge title={title} storageId={storageId} />;
  }

  const href = storageId ? `/activity?w=${encodeURIComponent(storageId)}` : "/activity";
  return (
    <Link className="demo-playback acquire-progress" href={href} title={title ?? "查看获取进度（活动）"}>
      <span className="demo-playback-bar">
        <span className="demo-playback-fill" style={{ width: `${displayPercent}%` }} />
      </span>
      {/* aria-live on the step text (NOT the anchor): keeps the element a proper
          link for assistive tech while still announcing progress updates. */}
      <span className="demo-playback-step" aria-live="polite">
        <LoaderCircle size={14} className="spin" aria-hidden />
        <span>{view.step}</span>
      </span>
    </Link>
  );
}
