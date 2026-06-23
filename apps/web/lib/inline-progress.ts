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
