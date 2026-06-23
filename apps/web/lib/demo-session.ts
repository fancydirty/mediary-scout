import type { ActivityCompletedItem } from "./activity-view";
import { playbackStateAt, DEMO_PLAYBACK_TOTAL_MS } from "./demo-playback-timeline";

export interface DemoAcquisitionEntry {
  tmdbId: number;
  title: string;
  year: number;
  type: "movie" | "tv" | "anime";
  posterPath: string | null;
  /** Wall-clock ms when this acquisition completed. Optional for back-compat /
   *  direct construction; recordDemoAcquisition stamps it so the 通知 NEW badge
   *  can diff it against the last-seen watermark. */
  acquiredAt?: number;
}

const KEY = "mediary-demo-acquired";
const MAX = 20;

/** Fired on the window whenever an acquisition is recorded, so every mounted
 *  surface (search cards, activity, library) refreshes from the session store. */
export const DEMO_ACQUIRED_EVENT = "mediary-demo-acquired";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): StorageLike | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function isEntry(value: unknown): value is DemoAcquisitionEntry {
  if (!value || typeof value !== "object") {
    return false;
  }
  const e = value as Record<string, unknown>;
  return (
    typeof e.tmdbId === "number" &&
    typeof e.title === "string" &&
    typeof e.year === "number" &&
    (e.type === "movie" || e.type === "tv" || e.type === "anime") &&
    (e.posterPath === null || typeof e.posterPath === "string")
  );
}

export function listDemoAcquisitions(
  storage: StorageLike | null = defaultStorage(),
): DemoAcquisitionEntry[] {
  if (!storage) {
    return [];
  }
  try {
    const raw = storage.getItem(KEY);
    if (!raw) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(isEntry);
  } catch {
    return [];
  }
}

export function recordDemoAcquisition(
  entry: DemoAcquisitionEntry,
  storage: StorageLike | null = defaultStorage(),
): DemoAcquisitionEntry[] {
  if (!storage) {
    return [];
  }
  // Read the session list ONCE (untrusted + potentially large), derive both the
  // existing match and the rest from the same snapshot — avoids a double parse and
  // any inconsistency from storage changing between two reads.
  const current = listDemoAcquisitions(storage);
  // Preserve the FIRST acquiredAt: this can be (re)recorded for the same tmdbId by
  // both the playback done-handler and useDemoInProgress's promotion tick. Re-stamping
  // a later time would push createdAt forward and make the 通知 NEW/unread badge
  // wrongly reappear after the user already saw it. Only stamp when truly new.
  const existing = current.find((e) => e.tmdbId === entry.tmdbId);
  const rest = current.filter((e) => e.tmdbId !== entry.tmdbId);
  const stamped: DemoAcquisitionEntry = {
    ...entry,
    // Only a FINITE existing value is worth preserving — a corrupted sessionStorage
    // value (string/NaN/Infinity) is nullish-distinct but useless, so fall through
    // to a fresh finite stamp rather than carrying the garbage forward.
    acquiredAt:
      safeAcquiredAt(entry.acquiredAt) ??
      safeAcquiredAt(existing?.acquiredAt) ??
      (typeof Date !== "undefined" ? Date.now() : 0),
  };
  const next = [stamped, ...rest].slice(0, MAX);
  try {
    storage.setItem(KEY, JSON.stringify(next));
    if (typeof window !== "undefined") {
      try {
        window.dispatchEvent(new Event(DEMO_ACQUIRED_EVENT));
      } catch {
        // no DOM event support — non-fatal
      }
    }
  } catch {
    // storage full / unavailable — best-effort, demo only
  }
  return next;
}

/** Render the session's acquisitions as completed activity items (demo only —
 *  no DB run exists; the activity feed merges these into 已完成). */
export function demoCompletedItems(entries: DemoAcquisitionEntry[]): ActivityCompletedItem[] {
  return entries.map((e) => ({
    workflowRunId: `demo-${e.tmdbId}`,
    title: e.title,
    seasonLabel: null,
    status: "complete",
    posterPath: e.posterPath,
    sizeText: null,
    createdAt: "2026-06-12T08:00:00.000Z",
  }));
}

