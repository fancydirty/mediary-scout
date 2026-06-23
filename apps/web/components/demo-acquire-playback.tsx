"use client";

import { useEffect, useRef, useState } from "react";
import { Check, LoaderCircle } from "lucide-react";
import { playbackStateAt, DEMO_PLAYBACK_TOTAL_MS } from "../lib/demo-playback-timeline";
import {
  clearDemoInProgress,
  recordDemoAcquisition,
  startDemoInProgress,
  type DemoAcquisitionEntry,
} from "../lib/demo-session";

/**
 * Read-only demo: a scripted, client-only playback of an agent acquisition. Drives
 * a progress bar + action ticker from the canned timeline — NO network request, no
 * DB write — so multiple visitors never collide and nothing persists.
 */
export function DemoAcquirePlayback({ entry }: { entry?: DemoAcquisitionEntry | undefined }) {
  const [elapsed, setElapsed] = useState(0);
  const recorded = useRef(false);
  // Keyed on entry.tmdbId so a new acquisition (entry change) resets the timer +
  // the recorded guard and re-announces in-progress, instead of staying stuck on
  // the previous title's playback.
  useEffect(() => {
    recorded.current = false;
    setElapsed(0);
    // Announce this acquisition as in-progress so OTHER pages (media library,
    // activity) show a real-time 获取中 card/row, clock-driven from startedAt —
    // not just this local progress bar. Completion promotion is handled by
    // useDemoInProgress's tick when navigated away, or by the done-record below
    // when this component stays mounted (both dedup by tmdbId → safe either way).
    if (entry) {
      startDemoInProgress({
        tmdbId: entry.tmdbId,
        title: entry.title,
        year: entry.year,
        type: entry.type,
        posterPath: entry.posterPath,
        startedAt: Date.now(),
      });
    }
    const start = Date.now();
    const id = setInterval(() => {
      const t = Date.now() - start;
      setElapsed(t);
      if (t >= DEMO_PLAYBACK_TOTAL_MS) {
        clearInterval(id);
      }
    }, 400);
    return () => clearInterval(id);
  }, [entry?.tmdbId]);

  const state = playbackStateAt(elapsed);
  const done = state.progress >= 100;

  useEffect(() => {
    if (done && entry && !recorded.current) {
      recorded.current = true;
      recordDemoAcquisition(entry);
      clearDemoInProgress(entry.tmdbId);
    }
  }, [done, entry]);

  return (
    <div className="demo-playback" role="status" aria-live="polite">
      <div className="demo-playback-bar">
        <div className="demo-playback-fill" style={{ width: `${state.progress}%` }} />
      </div>
      <div className="demo-playback-step">
        {done ? <Check size={14} aria-hidden /> : <LoaderCircle size={14} className="spin" aria-hidden />}
        <span>{state.label}</span>
      </div>
      {done ? <p className="demo-playback-note">已加入媒体库 · 仅本次演示</p> : null}
    </div>
  );
}
