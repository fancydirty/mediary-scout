import {
  MAX_DISTINCT_PLANNING_SEARCHES,
  MOVIE_SEARCH_BUDGET,
  MOVIE_SEARCH_SOFT_THRESHOLD,
  decideSearchGate,
  normalizeSearchKeyword,
} from "../planning-search-gate.js";
import type { AssrtCandidate, AssrtSubtitleFile, AssrtProviderPort } from "../subtitle-provider.js";
import type { ResourceProviderV2, ResourceSnapshotV2 } from "./fake-provider.js";
import type { SimTreeFile, StorageV2, TransferAttemptResult } from "./storage-115-simulator.js";
import { isSystemicTransferBlockMessage } from "./transfer-block.js";
import { animeSearchTabooWarnings, type SearchProfile } from "./search-profile.js";
import type { AuditEvent } from "../domain.js";
import { isMergedSourceEvidenceUsable, type MergedSourceHealth } from "../resource-source-health.js";
import { JEV_UNCERTAIN_LEGEND, jevAllDroppedWarning, jevUncertaintyFlag } from "../jev-judge.js";
import {
  AGENT_MEMORY_LIMITS,
  memoryDriveAllows,
  memoryOtherDriveError,
  validateMemoryInput,
  type AgentMemory,
  type AgentMemoryScope,
  type AgentMemoryStore,
  type AgentMemoryWrite,
} from "../agent-memory.js";
import { indexSubtitleFiles, selectSubtitleChunk } from "./subtitle-renewal.js";

/** Quality / subtitle / source tokens that PanSou share titles almost never carry,
 *  so appending them collapses recall (实测归零). Case-insensitive; word-ish so
 *  "1080p" / "WEB-DL" / "BluRay" match as units. 中字/国语/双语/字幕 are CJK so they
 *  match anywhere. */
const QUALITY_SUBTITLE_TOKEN =
  /\b(?:4k|2160p|1080p|720p|hdr|dv|remux|web-?dl|bluray|bdrip)\b|蓝光|中字|国语|双语|字幕/gi;

const SUBTITLE_NAME_PATTERN = /\.(srt|ass|ssa|sub|idx|vtt|sup|smi)$/i;

export const SUBTITLE_RENEWAL_CHUNK_SIZE = 24;
const SUBTITLE_MAX_CONSECUTIVE_FAILURES = 3;

export interface SubtitleChunkDiagnostic {
  chunkNumber: number;
  requestedCount: number;
  detailRefreshed: boolean;
  landedCount: number;
  unlandedCount: number;
  error?: string;
}

const STRIP_NOTICE =
  "已从关键词移除画质/字幕词(如 4K/1080p/蓝光/中字/字幕):PanSou 是通配符匹配,加这些只会把召回打成子集或归零,raw 裸标题召回最全。已改用裸标题搜索。";

/** Threshold for large snapshot digestion hint (病3). */
const LARGE_SNAPSHOT_DIGEST_THRESHOLD = 10;

/** 预搜(raw 预热)拿到**不可用**结果(unreachable / protocol_error 快照,或 provider
 *  直接抛错)时的退避重试间隔。生产实测源抖动多在 60 秒内自愈(2026-09 前那次持续
 *  11 天的 PanSou 抖动也是间歇的),5 秒窗口的救率高;重试仍坏就落首搜那份,不无限
 *  重试。degraded / healthy 都是可用证据,一律不重试(重试只为救「真的拿不到」,不为
 *  救「次优」——重试结果可能更坏,不得把可用结果换掉)。只作用于预搜路径——agent 的
 *  searchResources 不自动重试(dedup 只信健康快照已给它自愈能力,agent 自己会
 *  换词/重搜)。 */
export const PRESEARCH_RETRY_DELAY_MS = 5000;

/** Recorded (in place of "replaced") when the agent reports an episode replaced but a
 *  file it named for that episode is not in a target dir when it reports: still in
 *  staging (never moved beside the old one), or moved in and deleted since. The episode
 *  stays 待换 (moved in and reported again, it is upgraded). */
const REPLACEMENT_NOT_IN_TARGET_NOTE =
  "新文件不在目标目录(季目录/电影目录)里:还在暂存,或移进去后又被删掉了。不算完成替换,本轮记为未找到,留待下次巡检。";

/** 缓存快照能否当「已搜过」(dedup 的信任判据)。只有 healthy(含老快照缺字段)可信;
 *  unreachable / protocol_error / degraded 都不信,跳过缓存重打真实源。
 *
 *  degraded 不信的理由:它是 fallback 救回的「部分证据」——主源仍坏,重搜很可能
 *  拿回更全的结果;而且它的语义本身就是「证据不完整」,拿去当「已搜过、不会再变」
 *  自相矛盾。代价是一次多余的重搜(罕见且低频),换来坏快照不再永久钉死关键词。
 *
 *  与 reportNoCoverage 的证据闸( isMergedSourceEvidenceUsable,degraded 算可用)
 *  是两道边界,别互相抄:那边管「能不能报缺」——把 degraded 也拦会再也报不出真实
 *  的「没有资源」;这边只管「缓存可不可信」。 */
function isSnapshotHealthTrusted(snapshot: ResourceSnapshotV2): boolean {
  return (snapshot.sourceHealth?.status ?? "healthy") === "healthy";
}

/** 快照算不算「有可用证据」——预搜重试的触发判据与落点择优都用它。
 *  unreachable / protocol_error(或 provider 直接抛错)才是「真的拿不到」;degraded /
 *  healthy(含老快照缺字段)都是可用证据,与 fallback-provider、reportNoCoverage 证据
 *  闸( isSourceUsable / isMergedSourceEvidenceUsable)同一套「degraded=可用」分类学。
 *  degraded 是 fallback 救回的可用快照(有候选):重试只为救「真的拿不到」,不为救
 *  「次优」——重试结果可能更坏,不得把可用结果换掉。
 *
 *  与 isSnapshotHealthTrusted(healthy-only,dedup 信任闸)是两道边界,别互相抄:
 *  那边管「缓存能不能当已搜过」,这边只管「结果值不值得为它退避重试/换掉手里的证据」。 */
function isSnapshotEvidenceUsable(snapshot: ResourceSnapshotV2): boolean {
  return isMergedSourceEvidenceUsable(snapshot.sourceHealth);
}

/**
 * 把快照的源健康态翻成给 agent 的祈使句警告。返回 undefined 表示证据完整
 * （healthy 或老快照无此字段）——那种情形下的空候选才是权威的「确实没有」，
 * 必须保持可区分，所以这里绝不能对每个空快照都告警。
 *
 * 同一条教义见 transfer-block.ts：把系统故障报成「暂未找到资源」是拿资源
 * 给系统问题背锅（别甩锅）。unreachable 与 protocol_error 分开措辞，因为用户的
 * 处置动作不同（源挂了/网络不通 vs 地址填错了、那头根本不是 PanSou）。
 */
function sourceHealthWarning(health: MergedSourceHealth | undefined): string | undefined {
  if (!health || health.status === "healthy") return undefined;
  const sources = health.unhealthySources.length > 0 ? health.unhealthySources.join("、") : "未知";
  switch (health.status) {
    case "degraded":
      return `搜索源「${sources}」本次未响应,只有部分源答复:本次结果是不完整证据。已返回的候选照常可用,可以正常筛选转存;但不要因为没搜到就下「没有资源」的结论,更不要据此 reportNoCoverage——缺的那部分源可能正好有。`;
    case "protocol_error":
      return `搜索源「${sources}」返回了无法解析的响应:配置的地址可能指向的根本不是 PanSou(填错地址/被网关或登录页拦截)。本次等于没搜,「没有资源」这个结论不被这份证据支持,不要 reportNoCoverage;请如实说明是搜索源配置有问题。`;
    case "unreachable":
      return `搜索源「${sources}」本次连不上,一个候选都没能取回。这是搜索源故障,不是这部片子没有资源:「没有资源」这个结论不被这份证据支持,不要 reportNoCoverage;请如实说明是搜索源不可用。`;
  }
}

/** Rows viewResourceSnapshot renders before it truncates. Shared with the presenter
 *  so the legend is gated on exactly the rows that make it into the document. */
const RAW_SNAPSHOT_ROW_LIMIT = 120;

/** Below this many rows a majority of ⚠ can still point at something (2 of 3 is a
 *  real signal); from here on a majority means the judge could not tell. */
const JEV_FLAG_NOISE_MIN_ROWS = 10;

/** Shown in place of the flags when most rows would carry one. */
const JEV_FLAGS_SUPPRESSED_NOTE =
  "系统的片名预筛对这批候选里的大多数都拿不准是不是目标作品(长篇动画常见:字幕组的季号/总集数和 TMDB 对不上),所以本次没有逐条标 ⚠。请按标题自己判断。";

/** The tool-facing view of a snapshot: the ⚠ suffix rendered into each title (same as
 *  the 活期文档), the raw score map stripped (the agent judges titles, not numbers).
 *  Both read paths (searchResources and viewResourceSnapshot) go through here so the
 *  agent can never see two different stories about the same candidates. */
function presentSnapshotForAgent(snapshot: ResourceSnapshotV2, limit?: number): {
  snapshot: ResourceSnapshotV2;
  legend: string | undefined;
  allDroppedWarning: string | undefined;
} {
  const scores = snapshot.prefilterScores;
  if (!scores) return { snapshot, legend: undefined, allDroppedWarning: undefined };
  // The legend explains a ⚠ the agent can SEE. viewResourceSnapshot truncates its
  // rows, so a flag past the cut must not pull in a legend for a document that has
  // no flag in it. `limit` undefined = every row is shown (searchResources).
  // A flag only helps while it singles out a few rows. On a long-running anime the
  // fansub numbering (第四季 / 总第78话) disagrees with TMDB's one-season listing, and
  // the judge doubts nearly every row (Re:从零 patrol: 150 of 155) — a ⚠ on every
  // line tells the agent nothing and costs tokens on every read. Past that point the
  // flags are dropped and one line says why.
  const flags = snapshot.candidates.map((c) => jevUncertaintyFlag(scores[c.id]));
  // Judged on the rows the agent will actually see (viewResourceSnapshot cuts at `limit`).
  const shown = limit === undefined ? flags : flags.slice(0, limit);
  const shownFlagged = shown.filter((flag) => flag !== "").length;
  if (shown.length >= JEV_FLAG_NOISE_MIN_ROWS && shownFlagged > shown.length / 2) {
    const { prefilterScores: _scores, prefilterDropped: _dropped, ...rest } = snapshot;
    return { snapshot: rest, legend: JEV_FLAGS_SUPPRESSED_NOTE, allDroppedWarning: undefined };
  }
  let flagged = 0;
  const candidates = snapshot.candidates.map((c, index) => {
    const flag = flags[index]!;
    if (flag && (limit === undefined || index < limit)) flagged += 1;
    return flag ? { ...c, title: `${c.title}${flag}` } : c;
  });
  // Both prefilter fields are stripped: the agent judges titles, not numbers, and the
  // drop count only ever reaches it through the all-dropped warning below.
  const { prefilterScores: _scores, prefilterDropped: _dropped, ...rest } = snapshot;
  const dropped = snapshot.prefilterDropped ?? 0;
  return {
    snapshot: { ...rest, candidates },
    legend: flagged > 0 ? JEV_UNCERTAIN_LEGEND : undefined,
    allDroppedWarning: candidates.length === 0 && dropped > 0 ? jevAllDroppedWarning(dropped) : undefined,
  };
}

/** Strip quality/subtitle tokens from a search keyword and fold the resulting
 *  whitespace. `stripped` is true ONLY when an actual QUALITY_SUBTITLE_TOKEN was
 *  removed — NOT when mere whitespace was collapsed (so "奥本海默   第二季" does
 *  not falsely trip the strip notice). */
function stripQualitySubtitleTokens(keyword: string): { keyword: string; stripped: boolean } {
  // QUALITY_SUBTITLE_TOKEN has the /g flag → RegExp.test() is stateful on lastIndex.
  // Reset BEFORE and after the test so a non-zero lastIndex (from any prior/concurrent
  // use of this shared regex) can never make `stripped` a false negative.
  QUALITY_SUBTITLE_TOKEN.lastIndex = 0;
  const stripped = QUALITY_SUBTITLE_TOKEN.test(keyword);
  QUALITY_SUBTITLE_TOKEN.lastIndex = 0;
  const cleaned = keyword.replace(QUALITY_SUBTITLE_TOKEN, " ").replace(/\s+/g, " ").trim();
  return { keyword: cleaned, stripped };
}

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
  /** 预搜退避重试的等待毫秒数(默认 PRESEARCH_RETRY_DELAY_MS)。测试注入 0。 */
  presearchRetryDelayMs?: number;
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
  /** Title + aliases + original title. Context for the anime taboo-keyword
   *  warnings only (a year that is part of the title is not a taboo year). Search
   *  keywords are NOT checked against them: the agent may search any name,
   *  繁体/英文 included. */
  titleTerms?: string[];
  /** Movie-only "中文字幕软兜底": when true, the search budget becomes 8+2 (a
   *  RESERVE the agent is told about), and on budget exhaustion the agent is
   *  authorized to land a raw-name match of the CORRECT film as last-resort
   *  coverage (flagged 可能无中字) rather than reportNoCoverage. TV/anime leave
   *  this false so the 中文 floor stays HARD (no 生肉 dumping). */
  subtitleFallback?: boolean;
  /** assrt subtitle provider — when present AND the run is non-CN on a 115 drive,
   *  the orchestrator pre-warms a subtitle snapshot and the agent gets
   *  viewSubtitleSnapshot / transferSubtitle tools. Undefined = no subtitle flow. */
  subtitleProvider?: AssrtProviderPort;
  /** The task's fine-grained search profile — enables the anime taboo-keyword
   *  validator (warnings only, never blocking). 病2b。 */
  searchProfile?: SearchProfile;
  /** Agent memory binding. `titleKey` is computed by the system from the task target
   *  (memoryTitleKey) — the memory tools never take it from the agent, which is what
   *  confines a run to the memory of its own work. Absent = memory tools refuse. */
  memory?: {
    store: AgentMemoryStore;
    accountId: string;
    titleKey: string;
    runId: string;
    /** The drive this run lands on (connected-storage id). Bound by the system like
     *  titleKey: every note this run writes is tagged with it, so a lesson learned on
     *  one drive (a source that failed on 115) is never mistaken for one about another. */
    provider?: string;
    /** The run's brand: notes tagged with it predate concrete drive ids and are
     *  treated as this drive's (and retagged on write). */
    legacyProvider?: string;
    now?: () => string;
  };
  /** A replace_request run: the user asked for these episodes to be swapped. Files
   *  already in the target dirs when the run starts are protected (never deleted,
   *  moved or renamed); the agent rejects the current source and reports
   *  per-episode outcomes. Absent = the replace tools refuse. */
  replace?: {
    requestedEpisodes: string[];
    /** Whether the run carries at least one user message (false = a pending-only
     *  re-check of 待换 episodes). With a message and nothing requested at all,
     *  declareFinish refuses until the agent has identified at least one episode. */
    hasMessages: boolean;
    /** TV messages in this run without episode tags (0 on a movie run: a message about
     *  a film means the film). Such a message is words the agent reads episodes from,
     *  and the episodes requested up front (older 待换 rows, other messages' tags) say
     *  nothing about it — so while this is > 0, declareFinish refuses until the agent
     *  has identified an episode THIS run (see identifiedThisRun). Which message an
     *  episode came from is the agent's call; the system only asks for one. */
    untaggedMessages: number;
    /** Requested episodes whose current source an earlier run already rejected (the
     *  stored list). When every requested episode is in here the agent may transfer
     *  without calling rejectCurrentSource again — see assertRejectedFirst. */
    alreadyRejectedEpisodes?: string[];
    /** One item per (file, episode) the agent grouped together: the file's name, size,
     *  place and id — by which the caller finds the link of the transfer that landed it —
     *  and whether it is a video. The caller writes a rejected row for each video, or for
     *  every file of a group that has none (a subtitle beside a video is not a row). A
     *  throw refuses the whole rejection before the sandbox records any of it (the agent
     *  may call again). */
    onReject: (items: Array<{ episode: string; label: string; sizeBytes: number; reason: string; path: string; fileId: string; isVideo: boolean }>) => Promise<void>;
    /** A recorded "replaced" also carries the agent-named fileIds it was verified by, and
     *  the real total size of that episode's named video file(s), read from its target
     *  dir when reporting (a pack's title would give the whole pack's size). */
    onReport: (
      results: Array<{ episode: string; outcome: "replaced" | "not_found"; candidateId?: string; fileIds?: string[]; sizeBytes?: number; note: string }>,
    ) => Promise<void>;
  };
  /** Whether a search candidate is a copy of a resource the user rejected for this
   *  work (any run — the rejected list is account + work scoped, not replace-only).
   *  The search-side filter cannot catch everything within one run (the raw
   *  pre-search may predate a rejection; a repeated keyword returns the cached
   *  snapshot), so every transfer asks again. Absent = no transfer-time guard. */
  isRejected?: (candidate: { id: string; title: string }) => Promise<boolean>;
  /** Link identity of a candidate the agent names (resourceLinkKey of its url).
   *  Null when the candidate has no share/magnet identity. The agent only sees
   *  titles, so two titles of one link are indistinguishable without this. */
  linkOf?: (candidateId: string) => string | null;
  /** Any run of a work that has kept old + replacement copies (episode_sources):
   *  files already in the target dirs at the start are protected like in a replace
   *  run (never deleted, moved, renamed or flattened away), without the replace
   *  tools. The sandbox has no file↔episode map, so it protects all of them. */
  protectExistingFiles?: boolean;
  /** Listings of the staging directory use this maxDepth. A recovery sets
   *  JANITOR_LIST_DEPTH. Absent: the storage default (ordinary runs). */
  stagingListDepth?: number;
}

