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
  const ceiling = Math.min(99, base + TRICKLE_MARGIN);
  const fraction = 1 - Math.exp(-Math.max(0, elapsedMs) / TRICKLE_TAU_MS);
  return base + (ceiling - base) * fraction;
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
