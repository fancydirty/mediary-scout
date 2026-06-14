import type { ResourceSnapshot } from "../domain.js";
import type { ResourceProvider } from "../ports.js";
import type { CandidateRegistry } from "./candidate-registry.js";
import type { ResourceProviderV2, ResourceSnapshotV2 } from "./fake-provider.js";

/**
 * Phase 6 — the real PanSou provider as a ResourceProviderV2. It runs the real
 * search, records each candidate's full payload in the shared registry (so the
 * storage adapter can transfer by id), and hands the agent only the V2 view:
 * id/title/episodeHints/qualityHints — never the raw url or provider index.
 */
export interface RealResourceProviderV2Options {
  provider: ResourceProvider;
  registry: CandidateRegistry;
  /** Run-scopes content-addressed snapshot ids so re-acquisitions don't collide. */
  workflowRunId: string;
}

export class RealResourceProviderV2 implements ResourceProviderV2 {
  private readonly provider: ResourceProvider;
  private readonly registry: CandidateRegistry;
  private readonly workflowRunId: string;
  private readonly observedSnapshots = new Map<string, ResourceSnapshot>();

  constructor(options: RealResourceProviderV2Options) {
    this.provider = options.provider;
    this.registry = options.registry;
    this.workflowRunId = options.workflowRunId;
  }

  /** The domain snapshots observed this run (deduped by id — content-addressed
   *  providers repeat ids across keywords), for the workflow to persist. */
  snapshots(): ResourceSnapshot[] {
    return [...this.observedSnapshots.values()];
  }

  async search(keyword: string): Promise<ResourceSnapshotV2> {
    const snapshot = await this.provider.search({ keyword, workflowRunId: this.workflowRunId });
    if (!this.observedSnapshots.has(snapshot.id)) {
      this.observedSnapshots.set(snapshot.id, snapshot);
    }
    for (const candidate of snapshot.candidates) {
      this.registry.record(candidate);
    }
    return {
      id: snapshot.id,
      keyword: snapshot.keyword,
      candidates: snapshot.candidates.map((candidate) => ({
        id: candidate.id,
        title: candidate.title,
        episodeHints: candidate.episodeHints,
        qualityHints: candidate.qualityHints,
      })),
    };
  }
}