/** What the models see of a memory entry (no persistence identifiers). */
export type AgentMemoryView = Pick<AgentMemory, "scope" | "name" | "kind" | "description" | "body" | "provider" | "updatedAt">;

export interface SearchToolResult {
  /** Present on a fresh search and on a dedup (the prior snapshot). */
  snapshot?: ResourceSnapshotV2;
  /** True when the keyword was already searched — returned without re-hitting the provider. */
  deduped?: boolean;
  /** Set when the search budget is exhausted; the agent must decide from what it has. */
  refused?: string;
  /** Movie 8+2 reserve: set on a search performed in the reserve zone (after the
   *  normal 8) — tells the agent it is on its last searches and the subtitle
   *  fallback policy is now in play. */
  note?: string;
  /** Set when quality/subtitle tokens were stripped from the agent's keyword
   *  (C5 guardrail): tells the agent the words were dropped and raw recalls more. */
  notice?: string;
  /** Set when a deduped search is repeated: escalating warning with repeat count.
   *  病2a: 模型必须看见「这是重复」。 */
  repeatNotice?: string;
  /** Anime taboo-keyword validator warnings (year / subtype word / suspected
   *  cross-series token). Warnings only — the search still runs. 病2b。 */
  warnings?: string[];
  /** One-shot reminder that the PREVIOUS large snapshot (≥10 candidates) is
   *  still unfiltered when the agent switches keywords. 病3: 先消化再换词。 */
  digestHint?: string;
}

export interface TransferToolResult {
  attempt: TransferAttemptResult;
  /** The TRUE staging contents after a forced reread — the only evidence the
   *  agent should trust about what actually landed. */
  staging: SimTreeFile[];
  /** When the transfer failed with a SYSTEMIC message (quota / auth / VIP), the
   *  agent should STOP — every candidate will fail. Present only on a systemic
   *  block; absent means ordinary failure (iterate to the next candidate). */
  systemicBlock?: { reason: string };
}

/** One keyword in the run's search history (see TaskSandbox.searchHistory). */
export interface SearchHistoryEntry {
  keyword: string;
  /** How many times the agent (or the system pre-search) asked for it. */
  calls: number;
  /** The LAST call's outcome. */
  outcome: "ok" | "refused" | "error";
  candidateCount: number;
  sampleTitles: string[];
  /** Candidates the Jev prefilter removed (lookalike + NSFW), when it ran. */
  prefilterDropped?: number;
  /** Refusal / error text for a non-ok outcome. */
  note?: string;
}

export class TaskSandbox {
  private readonly provider: ResourceProviderV2;
  private readonly searchBudget: number;
  private readonly presearchRetryDelayMs: number;
  private readonly storage: StorageV2 | undefined;
  private readonly stagingDirectoryId: string | undefined;
  /** TV: season number -> scoped Season directory (multi-season distribution). */
  private readonly seasonDirs: Map<number, string>;
  /** A movie task's one target directory (movies have no seasons). */
  private readonly movieDir: string | undefined;
  private readonly need: string[];
  private readonly titleTerms: readonly string[];
  private readonly subtitleFallback: boolean;
  /** Reserve-zone threshold (movie 8+2) — undefined disables the reserve zone. */
  private readonly softThreshold: number | undefined;
  private readonly profile: SearchProfile | undefined;
  private readonly seenKeywords = new Set<string>();
  private readonly snapshotByKeyword = new Map<string, ResourceSnapshotV2>();
  /** 每个（规范化）关键词被搜索的次数——prime 记 1，agent fresh 记 1，dedup 命中递增。 */
  private readonly searchCountByKeyword = new Map<string, number>();
  private readonly observedSnapshots = new Map<string, ResourceSnapshotV2>();
  private readonly obtainedCodes = new Set<string>();
  /** Set when the agent landed a movie via the 中文字幕 last-resort fallback (no
   *  confirmed 中字). Surfaced in finish() → notification 可能无中文字幕(兜底). */
  private subtitleFallbackUsed = false;
  /** Raw snapshot from pre-warming (system-initiated search). Stored so
   *  viewResourceSnapshot can return it multiple times without cost. */
  private rawSnapshot: ResourceSnapshotV2 | null = null;
  /** assrt provider remembered from primeSubtitleSnapshot so transferSubtitle can
   *  later call detail() without the agent re-passing it. Reassigned on prime, so
   *  NOT readonly — mirrors rawSnapshot. */
  private subtitleProvider: TaskSandboxOptions["subtitleProvider"];
  /** Pre-warmed assrt candidates (id + title + lang), like rawSnapshot for video.
   *  Reassigned by primeSubtitleSnapshot, so NOT readonly. */
  private subtitleSnapshot: AssrtCandidate[] | null = null;
  /** 病3: 待消化的上一大快照（换词搜索时提醒一次，随即清空）。 */
  private pendingDigest: { keyword: string; count: number } | null = null;
  /** 病4: 本任务的审计事件（no_coverage 上报/dedup 重复/禁忌词警告）。runner 持久化到 workflowRun.auditEvents。 */
  private readonly auditEvents: AuditEvent[] = [];
  /** Every search call in order — one entry per distinct keyword (repeats counted),
   *  including refused and failed ones. The reflection digest reads this, NOT the
   *  provider's persisted snapshots: those are deduped by content id, so two keywords
   *  returning the same result collapse and a search that threw leaves no trace. */
  private readonly searchLog: SearchHistoryEntry[] = [];
  private readonly memory: TaskSandboxOptions["memory"];
  /** Writes + deletes made by this task (capped at AGENT_MEMORY_LIMITS.changesPerRunMax). */
  private memoryChanges = 0;
  /** Set the moment a video/subtitle transfer is ATTEMPTED (before the provider call,
   *  so a transfer that threw still counts). Read by hasTransferEvidence. */
  private transferAttempted = false;
  private readonly replace: TaskSandboxOptions["replace"];
  private readonly isRejected: TaskSandboxOptions["isRejected"];
  private readonly protectExistingFiles: boolean;
  private readonly stagingListDepth: number | undefined;
  /** Set once captureProtectedFiles has listed the target dirs (see assertRejectedFirst). */
  private protectedCaptured = false;
  /** Replace runs: every file in a target dir when the run started (the user's
   *  current copy — it must survive the run), keyed by id, with its dir label
   *  ("Season 01", or "" for the movie dir). Only these can be rejected. */
  private readonly protectedFiles = new Map<string, { file: SimTreeFile; dirLabel: string }>();
  /** Episodes already reported this run, with the outcome recorded. */
  private readonly reportedEpisodes = new Map<string, "replaced" | "not_found">();
  /** Episodes the agent rejected via rejectCurrentSource (in order). */
  private readonly rejectedEpisodes: string[] = [];
  /** Episodes the agent declared have no old file in the library (a rejectCurrentSource
   *  group with fileIds []): nothing to reject, so they pass the reject-before-transfer
   *  gate without a rejected row. The sandbox has no file↔episode map, so this is the
   *  agent's call (see assertRejectedFirst). */
  private readonly noFileEpisodes: string[] = [];
  /** Candidates that landed this run (reportReplacement's evidence): a succeeded
   *  attempt, or a failed one that still materialized files (quark marks some
   *  landings failed — the landing point is the truth, not the status flag). */
  private readonly succeededCandidates = new Set<string>();
  /** Every file a landed transfer materialized this run → the candidate that landed it
   *  (transferCandidate / each landed attempt of transferUntilLanded). A "replaced"
   *  names its episode's new files; each (subtitles aside — real drives never record
   *  them) must be in here, under the reported candidate — so the old file (pre-run) or
   *  a made-up id never counts. Where such a file is NOW is read from the target dirs
   *  when the agent reports (reportReplacement). */
  private readonly materializedBy = new Map<string, string>();
  /** file id → where it stands. Only "kept" made it into a target directory.
   *  A movie lands in its own directory, so those files start kept. Anything
   *  still "staging" when fate is read (end of run) was thrown away, same as
   *  a file deleted or discarded with the staging dir. */
  private readonly filePlace = new Map<string, "kept" | "staging" | "thrown">();
  private readonly linkOf: TaskSandboxOptions["linkOf"];
  /** Link key → the alias that reserved it. `landed` stays false until that
   *  attempt materializes files; a concurrent call sees the reservation either way. */
  private readonly linkHold = new Map<string, { owner: string; landed: boolean }>();
  /** File → the episode it backs, for every "replaced" recorded this run. One new file
   *  backs one episode: E24 can never be reported replaced by E13's file. A backing file
   *  can no longer be deleted this run (see deleteFiles). */
  private readonly fileBackedEpisode = new Map<string, string>();
  /** Ids from a moveToSeason that threw MOVE_NOT_DONE and that a later successful
   *  move or deleteFiles has not cleared. The harness reads this and will not
   *  delete staging while it is non-empty — those files may be the only copies. */
  private readonly unmovedFileIds = new Set<string>();
  /** Set only when discardStaging returns. A recovery finish is not permission
   *  to delete the leftover; the harness coverage read of finish() is not either. */
  private leftoverDiscarded = false;

  constructor(options: TaskSandboxOptions) {
    this.provider = options.provider;
    this.subtitleFallback = options.subtitleFallback ?? false;
    // Movie 8+2: default to MOVIE_SEARCH_BUDGET (10) with a reserve at 8 when the
    // subtitle fallback is on; otherwise the normal hard-8 (no reserve zone).
    this.searchBudget =
      options.searchBudget ?? (this.subtitleFallback ? MOVIE_SEARCH_BUDGET : MAX_DISTINCT_PLANNING_SEARCHES);
    this.presearchRetryDelayMs = options.presearchRetryDelayMs ?? PRESEARCH_RETRY_DELAY_MS;
    this.softThreshold = this.subtitleFallback ? MOVIE_SEARCH_SOFT_THRESHOLD : undefined;
    this.storage = options.storage;
    this.stagingDirectoryId = options.stagingDirectoryId;
    this.profile = options.searchProfile;
    this.seasonDirs = new Map(
      Object.entries(options.targetSeasonDirectoryIds ?? {}).map(([season, id]) => [Number(season), id]),
    );
    this.movieDir = options.targetMovieDirectoryId;
    this.need = [...(options.need ?? [])];
    this.titleTerms = options.titleTerms ?? [];
    this.subtitleProvider = options.subtitleProvider;
    this.memory = options.memory;
    this.replace = options.replace;
    this.isRejected = options.isRejected;
    this.linkOf = options.linkOf;
    this.protectExistingFiles = options.protectExistingFiles === true;
    this.stagingListDepth = options.stagingListDepth;
  }