// ── In-progress overlay (demo only) ───────────────────────────────────────────
// Mirrors the completed-acquisition layer, for acquisitions still PLAYING. An
// entry only stores `startedAt`; the live progress is derived from the clock
// (`now - startedAt` via playbackStateAt), so ANY page that mounts a tick shows
// the real-time 获取中 state without depending on the playback component staying
// mounted — the cross-page parity #3b is about. When the clock passes the total,
// the entry is "done" and gets promoted to the completed layer (+ a notification).

export interface DemoInProgressEntry {
  tmdbId: number;
  title: string;
  year: number;
  type: "movie" | "tv" | "anime";
  posterPath: string | null;
  /** Wall-clock ms when the acquisition playback started. */
  startedAt: number;
}

/** An in-progress entry with its clock-derived progress + step label. */
export interface DemoInProgressActive extends DemoInProgressEntry {
  /** 0–100 progress bar value at `now`. */
  progress: number;
  /** Human step label at `now` (e.g. "转存到网盘…"). */
  step: string;
}

const INPROGRESS_KEY = "mediary-demo-inprogress";

/** Fired on the window whenever the in-progress set changes, so every mounted
 *  surface (library, activity) re-reads and re-ticks. */
export const DEMO_INPROGRESS_EVENT = "mediary-demo-inprogress";

function isInProgressEntry(value: unknown): value is DemoInProgressEntry {
  if (!value || typeof value !== "object") {
    return false;
  }
  const e = value as Record<string, unknown>;
  return (
    typeof e.tmdbId === "number" &&
    typeof e.title === "string" &&
    typeof e.year === "number" &&
    (e.type === "movie" || e.type === "tv" || e.type === "anime") &&
    (e.posterPath === null || typeof e.posterPath === "string") &&
    // Finite, not just `number`: a corrupted NaN/Infinity startedAt would make
    // demoInProgressView's elapsed NaN → entry never promotes → stuck 获取中 row.
    typeof e.startedAt === "number" &&
    Number.isFinite(e.startedAt)
  );
}

export function listDemoInProgress(
  storage: StorageLike | null = defaultStorage(),
): DemoInProgressEntry[] {
  if (!storage) {
    return [];
  }
  try {
    const raw = storage.getItem(INPROGRESS_KEY);
    if (!raw) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(isInProgressEntry);
  } catch {
    return [];
  }
}

function fireInProgress(): void {
  // Dispatched ASYNCHRONOUSLY: useDemoInProgress both listens to this event AND
  // calls clearDemoInProgress() (→ fireInProgress) inside its tick when promoting
  // done items. A synchronous dispatch would re-enter tick() mid-loop (nested
  // recursion). Deferring to a macrotask lets the current call stack unwind first.
  if (typeof window !== "undefined") {
    try {
      window.setTimeout(() => {
        try {
          window.dispatchEvent(new Event(DEMO_INPROGRESS_EVENT));
        } catch {
          // no DOM event support — non-fatal
        }
      }, 0);
    } catch {
      // no timer support — non-fatal
    }
  }
}

export function startDemoInProgress(
  entry: DemoInProgressEntry,
  storage: StorageLike | null = defaultStorage(),
): void {
  if (!storage) {
    return;
  }
  // Cap like the completed layer (MAX): in-progress count is normally tiny, but a
  // bound keeps repeated demo acquisitions from growing sessionStorage unbounded.
  const next = [entry, ...listDemoInProgress(storage).filter((e) => e.tmdbId !== entry.tmdbId)].slice(
    0,
    MAX,
  );
  try {
    storage.setItem(INPROGRESS_KEY, JSON.stringify(next));
    fireInProgress();
  } catch {
    // storage full / unavailable — best-effort, demo only
  }
}

