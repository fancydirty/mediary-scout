import { createHash } from "node:crypto";
import type { ResourceCandidate, ResourceSnapshot } from "./domain.js";
import type { ResourceProvider } from "./ports.js";
import { mergeSourceHealth, type SourceHealth, type SourceStatus } from "./resource-source-health.js";

export interface CompositeResourceProviderOptions {
  providers: Array<{ name: string; provider: ResourceProvider }>;
  now?: () => string;
}

const BTIH_RE = /urn:btih:([0-9a-z]+)/i;

export class CompositeResourceProvider implements ResourceProvider {
  private readonly providers: Array<{ name: string; provider: ResourceProvider }>;
  private readonly now: () => string;

  constructor(options: CompositeResourceProviderOptions) {
    this.providers = options.providers;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async search(input: { keyword: string; workflowRunId?: string }): Promise<ResourceSnapshot> {
    const settled = await Promise.allSettled(
      this.providers.map((entry) => entry.provider.search(input)),
    );

    const merged: ResourceCandidate[] = [];
    const seen = new Set<string>();
    const sourceSnapshotIds: string[] = [];
    const healths: SourceHealth[] = [];
    for (const [index, result] of settled.entries()) {
      const name = this.providers[index]!.name;
      if (result.status !== "fulfilled") {
        // 以前这里直接 continue,失败就此消失 —— 部分搜索看起来和完整搜索一样。
        healths.push({ status: "unreachable", source: name });
        continue;
      }
      // 成员可能不抛错而是自报不健康(PanSou 就是这样),所以要读字段而不是
      // 只看 Promise 状态。缺字段的老 provider 视为 healthy(向后兼容)。
      const own = result.value.sourceHealth;
      healths.push({ status: memberStatus(own?.status), source: name });
      sourceSnapshotIds.push(result.value.id);
      for (const candidate of result.value.candidates) {
        const key = dedupeKey(candidate);
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(candidate);
      }
    }

    const snapshotId = createSnapshotId(input.keyword, sourceSnapshotIds, input.workflowRunId);
    const candidates: ResourceCandidate[] = merged.map((candidate, index) => ({
      ...candidate,
      id: `${snapshotId}_candidate_${index + 1}`,
      snapshotId,
      index,
    }));

    return {
      id: snapshotId,
      provider: "composite",
      keyword: input.keyword,
      candidates,
      createdAt: this.now(),
      sourceHealth: mergeSourceHealth(healths),
    };
  }
}

/** 把成员自报的合并态折回单源状态。degraded 只可能出现在多源成员上,对本层
 *  而言它意味着「那个成员的证据不完整」,按不可用处理更保守。 */
function memberStatus(status: string | undefined): SourceStatus {
  // degraded 也算「答过话」:那个成员内部有子源挂了,但它确实返回了候选。
  // 压成 unreachable 会让整体合并出 unreachable,于是产生一个「有候选却说
  // 一个都没取回」的自相矛盾快照(Copilot 评审指出)。
  if (status === undefined || status === "healthy" || status === "degraded") return "healthy";
  return status === "protocol_error" ? "protocol_error" : "unreachable";
}

function dedupeKey(candidate: ResourceCandidate): string {
  const payloadHash = candidate.providerPayload["infoHash"];
  if (typeof payloadHash === "string" && payloadHash) {
    return `btih:${payloadHash.toLowerCase()}`;
  }
  const url = candidate.providerPayload["url"];
  if (typeof url === "string" && url) {
    const m = BTIH_RE.exec(url);
    if (m) return `btih:${m[1]!.toLowerCase()}`;
    return `url:${url}`;
  }
  return `id:${candidate.id}`;
}

function createSnapshotId(keyword: string, sourceSnapshotIds: string[], workflowRunId?: string): string {
  const material = JSON.stringify({ workflowRunId: workflowRunId ?? null, keyword, sourceSnapshotIds });
  const hash = createHash("sha1").update(material).digest("hex").slice(0, 12);
  return workflowRunId ? `composite_${workflowRunId}_${hash}` : `composite_${hash}`;
}
