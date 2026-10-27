import type { ResourceSnapshot } from "../domain.js";
import type { ResourceProvider } from "../ports.js";
import { resourceFingerprintMatches } from "../user-requests.js";
import type { CandidateRegistry } from "./candidate-registry.js";
import { deadLinkKey, type DeadLinkStore } from "./dead-links.js";
import { brandOfUrl, candidateDriveLabel, resourceLinkKey } from "./resource-link.js";
import type { ResourceProviderV2, ResourceSnapshotV2 } from "./fake-provider.js";

/**
 * Phase 6 — the real PanSou provider as a ResourceProviderV2. It runs the real
 * search, records each candidate's full payload in the shared registry (so the
 * storage adapter can transfer by id), and hands the agent only the V2 view:
 * id, title, postedAt (YYYY-MM-DD) when the payload date is real, and
 * linkHistory when this work has transferred that same link — never the raw
 * url or provider index.
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
   *  resource (#15). A failing read fails the search: it never fails open. */
  deadLinkStore?: DeadLinkStore;
  /** The work's rejected resources (user said "not this one"), re-read on every search
   *  so a rejection made earlier in THIS run applies at once. Matching candidates are
   *  dropped like dead links. A failing read filters nothing — unless `strict` (a user
   *  replace run), where it fails the search instead. */
  rejectedResources?: {
    list: () => Promise<Array<{ linkKey: string | null; label: string; sizeBytes: number | null }>>;
    strict?: boolean;
  };
  /** resourceLinkKey → the note for that link. Absent = no history this run. */
  linkHistory?: ReadonlyMap<string, string>;
}

export class RealResourceProviderV2 implements ResourceProviderV2 {
  private readonly provider: ResourceProvider;
  private readonly registry: CandidateRegistry;
  private readonly workflowRunId: string;
  private readonly deadLinkStore: DeadLinkStore | undefined;
  private readonly rejectedResources: RealResourceProviderV2Options["rejectedResources"];
  private readonly linkHistory: ReadonlyMap<string, string> | undefined;
  private readonly observedSnapshots = new Map<string, ResourceSnapshot>();
  /** real snapshot id → `sN`. Content-addressed providers repeat a snapshot id
   *  across keywords; the same snapshot keeps the same alias. */
  private readonly snapshotAliases = new Map<string, string>();

  constructor(options: RealResourceProviderV2Options) {
    this.provider = options.provider;
    this.registry = options.registry;
    this.workflowRunId = options.workflowRunId;
    this.deadLinkStore = options.deadLinkStore;
    this.rejectedResources = options.rejectedResources;
    this.linkHistory = options.linkHistory;
  }

  /** The domain snapshots observed this run (deduped by id — content-addressed
   *  providers repeat ids across keywords), for the workflow to persist. */
  snapshots(): ResourceSnapshot[] {
    return [...this.observedSnapshots.values()];
  }

