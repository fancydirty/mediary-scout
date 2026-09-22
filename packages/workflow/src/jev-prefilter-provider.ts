// packages/workflow/src/jev-prefilter-provider.ts
import type { ResourceCandidate, ResourceSnapshot, SnapshotPrefilter } from "./domain.js";
import type { ResourceProvider } from "./ports.js";
import { JEV_MODEL, JEV_THRESHOLDS, classifyJevScore, normalizedTargetNames, titleContainsAny, type JevJudge, type JevJudgeTarget } from "./jev-judge.js";

export interface JevPrefilterProviderOptions {
  inner: ResourceProvider;
  target: JevJudgeTarget;
  judge: JevJudge;
  /** Injectable clock for durationMs (tests). */
  now?: () => number;
  log?: (line: string) => void;
  /** Consecutive judge failures after which this provider stops calling the judge for
   *  the rest of its life. Default JEV_CIRCUIT_BREAKER_FAILURES. */
  maxConsecutiveFailures?: number;
}

/** A judge that has failed this many times in a row is treated as down for the rest of
 *  the run. Two, not one: a single timeout is ordinary (p90 0.9s against an 8s ceiling)
 *  and re-arming on the next search is cheap; two in a row is an outage, and the agent
 *  searches many times per run — each one would otherwise pay the full timeout for a
 *  result that is fail-open anyway. */
export const JEV_CIRCUIT_BREAKER_FAILURES = 2;

/** True for candidates whose "title" carries no judgeable text (a date row, a bare
 *  URL, empty). The agent picks these via their link; judging the title would only
 *  ever drop them — all 10 false rejects in the 9,968-candidate eval were this shape. */
export function isTitleless(title: string): boolean {
  const t = title.trim();
  return t === "" || t.startsWith("📅") || /^https?:\/\//i.test(t);
}

/**
 * Pre-agent candidate filter backed by a Jev judge. Wraps ANY ResourceProvider so
 * both the system pre-warm search and the agent's searchResources are filtered.
 *
 * Guarantees:
 *  - judge error/timeout → snapshot returned untouched, status "failed" (fail-open);
 *  - after JEV_CIRCUIT_BREAKER_FAILURES consecutive judge failures the judge is not
 *    called again by this instance (same fail-open shape, reason "circuit-open: …");
 *  - nothing judgeable (all title-less) → judge not called, status "skipped";
 *  - inner.search() errors PROPAGATE, logged by error name only (source health is
 *    classified one layer down; masking a provider outage here would hide real incidents);
 *  - title-less candidates (empty / 📅 / http…) are never judged and never dropped,
 *    even if the judge returns a score for them;
 *  - a candidate whose title contains the target title/alias verbatim is never dropped,
 *    only flagged (see titleContainsAny) — recorded in prefilter.floored;
 *  - ids, index, order, sourceHealth, keyword and snapshot id are untouched.
 */
export class JevPrefilterProvider implements ResourceProvider {
  private readonly inner: ResourceProvider;
  private readonly target: JevJudgeTarget;
  /** The target's names, normalised once per provider rather than per candidate. */
  private readonly targetNames: string[];
  private readonly judge: JevJudge;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly maxConsecutiveFailures: number;
  /** Per instance = per acquisition run: a down judge stops costing this run a timeout
   *  per search, and the next run starts with the circuit closed (no global state). */
  private consecutiveFailures = 0;

  constructor(options: JevPrefilterProviderOptions) {
    this.inner = options.inner;
    this.target = options.target;
    this.targetNames = normalizedTargetNames(options.target);
    this.judge = options.judge;
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? ((line) => console.log(line));
    this.maxConsecutiveFailures = options.maxConsecutiveFailures ?? JEV_CIRCUIT_BREAKER_FAILURES;
  }

