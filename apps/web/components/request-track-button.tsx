"use client";

import { CalendarClock, Check, LoaderCircle, Plus } from "lucide-react";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { requestTrackingAction, type RequestTrackingActionResult } from "../app/actions";
import type { SearchActionState } from "@media-track/workflow";
import { RequestedBadge } from "./request-state";
import { isDemoModeClient } from "../lib/demo-mode";
import { DemoAcquirePlayback } from "./demo-acquire-playback";
import type { DemoAcquisitionEntry } from "../lib/demo-session";
import { useDemoAcquiredTmdbIds } from "../lib/use-demo-session";

/**
 * Acquire control for a movie candidate. Visual states, kept consistent with
 * SeasonRequestMenu / RequestSeriesButton:
 *  - requestable → a green "获取" pill;
 *  - reservable (an UNRELEASED film) → a "预定" pill; clicking reserves it so the
 *    daily patrol acquires it the moment it releases;
 *  - reserved → a "已预定" clock badge (tracked, waiting for release);
 *  - in progress (just requested, or an active workflow) → a spinning "已请求"
 *    badge (a spinner, not a checkmark — it is NOT done yet);
 *  - settled (already acquired / still tracked) → a "已获取" / "已追踪" badge.
 */
export function RequestTrackButton({
  candidateId,
  actionState = "can_request",
  label = "获取",
  disabled = false,
  storageId,
  demoEntry,
}: {
  candidateId?: string;
  actionState?: SearchActionState;
  label?: string;
  disabled?: boolean;
  /** Tree model: the active workspace drive — acquisition lands HERE, not the primary. */
  storageId?: string | undefined;
  /** Demo only: the candidate's display fields, recorded to the session library
   *  when the scripted playback finishes so the visitor sees it "land". */
  demoEntry?: DemoAcquisitionEntry;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<RequestTrackingActionResult | null>(null);
  // Read-only demo: clicking 获取 plays a scripted, client-only acquisition (no
  // server action, which is gated server-side anyway).
  const demo = isDemoModeClient();
  const [demoPlaying, setDemoPlaying] = useState(false);
  const acquiredIds = useDemoAcquiredTmdbIds();

  // Once the SERVER reports the run finished (already_tracked), the optimistic
  // "已请求" from the click must release — otherwise the AcquiringPoller refreshes
  // actionState but the button stays stuck on "已请求" until a manual reload.
  // NOTE: only already_tracked counts as done — active_workflow also sets
  // `disabled`, so we must NOT treat disabled as settled or an in-flight run
  // would wrongly show the green "done" badge.
  // Reserved (未上映, 已预定) — tracked, waiting for release. Distinct from settled:
  // it is NOT acquired, so it is a clock badge, never the green "done" checkmark.
  const reserved = actionState === "reserved" || result?.status === "reserved";
  const inProgress =
    !reserved &&
    actionState !== "already_tracked" &&
    (result?.status === "requested" ||
      result?.status === "active_workflow" ||
      actionState === "active_workflow");
  const settled =
    !inProgress &&
    !reserved &&
    (disabled || actionState === "already_tracked" || result?.status === "already_tracked");

  if (demo && demoPlaying) {
    return <DemoAcquirePlayback entry={demoEntry} />;
  }

  if (demo && demoEntry && acquiredIds.has(demoEntry.tmdbId)) {
    return (
      <span className="hub-badge tone-green">
        <Check size={12} aria-hidden />
        已获取
      </span>
    );
  }

  if (inProgress) {
    return <RequestedBadge title={result?.message} storageId={storageId} />;
  }

  if (reserved) {
    return (
      <span className="hub-badge tone-amber" title={result?.message}>
        <CalendarClock size={12} aria-hidden />
        已预定
      </span>
    );
  }

  if (settled) {
    return (
      <span className="hub-badge tone-green">
        <Check size={12} aria-hidden />
        {label}
      </span>
    );
  }

  return (
    <div className="request-track">
      <button
        className="primary-button"
        type="button"
        disabled={isPending}
        onClick={() => {
          if (demo) {
            setDemoPlaying(true);
            return;
          }
          startTransition(async () => {
            setResult(
              await requestTrackingAction({
                ...(candidateId ? { candidateId } : {}),
                currentState: actionState,
                ...(storageId ? { storageId } : {}),
              }),
            );
            // Re-fetch so the now-queued run mounts the AcquiringPoller, which
            // then flips this card to 已获取 when the run finishes.
            router.refresh();
          });
        }}
      >
        {isPending ? (
          <LoaderCircle size={16} className="spin" aria-hidden />
        ) : actionState === "can_reserve" ? (
          <CalendarClock size={16} aria-hidden />
        ) : (
          <Plus size={16} aria-hidden />
        )}
        {isPending ? (actionState === "can_reserve" ? "预定中" : "请求中") : label}
      </button>
      {/* A non-queued result (e.g. unsupported / failed) fell through to the
          requestable button — surface its reason instead of swallowing it. */}
      {result ? <p className="request-result">{result.message}</p> : null}
    </div>
  );
}