  async search(keyword: string): Promise<ResourceSnapshotV2> {
    const snapshot = await this.provider.search({ keyword, workflowRunId: this.workflowRunId });
    // A dead-link read error fails the search. Filtering nothing instead would show
    // every link already proven dead — and let the agent transfer it again. Only the
    // rejected list below fails open (best effort by design).
    const deadKeys = this.deadLinkStore ? new Set(await this.deadLinkStore.listDeadLinkKeys()) : new Set<string>();
    const rejected = await this.readRejected();
    const rejectedKeys = new Set(rejected.map((r) => r.linkKey).filter((k): k is string => k !== null));
    let deadDropped = 0;
    let rejectedDropped = 0;
    const kept = snapshot.candidates.filter((candidate) => {
      const url = String(candidate.providerPayload?.["url"] ?? "");
      const identity = deadLinkKey(url);
      if (identity && deadKeys.has(identity.key)) {
        deadDropped++;
        return false;
      }
      // A rejection follows every drive's share links, not only the ones dead-link tracking keys.
      const linkKey = resourceLinkKey(url);
      if (
        (linkKey !== null && rejectedKeys.has(linkKey)) ||
        rejected.some((r) => resourceFingerprintMatches(candidate.title, r))
      ) {
        rejectedDropped++;
        return false;
      }
      return true;
    });
    if (deadDropped > 0) {
      console.log(`[dead-link] filtered ${deadDropped} known-dead candidate(s) from search ${JSON.stringify(keyword)}`);
    }
    if (rejectedDropped > 0) {
      console.log(`[user-message] filtered ${rejectedDropped} user-rejected candidate(s) from search ${JSON.stringify(keyword)}`);
    }
    // Persist the UNION of every candidate ever observed under this snapshot id,
    // not just this call's filtered view: a candidate the agent already transferred
    // in an earlier search must stay in the persisted snapshot even if a later
    // rejection or dead-link filters it out of what the agent sees NOW — otherwise
    // persist throws "Transfer attempt … referenced an unknown candidate"
    // (validateWorkflowRunSnapshot in repository.ts). Invariant: every candidate the
    // agent could ever have transferred appears in some persisted snapshot.
    const prior = this.observedSnapshots.get(snapshot.id);
    const merged = prior
      ? [...new Map([...prior.candidates, ...kept].map((c) => [c.id, c])).values()].sort((a, b) => a.index - b.index)
      : kept;
    this.observedSnapshots.set(snapshot.id, { ...snapshot, candidates: merged });
    let snapshotAlias = this.snapshotAliases.get(snapshot.id);
    if (snapshotAlias === undefined) {
      snapshotAlias = `s${this.snapshotAliases.size + 1}`;
      this.snapshotAliases.set(snapshot.id, snapshotAlias);
    }
    // Numbered by position in the provider's own list, so a candidate keeps its
    // alias when dead-link filtering removes a neighbour.
    const aliasOf = new Map(snapshot.candidates.map((candidate, index) => [candidate.id, `${snapshotAlias}-${index + 1}`]));
    const keptIds = new Set(kept.map((candidate) => candidate.id));
    for (const candidate of kept) {
      this.registry.record(candidate, aliasOf.get(candidate.id));
    }
    // Only tag candidates with their drive/channel when the snapshot mixes multiple
    // distinct channels (unified multi-drive mode). Single-brand snapshots stay
    // byte-identical to the legacy representation.
    const resolvedBrands = kept.map((candidate) => {
      const rawUrl = candidate.providerPayload?.["url"];
      return (typeof rawUrl === "string" ? brandOfUrl(rawUrl) : null) ?? (candidate.type !== "manual" ? candidate.type : null);
    });
    const distinctBrandCount = new Set(resolvedBrands.filter((b): b is NonNullable<typeof b> => b !== null)).size;
    const includeDriveTags = distinctBrandCount > 1;

    return {
      id: snapshotAlias,
      keyword: snapshot.keyword,
      candidates: kept.map((candidate, idx) => {
        const postedAt = postedAtFromDatetime(candidate.providerPayload?.["datetime"]);
        const rawUrl = candidate.providerPayload?.["url"];
        const linkKey = typeof rawUrl === "string" ? resourceLinkKey(rawUrl) : null;
        const linkHistory = linkKey ? this.linkHistory?.get(linkKey) : undefined;
        const drive = includeDriveTags ? (resolvedBrands[idx] ?? undefined) : undefined;
        const driveLabel = drive ? candidateDriveLabel(drive) : undefined;
        const rawSize = candidate.providerPayload?.["sizeBytes"];
        const sizeBytes = includeDriveTags && typeof rawSize === "number" && Number.isFinite(rawSize) && rawSize > 0
          ? rawSize
          : undefined;
        return {
          id: aliasOf.get(candidate.id)!,
          title: candidate.title,
          ...(drive ? { drive } : {}),
          ...(driveLabel ? { driveLabel } : {}),
          ...(sizeBytes !== undefined ? { sizeBytes } : {}),
          ...(postedAt ? { postedAt } : {}),
          ...(linkHistory ? { linkHistory } : {}),
        };
      }),
      // 源健康态必须穿过这个边界。它在这里被丢掉过一次,后果是 6 天里源挂着,
      // agent 只看到空候选、照常 reportNoCoverage,用户看到「暂未找到可用资源」。
      ...(snapshot.sourceHealth ? { sourceHealth: snapshot.sourceHealth } : {}),
      // Same boundary that once dropped sourceHealth for 6 days — carry the scores
      // through explicitly; without this the ⚠ 相关度存疑 flag can never reach the agent.
      ...(snapshot.prefilter?.status === "applied"
        ? {
            prefilterScores: Object.fromEntries(
              Object.entries(snapshot.prefilter.scores).flatMap(([id, score]) => {
                if (!keptIds.has(id)) return [];
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

  private async readRejected(): Promise<Array<{ linkKey: string | null; label: string; sizeBytes: number | null }>> {
    if (!this.rejectedResources) return [];
    // A user replace run reads strictly: showing what the user rejected is worse than a
    // failed search (the agent sees the error and can search again).
    if (this.rejectedResources.strict) return this.rejectedResources.list();
    try {
      return await this.rejectedResources.list();
    } catch (error) {
      console.log(`[user-message] rejected list read failed (not filtering): ${truncateErrorMessage(error)}`);
      return [];
    }
  }
}

/** YYYY-MM-DD when `datetime` is a real calendar date. PanSou sends
 *  `0001-01-01T00:00:00Z` for unknown, and a year before 2000 is not a post date. */
function postedAtFromDatetime(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(value.trim());
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 2000) return undefined;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

/** Caps a read-failure message logged in the hot search path — some providers'
 *  errors carry huge payloads (stack traces, full response bodies). */
function truncateErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 160 ? `${message.slice(0, 160)}…` : message;
}
