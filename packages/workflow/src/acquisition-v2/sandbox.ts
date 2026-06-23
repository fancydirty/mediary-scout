import {
  MAX_DISTINCT_PLANNING_SEARCHES,
  decideSearchGate,
  keywordReferencesTitle,
  normalizeSearchKeyword,
} from "../planning-search-gate.js";
import type { ResourceProviderV2, ResourceSnapshotV2 } from "./fake-provider.js";
import type { SimTreeFile, StorageV2, TransferAttemptResult } from "./storage-115-simulator.js";

/**
 * The task sandbox for the Acquisition V2 rebuild — the permission cage the
 * strong agent runs inside. It owns the budgets, the scope, the observed
 * snapshots, and (later) the storage handles, and exposes the agent's tools.
 * The agent drives its own observe-act-verify loop through these tools; the
 * sandbox only makes the documented mistakes impossible — it does NOT plan.
 *
 * This file grows one tool at a time (TDD). First tool: searchResources.
 */
export interface TaskSandboxOptions {
  provider: ResourceProviderV2;
  /** Max distinct PanSou searches per task (the system's search budget). */
  searchBudget?: number;
  /** Scoped storage + the staging handle this task may transfer into. */
  storage?: StorageV2;
  stagingDirectoryId?: string;
  /** TV/anime: season number -> scoped Season directory. A multi-season / complete-
   *  series pack's files are distributed across these per season (§2 targetSeasons +
   *  moveToSeason(fileIds, season); architecture §Multi-season; permission-audit 105/209). */
  targetSeasonDirectoryIds?: Record<number, string>;
  /** Movie: the single scoped movie directory (§2 targetMovieDir). A movie has no
   *  seasons, so its moveToSeason omits `season`. TV tasks NEVER use this — even a
   *  single-season TV task uses targetSeasonDirectoryIds so the season stays known. */
  targetMovieDirectoryId?: string;
  /** Coverage need: the missing episode codes — which MAY span multiple seasons,
   *  e.g. ["S01E13","S04E07"] — or ["MOVIE"]. Coverage is met when every token
   *  has a markObtained-confirmed entry. Drives the §3 "no more side effects once
   *  satisfied" gate. The need is just "what's still missing"; sync computes it. */
  need?: string[];
  /** Title + aliases + original title. A search keyword that references NONE of
   *  these is rejected at the tool boundary (the agent's "2026 电影" genre/year
   *  fallback only returns noise). Empty/omitted → no title check (fail open). */
  titleTerms?: string[];
}

export interface SearchToolResult {
  /** Present on a fresh search and on a dedup (the prior snapshot). */
  snapshot?: ResourceSnapshotV2;
  /** True when the keyword was already searched — returned without re-hitting the provider. */
  deduped?: boolean;
  /** Set when the search budget is exhausted; the agent must decide from what it has. */
  refused?: string;
}

export interface TransferToolResult {
  attempt: TransferAttemptResult;
  /** The TRUE staging contents after a forced reread — the only evidence the
   *  agent should trust about what actually landed. */
  staging: SimTreeFile[];
}

export class TaskSandbox {
  private readonly provider: ResourceProviderV2;
  private readonly searchBudget: number;
  private readonly storage: StorageV2 | undefined;
  private readonly stagingDirectoryId: string | undefined;
  /** TV: season number -> scoped Season directory (multi-season distribution). */
  private readonly seasonDirs: Map<number, string>;
  /** A movie task's one target directory (movies have no seasons). */
  private readonly movieDir: string | undefined;
  private readonly need: readonly string[];
  private readonly titleTerms: readonly string[];
  private readonly seenKeywords = new Set<string>();
  private readonly snapshotByKeyword = new Map<string, ResourceSnapshotV2>();
  private readonly observedSnapshots = new Map<string, ResourceSnapshotV2>();
  private readonly obtainedCodes = new Set<string>();

