import type { ActivityActiveRun } from "./activity-view";

/** Find THIS card's active run: same tmdbId, and `seasonNumber === null` matches
 *  ANY season (movies, and the TV "all remaining seasons" scope), preferring a
 *  running run; a concrete `seasonNumber` matches exactly (a specific-season TV
 *  request, so another season's run isn't shown). */
export function findActiveRun(
  active: ActivityActiveRun[],
  tmdbId: number,
  seasonNumber: number | null,
): ActivityActiveRun | null {
  const matches = active.filter(
    (r) => r.tmdbId === tmdbId && (seasonNumber == null || r.seasonNumber === seasonNumber),
  );
  return matches.find((r) => r.status === "running") ?? matches[0] ?? null;
}

/**
 * Server progress is event-driven: it only advances on a real agent tool call.
 * But the biggest wall-clock costs happen BETWEEN calls — a single `searchResources`
 * can run ~90s (PanSou/Prowlarr + slow model) — so the bar would otherwise sit FROZEN
 * at one value for most of the run, reading as "empty / no progress" (measured: a real
 * movie run spent 94 of 193s frozen at 11% during search).
 *
 * Between server updates the client trickles the bar forward: it eases from the last
 * server percent toward a soft ceiling just above it (decelerating, asymptotic — never
 * reaching), so a long opaque step shows continuous life WITHOUT claiming completion or
 * crossing the next real milestone. The caller anchors on the last server percent and
 * takes max(serverPercent, trickle), rebasing when the server value increases, so the
 * displayed bar is always monotonic (never rewinds). Pure + monotonic in `elapsedMs`.
 */
const TRICKLE_MARGIN = 14; // soft ceiling = serverPercent + this (stays below the next jump)
const TRICKLE_TAU_MS = 32_000; // easing time constant: ~63% of the margin reached by ~32s
export function trickleDisplayPercent(serverPercent: number, elapsedMs: number): number {
  const base = Math.max(0, serverPercent);
  // `Math.max(0, …)` on the span so a base already at/above the 99 cap never yields a
  // negative slope (would trickle BACKWARD); the helper is monotonic for any input.
  const span = Math.max(0, Math.min(99, base + TRICKLE_MARGIN) - base);
  const fraction = 1 - Math.exp(-Math.max(0, elapsedMs) / TRICKLE_TAU_MS);
  return base + span * fraction;
}

/**
 * Per-run trickle state, folded across renders so the DISPLAYED bar is provably
 * monotonic (never rewinds) — even when the server advances in small increments
 * (the trickle can creep past the next polled value; rebasing must not drop below
 * what's already shown). A new `key` (new run) resets the bar to that run's value.
 */
export interface TrickleState {
  anchorPercent: number; // server % the current ease starts from
  anchorAtMs: number; // when that anchor was set
  displayed: number; // last shown % — only ever increases within a run
  key: string; // run identity; a change resets the bar
}

export function initialTrickleState(serverPercent: number, nowMs: number, key: string): TrickleState {
  const p = Math.max(0, serverPercent);
  return { anchorPercent: p, anchorAtMs: nowMs, displayed: p, key };
}

/** One tick/poll: advance the eased value and clamp it monotonic. Pure (takes nowMs). */
export function advanceTrickle(
  state: TrickleState,
  input: { serverPercent: number; nowMs: number; key: string },
): TrickleState {
  // New run → start fresh (bars are per-run; never carry the old run's high value over).
  if (input.key !== state.key) {
    return initialTrickleState(input.serverPercent, input.nowMs, input.key);
  }
  // Rebase the ease anchor only when the server ADVANCES (a real jump like search→
  // transfer eases from the new value); otherwise keep easing from the same anchor.
  let { anchorPercent, anchorAtMs } = state;
  if (input.serverPercent > anchorPercent) {
    anchorPercent = input.serverPercent;
    anchorAtMs = input.nowMs;
  }
  const crept = trickleDisplayPercent(anchorPercent, input.nowMs - anchorAtMs);
  // Monotonic floor: never below what we already showed, nor below the server truth.
  const displayed = Math.max(state.displayed, input.serverPercent, crept);
  return { anchorPercent, anchorAtMs, displayed, key: input.key };
}

/** Derive the inline progress display from the matched run. */
export function inlineProgressView(
  run: ActivityActiveRun | null,
): { running: boolean; percent: number; step: string } {
  const running = run?.status === "running";
  const percent = Math.max(3, Math.min(100, run?.progress?.percent ?? 3));
  // Empty/whitespace activity (?? only guards null/undefined) would render a blank
  // label — treat it as missing and fall back.
  const step = run?.progress?.activity?.trim() || "正在准备…";
  return { running, percent, step };
}
