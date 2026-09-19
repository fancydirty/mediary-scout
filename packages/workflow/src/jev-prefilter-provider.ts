// packages/workflow/src/jev-prefilter-provider.ts
import type { ResourceCandidate, ResourceSnapshot, SnapshotPrefilter } from "./domain.js";
import type { ResourceProvider } from "./ports.js";
import { JEV_THRESHOLDS, classifyJevScore, type JevJudge, type JevJudgeTarget } from "./jev-judge.js";

export interface JevPrefilterProviderOptions {
  inner: ResourceProvider;
  target: JevJudgeTarget;
  judge: JevJudge;
  /** Injectable clock for durationMs (tests). */
  now?: () => number;
  log?: (line: string) => void;
}

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
 *  - nothing judgeable (all title-less) → judge not called, status "skipped";
 *  - inner.search() errors PROPAGATE (source health is classified one layer down;
 *    masking a provider outage here would hide real incidents);
 *  - title-less candidates (empty / 📅 / http…) are never judged and never dropped,
 *    even if the judge returns a score for them;
 *  - ids, index, order, sourceHealth, keyword and snapshot id are untouched.
 */
export class JevPrefilterProvider implements ResourceProvider {
  private readonly inner: ResourceProvider;
  private readonly target: JevJudgeTarget;
  private readonly judge: JevJudge;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(options: JevPrefilterProviderOptions) {
    this.inner = options.inner;
    this.target = options.target;
    this.judge = options.judge;
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? ((line) => console.log(line));
  }

  async search(input: { keyword: string; workflowRunId?: string }): Promise<ResourceSnapshot> {
    const snapshot = await this.inner.search(input);
    if (snapshot.candidates.length === 0) return snapshot;
    const judgeable = snapshot.candidates.filter((c) => !isTitleless(c.title));
    const thresholds = JEV_THRESHOLDS;
    if (judgeable.length === 0) {
      // Nothing to judge (every candidate is title-less): not attempted, nothing dropped.
      // Outside the try: it cannot throw, so a "skipped" here is never a masked failure.
      return { ...snapshot, prefilter: { provider: "jev", model: "jev-latest", status: "skipped", reason: "no judgeable candidates", scores: {}, dropped: [], thresholds, durationMs: 0 } };
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
      const dropped: SnapshotPrefilter["dropped"] = [];
      let uncertain = 0;
      kept = snapshot.candidates.filter((c) => {
        const score = judgeableIds.has(c.id) ? result.scores[c.id] : undefined;
        if (score === undefined) return true; // unjudged (title-less or missing) → keep
        const band = classifyJevScore(score);
        if (band === "drop") { dropped.push({ id: c.id, title: c.title, score }); return false; }
        if (band === "uncertain") uncertain += 1;
        return true;
      });
      // Audit trail mirrors what was applied: scores for ids we actually asked about.
      const scores = Object.fromEntries(Object.entries(result.scores).filter(([id]) => judgeableIds.has(id)));
      const failedChunks = typeof result.failedChunks === "number" && result.failedChunks > 0 ? result.failedChunks : 0;
      prefilter = {
        provider: "jev", model: result.model, status: "applied", scores, dropped, thresholds,
        durationMs: this.now() - t0,
        // Still "applied" — the chunks that answered were applied — but a dedicated
        // field records that the filter saw less than everything, so a thin drop list is
        // explainable later without overloading `reason` (which means "why not applied").
        ...(failedChunks === 0 ? {} : { failedChunks }),
        ...(result.inputTokens === undefined ? {} : { inputTokens: result.inputTokens }),
        ...(result.cost === undefined ? {} : { cost: result.cost }),
      };
      this.log(`[jev-prefilter] ${JSON.stringify(input.keyword)} kept=${kept.length} dropped=${dropped.length} uncertain=${uncertain} ms=${prefilter.durationMs}${result.inputTokens === undefined ? "" : ` tok=${result.inputTokens}`}${failedChunks === 0 ? "" : ` failedChunks=${failedChunks}`}`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      kept = snapshot.candidates;
      prefilter = { provider: "jev", model: "jev-latest", status: "failed", reason, scores: {}, dropped: [], thresholds, durationMs: this.now() - t0 };
      this.log(`[jev-prefilter] ${JSON.stringify(input.keyword)} FAILED (fail-open, nothing dropped): ${reason}`);
    }
    return { ...snapshot, candidates: kept, prefilter };
  }
}
