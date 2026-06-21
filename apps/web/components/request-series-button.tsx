"use client";

import { Check, Layers, LoaderCircle } from "lucide-react";
import { useState, useTransition } from "react";
import { requestSeriesAction, type RequestTrackingActionResult } from "../app/actions";
import { isLockedResult } from "./request-state";
import { isDemoModeClient } from "../lib/demo-mode";
import { DemoAcquirePlayback } from "./demo-acquire-playback";
import type { DemoAcquisitionEntry } from "../lib/demo-session";
import { useDemoAcquiredTmdbIds } from "../lib/use-demo-session";

export function RequestSeriesButton({
  candidateId,
  storageId,
  demoEntry,
}: {
  candidateId: string;
  /** Tree model: the active workspace drive — acquisition lands HERE. REQUIRED
   *  (value may be undefined = primary) so the workspace is always threaded. */
  storageId: string | undefined;
  /** Demo only: recorded to the session library when the scripted playback ends. */
  demoEntry?: DemoAcquisitionEntry | undefined;
}) {
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<RequestTrackingActionResult | null>(null);
  const isLocked = isLockedResult(result);
  // Read-only demo: clicking plays the scripted playback (the server action is gated).
  const demo = isDemoModeClient();
  const [demoPlaying, setDemoPlaying] = useState(false);
  const acquiredIds = useDemoAcquiredTmdbIds();

  if (demo && demoPlaying) {
    return <DemoAcquirePlayback entry={demoEntry} />;
  }

  if (demo && demoEntry && acquiredIds.has(demoEntry.tmdbId)) {
    return (
      <span className="hub-badge tone-green">
        <Check size={14} aria-hidden />
        已获取
      </span>
    );
  }

  return (
    <button
      className="primary-button series-button"
      type="button"
      title={result?.message ?? "获取全部季"}
      disabled={isPending || isLocked}
      onClick={() => {
        if (demo) {
          setDemoPlaying(true);
          return;
        }
        startTransition(async () => {
          setResult(await requestSeriesAction({ candidateId, storageId }));
        });
      }}
    >
      {isPending || isLocked ? (
        <LoaderCircle size={14} className="spin" aria-hidden />
      ) : (
        <Layers size={14} aria-hidden />
      )}
      {isLocked ? "已请求" : "获取全剧"}
    </button>
  );
}
