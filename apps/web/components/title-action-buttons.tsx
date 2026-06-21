"use client";

import { Check, DownloadCloud, Layers, LoaderCircle } from "lucide-react";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  requestRemainingAction,
  requestSeasonAction,
  type RequestTrackingActionResult,
} from "../app/actions";
import { useAcquisitionLock } from "./acquisition-lock";
import { isLockedResult } from "./request-state";
import { isDemoModeClient } from "../lib/demo-mode";
import { DemoAcquirePlayback } from "./demo-acquire-playback";
import type { DemoAcquisitionEntry } from "../lib/demo-session";
import { useDemoAcquiredTmdbIds } from "../lib/use-demo-session";

export function RequestSeasonButton({
  tmdbId,
  seasonNumber,
  storageId,
  titleAcquiring = false,
  demoEntry,
}: {
  tmdbId: number;
  seasonNumber: number;
  /** Tree model: the active workspace drive — acquisition lands HERE. REQUIRED
   *  (value may be undefined = primary) so the workspace is always threaded. */
  storageId: string | undefined;
  /** Server truth: this title already has an acquisition run in flight. */
  titleAcquiring?: boolean;
  /** Demo only: recorded to the session library when the scripted playback ends. */
  demoEntry?: DemoAcquisitionEntry | undefined;
}) {
  const router = useRouter();
  const lock = useAcquisitionLock();
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<RequestTrackingActionResult | null>(null);
  const scope = `season-${seasonNumber}`;
  const isLocked = isLockedResult(result);
  const mine = lock?.acquiring === scope;
  const othersAcquiring = (lock != null && lock.acquiring != null && !mine) || titleAcquiring;
  const inFlight = isPending || mine;
  const demo = isDemoModeClient();
  const [demoPlaying, setDemoPlaying] = useState(false);
  const acquiredIds = useDemoAcquiredTmdbIds();

  if (demo && demoPlaying) {
    return <DemoAcquirePlayback entry={demoEntry} />;
  }

  if (demo && acquiredIds.has(tmdbId)) {
    return (
      <span className="hub-badge tone-green">
        <Check size={13} aria-hidden />
        已获取
      </span>
    );
  }

  return (
    <button
      className="season-request-button"
      type="button"
      title={
        othersAcquiring && !inFlight ? "该剧正在获取中，请稍候" : result?.message ?? `获取第 ${seasonNumber} 季`
      }
      disabled={isPending || isLocked || othersAcquiring}
      onClick={() => {
        if (demo) {
          setDemoPlaying(true);
          return;
        }
        lock?.lock(scope);
        startTransition(async () => {
          setResult(await requestSeasonAction({ tmdbId, seasonNumber, storageId }));
          router.refresh();
        });
      }}
    >
      {inFlight ? (
        <LoaderCircle size={13} className="spin" aria-hidden />
      ) : isLocked ? (
        <Check size={13} aria-hidden />
      ) : (
        <DownloadCloud size={13} aria-hidden />
      )}
      {inFlight ? "获取中" : isLocked ? "已请求" : "获取本季"}
    </button>
  );
}

export function RequestRemainingButton({
  tmdbId,
  label,
  storageId,
  titleAcquiring = false,
  demoEntry,
}: {
  tmdbId: number;
  label: string;
  /** Tree model: the active workspace drive — acquisition lands HERE. REQUIRED
   *  (value may be undefined = primary) so the workspace is always threaded. */
  storageId: string | undefined;
  /** Server truth: this title already has an acquisition run in flight. */
  titleAcquiring?: boolean;
  /** Demo only: recorded to the session library when the scripted playback ends. */
  demoEntry?: DemoAcquisitionEntry | undefined;
}) {
  const router = useRouter();
  const lock = useAcquisitionLock();
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<RequestTrackingActionResult | null>(null);
  const scope = "remaining";
  const isLocked = isLockedResult(result);
  const mine = lock?.acquiring === scope;
  const othersAcquiring = (lock != null && lock.acquiring != null && !mine) || titleAcquiring;
  const inFlight = isPending || mine;
  const demo = isDemoModeClient();
  const [demoPlaying, setDemoPlaying] = useState(false);
  const acquiredIds = useDemoAcquiredTmdbIds();

  if (demo && demoPlaying) {
    return <DemoAcquirePlayback entry={demoEntry} />;
  }

  if (demo && acquiredIds.has(tmdbId)) {
    return (
      <span className="hub-badge tone-green">
        <Check size={13} aria-hidden />
        已获取
      </span>
    );
  }

  return (
    <button
      className="primary-button"
      type="button"
      title={othersAcquiring && !inFlight ? "该剧正在获取中，请稍候" : result?.message ?? label}
      disabled={isPending || isLocked || othersAcquiring}
      onClick={() => {
        if (demo) {
          setDemoPlaying(true);
          return;
        }
        lock?.lock(scope);
        startTransition(async () => {
          setResult(await requestRemainingAction({ tmdbId, storageId }));
          router.refresh();
        });
      }}
    >
      {inFlight ? (
        <LoaderCircle size={14} className="spin" aria-hidden />
      ) : isLocked ? (
        <Check size={14} aria-hidden />
      ) : (
        <Layers size={14} aria-hidden />
      )}
      {inFlight ? "获取中" : isLocked ? "已请求" : label}
    </button>
  );
}
