/**
 * Trim a set of selected resource candidates to the fewest that still cover the
 * union of episodes the selection intended to grab.
 *
 * WHY this exists (a real 115 risk-control failure): the AcquisitionPlanningAgent
 * is told "compose overlapping ranges — overlap is safe, the workflow dedups
 * afterwards." That premise is FALSE for the storage layer: every selected
 * candidate is transferred to its own staging dir (receiveShare + recursive
 * collectVideos + per-file moveItems) BEFORE any dedup runs. A freshly finished
 * 12-episode show was observed selecting ~11 overlapping complete packs, whose
 * cumulative 115 API calls blew the per-operation budget guard
 * (PAN115_RATE_LIMIT, maxCallsPerOperation) and failed the whole acquisition.
 *
 * Dedup-after-transfer cannot help — the budget is spent on the transfers
 * themselves. So we trim BEFORE transferring, deterministically (the model
 * cannot be trusted to stop over-selecting), keeping coverage intact:
 *  - "needed" = the union of every episode any selected candidate covers
 *    (aired-missing AND provider-ahead), so no intended episode is dropped.
 *  - greedy set cover: repeatedly keep the candidate adding the most
 *    still-uncovered needed episodes; stop when all are covered.
 *  - a candidate that adds no new coverage (a pure subset / duplicate pack) is
 *    dropped — that redundancy is exactly what blows the budget.
 *
 * Lost redundancy (a backup copy if one transfer fails) is recoverable: a failed
 * pass records failure evidence and the next planning pass picks alternates. An
 * exhausted 115 budget is NOT recoverable mid-run — it fails everything.
 */
export function trimToMinimalCoveringCandidates<T extends { episodes: string[] }>(
  candidates: T[],
): T[] {
  const needed = new Set(candidates.flatMap((candidate) => candidate.episodes));
  const covered = new Set<string>();
  const chosen = new Set<T>();
  const remaining = [...candidates];

  while (covered.size < needed.size) {
    let best: T | undefined;
    let bestGain = 0;
    for (const candidate of remaining) {
      const gain = candidate.episodes.filter(
        (code) => needed.has(code) && !covered.has(code),
      ).length;
      if (gain > bestGain) {
        bestGain = gain;
        best = candidate;
      }
    }
    if (best === undefined || bestGain === 0) {
      break; // no remaining candidate adds coverage
    }
    chosen.add(best);
    remaining.splice(remaining.indexOf(best), 1);
    for (const code of best.episodes) {
      if (needed.has(code)) {
        covered.add(code);
      }
    }
  }

  // Preserve the agent's original ordering among the kept candidates.
  return candidates.filter((candidate) => chosen.has(candidate));
}