  /** A listing. The staging directory of a recovery is walked to the depth the
   *  janitor already verified; every other directory keeps the storage default. */
  private listTreeOf(directoryId: string): Promise<SimTreeFile[]> {
    if (!this.storage) {
      throw new Error("SANDBOX: no storage configured");
    }
    if (directoryId === this.stagingDirectoryId && this.stagingListDepth !== undefined) {
      return this.storage.listTree({ directoryId, maxDepth: this.stagingListDepth });
    }
    return this.storage.listTree({ directoryId });
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

  /** A movie task: exactly one movie dir and no seasons, so its staging IS that dir (a
   *  materialized transfer is already in the target). TV tasks always carry season
   *  dirs, even single-season, so their staging is a separate directory. */
  private isMovieRun(): boolean {
    return this.movieDir !== undefined && this.seasonDirs.size === 0;
  }

  /** Remember which candidate materialized which files this run (reportReplacement
   *  checks the files an agent names for an episode against it). */
  private recordMaterialized(candidateId: string, fileIds: string[]): void {
    const initial = this.isMovieRun() ? "kept" : "staging";
    for (const id of fileIds) {
      this.materializedBy.set(id, candidateId);
      if (!this.filePlace.has(id)) this.filePlace.set(id, initial);
    }
  }

  private markKept(fileIds: readonly string[]): void {
    for (const id of fileIds) {
      if (this.materializedBy.has(id) && this.filePlace.get(id) !== "thrown") this.filePlace.set(id, "kept");
    }
  }

  private markThrown(fileIds: readonly string[]): void {
    for (const id of fileIds) {
      if (this.materializedBy.has(id)) this.filePlace.set(id, "thrown");
    }
  }

  /** Take the link synchronously, before the transfer await. Returns the hold
   *  already owned by another alias (in flight or landed); null means this call
   *  now owns it. A link with no identity is never held. */
  private reserveLink(candidateId: string): { owner: string; landed: boolean } | null {
    const link = this.linkOf?.(candidateId);
    if (!link) return null;
    const existing = this.linkHold.get(link);
    if (existing) return existing;
    this.linkHold.set(link, { owner: candidateId, landed: false });
    return null;
  }

  /** Drop a reservation that materialized nothing, including a transfer that threw. */
  private releaseLink(candidateId: string): void {
    const link = this.linkOf?.(candidateId);
    if (!link) return;
    const hold = this.linkHold.get(link);
    if (hold && hold.owner === candidateId && !hold.landed) this.linkHold.delete(link);
  }

  private keepLink(candidateId: string): void {
    const link = this.linkOf?.(candidateId);
    if (!link) return;
    const hold = this.linkHold.get(link);
    if (hold && hold.owner === candidateId) hold.landed = true;
  }

  private sameLinkError(candidateId: string, hold: { owner: string; landed: boolean }): string {
    const why = hold.landed
      ? "whose files already landed this run — inspect them instead of transferring again"
      : "which is being transferred right now — wait for that result and inspect it instead of transferring again";
    return `SANDBOX_SAME_LINK: ${candidateId} is the same link as ${hold.owner}, ${why}`;
  }

  private sameLinkNote(hold: { owner: string; landed: boolean }): string {
    return hold.landed
      ? `same link as ${hold.owner} already landed this run`
      : `same link as ${hold.owner}, which is being transferred right now — wait for that result and inspect it instead of transferring again`;
  }

  private fateOf(fileIds: Iterable<string>): { kept: number; thrownAway: number } {
    let kept = 0;
    let thrownAway = 0;
    for (const id of fileIds) {
      if (this.filePlace.get(id) === "kept") kept += 1;
      else thrownAway += 1;
    }
    return { kept, thrownAway };
  }

  /** What became of the files one candidate materialized. Files still in staging
   *  count as thrown away — this is read after the run, for the reflection. */
  materializedFate(candidateId: string): { kept: number; thrownAway: number } {
    const ids: string[] = [];
    for (const [fileId, owner] of this.materializedBy) {
      if (owner === candidateId) ids.push(fileId);
    }
    return this.fateOf(ids);
  }

  /** Same counts for an explicit file-id list (a persisted attempt's ids, which
   *  are keyed by the provider's real candidate id, not the agent's alias).
   *  Undefined when this run did not materialize any of them. */
  materializedFateOf(fileIds: readonly string[]): { kept: number; thrownAway: number } | undefined {
    const known = fileIds.filter((id) => this.materializedBy.has(id));
    if (known.length === 0) return undefined;
    return this.fateOf(known);
  }

  /** Whether every needed token has been confirmed obtained — the gate that
   *  stops the agent from acquiring past the point of coverage (莉可丽丝 scar). */
  isCoverageMet(): boolean {
    return this.need.length > 0 && this.need.every((token) => this.countsAsObtained(token));
  }

  private missingNeed(): string[] {
    return this.need.filter((token) => !this.countsAsObtained(token));
  }

  /** Replace runs: the episodes the user wants swapped (requested or rejected this
   *  run). Their OLD file is already in the library, so a mark proves nothing until
   *  a new file has landed — see markObtained. Empty outside a replace run. */
  private replaceGuardedEpisodes(): Set<string> {
    return new Set(this.replaceEpisodes());
  }

  /** Every episode this replace run is about, in order: requested, then rejected or
   *  declared file-less this run. Empty outside a replace run. */
  private replaceEpisodes(): string[] {
    if (!this.replace) return [];
    return [...new Set([...this.replace.requestedEpisodes, ...this.rejectedEpisodes, ...this.noFileEpisodes])];
  }

  /** Whether a marked token counts: toward coverage, and as obtained in finish(). A
   *  replace-guarded episode counts only once reportReplacement recorded it replaced
   *  (which checks its mark, a landed candidate and the episode's own new files in the
   *  target). A mark alone is not enough: it may predate the rejection, or be unlocked
   *  by a transfer that carried a different episode — either way the old file would
   *  close the transfer gate before this episode was ever replaced. */
  private countsAsObtained(token: string): boolean {
    if (!this.obtainedCodes.has(token)) return false;
    return !this.replaceGuardedEpisodes().has(token) || this.reportedEpisodes.get(token) === "replaced";
  }

  /** Search one keyword. Repeats are deduped (no extra provider hit); distinct
   *  searches are capped by the budget. Every observed snapshot is recorded so a
   *  later transferCandidate can be bound to a snapshot seen in THIS task. */
  async searchResources(keyword: string): Promise<SearchToolResult> {
    // C5 guardrail: PanSou wildcard-matches share titles, which almost never carry
    // 画质/字幕 markers — so a quality/subtitle-laden keyword collapses recall to a
    // subset or to ZERO (实测 铁拳教育 84→+1080p=0, 奥本海默 185→+中字=0). Strip those
    // tokens so the bare title is what gets searched, and tell the
    // agent the words were dropped (raw recalls the most). Not a hard reject — it
    // does not second-guess the agent's title choice, only removes proven-dead noise.
    const stripped = stripQualitySubtitleTokens(keyword);
    const effectiveKeyword = stripped.keyword;
    // Nothing left to search ("1080p 中字" is all quality/subtitle words). Refused
    // before the budget and the provider, like the budget-exhausted case.
    if (effectiveKeyword === "") {
      this.logSearch(keyword, { outcome: "refused", note: "empty keyword after stripping quality/subtitle words" });
      return {
        refused: `关键词「${keyword}」去掉画质/字幕词后是空的,没有可搜的内容。请用片名搜(裸片名召回最全)。`,
      };
    }

    const normalized = normalizeSearchKeyword(effectiveKeyword);
    const notice = stripped.stripped ? STRIP_NOTICE : undefined;

    // 病2b: anime taboo-keyword validator (warnings only, before dedup).
    const tabooWarnings = this.profile
      ? animeSearchTabooWarnings({ keyword: effectiveKeyword, profile: this.profile, titleTerms: this.titleTerms })
      : [];
    if (tabooWarnings.length > 0) {
      this.auditEvents.push({
        type: "search_taboo_warning",
        message: `搜索词「${effectiveKeyword}」触发动漫禁忌词警告 ${tabooWarnings.length} 条`,
        data: { keyword: effectiveKeyword, warnings: tabooWarnings },
      });
    }

    // 病3: take the digestion hint — only when switching keywords (the current
    // normalized keyword differs from the pending one). The stored keyword is the
    // EFFECTIVE (original-case) form for display — case-consistent with
    // repeatNotice — so the comparison normalizes it first.
    const digestHint =
      this.pendingDigest && normalizeSearchKeyword(this.pendingDigest.keyword) !== normalized
        ? `提示：上一快照「${this.pendingDigest.keyword}」有 ${this.pendingDigest.count} 个候选尚未筛过——候选列表就在你此前那次 searchResources 的返回里，回读不花预算；先消化再换词通常更快。`
        : undefined;
    if (digestHint) this.pendingDigest = null;

    // Check dedup FIRST — if this keyword was already searched (either by agent
    // or by system pre-warming), return the cached snapshot without hitting the
    // provider or consuming budget. This covers both agent re-searches and agent
    // searching a keyword that was pre-warmed.
    //
    // 但 dedup 只信任健康快照:缓存不健康(unreachable/protocol_error/degraded)时
    // 不算「已搜过」,落到下方真实搜索重打 provider。事故原形:PanSou 抖动时的
    // 「双源全挂 0 候选快照」被 dedup 永久钉死关键词,agent 复搜根本没打到已恢复的
    // 源,一次瞬断被放大成「该片候选池永久丢失」(《猛攻》4K 大文件全程没被搜出)。
    const cachedSnapshot = this.snapshotByKeyword.get(normalized);
    const cachedUntrusted = cachedSnapshot !== undefined && !isSnapshotHealthTrusted(cachedSnapshot);
    if (cachedSnapshot && !cachedUntrusted) {
      const count = (this.searchCountByKeyword.get(normalized) ?? 1) + 1;
      this.searchCountByKeyword.set(normalized, count);
      this.logSearch(effectiveKeyword, { outcome: "ok", snapshot: cachedSnapshot });
      this.auditEvents.push({
        type: "search_dedup",
        message: `重复搜索「${effectiveKeyword}」第 ${count} 次`,
        data: { keyword: effectiveKeyword, count },
      });
      // 复搜必须跟首搜讲同一个故事:同样的 ⚠ 标记、同样的说明。否则 agent 第二次
      // 看到一份「干净」的快照,前一次的存疑提示就凭空消失了。(dedup 只可能命中
      // 健康快照——不健康缓存走下方重搜路径——所以这里没有源健康警告可带。)
      const dedupWarnings = [...tabooWarnings];
      const cachedView = presentSnapshotForAgent(cachedSnapshot);
      if (cachedView.legend) dedupWarnings.push(cachedView.legend);
      if (cachedView.allDroppedWarning) dedupWarnings.push(cachedView.allDroppedWarning);
      return {
        snapshot: cachedView.snapshot,
        deduped: true,
        repeatNotice: this.repeatNotice(effectiveKeyword, count, cachedSnapshot.candidates.length),
        ...(notice ? { notice } : {}),
        ...(dedupWarnings.length > 0 ? { warnings: dedupWarnings } : {}),
        ...(digestHint ? { digestHint } : {}),
      };
    }

    // 源故障触发的重搜不是新的 distinct 搜索:跳过预算闸,下面也不进 seenKeywords
    // ——重打已坏过一次的关键词不许吃掉 agent 的搜索名额。
    //
    // 免费重搜(不占预算的这些重搜)的狂搜兜底不在预算闸,而在 repetition-stop:
    // 生产快照是内容寻址的、V2 视图又不带时间戳 → 同内容同 id → 同结果文本,
    // 4 连相同就被 repetition-stop 收掉。若未来快照 id 引入随机性,需另设重搜上限。
    const decision = cachedUntrusted
      ? "fresh"
      : decideSearchGate({
          normalizedKeyword: normalized,
          seenKeywords: this.seenKeywords,
          maxDistinctSearches: this.searchBudget,
          ...(this.softThreshold === undefined ? {} : { softThreshold: this.softThreshold }),
        });
    if (decision === "duplicate") {
      // 防御窗口:seenKeywords 有词、snapshotByKeyword 无快照。钉词已挪到成功
      // 缓存之后(下方),正常流程不再产生这个状态;但旧「抛错钉死」就是这个形状
      // (provider 抛错在缓存快照前就钉词,与坏快照钉死同一事故),一旦再现,
      // 裸返回 {deduped:true} 会让 agent 既不打 provider 又拿不到任何证据、还
      // 白烧一轮——所以兜底走真实搜索:该词已在 seenKeywords,预算计数不变。
      console.warn(`[sandbox] duplicate keyword without cached snapshot keyword=${normalized} — falling back to a real search`);
    } else if (decision === "exhausted") {
      this.logSearch(effectiveKeyword, { outcome: "refused", note: "search budget exhausted" });
      return { refused: this.budgetExhaustedMessage() };
    }
    // "fresh" and "reserve" both perform the search; "reserve" (movie 8+2) attaches
    // the note that flips the agent into last-resort subtitle-fallback mode.
    let snapshot: ResourceSnapshotV2;
    try {
      snapshot = await this.provider.search(effectiveKeyword);
    } catch (error) {
      this.logSearch(effectiveKeyword, { outcome: "error", note: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    this.logSearch(effectiveKeyword, { outcome: "ok", snapshot });
    this.snapshotByKeyword.set(normalized, snapshot);
    // 钉词只在成功缓存快照之后:provider 抛错不留痕(不进 seenKeywords、不占预算),
    // agent 重试同词自然走真搜——重试真实失败是合理行为,而不是被 duplicate 裸
    // 返回钉死(抛错钉死)。源故障重搜(缓存不健康)照旧不钉:它不是新的 distinct
    // 搜索,不占 agent 的搜索名额。
    if (!cachedUntrusted) this.seenKeywords.add(normalized);
    // 预搜的那份(活期文档)就是被替换的坏快照时,viewResourceSnapshot 跟着换——
    // 否则 agent 眼前的活期文档还是旧的坏快照。
    if (this.rawSnapshot === cachedSnapshot) this.rawSnapshot = snapshot;
    if (cachedUntrusted) {
      // 这次是源故障触发的重搜:搜索次数照记(它是真实的一搜),预算未占(见上)。
      this.searchCountByKeyword.set(normalized, (this.searchCountByKeyword.get(normalized) ?? 1) + 1);
      this.auditEvents.push({
        type: "search_health_retry",
        message: `缓存快照不健康(${cachedSnapshot.sourceHealth?.status ?? "未知"})不予采信,已重搜「${effectiveKeyword}」的真实源`,
        data: {
          keyword: effectiveKeyword,
          cachedStatus: cachedSnapshot.sourceHealth?.status ?? "unknown",
          cachedCandidateCount: cachedSnapshot.candidates.length,
        },
      });
    } else {
      this.searchCountByKeyword.set(normalized, 1);
    }
    this.observedSnapshots.set(snapshot.id, snapshot);

    // 病3: register a large fresh snapshot for later digestion hint. Store the
    // effective (original-case) keyword for display; the trigger comparison
    // normalizes it.
    if (snapshot.candidates.length >= LARGE_SNAPSHOT_DIGEST_THRESHOLD) {
      this.pendingDigest = { keyword: effectiveKeyword, count: snapshot.candidates.length };
    }

    // Task 9: 源不健康 → 明确告诉 agent 证据不完整。没有这一步,源挂掉与「确实
    // 没有」在 agent 眼里同形(都是空候选),它只会 reportNoCoverage。
    const healthWarning = sourceHealthWarning(snapshot.sourceHealth);
    if (healthWarning) {
      this.auditEvents.push({
        type: "search_source_unhealthy",
        message: `搜索「${effectiveKeyword}」时搜索源不健康(${snapshot.sourceHealth!.status}): ${snapshot.sourceHealth!.unhealthySources.join("、") || "未知"}`,
        data: {
          keyword: effectiveKeyword,
          status: snapshot.sourceHealth!.status,
          unhealthySources: snapshot.sourceHealth!.unhealthySources,
        },
      });
    }
    const searchWarnings = healthWarning ? [...tabooWarnings, healthWarning] : [...tabooWarnings];

    // 源故障重搜要告知「缓存没被采信」——否则 agent 以为自己拿到的还是同一份旧证据。
    // 旧候选不机械并进新快照(内容寻址 id / observedSnapshots 绑定不许被改写),
    // 而是提示 agent 去对照自己此前拿到的那份(degraded 缓存常带候选,别丢线索)。
    // 措辞是条件式:不健康缓存可能来自预搜、agent 还没读过(viewResourceSnapshot
    // 没叫过、也不在其 searchResources 返回里),那种「仍在你此前的返回里」是假的。
    if (cachedUntrusted) {
      const oldCount = cachedSnapshot.candidates.length;
      const oldSources = cachedSnapshot.sourceHealth?.unhealthySources.join("、") ?? "";
      searchWarnings.unshift(
        `上次搜索「${effectiveKeyword}」的缓存快照来自不健康的搜索源(${cachedSnapshot.sourceHealth?.status ?? "未知"}${oldSources ? `：${oldSources}` : ""}),不予采信;本次已重搜真实源,以下为新结果。` +
          (oldCount > 0 ? `若你此前已读过该快照,上次有 ${oldCount} 条候选可对照;未读过则请以本次结果为准。` : ""),
      );
    }

    // 内部各表(snapshotByKeyword / observedSnapshots / rawSnapshot)保留原始快照;
    // 只有交给 agent 的这一份带 ⚠ 标记且不含原始分数。
    const view = presentSnapshotForAgent(snapshot);
    if (view.legend) searchWarnings.push(view.legend);
    if (view.allDroppedWarning) searchWarnings.push(view.allDroppedWarning);

    return {
      snapshot: view.snapshot,
      ...(decision === "reserve" ? { note: this.reserveNote() } : {}),
      ...(notice ? { notice } : {}),
      ...(searchWarnings.length > 0 ? { warnings: searchWarnings } : {}),
      ...(digestHint ? { digestHint } : {}),
    };
  }

  /** Budget-exhausted refusal. For a movie (subtitle fallback) it authorizes the
   *  last-resort raw landing; otherwise the original hard-stop message (the 中文
   *  floor stays hard for TV/anime). */
  private budgetExhaustedMessage(): string {
    if (this.subtitleFallback) {
      return `搜索预算已用尽(${this.searchBudget} 次)。立刻从已有证据决策:若已确认正确影片的 raw 名匹配,就兜底 transferCandidate 落它,并在 markObtained 时带 subtitleFallback(系统会标注「可能无中文字幕」);只有连正确影片的任何候选都没有时,才 reportNoCoverage。`;
    }
    return `search budget exhausted (${this.searchBudget} distinct searches); decide from the evidence already gathered`;
  }

  /** The reserve-zone note (movie 8+2) attached to searches 9–10. */
  private reserveNote(): string {
    const reserve = this.searchBudget - (this.softThreshold ?? this.searchBudget);
    return `⚠️ 中字搜索预算(${this.softThreshold})已用满,还剩 ${reserve} 次预留。用它做最后的裸名/抖动复搜;若仍找不到带中字的版本、但已确认正确影片的 raw 名匹配,就直接 transferCandidate 兜底落它(markObtained 带 subtitleFallback,系统标注「可能无中字」),不要 reportNoCoverage —— 有正片胜过没有,且该版实际未必无中字。`;
  }

  /** 病2a: dedup 强提示。第 2 次报次数；第 3-4 次升级警告；第 5 次起文本固定——
   *  固定是刻意的：递增计数会让重复步骤的 result 每次不同，反而令 repetition-stop
   *  的「4 连相同」永远不命中。 */
  private repeatNotice(keyword: string, count: number, candidateCount: number): string {
    if (count >= 5) {
      return `⚠️ 「${keyword}」已重复多次搜索，结果不会再变（共 ${candidateCount} 候选）。这已被视为无进展：立即基于已有证据决策（transferCandidate 或 reportNoCoverage）。`;
    }
    const escalation = count >= 3 ? "再重复将视为无进展。" : "";
    return `⚠️ 「${keyword}」已是第 ${count} 次搜索（结果与上次相同，共 ${candidateCount} 候选）。换实质不同的新词，或立即基于已有证据决策。${escalation}`;
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
    return this.listTreeOf(this.stagingDirectoryId);
  }

  /** Read-only list of the wrapper subdirectories currently in staging.
   *  Not on the agent toolset (the agent works from inspectStaging's flat tree
   *  and wipes leftovers with discardStaging); kept for tests / hands-on debug. */
  async inspectStagingDirs(): Promise<Array<{ id: string; path: string }>> {
    if (!this.storage || !this.stagingDirectoryId) {
      throw new Error("SANDBOX: no storage/staging handle configured");
    }
    return this.storage.listSubdirectories(
      this.stagingListDepth === undefined
        ? { directoryId: this.stagingDirectoryId }
        : { directoryId: this.stagingDirectoryId, maxDepth: this.stagingListDepth },
    );
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
      return this.listTreeOf(dir);
    }
    const trees = await Promise.all(
      this.allTargetDirIds().map((directoryId) => this.listTreeOf(directoryId)),
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
    const candidate = this.findObservedCandidate(input.candidateId, input.snapshotId);
    if (!candidate) {
      throw new Error(`SANDBOX_CANDIDATE_NOT_IN_SNAPSHOT: ${input.candidateId} is not in ${input.snapshotId}`);
    }
    this.assertRejectedFirst();
    if (this.isRejected && (await this.isRejected({ id: candidate.id, title: candidate.title }))) {
      throw new Error(
        `SANDBOX_CANDIDATE_REJECTED: ${input.candidateId} is a copy of a resource the user rejected — pick a different one`,
      );
    }
    const held = this.reserveLink(input.candidateId);
    if (held) throw new Error(this.sameLinkError(input.candidateId, held));
    this.transferAttempted = true;
    let attempt;
    try {
      attempt = await this.storage.transferCandidate({
        candidateId: input.candidateId,
        intoDirectoryId: this.stagingDirectoryId,
      });
    } catch (error) {
      this.releaseLink(input.candidateId);
      throw error;
    }
    if (attempt.status === "succeeded" || attempt.materializedFileIds.length > 0) {
      this.succeededCandidates.add(input.candidateId);
      this.recordMaterialized(input.candidateId, attempt.materializedFileIds);
    }
    // An empty id list landed nothing, even when the status says succeeded.
    if (attempt.materializedFileIds.length > 0) this.keepLink(input.candidateId);
    else this.releaseLink(input.candidateId);
    const staging = await this.listTreeOf(this.stagingDirectoryId);
    // A systemic block ONLY when nothing actually landed — a provider can mark an
    // attempt failed yet materialize files (e.g. quark); the truth is the landing
    // point (staging / materializedFileIds), not the status flag.
    const nothingLanded = staging.length === 0 && attempt.materializedFileIds.length === 0;
    const systemicBlock =
      attempt.status === "failed" && nothingLanded && isSystemicTransferBlockMessage(attempt.providerMessage)
        ? { reason: attempt.providerMessage!.trim() }
        : undefined;
    return { attempt, staging, ...(systemicBlock ? { systemicBlock } : {}) };
  }

  /** MOVIE-ONLY: transfer an AGENT-ORDERED list of candidates the agent judged to
   *  be the SAME target film (best → next-best by resource name), stopping at the
   *  FIRST that 秒传-lands; the rest are abandoned. The candidate SET is the agent's
   *  semantic choice (a wildcard search returns same-named DIFFERENT works — never
   *  iterate the raw result set); the system only burns through the dead links in
   *  that vetted, ordered set. FAIL-LOUD SHARE LINKS ONLY (115/夸克/天翼/123/光鸭
   *  转存分享): every share-transfer brand fails loud on a dead link (链接已过期/
   *  分享已取消/分享不存在 come back at once), so iterate-on-failure is sound; a
   *  magnet's success is only knowable via the landing point, so magnets (and
   *  unknown links) are rejected — use transferCandidate + inspectStaging for
   *  those. TV/anime never gets this tool (it must not be confused with
   *  multi-resource season coverage). Refused once coverage is met.
   *  Force-rereads staging. */
  async transferUntilLanded(input: { candidateIds: string[] }): Promise<{
    landed: SimTreeFile[];
    transferredCandidateId: string | null;
    attempts: Array<{ candidateId: string; status: "succeeded" | "failed"; providerMessage?: string }>;
    systemicBlock?: { reason: string };
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
    this.assertRejectedFirst();
    const observed = new Map<string, ResourceSnapshotV2["candidates"][number]>();
    for (const candidateId of input.candidateIds) {
      const candidate = this.findObservedCandidate(candidateId);
      if (!candidate) {
        throw new Error(`SANDBOX_CANDIDATE_NOT_OBSERVED: ${candidateId} was not seen in a search this task`);
      }
      observed.set(candidateId, candidate);
    }
    for (const candidateId of input.candidateIds) {
      if (this.storage.candidateLinkKind(candidateId) !== "share") {
        throw new Error(
          `SANDBOX_TRANSFER_UNTIL_LANDED_REQUIRES_SHARE_LINK: ${candidateId} is not a fail-loud share link ` +
            "(115/夸克/天翼/123/光鸭 转存分享) — use transferCandidate for magnets and verify via the landing point",
        );
      }
    }
    const attempts: Array<{ candidateId: string; status: "succeeded" | "failed"; providerMessage?: string }> = [];
    let transferredCandidateId: string | null = null;
    let systemicBlock: { reason: string } | undefined;
    for (const candidateId of input.candidateIds) {
      // A copy of what the user rejected is skipped like a dead link (recorded, not
      // transferred) so the rest of the agent's ordered list still runs.
      if (this.isRejected && (await this.isRejected({ id: candidateId, title: observed.get(candidateId)!.title }))) {
        attempts.push({ candidateId, status: "failed", providerMessage: "user rejected" });
        continue;
      }
      // Same as a rejected copy: record it and keep going, so the rest of the
      // ranked list still runs. The hold is either files already landed, or a
      // transfer of this link that has not returned yet.
      const held = this.reserveLink(candidateId);
      if (held) {
        attempts.push({ candidateId, status: "failed", providerMessage: this.sameLinkNote(held) });
        continue;
      }
      this.transferAttempted = true;
      let attempt;
      try {
        attempt = await this.storage.transferCandidate({
          candidateId,
          intoDirectoryId: this.stagingDirectoryId,
        });
      } catch (error) {
        this.releaseLink(candidateId);
        throw error;
      }
      attempts.push({
        candidateId,
        status: attempt.status,
        ...(attempt.providerMessage ? { providerMessage: attempt.providerMessage } : {}),
      });
      // Failed-but-landed (quark) counts too: the landing point, not the status flag.
      // The loop still stops only on succeeded.
      if (attempt.status === "succeeded" || attempt.materializedFileIds.length > 0) {
        this.succeededCandidates.add(candidateId);
        this.recordMaterialized(candidateId, attempt.materializedFileIds);
      }
      if (attempt.materializedFileIds.length > 0) this.keepLink(candidateId);
      else this.releaseLink(candidateId);
      if (attempt.status === "succeeded") {
        transferredCandidateId = candidateId;
        break;
      }
      // Layer-1: stop on the first failure that is a SYSTEMIC block (quota / auth /
      // VIP) — it may come after one or more dead-link failures, but once we see a
      // systemic one every remaining candidate will fail the same way, so don't
      // grind the rest of the list (the 心灵奇旅 13-transfer waste). Ordinary
      // dead-link failures (过期/取消/错链) keep iterating to the next candidate.
      // Only a block if THIS attempt landed nothing — a provider can materialize
      // files yet mark the attempt failed (e.g. quark); trust the landing point.
      if (attempt.materializedFileIds.length === 0 && isSystemicTransferBlockMessage(attempt.providerMessage)) {
        systemicBlock = { reason: attempt.providerMessage!.trim() };
        break;
      }
      // no_target_change with nothing landed: on an async-copy brand (123's
      // fire-copy + settle window) this can be a FALSE miss — the server-side copy
      // may land AFTER the window. Burning the next candidate now could double-land
      // the film once the slow copy arrives, so STOP and hand judgment back to the
      // agent (its runbook: re-read via inspectStaging BEFORE re-transferring or
      // writing the candidate off). Loud dead links (non-ntc) keep iterating —
      // their death is proven, not pending.
      if (attempt.noTargetChange === true && attempt.materializedFileIds.length === 0) {
        break;
      }
    }
    const landed = await this.listTreeOf(this.stagingDirectoryId);
    return { landed, transferredCandidateId, attempts, ...(systemicBlock ? { systemicBlock } : {}) };
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
    // A budget refusal here never reaches the move loop, so it has to hold the
    // ids itself — otherwise markObtained plus harness cleanup deletes the only copies.
    let stagingTree;
    try {
      stagingTree = await this.listTreeOf(this.stagingDirectoryId);
    } catch (error) {
      const ids = resolved.flatMap((move) => move.fileIds);
      for (const fileId of ids) this.unmovedFileIds.add(fileId);
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `MOVE_NOT_DONE: these files did NOT move (${ids.join(", ")}). Do not markObtained their episodes this run — they are still only in staging. ${reason}`,
      );
    }
    const stagingIds = new Set(stagingTree.map((file) => file.id));
    const outOfScope = resolved.flatMap((move) => move.fileIds).filter((fileId) => !stagingIds.has(fileId));
    if (outOfScope.length > 0) {
      throw new Error(`SANDBOX_FILES_NOT_IN_STAGING: ${outOfScope.join(",")}`);
    }
    // A movie's staging IS its movie dir, so the old film sits "in staging" too.
    this.assertNotProtected(resolved.flatMap((move) => move.fileIds));
    // Hold every validated id before the first move. A throw on season 1 must not
    // leave season 2's files unmarked — the loop never reaches them.
    for (const fileId of resolved.flatMap((move) => move.fileIds)) {
      this.unmovedFileIds.add(fileId);
    }
    // Execute each move (the system does the per-file moves under the hood).
    // A failure — a 115 budget refusal in particular — must come back saying the
    // files did not move. The agent otherwise marks the episodes obtained and the
    // only copies sit in staging (2026-09-27, 14 episodes).
    for (const move of resolved) {
      // null = moveFiles threw before any list. A returned list, even a short one,
      // is the ids already in the season; only the rest are still only in staging.
      let landed: readonly string[] | null = null;
      try {
        const moved = await this.storage.moveFiles({ fileIds: move.fileIds, targetDirectoryId: move.targetDir });
        landed = moved.moved;
        // A movie's target IS staging, so those files were already kept at landing.
        // 115 can answer ok:false and return moved: [] — those files are still in staging.
        if (move.targetDir !== this.stagingDirectoryId) this.markKept(moved.moved);
        if (moved.moved.length !== move.fileIds.length) {
          throw new Error(`moveFiles moved ${moved.moved.length} of ${move.fileIds.length}`);
        }
        for (const fileId of move.fileIds) {
          this.unmovedFileIds.delete(fileId);
        }
      } catch (error) {
        const landedIds = new Set(landed ?? []);
        for (const fileId of move.fileIds) {
          if (landedIds.has(fileId)) this.unmovedFileIds.delete(fileId);
          else this.unmovedFileIds.add(fileId);
        }
        const reason = error instanceof Error ? error.message : String(error);
        const missed = landed === null ? move.fileIds : move.fileIds.filter((fileId) => !landedIds.has(fileId));
        throw new Error(
          `MOVE_NOT_DONE: these files did NOT move (${missed.join(", ")}). Do not markObtained their episodes this run — they are still only in staging. ${reason}`,
        );
      }
    }
    // Force-reread every touched target season + staging for one-shot verification.
    const seasons: Record<number, SimTreeFile[]> = {};
    for (const move of resolved) {
      if (move.season !== undefined) {
        seasons[move.season] = await this.listTreeOf(move.targetDir);
      }
    }
    return { seasons, staging: await this.listTreeOf(this.stagingDirectoryId) };
  }

  /** Delete agent-chosen files from a named scoped directory (the dedup
   *  keep-larger execution, or residue cleanup). Scope guard: every id must
   *  currently be in that directory — no deleting arbitrary/raw ids. Rereads.
   *  Replace runs: neither a pre-run file nor one reported as a replacement this run. */
  async deleteFiles(input: {
    directory: "staging" | "season";
    season?: number;
    fileIds: string[];
  }): Promise<{ deleted: string[]; directory: SimTreeFile[] }> {
    if (!this.storage) {
      throw new Error("SANDBOX: no storage configured");
    }
    this.assertNotProtected(input.fileIds);
    this.assertNotBackingReplacement(input.fileIds);
    const directoryId =
      input.directory === "season" ? this.resolveTargetDir(input.season) : this.stagingDirectoryId;
    if (!directoryId) {
      throw new Error(`SANDBOX: no ${input.directory} handle configured`);
    }
    const present = new Set(
      (await this.listTreeOf(directoryId)).map((file) => file.id),
    );
    const outOfScope = input.fileIds.filter((fileId) => !present.has(fileId));
    if (outOfScope.length > 0) {
      throw new Error(`SANDBOX_FILES_NOT_IN_${input.directory.toUpperCase()}: ${outOfScope.join(",")}`);
    }
    const { deleted } = await this.storage.deleteFiles({ directoryId, fileIds: input.fileIds });
    this.markThrown(deleted);
    for (const fileId of deleted) {
      this.unmovedFileIds.delete(fileId);
    }
    return { deleted, directory: await this.listTreeOf(directoryId) };
  }

  /** The agent called discardStaging and it returned. */
  stagingDiscarded(): boolean {
    return this.leftoverDiscarded;
  }

  /** File ids still only in staging because their move failed. Read-only. */
  unmovedStagingFileIds(): string[] {
    return [...this.unmovedFileIds];
  }

  /** Record the episodes the agent declares obtained — the agent's FINAL action,
   *  pure agent judgment. The system does NOT mechanically re-read 115 to verify
   *  a backing file exists (§12, 2026-06-15): move/flatten already force-reread
   *  and handed the truth back; the mark is reversible; and §1.13 has the agent
   *  re-judge from the real files every patrol, so a stale mark self-heals next
   *  round. Correctness is the prompt ordering (clean/flatten, THEN mark last),
   *  not a system gate that costs extra 115 reads. No fileId↔episode map (§1.13):
   *  the code IS the unit; the agent names what it judged present.
   *
   *  Replace runs are the one exception: a requested/rejected episode's OLD file is
   *  already there, and marking it would meet coverage and block every transfer. So
   *  such a mark is refused (whole call, nothing recorded) until at least one
   *  transfer succeeded this run. Deliberately coarse — any landed transfer unlocks
   *  the mark; which episodes that transfer carried stays the agent's judgment. The
   *  mark still neither counts toward coverage nor leaves the sandbox in finish()
   *  until reportReplacement records the episode replaced (see countsAsObtained). */
  async markObtained(input: { codes: string[]; subtitleFallback?: boolean }): Promise<{ confirmed: string[] }> {
    if (this.replace && this.succeededCandidates.size === 0) {
      const guarded = this.replaceGuardedEpisodes();
      const early = input.codes.filter((code) => guarded.has(code));
      if (early.length > 0) {
        throw new Error(
          `SANDBOX_REPLACEMENT_NOT_LANDED: ${early.join(",")} — the user wants these replaced and nothing has landed this run; the OLD file does not count. Mark them only after the NEW file is in place`,
        );
      }
    }
    for (const code of input.codes) {
      this.obtainedCodes.add(code);
    }
    // Movie 中文字幕软兜底: the agent landed a raw-name match without a confirmed
    // 中文 sub track (budget exhausted). Sticky so finish() can flag 可能无中字.
    if (input.subtitleFallback) {
      this.subtitleFallbackUsed = true;
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
    if (this.unmovedFileIds.size > 0) {
      const ids = [...this.unmovedFileIds];
      throw new Error(
        `SANDBOX_STAGING_HOLDS_UNMOVED: ${ids.length} file(s) whose move failed are still in staging (${ids.join(", ")}) — move them into their season with moveToSeason, or deleteFiles them on purpose, before discarding staging`,
      );
    }
    const removed = await this.storage.removeDirectory({ directoryId: this.stagingDirectoryId });
    this.leftoverDiscarded = true;
    return removed;
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
    const tree = await this.listTreeOf(root);
    // Replace run: the old film (and anything beside it) stays exactly where it was —
    // it is neither lifted nor swept away with a wrapper.
    const nested = tree.filter(
      (file) => (file.isVideo || file.isSubtitle) && file.path.includes("/") && !this.protectedFiles.has(file.id),
    );
    // 115 answers ok:false with { moved: [] }. Those files are still inside the
    // wrapper; deleting the wrapper would delete the film.
    const moved = nested.length === 0
      ? []
      : (await this.storage.moveFiles({ fileIds: nested.map((file) => file.id), targetDirectoryId: root })).moved;
    const liftedIds = new Set(moved);
    const unlifted = nested.filter((file) => !liftedIds.has(file.id));
    const protectedPaths = tree.filter((file) => this.protectedFiles.has(file.id)).map((file) => file.path);
    for (const wrapper of await this.storage.listSubdirectories({ directoryId: root })) {
      // 115 lists subdirectories recursively, parents before children. Removing a
      // wrapper deletes its subtree, so a nested path is already gone — removing it
      // next throws WRITE_SCOPE_VIOLATION on a movie dir that is already clean.
      if (wrapper.path.includes("/")) continue;
      if (protectedPaths.some((path) => path.startsWith(`${wrapper.path}/`))) continue;
      const prefix = `${wrapper.path}/`;
      if (unlifted.some((file) => file.path.startsWith(prefix))) continue;
      const removed = await this.storage.removeDirectory({ directoryId: wrapper.id });
      // Real drives return the directory id, not the file ids that went with it.
      // The pre-move tree already names them: everything still under this wrapper
      // (nested subdirs included) except the video/subtitle that actually moved.
      if (removed.removed.length === 0) continue;
      this.markThrown(tree.filter((file) => file.path.startsWith(prefix) && !liftedIds.has(file.id)).map((file) => file.id));
    }
    if (unlifted.length > 0) {
      throw new Error(
        `FLATTEN_NOT_DONE: ${unlifted.length} file(s) did not move out of their wrapper (${unlifted.map((file) => file.id).join(",")}) — the wrapper holding them was kept; call flattenMovie again`,
      );
    }
    return { movie: await this.listTreeOf(root) };
  }

  /** The agent's `finish` tool. On a replace run it is refused while an episode the
   *  user asked about (or the agent rejected) has no reportReplacement yet, and while a
   *  message's episodes are not identified: a run with a message but nothing requested
   *  at all, or with a TV message without tags and no episode identified this run —
   *  the agent reads them from the words, and the episodes requested up front (older
   *  待换 rows, other messages' tags) say nothing about that message. Finishing then
   *  would drop its request. The error goes back to the agent and the loop continues
   *  (the step cap and the recovery turn still end it; finalizeReplacement then records
   *  the rest as not_found, and a message whose episodes were never identified is
   *  answered as unidentified). */
  async declareFinish(): Promise<Awaited<ReturnType<TaskSandbox["finish"]>>> {
    if (this.replace) {
      const nothingRequested = this.replace.hasMessages && this.replaceEpisodes().length === 0;
      if (nothingRequested || (this.replace.untaggedMessages > 0 && !this.identifiedThisRun())) {
        throw new Error(
          "SANDBOX_NO_EPISODE_IDENTIFIED: work out from the user's words which episode(s) they mean, call rejectCurrentSource for them (a group with fileIds: [] for an episode with no file), then reportReplacement",
        );
      }
      const unreported = this.unreportedReplaceEpisodes();
      if (unreported.length > 0) {
        throw new Error(
          `SANDBOX_REPORT_REQUIRED: ${unreported.join(",")} — call reportReplacement for these (replaced with the candidateId that landed and the episode's new fileIds, or not_found with a note), then finish`,
        );
      }
    }
    return this.finish();
  }

  /** Requested or rejected episodes with no reportReplacement yet, in request order. */
  private unreportedReplaceEpisodes(): string[] {
    return this.replaceEpisodes().filter((e) => !this.reportedEpisodes.has(e));
  }

  /** The honest coverage picture from the obtained marks — the workflow decides what
   *  to persist. Also the loop's own end-of-run summary, so never gated. */
  async finish(): Promise<{ coverageMet: boolean; obtained: string[]; missing: string[]; subtitleFallback: boolean }> {
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
      // Replace runs: a requested/rejected episode leaves here only once it was reported
      // replaced. The workflow unions these codes into the persisted obtained set, and
      // any landed transfer unlocks the mark — so a bare mark would persist an episode
      // whose replacement was not_found (one declared file-less was never obtained).
      // Outside a replace run every mark counts, as before.
      .filter((code) => this.countsAsObtained(code))
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
      subtitleFallback: this.subtitleFallbackUsed,
    };
  }

  /** The agent honestly reports it cannot cover the target. This is only valid
   *  when a real provider search actually ran (§9): reporting no-coverage without
   *  ever searching is an infrastructure failure, not an honest result.
   *
   *  Evidence base = the agent's own fresh searches ∪ every keyword a snapshot
   *  was observed for — which includes the system's raw pre-warm. The prompt
   *  tells the agent NOT to re-search the raw keyword (viewResourceSnapshot is
   *  free), and even a re-search hits dedup without touching seenKeywords — so
   *  counting only seenKeywords refused a well-behaved agent's honest report on
   *  a truly-uncovered title and forced wasted turns (the 病1-style dead tail).
   *
   *  Task 10: 光有搜索还不够——那些搜索还得是有效证据。证据基整体不健康时上报
   *  被机械拒绝(SANDBOX_SOURCE_UNHEALTHY),因为「没有资源」这个结论不被一份
   *  全是故障源的证据支持。只拦「全不健康」,不拦「部分不健康」。 */
  async reportNoCoverage(reason: string): Promise<{ reason: string; searchesPerformed: number }> {
    const evidenceKeywords = new Set([...this.seenKeywords, ...this.snapshotByKeyword.keys()]);
    if (evidenceKeywords.size === 0) {
      throw new Error(
        "SANDBOX_NO_PROVIDER_EVIDENCE: cannot report no-coverage before any real search ran (§9 infrastructure failure)",
      );
    }
    // Task 10: 整个证据基都不健康 → 「没有资源」不是这份证据支持得起的结论。
    // Task 9 已经把这件事告诉 agent 了,但那只是劝告;LLM 有时就是会无视警告,
    // 于是源挂了 6 天、用户一直读到「暂未找到可用资源」。所以这里必须是机械的。
    //
    // 别甩锅(同 transfer-block.ts 的 systemicBlock):把系统故障报成「暂未找到
    // 资源」是拿资源给系统问题背锅。这里只拦「全不健康」——只要有一份快照可用
    // (healthy 或 degraded),就说明确实有源答过话,那是合法的「确实没有」,放行。
    const snapshots = [...this.snapshotByKeyword.values()];
    const unusable = snapshots.filter((snapshot) => !isMergedSourceEvidenceUsable(snapshot.sourceHealth));
    if (snapshots.length > 0 && unusable.length === snapshots.length) {
      const unhealthySources = [
        ...new Set(unusable.flatMap((snapshot) => snapshot.sourceHealth?.unhealthySources ?? [])),
      ];
      const sources = unhealthySources.length > 0 ? unhealthySources.join("、") : "未知";
      const statuses = [...new Set(unusable.map((snapshot) => snapshot.sourceHealth!.status))].join("/");
      this.auditEvents.push({
        type: "no_coverage_refused_source_unhealthy",
        message: `拒绝无覆盖上报:证据基 ${snapshots.length} 份快照全部来自不健康的搜索源(${statuses}): ${sources}`,
        data: { reason, status: statuses, unhealthySources, snapshotCount: snapshots.length },
      });
      throw new Error(
        `SANDBOX_SOURCE_UNHEALTHY: 搜索源「${sources}」本次全程故障(${statuses}),你手上这 ${snapshots.length} 份快照没有一份是有效证据。「没有资源」这个结论不被这份证据支持,已拒绝上报——不要再改措辞重试。请直接结束本次任务并如实说明是搜索源故障(不是这部片子没有资源):本轮按「搜索源不可用」收尾,资源留待源恢复后重试。`,
      );
    }
    this.auditEvents.push({
      type: "no_coverage_reported",
      message: `agent 上报无覆盖：${reason}（已搜索 ${evidenceKeywords.size} 个词，含系统预搜）`,
      data: { reason, searchesPerformed: evidenceKeywords.size },
    });
    return { reason, searchesPerformed: evidenceKeywords.size };
  }

  /** Whether there is anything a finish-only recovery could act on: a transfer was
   *  attempted in this task, or staging already holds files (a movie's staging IS its
   *  directory, so a prior run's landed file counts). False = the task has not moved
   *  anything yet — the content-filter recovery (agent-loop) then fails loud instead of
   *  running a turn that can only end in a false no-coverage.
   *  A replace run's pre-run files do not count: they are the copy the user rejected (a
   *  movie's sits in staging, its own directory), nothing a recovery could finish. Outside
   *  a replace run they still count, protected or not — a film already there may simply
   *  be waiting for its mark. */
  async hasTransferEvidence(): Promise<boolean> {
    if (this.transferAttempted) return true;
    if (!this.storage || !this.stagingDirectoryId) return false;
    try {
      const staged = await this.listTreeOf(this.stagingDirectoryId);
      return staged.some((file) => !(this.replace && this.protectedFiles.has(file.id)));
    } catch {
      // Unreadable staging: do not claim "nothing happened" on missing evidence —
      // let the recovery turn look for itself (its inspect tools report the error).
      return true;
    }
  }

  // ── User replace request tools ────────────────────────────────────────────
  /** Whether this run carries a user replace request (the replace tools are
   *  registered only when it does). */
  hasReplace(): boolean {
    return this.replace !== undefined;
  }

  /** Whether the agent identified at least one episode in THIS run: a successful
   *  rejectCurrentSource (a rejection, or the declaration that an episode has no file
   *  here). Being requested up front (a tag, a 待换 row) is not identifying — nothing
   *  was read from a message's words for it. */
  identifiedThisRun(): boolean {
    return this.rejectedEpisodes.length > 0 || this.noFileEpisodes.length > 0;
  }

  /** Called once before the agent starts: every file already in a target dir is the
   *  user's current copy and must survive this run (replace run, or a work with kept
   *  old + replacement copies — see protectExistingFiles). */
  async captureProtectedFiles(): Promise<void> {
    if ((!this.replace && !this.protectExistingFiles) || !this.storage) return;
    for (const [season, directoryId] of this.seasonDirs) {
      const dirLabel = `Season ${String(season).padStart(2, "0")}`;
      for (const file of await this.listTreeOf(directoryId)) this.protectedFiles.set(file.id, { file, dirLabel });
    }
    if (this.movieDir !== undefined) {
      for (const file of await this.listTreeOf(this.movieDir)) {
        this.protectedFiles.set(file.id, { file, dirLabel: "" });
      }
    }
    this.protectedCaptured = true;
  }

  /** Replace runs: nothing may be transferred before the user's current copy of EVERY
   *  requested episode is rejected. The raw snapshot is pre-warmed before the agent can
   *  reject anything, and transfer tools carry no episode — so a gate opened by one
   *  rejection would let a model reject E13 and re-land the very E24 the user
   *  complained about. A requested episode is covered when it was:
   *  - rejected this run (rejectCurrentSource with that episode's current files);
   *  - declared to have no old file here (a group with that episode and fileIds []) —
   *    the sandbox has no file↔episode map, so this is the agent's call;
   *  - in alreadyRejectedEpisodes: a stored rejection from an earlier run (a 待换
   *    re-check — its copies are filtered from search and refused anyway). The caller
   *    (runAcquisitionV2) only fills this in for a PENDING-ONLY re-check (no new
   *    message this run): a new message means the user is unhappy with the file in
   *    place now, which may itself be an earlier replacement — that must be rejected
   *    fresh, so the caller passes [] and this closes.
   *  With no requested episode at all (a TV message without tags) the agent reads the
   *  episodes from the words, so the gate asks for at least one rejectCurrentSource
   *  call (a rejection or a no-file declaration) before anything transfers.
   *  Global hatch: the target dirs held no file at all when the run started. */
  private assertRejectedFirst(): void {
    if (!this.replace) return;
    if (this.protectedCaptured && this.protectedFiles.size === 0) return;
    const requested = this.replace.requestedEpisodes;
    if (requested.length === 0) {
      if (this.rejectedEpisodes.length > 0 || this.noFileEpisodes.length > 0) return;
      throw new Error(
        "SANDBOX_REJECT_FIRST: call rejectCurrentSource for the files the user complained about before transferring",
      );
    }
    const covered = new Set([...this.rejectedEpisodes, ...this.noFileEpisodes, ...(this.replace.alreadyRejectedEpisodes ?? [])]);
    const uncovered = requested.filter((episode) => !covered.has(episode));
    if (uncovered.length === 0) return;
    throw new Error(
      `SANDBOX_REJECT_FIRST: ${uncovered.join(",")} not rejected yet — call rejectCurrentSource with one group per requested episode (that episode's current file ids; fileIds: [] when it has no file in the library) before transferring`,
    );
  }

  /** After a rejection: drop the newly rejected copies from what the agent can read
   *  back for free (the raw pre-warm via viewResourceSnapshot, and every cached
   *  keyword a deduped searchResources returns). observedSnapshots keep the full
   *  snapshots — transfer validation and persistence need them; the transfer-time
   *  guard still refuses a rejected id the agent remembers. */
  private async refilterCachedSnapshots(): Promise<void> {
    const isRejected = this.isRejected;
    if (!isRejected) return;
    const filtered = new Map<ResourceSnapshotV2, ResourceSnapshotV2>();
    const refilter = async (snapshot: ResourceSnapshotV2): Promise<ResourceSnapshotV2> => {
      const done = filtered.get(snapshot);
      if (done) return done;
      // Asked all at once: the caller can answer the whole batch from one read.
      const hits = await Promise.all(snapshot.candidates.map((c) => isRejected({ id: c.id, title: c.title })));
      const keep = snapshot.candidates.filter((_, index) => !hits[index]);
      const next = keep.length === snapshot.candidates.length ? snapshot : { ...snapshot, candidates: keep };
      filtered.set(snapshot, next);
      return next;
    };
    for (const [keyword, snapshot] of this.snapshotByKeyword) this.snapshotByKeyword.set(keyword, await refilter(snapshot));
    if (this.rawSnapshot) this.rawSnapshot = await refilter(this.rawSnapshot);
  }

  private assertNotProtected(fileIds: string[]): void {
    const hit = fileIds.filter((id) => this.protectedFiles.has(id));
    if (hit.length > 0) {
      throw new Error(
        `SANDBOX_FILE_PROTECTED: ${hit.join(",")} was in the library before this run — the user deletes old copies, never the agent`,
      );
    }
  }

  /** A file reported as an episode's replacement this run stays: the recorded result
   *  (and the episode source written from it) stands on that file being there. */
  private assertNotBackingReplacement(fileIds: string[]): void {
    const hit = fileIds.filter((id) => this.fileBackedEpisode.has(id));
    if (hit.length > 0) {
      throw new Error(
        `SANDBOX_FILE_BACKS_REPLACEMENT: ${hit.map((id) => `${id} backs ${this.fileBackedEpisode.get(id)}`).join(", ")} — it was reported as that episode's replacement this run, so it stays`,
      );
    }
  }

  /** Episode codes for the replace tools: a movie run takes only "MOVIE"; a TV run
   *  takes SxxEyy codes whose season is one of this run's season dirs. */
  private assertEpisodeTokens(episodes: string[]): void {
    const movieRun = this.isMovieRun();
    for (const episode of episodes) {
      if (movieRun) {
        if (episode === "MOVIE") continue;
      } else {
        const m = /^S(\d{2,})E(\d{2,})$/.exec(episode);
        if (m && this.seasonDirs.has(Number(m[1]))) continue;
      }
      throw new Error(`SANDBOX_EPISODE_OUT_OF_SCOPE: ${episode}`);
    }
  }

  /** Season number of a SxxEyy token (already validated in scope by assertEpisodeTokens),
   *  or undefined for a non-episode token like the movie "MOVIE". The token's declared
   *  season is the agent's claim — checking a replacement file lives in THAT season's dir
   *  is a fact check, never filename parsing. */
  private seasonOfEpisode(episode: string): number | undefined {
    const m = /^S(\d{2,})E(\d{2,})$/.exec(episode);
    return m ? Number(m[1]) : undefined;
  }

  /** The candidate the agent means by `candidateId`, from the snapshots it saw this
   *  run. These are the provider's AGENT-FACING snapshots (RealResourceProviderV2
   *  hands back short aliases like s2-14), so the lookup is by the id the agent
   *  passed — never by the provider's real id. `snapshotId` narrows it to one
   *  snapshot (transferCandidate); omitted = any snapshot seen (transferUntilLanded).
   *  Both transfer paths read the title the rejection check needs from here. */
  private findObservedCandidate(candidateId: string, snapshotId?: string): ResourceSnapshotV2["candidates"][number] | undefined {
    const snapshots =
      snapshotId === undefined ? [...this.observedSnapshots.values()] : [this.observedSnapshots.get(snapshotId)].filter((x) => x !== undefined);
    for (const snapshot of snapshots) {
      const hit = snapshot.candidates.find((c) => c.id === candidateId);
      if (hit) return hit;
    }
    return undefined;
  }

  /** Reject the current file(s) of the episodes the user complained about. One group
   *  per episode (a second group for the same episode is refused). Each group names
   *  one episode and all of that episode's file ids (a TV call may carry every episode;
   *  a movie is one group, episode omitted or "MOVIE"). A file is recorded only under
   *  the episode it is grouped with. The caller adds the link and decides which items
   *  become rows. The files stay in place. The episodes join the need, so one the agent
   *  read from the user's words (no tag) can still pass the transfer gate. A TV group
   *  must name its episode. Only files that were in the library before this run qualify.
   *  A group with fileIds [] declares "no old file of this episode here": nothing is
   *  recorded as rejected, the episode just passes the transfer gate. */
  async rejectCurrentSource(
    input: { rejections: Array<{ episode?: string; fileIds: string[] }>; reason: string },
  ): Promise<{ rejected: number; declaredNoFile?: string[] }> {
    if (!this.replace || !this.storage) throw new Error("SANDBOX_NO_REPLACE: this run has no user request");
    const groups = input.rejections ?? [];
    if (groups.length === 0) {
      throw new Error("SANDBOX_NO_FILES: pass rejections, each with the fileIds of that episode's current copy (from inspectTargetDir)");
    }
    const movieRun = this.isMovieRun();
    const normalized: Array<{ episode: string; fileIds: string[] }> = [];
    for (const group of groups) {
      const named = group.episode;
      const fileIds = group.fileIds ?? [];
      if (movieRun && (named === undefined || named === "MOVIE")) {
        normalized.push({ episode: "MOVIE", fileIds });
        continue;
      }
      if (!named) {
        throw new Error(
          "SANDBOX_EPISODES_REQUIRED: every TV group names its episode (e.g. S01E13) — omitting episode is only for a movie",
        );
      }
      this.assertEpisodeTokens([named]);
      normalized.push({ episode: named, fileIds });
    }
    // One group per episode. Two groups for one episode disagree with the row
    // builder, which collapses by episode (a subtitle group plus a video group
    // would hide the subtitle, or a no-file group would contradict the files).
    const duplicated: string[] = [];
    const seenEpisode = new Set<string>();
    for (const group of normalized) {
      if (!seenEpisode.has(group.episode)) {
        seenEpisode.add(group.episode);
        continue;
      }
      if (!duplicated.includes(group.episode)) duplicated.push(group.episode);
    }
    if (duplicated.length > 0) {
      throw new Error(
        `SANDBOX_DUPLICATE_EPISODE: ${duplicated.join(",")} appears in more than one group — put all of that episode's file ids in one group`,
      );
    }
    const withFiles = normalized.filter((group) => group.fileIds.length > 0);
    const noFile = normalized.filter((group) => group.fileIds.length === 0);
    const missing = [...new Set(withFiles.flatMap((group) => group.fileIds.filter((id) => !this.protectedFiles.has(id))))];
    if (missing.length > 0) {
      throw new Error(
        `SANDBOX_FILES_NOT_IN_TARGET: ${missing.join(",")} — only a file that was in the library before this run can be rejected`,
      );
    }
    const reason = input.reason.slice(0, 200);
    const items = withFiles.flatMap((group) =>
      group.fileIds.map((id) => {
        const { file, dirLabel: dir } = this.protectedFiles.get(id)!;
        const path = dir ? `${dir}/${file.path}` : file.path;
        return {
          episode: group.episode,
          label: file.path.split("/").pop()!,
          sizeBytes: file.sizeBytes,
          reason,
          path,
          fileId: id,
          isVideo: file.isVideo,
        };
      }),
    );
    // onReject first: a throw (unreadable landing history) records nothing, including
    // a no-file declaration that rode in the same call.
    if (items.length > 0) await this.replace.onReject(items);
    for (const group of withFiles) {
      if (!this.need.includes(group.episode)) this.need.push(group.episode);
      if (!this.rejectedEpisodes.includes(group.episode)) this.rejectedEpisodes.push(group.episode);
    }
    for (const group of noFile) {
      if (!this.need.includes(group.episode)) this.need.push(group.episode);
      if (!this.noFileEpisodes.includes(group.episode)) this.noFileEpisodes.push(group.episode);
    }
    if (items.length > 0) await this.refilterCachedSnapshots();
    const declared = [...new Set(noFile.map((group) => group.episode))];
    return { rejected: items.length, ...(declared.length > 0 ? { declaredNoFile: declared } : {}) };
  }

  /** Per-episode outcome of the request. Every episode must be requested or rejected
   *  this run. A "replaced" names that episode's own NEW file(s) in fileIds — which file
   *  is which episode stays the agent's call (the system never reads names); the system
   *  only checks facts about the claim: the episode was marked obtained this run, its
   *  candidate landed this run, every named file (subtitles aside, see below) was
   *  downloaded THIS run BY that candidate (never the old copy, never a made-up id), one
   *  file backs one episode per run (E24 can never ride on E13's file), and — read from
   *  the target dirs as the agent reports — every such file is in one now and at least
   *  one of them is a video.
   *  A named subtitle in the episode's dir is optional and never checked (real drives do
   *  not record subtitles as downloaded): it is no evidence and backs nothing. Any failed
   *  check refuses the whole call (nothing recorded), except a named file missing from
   *  the target dirs: that episode is recorded not_found (see notInTarget). A replaced
   *  result carries the named videos' real size, and its files can no longer be deleted
   *  this run. An episode is recorded once — except that an earlier not_found may be
   *  upgraded to replaced; other repeats come back as `ignored`. */
  async reportReplacement(input: {
    results: Array<{ episode: string; outcome: "replaced" | "not_found"; candidateId?: string; fileIds?: string[]; note: string }>;
  }): Promise<{
    recorded: number;
    ignored: Array<{ episode: string; reason: string }>;
    /** "replaced" episodes recorded not_found because a named file is not in a target
     *  dir now (still in staging, or deleted since). */
    notInTarget?: Array<{ episode: string; reason: string }>;
  }> {
    if (!this.replace) throw new Error("SANDBOX_NO_REPLACE: this run has no user request");
    this.assertEpisodeTokens(input.results.map((r) => r.episode));
    const allowed = new Set(this.replaceEpisodes());
    const byEpisode = new Map<string, (typeof input.results)[number]>();
    for (const r of input.results) {
      if (!allowed.has(r.episode)) {
        throw new Error(`SANDBOX_EPISODE_NOT_REQUESTED: ${r.episode} was neither requested by the user nor passed to rejectCurrentSource this run`);
      }
      const first = byEpisode.get(r.episode);
      if (!first) byEpisode.set(r.episode, r);
      else if (first.outcome !== r.outcome) {
        throw new Error(`SANDBOX_REPORT_CONFLICT: ${r.episode} is reported both replaced and not_found in one call`);
      }
    }
    const fresh: Array<(typeof input.results)[number]> = [];
    const ignored: Array<{ episode: string; reason: string }> = [];
    for (const r of byEpisode.values()) {
      const earlier = this.reportedEpisodes.get(r.episode);
      if (earlier === undefined || (earlier === "not_found" && r.outcome === "replaced")) fresh.push(r);
      else ignored.push({ episode: r.episode, reason: `already reported ${earlier}` });
    }
    // Validate every "replaced" before recording any: first the checks that need no
    // listing, then the named files against the target dirs as they are now.
    const toCheck = fresh.map((r) => {
      if (r.outcome !== "replaced") return r;
      if (!this.obtainedCodes.has(r.episode)) {
        throw new Error(`SANDBOX_REPLACEMENT_NOT_MARKED: ${r.episode} was not marked obtained this run`);
      }
      if (!r.candidateId || !this.succeededCandidates.has(r.candidateId)) {
        throw new Error(`SANDBOX_REPLACEMENT_NO_TRANSFER: ${r.candidateId ?? "(none)"} did not land in this run`);
      }
      const fileIds = [...new Set(r.fileIds ?? [])];
      if (fileIds.length === 0) {
        throw new Error(
          `SANDBOX_REPLACEMENT_FILES_REQUIRED: ${r.episode} — a "replaced" result must name fileIds: the NEW video file(s) of that episode`,
        );
      }
      return { ...r, fileIds };
    });
    // Where the named files are NOW, read once for this call (only when something is
    // reported replaced), never remembered. Keep each scoped target dir SEPARATE so a
    // replacement is checked against its OWN dir: for TV, one live set per season (keyed
    // by season number) — a new S01E13 file that was moved into Season 02's dir does NOT
    // satisfy S01E13; for a movie, the single movie dir. The season dir is separate from
    // staging, so a new copy never moved in is not beside the old one; a replacement moved
    // in and deleted since is gone too. Same number of listTree calls as one union list.
    const anyReplaced = toCheck.some((r) => r.outcome === "replaced");
    const movieRun = this.isMovieRun();
    const movieLive =
      anyReplaced && movieRun ? new Map((await this.inspectTargetDir()).map((file) => [file.id, file])) : new Map<string, SimTreeFile>();
    const liveBySeason = new Map<number, Map<string, SimTreeFile>>();
    if (anyReplaced && !movieRun) {
      const seasons = [...this.seasonDirs.keys()];
      const trees = await Promise.all(seasons.map((season) => this.inspectTargetDir({ season })));
      seasons.forEach((season, i) => liveBySeason.set(season, new Map(trees[i]!.map((file) => [file.id, file]))));
    }
    // The live set an episode's files must be in: its OWN season's dir (TV) or the movie dir.
    const liveFor = (episode: string): Map<string, SimTreeFile> => {
      if (movieRun) return movieLive;
      const season = this.seasonOfEpisode(episode);
      return (season !== undefined ? liveBySeason.get(season) : undefined) ?? new Map<string, SimTreeFile>();
    };
    // Where each named file came from. Subtitles are optional and never checked: real
    // drives record only new VIDEO files as downloaded (an assrt subtitle, or one shipped
    // in a pack, is never among them), so checking them would refuse the whole report. A
    // named subtitle in the episode's own dir is skipped: it need not be downloaded this
    // run, is no evidence and backs nothing. Every other named file must have been
    // downloaded THIS run by the reported candidate and back only this episode. `claimed`
    // spans this call, so one file named for two episodes in the same call is caught too.
    const claimed = new Map<string, string>();
    const checkedFiles = new Map<string, string[]>();
    for (const r of toCheck) {
      if (r.outcome !== "replaced") continue;
      const live = liveFor(r.episode);
      const fileIds = (r.fileIds ?? []).filter((id) => !live.get(id)?.isSubtitle);
      const unknown = fileIds.filter((id) => !this.materializedBy.has(id));
      if (unknown.length > 0) {
        throw new Error(
          `SANDBOX_REPLACEMENT_FILE_UNKNOWN: ${unknown.join(",")} were not downloaded this run — name the NEW video file(s) of ${r.episode} that a transfer landed this run (not the old copy)`,
        );
      }
      const foreign = fileIds.filter((id) => this.materializedBy.get(id) !== r.candidateId);
      if (foreign.length > 0) {
        const from = foreign.map((id) => `${id} was downloaded by ${this.materializedBy.get(id)}`).join(", ");
        throw new Error(
          `SANDBOX_REPLACEMENT_FILE_CANDIDATE_MISMATCH: ${from}, not ${r.candidateId} — report ${r.episode} with the candidateId that landed its file`,
        );
      }
      for (const id of fileIds) {
        const owner = this.fileBackedEpisode.get(id) ?? claimed.get(id);
        if (owner !== undefined && owner !== r.episode) {
          throw new Error(
            `SANDBOX_REPLACEMENT_FILE_REUSED: ${id} already backs ${owner} — one new file backs one episode; name ${r.episode}'s own new file`,
          );
        }
        claimed.set(id, r.episode);
      }
      checkedFiles.set(r.episode, fileIds);
    }
    // A checked file not in the episode's OWN target dir records THAT episode not_found (it
    // stays 待换) instead of throwing the whole batch away — moved into its own season and
    // reported again, it is upgraded, exactly like an earlier not_found; its files back no
    // episode until then. Among files that are there, one must be a video: subtitles ride
    // along with the new video, they never replace an episode on their own (refuses the call).
    const notInTarget: Array<{ episode: string; reason: string }> = [];
    const recorded = toCheck.map((r) => {
      if (r.outcome !== "replaced") return r;
      const live = liveFor(r.episode);
      const checked = checkedFiles.get(r.episode) ?? [];
      const absent = checked.filter((id) => !live.has(id));
      if (absent.length > 0) {
        // A movie's staging IS its directory: a file missing from it is gone.
        const retry = movieRun ? "" : `; if it is still in staging, moveToSeason it into the season directory, then report ${r.episode} again`;
        notInTarget.push({
          episode: r.episode,
          reason: `not in the target directory now: ${absent.join(",")} — recorded not_found${retry}`,
        });
        return { episode: r.episode, outcome: "not_found" as const, note: REPLACEMENT_NOT_IN_TARGET_NOTE };
      }
      const videos = checked.filter((id) => live.get(id)?.isVideo);
      if (videos.length === 0) {
        throw new Error(`SANDBOX_REPLACEMENT_NO_VIDEO: ${r.episode} — name the new video file (subtitles alone don't count)`);
      }
      // What the episode was replaced with, as it lies in its dir: a pack's title would
      // carry the whole pack's size.
      return { ...r, sizeBytes: videos.reduce((sum, id) => sum + live.get(id)!.sizeBytes, 0) };
    });
    for (const r of recorded) {
      this.reportedEpisodes.set(r.episode, r.outcome);
      if (r.outcome === "replaced") for (const id of checkedFiles.get(r.episode) ?? []) this.fileBackedEpisode.set(id, r.episode);
    }
    if (recorded.length > 0) await this.replace.onReport(recorded.map((r) => ({ ...r, note: r.note.slice(0, 200) })));
    return { recorded: recorded.length, ignored, ...(notInTarget.length > 0 ? { notInTarget } : {}) };
  }

  /** End of run: every episode the user asked about (tags / pending) or the agent
   *  rejected, that the agent did not report, is not_found — so it stays 待换 and later
   *  patrols keep looking. */
  async finalizeReplacement(): Promise<void> {
    if (!this.replace) return;
    const left = this.unreportedReplaceEpisodes();
    for (const e of left) this.reportedEpisodes.set(e, "not_found");
    if (left.length > 0) await this.replace.onReport(left.map((episode) => ({ episode, outcome: "not_found", note: "" })));
  }

  // ── Agent memory tools ────────────────────────────────────────────────────
  /** Whether this run has a memory binding (reflection runs only when it does). */
  hasMemory(): boolean {
    return this.memory !== undefined;
  }

  /** Writes + deletes made so far this run (for the reflection summary log). */
  memoryChangeCount(): number {
    return this.memoryChanges;
  }

  private requireMemory(): NonNullable<TaskSandboxOptions["memory"]> {
    if (!this.memory) throw new Error("MEMORY_UNAVAILABLE: agent memory is not enabled for this run");
    return this.memory;
  }

  private memoryTitleKeyFor(scope: AgentMemoryScope): string | null {
    return scope === "title" ? this.requireMemory().titleKey : null;
  }

  /** Read one entry's body. Title scope = THIS work only. Returns the agent-facing
   *  projection — never the row's id / account / bound key / run id. */
  async readMemory(input: { scope: AgentMemoryScope; name: string }): Promise<AgentMemoryView> {
    const memory = this.requireMemory();
    const rows = await memory.store.listAgentMemories({
      accountId: memory.accountId,
      scope: input.scope,
      titleKey: this.memoryTitleKeyFor(input.scope),
    });
    const hit = rows.find((row) => row.name === input.name);
    if (!hit) throw new Error(`MEMORY_NOT_FOUND: no ${input.scope} memory named "${input.name}"`);
    return {
      scope: hit.scope,
      name: hit.name,
      kind: hit.kind,
      description: hit.description,
      body: hit.body,
      provider: hit.provider,
      updatedAt: hit.updatedAt,
    };
  }

  /** Upsert by name. The title key is the BOUND one — any titleKey the agent passes
   *  is ignored (the input type does not even carry it). */
  async writeMemory(input: AgentMemoryWrite): Promise<{ name: string; scope: AgentMemoryScope; updated: boolean }> {
    const memory = this.requireMemory();
    const entry: AgentMemoryWrite = {
      scope: input.scope,
      name: input.name,
      description: input.description,
      kind: input.kind,
      body: input.body,
      ...(input.provider ? { provider: input.provider } : {}),
    };
    const invalid = validateMemoryInput(entry);
    if (invalid) throw new Error(`MEMORY_INVALID: ${invalid}`);
    this.reserveMemoryChange();
    let updated: boolean;
    try {
      const titleKey = this.memoryTitleKeyFor(entry.scope);
      const existing = await memory.store.listAgentMemories({ accountId: memory.accountId, scope: entry.scope, titleKey });
      const previous = existing.find((row) => row.name === entry.name);
      this.assertSameDrive(previous, entry.scope, entry.name);
      updated = previous !== undefined;
      const cap = entry.scope === "title" ? AGENT_MEMORY_LIMITS.titleEntriesMax : AGENT_MEMORY_LIMITS.globalEntriesMax;
      if (!updated && existing.length >= cap) {
        throw new Error(`MEMORY_FULL: ${entry.scope} memory already has ${existing.length}/${cap} entries — delete or overwrite a stale one first`);
      }
      // The store enforces the cap atomically (concurrent reflections cannot overshoot);
      // the check above only turns the common case into an early, friendly error.
      // The bound drive wins (the model cannot tag a note with another drive). Without
      // one, a revision that omits provider keeps the drive the entry was tied to (the
      // upsert would otherwise overwrite it with null).
      const provider = memory.provider ?? entry.provider ?? previous?.provider;
      const stored: AgentMemoryWrite = provider ? { ...entry, provider } : entry;
      await memory.store.upsertAgentMemory({
        accountId: memory.accountId,
        titleKey,
        entry: stored,
        // Atomic twin of assertSameDrive above (which only gives the early message).
        ...(memory.provider ? { onlyDrive: memory.provider } : {}),
        ...(memory.provider && memory.legacyProvider ? { legacyDrive: memory.legacyProvider } : {}),
        sourceRunId: memory.runId,
        now: (memory.now ?? (() => new Date().toISOString()))(),
        maxEntries: cap,
      });
    } catch (error) {
      this.memoryChanges -= 1;
      throw error;
    }
    this.auditEvents.push({
      type: "memory_written",
      message: `agent 记忆${updated ? "更新" : "新增"}:${entry.scope}/${entry.name}`,
      data: { scope: entry.scope, name: entry.name, updated },
    });
    return { name: entry.name, scope: entry.scope, updated };
  }

  /** A run bound to a drive may not overwrite or delete a note tagged with ANOTHER
   *  drive: a source that failed here (a magnet the drive had no cache for) may be
   *  exactly what worked there. Untagged notes stay editable by any drive. */
  private assertSameDrive(row: { provider: string | null } | undefined, scope: AgentMemoryScope, name: string): void {
    const bound = this.memory?.provider;
    if (bound && row && !memoryDriveAllows(row.provider, bound, this.memory?.legacyProvider)) {
      throw memoryOtherDriveError(scope, name, row.provider!, bound);
    }
  }

  /** Take a per-run change slot BEFORE the first await: the model may issue several
   *  tool calls in one step and AI SDK runs them concurrently, so check-then-increment
   *  after the store call would let them all pass. Callers release it on failure. */
  private reserveMemoryChange(): void {
    if (this.memoryChanges >= AGENT_MEMORY_LIMITS.changesPerRunMax) {
      throw new Error(`MEMORY_RUN_LIMIT: at most ${AGENT_MEMORY_LIMITS.changesPerRunMax} memory writes/deletes per run`);
    }
    this.memoryChanges += 1;
  }

  async deleteMemory(input: { scope: AgentMemoryScope; name: string }): Promise<{ deleted: boolean }> {
    const memory = this.requireMemory();
    this.reserveMemoryChange();
    let deleted: boolean;
    try {
      // The drive guard runs INSIDE the store's delete (atomic): a check here followed
      // by a plain delete could remove a note another drive tagged in between.
      deleted = await memory.store.deleteAgentMemory({
        accountId: memory.accountId,
        scope: input.scope,
        titleKey: this.memoryTitleKeyFor(input.scope),
        name: input.name,
        ...(memory.provider ? { onlyDrive: memory.provider } : {}),
        ...(memory.provider && memory.legacyProvider ? { legacyDrive: memory.legacyProvider } : {}),
      });
    } catch (error) {
      this.memoryChanges -= 1;
      throw error;
    }
    if (!deleted) this.memoryChanges -= 1;
    if (deleted) {
      this.auditEvents.push({
        type: "memory_deleted",
        message: `agent 记忆删除:${input.scope}/${input.name}`,
        data: { scope: input.scope, name: input.name },
      });
    }
    return { deleted };
  }

  /** Per-keyword search history for the reflection digest (copies; order = first call). */
  searchHistory(): SearchHistoryEntry[] {
    return this.searchLog.map((entry) => ({ ...entry, sampleTitles: [...entry.sampleTitles] }));
  }

  private logSearch(
    keyword: string,
    result:
      | { outcome: "ok"; snapshot: ResourceSnapshotV2 }
      | { outcome: "refused" | "error"; note: string },
  ): void {
    const normalized = normalizeSearchKeyword(keyword);
    let entry = this.searchLog.find((e) => normalizeSearchKeyword(e.keyword) === normalized);
    if (!entry) {
      entry = { keyword, calls: 0, outcome: result.outcome, candidateCount: 0, sampleTitles: [] };
      this.searchLog.push(entry);
    }
    entry.calls += 1;
    entry.outcome = result.outcome;
    if (result.outcome === "ok") {
      entry.candidateCount = result.snapshot.candidates.length;
      entry.sampleTitles = result.snapshot.candidates.slice(0, 3).map((c) => c.title);
      if (result.snapshot.prefilterDropped) entry.prefilterDropped = result.snapshot.prefilterDropped;
      delete entry.note;
    } else {
      entry.note = result.note.slice(0, 160);
    }
  }

  auditTrail(): AuditEvent[] {
    return [...this.auditEvents];
  }

  /** Pre-warm a raw search (system-initiated, does NOT consume agent's distinct
   *  search budget). The snapshot is recorded in dedup/registry/observedSnapshots
   *  just like an agent search, so agent can later transferCandidate by id. Calling
   *  this multiple times replaces the prior raw snapshot.
   *
   *  预搜拿到**不可用**结果(unreachable / protocol_error 快照,或 provider 直接抛错)时
   *  退避 PRESEARCH_RETRY_DELAY_MS 后重试一次(源头自愈):预搜是整轮的证据底座,赶在
   *  源抖动的瞬间落下没证据的空快照会被后续决策全程当真。重试只为救「真的拿不到」,
   *  不为救「次优」:degraded/healthy 都是可用证据(degraded 有 fallback 救回的候选),
   *  不重试——重试结果可能更坏,不得把可用结果换掉。
   *  落点择优,重试只在可用时才落重试那份:重试可用→取重试那份;重试仍坏→落首搜那份
   *  (不把手里那份换成更坏的结果);两次都抛→抛第二次的错(orchestrator 按「无预搜」
   *  降级,agent 自己搜)。 */
  async primeRawSnapshot(keyword: string): Promise<void> {
    const normalized = normalizeSearchKeyword(keyword);
    // Perform the search WITHOUT marking it as seen by the agent (don't add to
    // seenKeywords) — so it doesn't consume the distinct search budget.
    let snapshot: ResourceSnapshotV2 | undefined;
    let searchError: unknown;
    try {
      snapshot = await this.provider.search(keyword);
    } catch (error) {
      searchError = error;
    }
    if (snapshot === undefined || !isSnapshotEvidenceUsable(snapshot)) {
      await new Promise((resolve) => setTimeout(resolve, this.presearchRetryDelayMs));
      try {
        const retried = await this.provider.search(keyword);
        // 择优:重试可用才落重试那份;仍坏就落首搜那份——重试可能更坏,不得把手里
        // 那份换成更坏的结果(首搜抛错时手里没有快照,重试返回什么落什么)。
        if (snapshot === undefined || isSnapshotEvidenceUsable(retried)) {
          snapshot = retried;
          searchError = undefined;
        }
      } catch (error) {
        // 首搜已有快照(只是不可用)→ 重试抛错就落首搜那份;两次都抛 → 抛第二次的错。
        if (snapshot === undefined) searchError = error;
      }
    }
    if (snapshot === undefined) {
      this.logSearch(keyword, {
        outcome: "error",
        note: searchError instanceof Error ? searchError.message : String(searchError),
      });
      throw searchError;
    }
    this.logSearch(keyword, { outcome: "ok", snapshot });

    // Record in dedup map so agent re-searching this keyword hits dedup
    this.snapshotByKeyword.set(normalized, snapshot);
    this.searchCountByKeyword.set(normalized, 1);

    // Record in observed snapshots so transferCandidate can resolve candidate ids
    this.observedSnapshots.set(snapshot.id, snapshot);

    // Store for viewResourceSnapshot
    this.rawSnapshot = snapshot;
  }

  /** Read-only tool: view the pre-warmed raw snapshot as a structured document.
   *  Free, repeatable, does NOT consume search budget. Each row is id + title,
   *  plus · 发布 YYYY-MM-DD when postedAt is known, then · 近 30 天转过… when
   *  linkHistory is set (truncated at 120 if excessive). */
  viewResourceSnapshot(): { document: string; candidateCount: number } {
    if (!this.rawSnapshot) {
      return {
        document: "No raw snapshot available. Call primeRawSnapshot first.",
        candidateCount: 0,
      };
    }

    // A flag means the judge was not confident this is the target: the uncertain band,
    // or a drop-band row the containment floor kept because its title contains the
    // target's name. Kept and flagged so the agent looks twice.
    // Same presenter as searchResources: one story, two read paths.
    const view = presentSnapshotForAgent(this.rawSnapshot, RAW_SNAPSHOT_ROW_LIMIT);
    const candidates = view.snapshot.candidates;
    const total = candidates.length;
    const truncated = candidates.slice(0, RAW_SNAPSHOT_ROW_LIMIT);
    const remaining = total - truncated.length;

    let document = `📋 Raw snapshot (${total} candidates):\n\n`;

    for (const candidate of truncated) {
      const posted = candidate.postedAt ? ` · 发布 ${candidate.postedAt}` : "";
      const history = candidate.linkHistory ? ` · ${candidate.linkHistory}` : "";
      document += `[${candidate.id}] ${candidate.title}${posted}${history}\n`;
    }

    if (remaining > 0) {
      document += `\n... 还有 ${remaining} 条。如需更多,可用 searchResources 搜繁体/英文关键词。\n`;
    }
    if (view.legend) document += `\n${view.legend}\n`;
    if (view.allDroppedWarning) document += `\n${view.allDroppedWarning}\n`;

    return { document, candidateCount: total };
  }

  /** Pre-warm the assrt subtitle snapshot (system-initiated, like primeRawSnapshot).
   *  Stores candidates so viewSubtitleSnapshot can render them repeatedly for free.
   *  Soft-fails (empty snapshot) on any provider miss — never throws, so a flaky
   *  assrt / a no-result search never blocks the video task. */
  async primeSubtitleSnapshot(
    keyword: string,
    provider: AssrtProviderPort,
  ): Promise<void> {
    this.subtitleProvider = provider;
    try {
      this.subtitleSnapshot = await provider.search(keyword);
    } catch {
      this.subtitleSnapshot = [];
    }
  }

  /** Read-only view of the pre-warmed subtitle candidates as a structured doc.
   *  Free, repeatable. The agent reads this to pick which subtitle package to land. */
  viewSubtitleSnapshot(): { document: string; candidateCount: number } {
    if (!this.subtitleSnapshot || this.subtitleSnapshot.length === 0) {
      return {
        document: "No subtitle candidates were found for this title on assrt.net. Subtitles are optional — proceed with the video alone; do not block or retry on this.",
        candidateCount: 0,
      };
    }
    const candidates = this.subtitleSnapshot;
    let document = `📋 Subtitle snapshot (${candidates.length} candidates from assrt.net; ★=社区评分,组=字幕组 — 大家验证过的证据,语义权衡用):\n\n`;
    for (const candidate of candidates) {
      const lang = candidate.lang ? ` [${candidate.lang}]` : "";
      const evidence = [
        candidate.voteScore === undefined ? "" : `★${candidate.voteScore}`,
        candidate.releaseSite ? `组:${candidate.releaseSite}` : "",
        candidate.uploadTime ?? "",
      ]
        .filter(Boolean)
        .join(" · ");
      document += `[${candidate.id}] ${candidate.title}${lang}${evidence ? ` (${evidence})` : ""}\n`;
    }
    return { document, candidateCount: candidates.length };
  }

  /** Land a chosen subtitle package's files into staging via the 115 offline-task
   *  path. Refreshes assrt detail() before each bounded chunk so short-lived URLs
   *  are never reused after they age out. The agent then renames landed files
   *  (moveToSeason/flattenMovie) to ride beside the video. */
  async transferSubtitle(input: {
    candidateId: number;
  }): Promise<{
    status: "succeeded" | "failed";
    landedFilenames: string[];
    error?: string;
    chunksProcessed: number;
    chunksTotal: number;
    unattemptedCount: number;
    chunkDiagnostics: SubtitleChunkDiagnostic[];
  }> {
    if (!this.storage || !this.stagingDirectoryId) {
      throw new Error("SANDBOX: no storage/staging handle configured for subtitle transfer");
    }
    if (!this.subtitleProvider) {
      throw new Error("SANDBOX_NO_SUBTITLE_PROVIDER: subtitle flow was not primed");
    }
    if (!this.subtitleSnapshot || !this.subtitleSnapshot.some((c) => c.id === input.candidateId)) {
      throw new Error(
        `SANDBOX_SUBTITLE_NOT_IN_SNAPSHOT: candidate ${input.candidateId} was not in the pre-warmed subtitle snapshot`,
      );
    }
    this.transferAttempted = true;
    let files: AssrtSubtitleFile[];
    try {
      files = await this.subtitleProvider.detail(input.candidateId);
    } catch {
      return {
        status: "failed",
        landedFilenames: [],
        chunksProcessed: 0,
        chunksTotal: 0,
        unattemptedCount: 0,
        chunkDiagnostics: [],
      };
    }
    if (files.length === 0) {
      return {
        status: "failed",
        landedFilenames: [],
        chunksProcessed: 0,
        chunksTotal: 0,
        unattemptedCount: 0,
        chunkDiagnostics: [],
      };
    }
    // Boundary guard (same class as the rename guard): only subtitle-extension
    // files may ride the landing pipeline. assrt's detail() can return a
    // whole-package .zip fallback or stray readme/fonts entries — those would
    // land as unusable junk in staging (renameSubtitle rejects them, cleanup has
    // to sweep them) while burning real 115 API budget, and a zip-only landing
    // would report a misleading "succeeded".
    // macOS AppleDouble twins (`._name.ass`, a few hundred bytes of resource-fork
    // metadata) ride inside zip-sourced assrt packages and pass the extension filter;
    // they land as junk (真机 2026-09-21). Drop them here too.
    const subtitleFiles = files.filter(
      (file) => SUBTITLE_NAME_PATTERN.test(file.filename) && !file.filename.startsWith("._"),
    );
    if (subtitleFiles.length === 0) {
      return {
        status: "failed",
        landedFilenames: [],
        chunksProcessed: 0,
        chunksTotal: 0,
        unattemptedCount: 0,
        chunkDiagnostics: [],
        error:
          "该字幕包没有可直接落盘的字幕文件(整包压缩包 zip/rar 落盘也无法使用)——换一个候选,或放弃字幕(软目标,不阻塞视频)。",
      };
    }
    const initial = indexSubtitleFiles(subtitleFiles);
    const pending = new Set(initial.map((file) => file.key));
    const chunksTotalPending = new Set(pending);
    let chunksTotal = 0;
    while (chunksTotalPending.size > 0) {
      const chunk = selectSubtitleChunk(initial, initial, chunksTotalPending, SUBTITLE_RENEWAL_CHUNK_SIZE);
      if (chunk.selected.length === 0) break;
      chunksTotal += 1;
      for (const file of chunk.selected) chunksTotalPending.delete(file.key);
    }
    let chunksProcessed = 0;
    let unattemptedCount = 0;
    let consecutiveFailures = 0;
    let circuitTripped = false;
    const landedFilenames: string[] = [];
    const chunkDiagnostics: SubtitleChunkDiagnostic[] = [];
    let lastError: string | undefined;

    while (pending.size > 0 && !circuitTripped) {
      const detailRefreshed = chunksProcessed > 0;
      const chunkNumber = chunksProcessed + 1;
      const chunkSize = consecutiveFailures > 0 ? 1 : SUBTITLE_RENEWAL_CHUNK_SIZE;
      let selected: ReturnType<typeof selectSubtitleChunk>["selected"];
      let missing: string[];
      if (!detailRefreshed) {
        ({ selected, missing } = selectSubtitleChunk(initial, initial, pending, SUBTITLE_RENEWAL_CHUNK_SIZE));
      } else {
        let refreshedFiles: AssrtSubtitleFile[];
        const candidateChunk = selectSubtitleChunk(initial, initial, pending, chunkSize);
        const candidateCount = candidateChunk.selected.length + candidateChunk.missing.length;
        try {
          refreshedFiles = await this.subtitleProvider.detail(input.candidateId);
        } catch {
          lastError = "字幕链接续签失败：无法刷新 assrt detail，已停止后续字幕块。";
          chunkDiagnostics.push({
            chunkNumber,
            requestedCount: candidateCount,
            detailRefreshed: false,
            landedCount: 0,
            unlandedCount: candidateCount,
            error: lastError,
          });
          break;
        }
        const refreshed = indexSubtitleFiles(
          refreshedFiles.filter(
            (file) => SUBTITLE_NAME_PATTERN.test(file.filename) && !file.filename.startsWith("._"),
          ),
        );
        ({ selected, missing } = selectSubtitleChunk(initial, refreshed, pending, chunkSize));
        if (consecutiveFailures > 0 && selected.length > 1) {
          selected = [selected[0]!];
          missing = [];
        }
        if (selected.length === 0) {
          lastError = "字幕链接续签后没有匹配的文件，已停止后续字幕块。";
          const requestedCount = selected.length + missing.length;
          chunkDiagnostics.push({
            chunkNumber,
            requestedCount,
            detailRefreshed: true,
            landedCount: 0,
            unlandedCount: requestedCount,
            error: lastError,
          });
          break;
        }
      }

      if (missing.length > 0) {
        unattemptedCount += missing.length;
        lastError = `字幕链接续签后 ${missing.length} 个文件不再存在，未复用旧链接。`;
      }
      for (const key of [...missing, ...selected.map((file) => file.key)]) pending.delete(key);

      // Storage owns brand-specific soft failure, budget, and auth semantics. A
      // throw remains loud; the sandbox only renews links and aggregates results.
      const results = await this.storage.transferSubtitleUrls({
        files: selected.map((file) => ({ url: file.url, filename: file.filename })),
        intoDirectoryId: this.stagingDirectoryId,
      });
      chunksProcessed += 1;
      let landedInChunk = 0;
      let chunkError: string | undefined = missing.length > 0 ? lastError : undefined;
      for (const result of results) {
        if (result.status === "succeeded") {
          landedFilenames.push(result.landedFilename ?? result.filename);
          landedInChunk += 1;
          if (!circuitTripped) consecutiveFailures = 0;
        } else {
          consecutiveFailures += 1;
          if (result.providerMessage) {
            lastError = result.providerMessage;
            chunkError = result.providerMessage;
          }
          if (consecutiveFailures >= SUBTITLE_MAX_CONSECUTIVE_FAILURES) {
            circuitTripped = true;
          }
        }
      }
      chunkDiagnostics.push({
        chunkNumber,
        requestedCount: selected.length + missing.length,
        detailRefreshed,
        landedCount: landedInChunk,
        unlandedCount: selected.length - landedInChunk + missing.length,
        ...(chunkError ? { error: chunkError } : {}),
      });
      if (circuitTripped) {
        if (lastError === undefined) {
          lastError = `已连续 ${SUBTITLE_MAX_CONSECUTIVE_FAILURES} 个字幕文件落盘失败，已停止后续字幕块。`;
        }
      }
    }

    if (landedFilenames.length === 0 && lastError === undefined) {
      lastError = "subtitle transfer failed (no files landed, no provider message)";
    }
    const remainingChunkSize = consecutiveFailures > 0 ? 1 : SUBTITLE_RENEWAL_CHUNK_SIZE;
    const remainingForCount = new Set(pending);
    let remainingChunks = 0;
    while (remainingForCount.size > 0) {
      const chunk = selectSubtitleChunk(initial, initial, remainingForCount, remainingChunkSize);
      if (chunk.selected.length === 0) break;
      remainingChunks += 1;
      for (const file of chunk.selected) remainingForCount.delete(file.key);
    }
    return {
      status: landedFilenames.length > 0 ? "succeeded" : "failed",
      landedFilenames,
      chunksProcessed,
      chunksTotal: Math.max(chunksTotal, chunksProcessed + remainingChunks),
      unattemptedCount: unattemptedCount + pending.size,
      chunkDiagnostics,
      ...(lastError ? { error: lastError } : {}),
    };
  }

  /** Rename landed subtitle files in staging (the ONE rename exception — subtitles
   *  are renamed to match their videos so scrapers auto-load them). BATCH shape:
   *  the agent decides EVERY subtitle↔episode pairing, then submits them in ONE
   *  call — live stress-testing (Re:Zero, 77 episodes, 2026-07-02) showed that a
   *  one-file-per-call tool collapses at scale (the agent renamed 1 of 77 pairs
   *  and gave up). One staging listing serves the whole batch; guards stay
   *  per-item (source must be a subtitle in THIS staging; the new name must keep
   *  a subtitle extension and contain no path separators) and violations are
   *  collected per item instead of aborting the batch. */
  async renameSubtitle(input: {
    renames: Array<{ fileId: string; newName: string }>;
  }): Promise<{ renamed: string[]; errors?: Array<{ fileId: string; error: string }> }> {
    if (!this.storage || !this.stagingDirectoryId) {
      throw new Error("SANDBOX: no storage/staging handle configured for subtitle rename");
    }
    if (input.renames.length === 0) {
      throw new Error(
        "SANDBOX_EMPTY_RENAMES: renames must not be empty — decide every subtitle↔episode pairing first (至少一项)",
      );
    }
    const staging = await this.listTreeOf(this.stagingDirectoryId);
    const renamed: string[] = [];
    const errors: Array<{ fileId: string; error: string }> = [];
    for (const { fileId, newName } of input.renames) {
      try {
        const target = staging.find((file) => file.id === fileId);
        if (!target) {
          throw new Error(`SANDBOX_FILE_NOT_IN_STAGING: ${fileId} is not in this task's staging`);
        }
        if (!target.isSubtitle) {
          throw new Error(
            `SANDBOX_NOT_A_SUBTITLE: ${fileId} is not a subtitle file; only subtitles may be renamed`,
          );
        }
        this.assertNotProtected([fileId]);
        if (/[\\/]/.test(newName)) {
          throw new Error(
            `SANDBOX_INVALID_SUBTITLE_NAME: newName must be a bare filename without path separators`,
          );
        }
        if (!SUBTITLE_NAME_PATTERN.test(newName)) {
          throw new Error(
            `SANDBOX_INVALID_SUBTITLE_NAME: newName must keep a subtitle extension (.srt/.ass/.ssa/.sub/.idx/.vtt/.sup/.smi)`,
          );
        }
        await this.storage.renameFile({
          directoryId: this.stagingDirectoryId,
          fileId,
          newName,
        });
        renamed.push(newName);
      } catch (error) {
        errors.push({ fileId, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { renamed, ...(errors.length > 0 ? { errors } : {}) };
  }
}
