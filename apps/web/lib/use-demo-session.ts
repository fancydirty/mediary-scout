"use client";

import { useEffect, useState } from "react";
import { isDemoModeClient } from "./demo-mode";
import {
  DEMO_ACQUIRED_EVENT,
  DEMO_INPROGRESS_EVENT,
  clearDemoInProgress,
  demoInProgressView,
  listDemoAcquisitions,
  listDemoInProgress,
  recordDemoAcquisition,
  type DemoAcquisitionEntry,
  type DemoInProgressActive,
} from "./demo-session";

/**
 * Live view of THIS browser session's demo acquisitions. SSR-safe: starts empty
 * (matches the server render), fills on mount, and refreshes when an acquisition
 * is recorded (DEMO_ACQUIRED_EVENT) so every mounted surface stays in sync.
 */
export function useDemoAcquisitions(): DemoAcquisitionEntry[] {
  const [entries, setEntries] = useState<DemoAcquisitionEntry[]>([]);
  useEffect(() => {
    // Real mode (or any non-demo page that mounts a consumer, e.g. ActivityFeed):
    // do NO work — no sessionStorage read, no setState (so no extra render), no
    // listener. The store has no key anyway → zero impact.
    if (!isDemoModeClient()) {
      return;
    }
    const read = () => setEntries(listDemoAcquisitions());
    read();
    window.addEventListener(DEMO_ACQUIRED_EVENT, read);
    return () => window.removeEventListener(DEMO_ACQUIRED_EVENT, read);
  }, []);
  return entries;
}

/** The set of tmdbIds acquired this session — for acquire buttons to show 已获取. */
export function useDemoAcquiredTmdbIds(): Set<number> {
  const entries = useDemoAcquisitions();
  return new Set(entries.map((e) => e.tmdbId));
}

/**
 * Live view of THIS session's IN-PROGRESS demo acquisitions, ticked from the
 * clock so every mounted surface (library, activity) shows real-time 获取中 +
 * progress without depending on the playback component staying mounted. On each
 * tick, any entry whose clock has passed the total is PROMOTED to the completed
 * layer (record + notification) and cleared — a single promotion exit, idempotent
 * with the playback component's own done-record (both dedup by tmdbId), so it's
 * robust whether the user stayed on the page or navigated away mid-playback.
 * SSR-safe: starts empty, fills on mount.
 */
export function useDemoInProgress(): DemoInProgressActive[] {
  const [active, setActive] = useState<DemoInProgressActive[]>([]);
  useEffect(() => {
    // Real mode (or any non-demo page that mounts this hook, e.g. ActivityFeed):
    // do NO work — no interval, no re-renders. sessionStorage has no key anyway.
    if (!isDemoModeClient()) {
      return;
    }
    // Only re-render when the active set actually changes — the 500ms tick reads
    // + diffs cheaply, but skips setState when nothing moved, so an idle demo page
    // doesn't re-render twice a second.
    let prevSig = "";
    const tick = () => {
      const view = demoInProgressView(listDemoInProgress(), Date.now());
      for (const d of view.done) {
        recordDemoAcquisition({
          tmdbId: d.tmdbId,
          title: d.title,
          year: d.year,
          type: d.type,
          posterPath: d.posterPath,
        });
        clearDemoInProgress(d.tmdbId);
      }
      const sig = view.active.map((a) => `${a.tmdbId}:${a.progress}:${a.step}`).join("|");
      if (sig !== prevSig) {
        prevSig = sig;
        setActive(view.active);
      }
    };
    tick();
    const id = window.setInterval(tick, 500);
    window.addEventListener(DEMO_INPROGRESS_EVENT, tick);
    return () => {
      window.clearInterval(id);
      window.removeEventListener(DEMO_INPROGRESS_EVENT, tick);
    };
  }, []);
  return active;
}
