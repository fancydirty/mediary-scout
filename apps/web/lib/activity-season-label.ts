// Client-safe, pure season-label helpers. This module MUST have ZERO runtime
// imports — only `import type` — so it can be value-imported from a "use client"
// component without dragging the server runtime (and transitively the `pg`
// Postgres driver) into the browser bundle. `activity-view.ts` re-exports these
// for server-side callers; the activity-feed client component imports them here.
import type { EpisodeState, MediaType } from "@media-track/workflow";

/**
 * Distinct, sorted (numeric) season numbers present in an episode set, derived
 * from each episode's `SxxExx` code (EpisodeState carries no explicit season).
 * A whole-show ("全季") run has episodes across many seasons even though its
 * `season.seasonNumber` is a single placeholder → this exposes the real span.
 * Pure + defensive: episodes with an unparseable code are skipped.
 */
export function distinctSeasons(episodes: readonly EpisodeState[]): number[] {
  const seasons = new Set<number>();
  for (const episode of episodes) {
    const match = /^S(\d{2,})E\d{2,}$/.exec(episode.episodeCode);
    if (match) {
      seasons.add(Number(match[1]));
    }
  }
  return Array.from(seasons).sort((a, b) => a - b);
}

/**
 * The season label for an active-run card. Movies and season-less runs → "".
 * One season → "第 N 季"; several → "第 1/2/3/4 季". Prefers the covered-season
 * list; falls back to the single `seasonNumber` when the list is empty. Pure.
 */
export function seasonLabelText(
  type: MediaType,
  seasonNumbers: readonly number[],
  seasonNumber: number | null,
): string {
  if (type === "movie") {
    return "";
  }
  const seasons = seasonNumbers.length > 0 ? seasonNumbers : seasonNumber === null ? [] : [seasonNumber];
  if (seasons.length === 0) {
    return "";
  }
  return `第 ${seasons.join("/")} 季`;
}
