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
 * Guarantees: fail-open on every error (snapshot returned untouched, status
 * "skipped"), title-less candidates never judged, ids/index/order untouched
 * (registry and transfer resolve by id), sourceHealth/keyword/id passed through.
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
    const t0 = this.now();
    const thresholds = JEV_THRESHOLDS;
    let prefilter: SnapshotPrefilter;
    let kept: ResourceCandidate[];
    try {
      if (judgeable.length === 0) {
        // Nothing to judge (every candidate is title-less): not attempted, nothing dropped.
        return { ...snapshot, prefilter: { provider: "jev", model: "jev-latest", status: "skipped", reason: "no judgeable candidates", scores: {}, dropped: [], thresholds, durationMs: 0 } };
      }
      const result = await this.judge.judgeCandidates({ target: this.target, candidates: judgeable.map((c) => ({ id: c.id, title: c.title })) });
      const dropped: SnapshotPrefilter["dropped"] = [];
      kept = snapshot.candidates.filter((c) => {
        const score = result.scores[c.id];
        if (score === undefined) return true; // unjudged (title-less or missing) → keep
        if (classifyJevScore(score) === "drop") { dropped.push({ id: c.id, title: c.title, score }); return false; }
        return true;
      });
      const uncertain = kept.filter((c) => { const s = result.scores[c.id]; return s !== undefined && classifyJevScore(s) === "uncertain"; }).length;
      prefilter = {
        provider: "jev", model: result.model, status: "applied", scores: result.scores, dropped, thresholds,
        durationMs: this.now() - t0,
        ...(result.inputTokens === undefined ? {} : { inputTokens: result.inputTokens }),
        ...(result.cost === undefined ? {} : { cost: result.cost }),
      };
      this.log(`[jev-prefilter] ${JSON.stringify(input.keyword)} kept=${kept.length} dropped=${dropped.length} uncertain=${uncertain} ms=${prefilter.durationMs}${result.inputTokens === undefined ? "" : ` tok=${result.inputTokens}`}`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      kept = snapshot.candidates;
      prefilter = { provider: "jev", model: "jev-latest", status: "failed", reason, scores: {}, dropped: [], thresholds, durationMs: this.now() - t0 };
      this.log(`[jev-prefilter] ${JSON.stringify(input.keyword)} FAILED (fail-open, nothing dropped): ${reason}`);
    }
    return { ...snapshot, candidates: kept, prefilter };
  }
}