  constructor(options: TaskSandboxOptions) {
    this.provider = options.provider;
    this.searchBudget = options.searchBudget ?? MAX_DISTINCT_PLANNING_SEARCHES;
    this.storage = options.storage;
    this.stagingDirectoryId = options.stagingDirectoryId;
    this.seasonDirs = new Map(
      Object.entries(options.targetSeasonDirectoryIds ?? {}).map(([season, id]) => [Number(season), id]),
    );
    this.movieDir = options.targetMovieDirectoryId;
    this.need = options.need ?? [];
    this.titleTerms = options.titleTerms ?? [];
  }

  /** Every scoped target directory (all seasons + the movie) — the union used for
   *  presence checks and full-target inspection. */
  private allTargetDirIds(): string[] {
    const ids = [...this.seasonDirs.values()];
    if (this.movieDir !== undefined) ids.push(this.movieDir);
    return ids;
  }

  /** Resolve which scoped target directory a move/inspect/delete addresses. A TV
   *  task ALWAYS names the season explicitly — single-season included, so the
   *  season number stays known and a file can never land in an unknown season.
   *  Only a movie task (no seasons) resolves without a season. */
  private resolveTargetDir(season?: number): string | undefined {
    if (season !== undefined) return this.seasonDirs.get(season);
    return this.seasonDirs.size === 0 ? this.movieDir : undefined;
  }

  /** Whether every needed token has been confirmed obtained — the gate that
   *  stops the agent from acquiring past the point of coverage (莉可丽丝 scar). */
  isCoverageMet(): boolean {
    return this.need.length > 0 && this.need.every((token) => this.obtainedCodes.has(token));
  }

  private missingNeed(): string[] {
    return this.need.filter((token) => !this.obtainedCodes.has(token));
  }

  /** Search one keyword. Repeats are deduped (no extra provider hit); distinct
   *  searches are capped by the budget. Every observed snapshot is recorded so a
   *  later transferCandidate can be bound to a snapshot seen in THIS task. */
  async searchResources(keyword: string): Promise<SearchToolResult> {
    // Hard guard: a keyword that names no title term is a genre/year-only
    // fallback ("2026 电影") — it can only return noise. Reject it BEFORE the
    // budget/provider so it costs nothing and the agent must re-keyword with the
    // real title. (asEvidence turns this throw into the {error} the agent reads.)
    if (!keywordReferencesTitle(keyword, this.titleTerms)) {
      throw new Error(
        `搜索关键词必须包含片名(片名/原名/别名)。"${keyword}" 不含片名,只会返回噪音,已拒绝。请用包含片名的关键词(可附加年份/原名/4K/全集 等),不要用纯类型或纯年份(如 "电影"、"2026 电影")。`,
      );
    }
    const normalized = normalizeSearchKeyword(keyword);
    const decision = decideSearchGate({
      normalizedKeyword: normalized,
      seenKeywords: this.seenKeywords,
      maxDistinctSearches: this.searchBudget,
    });
    if (decision === "duplicate") {
      const prior = this.snapshotByKeyword.get(normalized);
      return prior ? { snapshot: prior, deduped: true } : { deduped: true };
    }
    if (decision === "exhausted") {
      return {
        refused: `search budget exhausted (${this.searchBudget} distinct searches); decide from the evidence already gathered`,
      };
    }
    this.seenKeywords.add(normalized);
    const snapshot = await this.provider.search(keyword);
    this.snapshotByKeyword.set(normalized, snapshot);
    this.observedSnapshots.set(snapshot.id, snapshot);
    return { snapshot };
  }

  /** Whether a snapshot id was actually observed in this task — the gate for
   *  snapshot-bound transfers (no acting on stale/unseen ids). */
  hasObservedSnapshot(snapshotId: string): boolean {
    return this.observedSnapshots.has(snapshotId);
  }

  /** Read-only full raw tree of THIS task's staging handle — the agent's
   *  "看现场" surface. Returns everything (no top-N slicing, §11) so the agent
   *  judges identity/dupes/extras from real files, not a summary. */
  async inspectStaging(): Promise<SimTreeFile[]> {
    if (!this.storage || !this.stagingDirectoryId) {
      throw new Error("SANDBOX: no storage/staging handle configured");
    }
    return this.storage.listTree({ directoryId: this.stagingDirectoryId });
  }