export function clearDemoInProgress(
  tmdbId: number,
  storage: StorageLike | null = defaultStorage(),
): void {
  if (!storage) {
    return;
  }
  try {
    storage.setItem(
      INPROGRESS_KEY,
      JSON.stringify(listDemoInProgress(storage).filter((e) => e.tmdbId !== tmdbId)),
    );
    fireInProgress();
  } catch {
    // best-effort, demo only
  }
}

/** Split the in-progress entries into still-active (with clock-derived progress)
 *  and done (clock passed the playback total). Pure — drives the tick. */
export function demoInProgressView(
  entries: DemoInProgressEntry[],
  now: number,
): { active: DemoInProgressActive[]; done: DemoInProgressEntry[] } {
  const active: DemoInProgressActive[] = [];
  const done: DemoInProgressEntry[] = [];
  for (const e of entries) {
    const elapsed = now - e.startedAt;
    if (elapsed >= DEMO_PLAYBACK_TOTAL_MS) {
      done.push(e);
      continue;
    }
    const state = playbackStateAt(Math.max(0, elapsed));
    active.push({ ...e, progress: state.progress, step: state.label });
  }
  return { active, done };
}

/** Map active in-progress entries to media-library "获取中" placeholder cards. */
export function demoInProgressLibraryCards(active: DemoInProgressActive[]): Array<{
  tmdbId: number;
  title: string;
  year: number;
  type: "movie" | "tv" | "anime";
  posterPath: string | null;
  acquiring: true;
}> {
  return active.map((e) => ({
    tmdbId: e.tmdbId,
    title: e.title,
    year: e.year,
    type: e.type,
    posterPath: e.posterPath,
    acquiring: true as const,
  }));
}

/** Map active in-progress entries to activity-page "获取中" rows (with progress). */
export function demoInProgressActivityItems(active: DemoInProgressActive[]): Array<{
  id: string;
  tmdbId: number;
  title: string;
  year: number;
  type: "movie" | "tv" | "anime";
  posterPath: string | null;
  progress: number;
  step: string;
}> {
  return active.map((e) => ({
    id: `demo-inprogress-${e.tmdbId}`,
    tmdbId: e.tmdbId,
    title: e.title,
    year: e.year,
    type: e.type,
    posterPath: e.posterPath,
    progress: e.progress,
    step: e.step,
  }));
}

/** One demo session notification card (completion). */
export interface DemoSessionNotification {
  id: string;
  tmdbId: number;
  title: string;
  year: number;
  type: "movie" | "tv" | "anime";
  posterPath: string | null;
  kind: "acquired";
  /** ISO string derived from acquiredAt so the 通知 seen-marker can diff it. */
  createdAt: string;
}

/** Fixed fallback for entries lacking acquiredAt (legacy / direct construction). */
const DEMO_NOTIF_FALLBACK_AT = "2026-06-12T08:00:00.000Z";

/** A finite acquiredAt or null — entries come from untrusted sessionStorage, so a
 *  corrupted value (string / NaN / Infinity) must never reach Date()/arithmetic
 *  (`new Date(NaN).toISOString()` throws RangeError, breaking the 通知 page). */
function safeAcquiredAt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Map completed demo acquisitions to 通知-feed session cards, newest first. */
export function demoSessionNotifications(
  completed: DemoAcquisitionEntry[],
): DemoSessionNotification[] {
  return [...completed]
    .sort((a, b) => (safeAcquiredAt(b.acquiredAt) ?? 0) - (safeAcquiredAt(a.acquiredAt) ?? 0))
    .map((e) => {
      const at = safeAcquiredAt(e.acquiredAt);
      return {
        id: `demo-notif-${e.tmdbId}`,
        tmdbId: e.tmdbId,
        title: e.title,
        year: e.year,
        type: e.type,
        posterPath: e.posterPath,
        kind: "acquired" as const,
        createdAt: at != null ? new Date(at).toISOString() : DEMO_NOTIF_FALLBACK_AT,
      };
    });
}
