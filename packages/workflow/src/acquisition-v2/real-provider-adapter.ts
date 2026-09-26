import type { ResourceSnapshot } from "../domain.js";
import type { ResourceProvider } from "../ports.js";
import type { CandidateRegistry } from "./candidate-registry.js";
import { deadLinkKey, type DeadLinkStore } from "./dead-links.js";
import type { ResourceProviderV2, ResourceSnapshotV2 } from "./fake-provider.js";

/**
 * Phase 6 — the real PanSou provider as a ResourceProviderV2. It runs the real
 * search, records each candidate's full payload in the shared registry (so the
 * storage adapter can transfer by id), and hands the agent only the V2 view:
 * id/title — never the raw url or provider index.
 *
 * The ids the agent sees are short run-local aliases (snapshot `s2`, candidate
 * `s2-14`), not the provider's `pansou_<runId>_<hash>_candidate_14`: the long form
 * was longer than the titles themselves and every search result re-sent it for
 * every row. Persisted snapshots and transfer attempts keep the real ids — the
 * registry resolves an alias back to the real candidate.
 */
export interface RealResourceProviderV2Options {
  provider: ResourceProvider;
  registry: CandidateRegistry;
  /** Run-scopes content-addressed snapshot ids so re-acquisitions don't collide. */
  workflowRunId: string;
  /** When set, candidates whose link is known-dead are dropped BEFORE the agent
   *  sees them (and never recorded/persisted), so it never re-transfers a dead
   *  resource (#15). */
  deadLinkStore?: DeadLinkStore;
}

export class RealResourceProviderV2 implements ResourceProviderV2 {
  private readonly provider: ResourceProvider;
  private readonly registry: CandidateRegistry;
  private readonly workflowRunId: string;
  private readonly deadLinkStore: DeadLinkStore | undefined;
  private readonly observedSnapshots = new Map<string, ResourceSnapshot>();
  /** real snapshot id → `sN`. Content-addressed providers repeat a snapshot id
   *  across keywords; the same snapshot keeps the same alias. */
  private readonly snapshotAliases = new Map<string, string>();

  constructor(options: RealResourceProviderV2Options) {
    this.provider = options.provider;
    this.registry = options.registry;
    this.workflowRunId = options.workflowRunId;
    this.deadLinkStore = options.deadLinkStore;
  }

  /** The domain snapshots observed this run (deduped by id — content-addressed
   *  providers repeat ids across keywords), for the workflow to persist. */
  snapshots(): ResourceSnapshot[] {
    return [...this.observedSnapshots.values()];
  }

  async search(keyword: string): Promise<ResourceSnapshotV2> {
    const snapshot = await this.provider.search({ keyword, workflowRunId: this.workflowRunId });
    const deadKeys = this.deadLinkStore ? new Set(await this.deadLinkStore.listDeadLinkKeys()) : null;
    const kept = deadKeys
      ? snapshot.candidates.filter((candidate) => {
          const identity = deadLinkKey(String(candidate.providerPayload?.["url"] ?? ""));
          return !(identity && deadKeys.has(identity.key));
        })
      : snapshot.candidates;
    const dropped = snapshot.candidates.length - kept.length;
    if (dropped > 0) {
      console.log(`[dead-link] filtered ${dropped} known-dead candidate(s) from search ${JSON.stringify(keyword)}`);
    }
    // Persist + record only the filtered view — the agent never sees, transfers,
    // or has persisted the dead candidates.
    const filteredSnapshot: ResourceSnapshot = { ...snapshot, candidates: kept };
    if (!this.observedSnapshots.has(snapshot.id)) {
      this.observedSnapshots.set(snapshot.id, filteredSnapshot);
    }
    let snapshotAlias = this.snapshotAliases.get(snapshot.id);
    if (snapshotAlias === undefined) {
      snapshotAlias = `s${this.snapshotAliases.size + 1}`;
      this.snapshotAliases.set(snapshot.id, snapshotAlias);
    }
    // Numbered by position in the provider's own list, so a candidate keeps its
    // alias when dead-link filtering removes a neighbour.
    const aliasOf = new Map(snapshot.candidates.map((candidate, index) => [candidate.id, `${snapshotAlias}-${index + 1}`]));
    for (const candidate of kept) {
      this.registry.record(candidate, aliasOf.get(candidate.id));
    }
    return {
      id: snapshotAlias,
      keyword: snapshot.keyword,
      candidates: kept.map((candidate) => ({
        id: aliasOf.get(candidate.id)!,
        title: candidate.title,
      })),
      // 源健康态必须穿过这个边界。它在这里被丢掉过一次,后果是 6 天里源挂着,
      // agent 只看到空候选、照常 reportNoCoverage,用户看到「暂未找到可用资源」。
      ...(snapshot.sourceHealth ? { sourceHealth: snapshot.sourceHealth } : {}),
      // Same boundary that once dropped sourceHealth for 6 days — carry the scores
      // through explicitly; without this the ⚠ 相关度存疑 flag can never reach the agent.
      ...(snapshot.prefilter?.status === "applied"
        ? {
            prefilterScores: Object.fromEntries(
              Object.entries(snapshot.prefilter.scores).flatMap(([id, score]) => {
                const alias = aliasOf.get(id);
                return alias === undefined ? [] : [[alias, score]];
              }),
            ),
            // Adult-content drops count too: an all-porn result must still read as
            // "the system removed some", never as an empty search.
            prefilterDropped: snapshot.prefilter.dropped.length + (snapshot.prefilter.nsfwDropped?.length ?? 0),
          }
        : {}),
    };
  }
}