  /** Read-only list of the wrapper subdirectories currently in staging.
   *  Not on the agent toolset (the agent works from inspectStaging's flat tree
   *  and wipes leftovers with discardStaging); kept for tests / hands-on debug. */
  async inspectStagingDirs(): Promise<Array<{ id: string; path: string }>> {
    if (!this.storage || !this.stagingDirectoryId) {
      throw new Error("SANDBOX: no storage/staging handle configured");
    }
    return this.storage.listSubdirectories({ directoryId: this.stagingDirectoryId });
  }

  /** Read-only full raw tree of a scoped target directory — ground truth for what
   *  has landed. With a season, that season's dir (so the agent sees what season N
   *  already holds before deciding what to move/dedup); without one, the union of
   *  all target dirs (every season + movie) for the whole picture. */
  async inspectTargetDir(input: { season?: number } = {}): Promise<SimTreeFile[]> {
    if (!this.storage) {
      throw new Error("SANDBOX: no storage configured");
    }
    if (input.season !== undefined) {
      const dir = this.resolveTargetDir(input.season);
      if (!dir) {
        throw new Error(`SANDBOX: no target directory for season ${input.season}`);
      }
      return this.storage.listTree({ directoryId: dir });
    }
    const trees = await Promise.all(
      this.allTargetDirIds().map((directoryId) => this.storage!.listTree({ directoryId })),
    );
    return trees.flat();
  }

  /** Transfer ONE candidate into the task's staging handle, then force-reread
   *  staging and return the TRUE contents. The candidate must come from a
   *  snapshot observed in THIS task (no stale/raw ids) — the agent can never
   *  transfer-and-run; the real landing is handed back for it to judge. */
  async transferCandidate(input: { snapshotId: string; candidateId: string }): Promise<TransferToolResult> {
    if (!this.storage || !this.stagingDirectoryId) {
      throw new Error("SANDBOX: no storage/staging handle configured for transfers");
    }
    if (this.isCoverageMet()) {
      throw new Error(
        `SANDBOX_COVERAGE_ALREADY_MET: every needed item (${this.need.join(",")}) is obtained; no further transfers`,
      );
    }
    const snapshot = this.observedSnapshots.get(input.snapshotId);
    if (!snapshot) {
      throw new Error(`SANDBOX_SNAPSHOT_NOT_OBSERVED: ${input.snapshotId} was not seen in this task`);
    }
    if (!snapshot.candidates.some((candidate) => candidate.id === input.candidateId)) {
      throw new Error(`SANDBOX_CANDIDATE_NOT_IN_SNAPSHOT: ${input.candidateId} is not in ${input.snapshotId}`);
    }
    const attempt = await this.storage.transferCandidate({
      candidateId: input.candidateId,
      intoDirectoryId: this.stagingDirectoryId,
    });
    const staging = await this.storage.listTree({ directoryId: this.stagingDirectoryId });
    return { attempt, staging };
  }