  async search(input: { keyword: string; workflowRunId?: string }): Promise<ResourceSnapshot> {
    let snapshot: ResourceSnapshot;
    try {
      snapshot = await this.inner.search(input);
    } catch (error) {
      // Rethrown untouched (see Guarantees), but not silently. The error's NAME only:
      // undici quotes an invalid header VALUE in its message, and Prowlarr's key travels
      // in the X-Api-Key header, so the message is not something to put in a log.
      const name = error instanceof Error ? error.name : typeof error;
      this.log(`[jev-prefilter] ${JSON.stringify(input.keyword)} source search failed (${name}) — judge not called, error rethrown`);
      throw error;
    }
    // Every search leaves one [jev-prefilter] line — these two, and a source failure
    // above — so the audit trail can tell "the judge was not needed" from "nothing was logged".
    if (snapshot.candidates.length === 0) {
      this.log(`[jev-prefilter] ${JSON.stringify(input.keyword)} skipped: 0 candidates`);
      return snapshot;
    }
    const judgeable = snapshot.candidates.filter((c) => !isTitleless(c.title));
    const thresholds = JEV_THRESHOLDS;
    if (judgeable.length === 0) {
      // Nothing to judge (every candidate is title-less): not attempted, nothing dropped.
      // Outside the try: it cannot throw, so a "skipped" here is never a masked failure.
      this.log(`[jev-prefilter] ${JSON.stringify(input.keyword)} skipped: no judgeable candidates (${snapshot.candidates.length} title-less)`);
      return { ...snapshot, prefilter: { provider: "jev", model: JEV_MODEL, status: "skipped", reason: "no judgeable candidates", scores: {}, dropped: [], thresholds, durationMs: 0 } };
    }
    // Circuit breaker. Checked after the "nothing judgeable" branch so that case keeps
    // its more precise reason (the judge would not have been called either way).
    // Same fail-open shape as a real failure — the snapshot is returned untouched — so
    // an open circuit can never be the thing that drops a candidate.
    if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
      const reason = `circuit-open: ${this.consecutiveFailures} consecutive judge failures`;
      this.log(`[jev-prefilter] ${JSON.stringify(input.keyword)} circuit open (${this.consecutiveFailures} consecutive failures) — skipping judge for the rest of this run`);
      return { ...snapshot, prefilter: { provider: "jev", model: JEV_MODEL, status: "failed", reason, scores: {}, dropped: [], thresholds, durationMs: 0 } };
    }
    // The title-less guarantee is enforced by this set, not by the judge behaving: an
    // answer for a candidate we never asked about (bug, or a title that prompt-injected
    // the judge into scoring its neighbours) can never drop anything.
    const judgeableIds = new Set(judgeable.map((c) => c.id));
    const t0 = this.now();
    let prefilter: SnapshotPrefilter;
    let kept: ResourceCandidate[];
    try {
      const result = await this.judge.judgeCandidates({ target: this.target, candidates: judgeable.map((c) => ({ id: c.id, title: c.title })) });
      // CONSECUTIVE failures only: an answer — even a partial one (failedChunks) — proves
      // the judge is reachable, so a flaky one never accumulates its way to an open circuit.
      this.consecutiveFailures = 0;
      const dropped: SnapshotPrefilter["dropped"] = [];
      const floored: NonNullable<SnapshotPrefilter["floored"]> = [];
      // Named for what the agent sees (a ⚠ on the row), not for one band: it counts the
      // uncertain band AND the sub-threshold rows the containment floor kept.
      let flagged = 0;
      kept = snapshot.candidates.filter((c) => {
        const score = judgeableIds.has(c.id) ? result.scores[c.id] : undefined;
        if (score === undefined) return true; // unjudged (title-less or missing) → keep
        const band = classifyJevScore(score);
        if (band === "drop") {
          // Containment floor: a title that carries the target's own name verbatim is
          // kept whatever the score says. The judge is right that 《权利交锋》 is another
          // work — and wrong about this row, which was an uploader mislabel of 《交锋》
          // and the pack the agent actually selected. The score is NOT rewritten: the
          // row reaches the agent flagged 相关度存疑(0.04) and the agent decides.
          if (titleContainsAny(c.title, this.targetNames)) { floored.push({ id: c.id, title: c.title, score }); flagged += 1; return true; }
          dropped.push({ id: c.id, title: c.title, score });
          return false;
        }
        if (band === "uncertain") flagged += 1;
        return true;
      });
      // Audit trail mirrors what was applied: scores for ids we actually asked about.
      const scores = Object.fromEntries(Object.entries(result.scores).filter(([id]) => judgeableIds.has(id)));
      const failedChunks = typeof result.failedChunks === "number" && result.failedChunks > 0 ? result.failedChunks : 0;
      prefilter = {
        provider: "jev", model: result.model, status: "applied", scores, dropped, thresholds,
        durationMs: this.now() - t0,
        ...(floored.length === 0 ? {} : { floored }),
        // Still "applied" — the chunks that answered were applied — but a dedicated
        // field records that the filter saw less than everything, so a thin drop list is
        // explainable later without overloading `reason` (which means "why not applied").
        ...(failedChunks === 0 ? {} : { failedChunks }),
        ...(result.inputTokens === undefined ? {} : { inputTokens: result.inputTokens }),
        ...(result.cost === undefined ? {} : { cost: result.cost }),
      };
      // A batch where the floor carried half the judged rows is a wording regression in
      // disguise — the judge stopped recognising the target and only containment saved
      // it. The drop rate alone cannot show that, so it is spelled out when it happens.
      // judgeable.length > 0 here: the empty case returned "skipped" above.
      const floorRate = floored.length / judgeable.length;
      this.log(`[jev-prefilter] ${JSON.stringify(input.keyword)} kept=${kept.length} dropped=${dropped.length} flagged=${flagged} ms=${prefilter.durationMs}${result.inputTokens === undefined ? "" : ` tok=${result.inputTokens}`}${floored.length === 0 ? "" : ` floored=${floored.length}`}${failedChunks === 0 ? "" : ` failedChunks=${failedChunks}`}${floorRate < 0.5 ? "" : ` floorRate=${Math.round(floorRate * 100)}%`}`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.consecutiveFailures += 1;
      kept = snapshot.candidates;
      prefilter = { provider: "jev", model: JEV_MODEL, status: "failed", reason, scores: {}, dropped: [], thresholds, durationMs: this.now() - t0 };
      this.log(`[jev-prefilter] ${JSON.stringify(input.keyword)} FAILED (fail-open, nothing dropped): ${reason}`);
    }
    return { ...snapshot, candidates: kept, prefilter };
  }
}
