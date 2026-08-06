/**
 * Deterministic resource provider for the Acquisition V2 rebuild (Phase 0). It
 * stands in for PanSou: a keyword search returns a snapshot of candidates whose
 * ids double as Storage115Simulator pack ids (so the loop can transfer them).
 *
 * It models the real provider's awkward edges: empty results are a miss (not an
 * error), some keywords genuinely error (evidence to recover from, not the end),
 * and snapshot ids are CONTENT-ADDRESSED — the same candidate set recurs with
 * the same id across different keywords (PanSou 踩坑2), so persistence must dedup
 * on the id rather than assume one snapshot per search.
 */

import type { MergedSourceHealth } from "../resource-source-health.js";

export interface SimResourceCandidate {
  id: string;
  title: string;
}

export interface ResourceSnapshotV2 {
  id: string;
  keyword: string;
  candidates: SimResourceCandidate[];
  /** 本次搜索各源的健康态，原样自域快照透传（domain.ts ResourceSnapshot.sourceHealth）。
   *  可选：fake provider 与老 fixture 不带此字段，缺失按 healthy 处理。
   *  存在的唯一理由是让沙箱能把「源挂了」与「确实没有这个资源」区分开——两者
   *  在 candidates 层面完全同形（都是空数组）。丢掉它，agent 就只能上报
   *  reportNoCoverage，用户看到「暂未找到可用资源」，系统故障被甩锅给资源。 */
  sourceHealth?: MergedSourceHealth;
}

/** The provider surface the sandbox depends on — the fake and the real PanSou
 *  adapter both satisfy it. */
export interface ResourceProviderV2 {
  search(keyword: string): Promise<ResourceSnapshotV2>;
}

export class FakeResourceProviderV2 implements ResourceProviderV2 {
  private readonly results: Map<string, SimResourceCandidate[]>;
  private readonly errorKeywords: Set<string>;
  private readonly onSearch: (() => void) | undefined;

  constructor(options: {
    results?: Record<string, SimResourceCandidate[]>;
    errorKeywords?: string[];
    onSearch?: () => void;
  } = {}) {
    this.results = new Map(
      Object.entries(options.results ?? {}).map(([keyword, candidates]) => [
        normalizeKeyword(keyword),
        candidates,
      ]),
    );
    this.errorKeywords = new Set((options.errorKeywords ?? []).map(normalizeKeyword));
    this.onSearch = options.onSearch ?? undefined;
  }

  async search(keyword: string): Promise<ResourceSnapshotV2> {
    this.onSearch?.();
    const normalized = normalizeKeyword(keyword);
    if (this.errorKeywords.has(normalized)) {
      throw new Error(`PROVIDER_ERROR: search failed for "${keyword}"`);
    }
    const candidates = this.results.get(normalized) ?? [];
    return { id: contentAddressedId(candidates), keyword, candidates };
  }
}

function normalizeKeyword(keyword: string): string {
  return keyword.trim().toLowerCase();
}

/** Content hash of the candidate set, so identical results share an id. */
function contentAddressedId(candidates: SimResourceCandidate[]): string {
  const signature = candidates
    .map((candidate) => candidate.id)
    .sort()
    .join(",");
  let hash = 5381;
  for (let i = 0; i < signature.length; i += 1) {
    hash = ((hash << 5) + hash + signature.charCodeAt(i)) >>> 0;
  }
  return `snap_${hash.toString(36)}`;
}