  /** MOVIE-ONLY: transfer an AGENT-ORDERED list of candidates the agent judged to
   *  be the SAME target film (best → next-best by resource name), stopping at the
   *  FIRST that 秒传-lands; the rest are abandoned. The candidate SET is the agent's
   *  semantic choice (a wildcard search returns same-named DIFFERENT works — never
   *  iterate the raw result set); the system only burns through the dead links in
   *  that vetted, ordered set. 115 SHARE LINKS ONLY: only a 115 share fails loud
   *  (链接已过期/错误的链接/分享已取消 come back at once), so iterate-on-failure is
   *  sound; a magnet's success is only knowable via the landing point, so magnets
   *  are rejected — use transferCandidate + inspectStaging for those. TV/anime
   *  never gets this tool (it must not be confused with multi-resource season
   *  coverage). Refused once coverage is met. Force-rereads staging. */
  async transferUntilLanded(input: { candidateIds: string[] }): Promise<{
    landed: SimTreeFile[];
    transferredCandidateId: string | null;
    attempts: Array<{ candidateId: string; status: "succeeded" | "failed" }>;
  }> {
    if (!this.storage || !this.stagingDirectoryId) {
      throw new Error("SANDBOX: no storage/staging handle configured for transfers");
    }
    if (this.movieDir === undefined || this.seasonDirs.size > 0) {
      throw new Error(
        "SANDBOX_TRANSFER_UNTIL_LANDED_MOVIE_ONLY: only a movie task may iterate alternative links for one film",
      );
    }
    if (this.isCoverageMet()) {
      throw new Error(
        `SANDBOX_COVERAGE_ALREADY_MET: every needed item (${this.need.join(",")}) is obtained; no further transfers`,
      );
    }
    if (input.candidateIds.length === 0) {
      throw new Error("SANDBOX_NO_CANDIDATES: transferUntilLanded needs at least one candidate");
    }
    for (const candidateId of input.candidateIds) {
      const observed = [...this.observedSnapshots.values()].some((snapshot) =>
        snapshot.candidates.some((candidate) => candidate.id === candidateId),
      );
      if (!observed) {
        throw new Error(`SANDBOX_CANDIDATE_NOT_OBSERVED: ${candidateId} was not seen in a search this task`);
      }
    }
    for (const candidateId of input.candidateIds) {
      if (this.storage.candidateLinkKind(candidateId) !== "pan115") {
        throw new Error(
          `SANDBOX_TRANSFER_UNTIL_LANDED_REQUIRES_PAN115: ${candidateId} is not a 115 share link ` +
            "(use transferCandidate for magnets and verify via the landing point)",
        );
      }
    }
    const attempts: Array<{ candidateId: string; status: "succeeded" | "failed" }> = [];
    let transferredCandidateId: string | null = null;
    for (const candidateId of input.candidateIds) {
      const attempt = await this.storage.transferCandidate({
        candidateId,
        intoDirectoryId: this.stagingDirectoryId,
      });
      attempts.push({ candidateId, status: attempt.status });
      if (attempt.status === "succeeded") {
        transferredCandidateId = candidateId;
        break;
      }
    }
    const landed = await this.storage.listTree({ directoryId: this.stagingDirectoryId });
    return { landed, transferredCandidateId, attempts };
  }

  /** Batch distribution plan (挖取/extract): the agent submits the WHOLE
   *  "files → season" mapping at once — each video's SUBTITLES ride in the same
   *  season's fileIds (§1.14). The system runs every move and force-rereads,
   *  returning EVERY touched season dir + the remaining staging so the agent
   *  verifies the whole distribution in one shot and fixes any misplacement. Only
   *  still-missing episodes are moved (already-present seasons are NOT recopied —
   *  the agent judges this). A movie move OMITS `season` (its target is the movie
   *  dir, which equals staging). Distributing in one call is more ergonomic than
   *  per-season calls, and moves are NOT 逆鳞-budget-sensitive like transfers
   *  (§2/§5). Scope guard: every fileId must currently be in THIS task's staging. */
  async moveToSeason(input: {
    moves: Array<{ season?: number; fileIds: string[] }>;
  }): Promise<{ seasons: Record<number, SimTreeFile[]>; staging: SimTreeFile[] }> {
    if (!this.storage || !this.stagingDirectoryId) {
      throw new Error("SANDBOX: no storage/staging handle configured");
    }
    // Resolve every target up front; reject an unknown/unscoped season before any move.
    const resolved = input.moves.map((move) => {
      const targetDir = this.resolveTargetDir(move.season);
      if (!targetDir) {
        throw new Error(
          move.season === undefined
            ? "SANDBOX_SEASON_REQUIRED: every TV move must name its season (single-season included — the season number must stay known)"
            : `SANDBOX_NO_SEASON_DIR: no scoped directory for season ${move.season} (out of this task's season scope)`,
        );
      }
      return { season: move.season, targetDir, fileIds: move.fileIds };
    });
    // Validate ALL fileIds against the current staging snapshot before any move.
    const stagingIds = new Set(
      (await this.storage.listTree({ directoryId: this.stagingDirectoryId })).map((file) => file.id),
    );
    const outOfScope = resolved.flatMap((move) => move.fileIds).filter((fileId) => !stagingIds.has(fileId));
    if (outOfScope.length > 0) {
      throw new Error(`SANDBOX_FILES_NOT_IN_STAGING: ${outOfScope.join(",")}`);
    }
    // Execute each move (the system does the per-file moves under the hood).
    for (const move of resolved) {
      await this.storage.moveFiles({ fileIds: move.fileIds, targetDirectoryId: move.targetDir });
    }
    // Force-reread every touched target season + staging for one-shot verification.
    const seasons: Record<number, SimTreeFile[]> = {};
    for (const move of resolved) {
      if (move.season !== undefined) {
        seasons[move.season] = await this.storage.listTree({ directoryId: move.targetDir });
      }
    }
    return { seasons, staging: await this.storage.listTree({ directoryId: this.stagingDirectoryId }) };
  }

  /** Delete agent-chosen files from a named scoped directory (the dedup
   *  keep-larger execution, or residue cleanup). Scope guard: every id must
   *  currently be in that directory — no deleting arbitrary/raw ids. Rereads. */
  async deleteFiles(input: {
    directory: "staging" | "season";
    season?: number;
    fileIds: string[];
  }): Promise<{ deleted: string[]; directory: SimTreeFile[] }> {
    if (!this.storage) {
      throw new Error("SANDBOX: no storage configured");
    }
    const directoryId =
      input.directory === "season" ? this.resolveTargetDir(input.season) : this.stagingDirectoryId;
    if (!directoryId) {
      throw new Error(`SANDBOX: no ${input.directory} handle configured`);
    }
    const present = new Set(
      (await this.storage.listTree({ directoryId })).map((file) => file.id),
    );
    const outOfScope = input.fileIds.filter((fileId) => !present.has(fileId));
    if (outOfScope.length > 0) {
      throw new Error(`SANDBOX_FILES_NOT_IN_${input.directory.toUpperCase()}: ${outOfScope.join(",")}`);
    }
    const { deleted } = await this.storage.deleteFiles({ directoryId, fileIds: input.fileIds });
    return { deleted, directory: await this.storage.listTree({ directoryId }) };
  }

  /** Record the episodes the agent declares obtained — the agent's FINAL action,
   *  pure agent judgment. The system does NOT mechanically re-read 115 to verify
   *  a backing file exists (§12, 2026-06-15): move/flatten already force-reread
   *  and handed the truth back; the mark is reversible; and §1.13 has the agent
   *  re-judge from the real files every patrol, so a stale mark self-heals next
   *  round. Correctness is the prompt ordering (clean/flatten, THEN mark last),
   *  not a system gate that costs extra 115 reads. No fileId↔episode map (§1.13):
   *  the code IS the unit; the agent names what it judged present. */
  async markObtained(input: { codes: string[] }): Promise<{ confirmed: string[] }> {
    for (const code of input.codes) {
      this.obtainedCodes.add(code);
    }
    return { confirmed: input.codes };
  }

  /** TV/anime clean-up: wipe THIS task's staging dir wholesale after the agent has
   *  distributed the episodes it needs (mark already done). Leftovers (unwanted
   *  episodes / dup packs) are discarded — no classification, no foreign-work
   *  isolation (§1.6). Harnessed: the agent can ONLY delete its own staging, and
   *  NEVER when staging is also a target dir (the movie flatten-in-place case,
   *  where staging === the movie dir — refused so the film is never nuked). */
  async discardStaging(): Promise<{ removed: string[] }> {
    if (!this.storage || !this.stagingDirectoryId) {
      throw new Error("SANDBOX: no storage/staging handle configured");
    }
    if (this.allTargetDirIds().includes(this.stagingDirectoryId)) {
      throw new Error(
        "SANDBOX_STAGING_IS_TARGET: this task has no separate staging to discard (a movie flattens in place)",
      );
    }
    return this.storage.removeDirectory({ directoryId: this.stagingDirectoryId });
  }

  /** Movie-only automatic flatten: the film landed nested inside its resource
   *  wrapper under the movie dir (staging === movie dir). Move EVERY video AND
   *  subtitle file up to the movie dir root (§1.14 — subtitles ride along), then
   *  remove the now-residual wrapper subdirs (non-media like covers/nfo go with
   *  them). Fully automatic — no per-file selection (a movie is one film, take it
   *  all); the agent removes any extras (花絮) afterward with deleteFiles. */
  async flattenMovie(): Promise<{ movie: SimTreeFile[] }> {
    if (!this.storage || this.movieDir === undefined) {
      throw new Error("SANDBOX_NOT_A_MOVIE: flattenMovie is movie-only");
    }
    const root = this.movieDir;
    const nested = (await this.storage.listTree({ directoryId: root })).filter(
      (file) => (file.isVideo || file.isSubtitle) && file.path.includes("/"),
    );
    if (nested.length > 0) {
      await this.storage.moveFiles({ fileIds: nested.map((file) => file.id), targetDirectoryId: root });
    }
    for (const wrapper of await this.storage.listSubdirectories({ directoryId: root })) {
      await this.storage.removeDirectory({ directoryId: wrapper.id });
    }
    return { movie: await this.storage.listTree({ directoryId: root }) };
  }

  /** The agent declares it is done. Returns the honest coverage picture from the
   *  obtained marks — the workflow decides what to persist. */
  async finish(): Promise<{ coverageMet: boolean; obtained: string[]; missing: string[] }> {
    // Report the agent's marks beyond just need∩marked — a coherent full pack
    // often delivers episodes BEYOND the aired cursor (the need), and those
    // provider-ahead marks must survive finish() so syncSeasonNeed records them as
    // provider-ahead (frontend 超前). Filtering to `need` silently dropped them —
    // the live #4 bug (quark 超市: agent marked 12, only E01 persisted).
    // Guard: keep only an in-need token (e.g. the movie "MOVIE" sentinel) or a
    // syntactically valid episode code — a malformed agent mark must NOT flow into
    // syncSeasonNeed's episodePartsFromCode (which throws), crashing the run.
    const needSet = new Set(this.need);
    const parse = (code: string): [number, number] | null => {
      const m = /^S(\d{2,})E(\d{2,})$/.exec(code);
      return m ? [Number(m[1]), Number(m[2])] : null;
    };
    const obtained = [...this.obtainedCodes]
      .filter((code) => needSet.has(code) || parse(code) !== null)
      // Order by (season, episode) NUMERICALLY — a lexical sort misorders ≥100
      // (S01E100 < S01E99). Non-episode tokens (e.g. the movie "MOVIE") sort last.
      .sort((a, b) => {
        const pa = parse(a);
        const pb = parse(b);
        if (pa && pb) return pa[0] - pb[0] || pa[1] - pb[1];
        if (pa) return -1;
        if (pb) return 1;
        return a < b ? -1 : a > b ? 1 : 0;
      });
    return {
      coverageMet: this.isCoverageMet(),
      obtained,
      missing: this.missingNeed(),
    };
  }

  /** The agent honestly reports it cannot cover the target. This is only valid
   *  when a real provider search actually ran (§9): reporting no-coverage without
   *  ever searching is an infrastructure failure, not an honest result. */
  async reportNoCoverage(reason: string): Promise<{ reason: string; searchesPerformed: number }> {
    if (this.seenKeywords.size === 0) {
      throw new Error(
        "SANDBOX_NO_PROVIDER_EVIDENCE: cannot report no-coverage before any real search ran (§9 infrastructure failure)",
      );
    }
    return { reason, searchesPerformed: this.seenKeywords.size };
  }
}
