import { memoryTitleKey, type AgentMemory, type AgentMemoryStore } from "../agent-memory.js";
import { buildReflectionDigest, runMemoryReflection } from "./agent-loop.js";
import type { LanguageModel } from "ai";
import type { AgentDecision, AuditEvent, ResourceSnapshot, TransferAttempt } from "../domain.js";
import type { ResourceProvider, StorageExecutor } from "../ports.js";
import type { AcquisitionAgentResult } from "./agent-loop.js";
import type { AgentToolEvent } from "./activity.js";
import { CandidateRegistry } from "./candidate-registry.js";
import type { DeadLinkStore } from "./dead-links.js";
import { linkHistoryByKey } from "./link-history.js";
import { resourceLinkKey } from "./resource-link.js";
import { resourceFingerprintMatches, type LinkHistoryRow } from "../user-requests.js";
import type { UserRequestPromptInput } from "./user-request-block.js";
import { RealResourceProviderV2 } from "./real-provider-adapter.js";
import { RealStorageV2 } from "./real-storage-adapter.js";
import { budgetSoftThreshold } from "./agent-loop-guards.js";
import { TaskSandbox } from "./sandbox.js";
import { JANITOR_LIST_DEPTH } from "../staging-depth.js";
import { AssrtSubtitleProvider, type AssrtProviderPort } from "../subtitle-provider.js";
import { JevPrefilterProvider } from "../jev-prefilter-provider.js";
import type { JevJudge, JevJudgeTarget } from "../jev-judge.js";
import type { SearchProfile } from "./search-profile.js";
import {
  needForMovie,
  needForTvTarget,
  runMovieTaskAgent,
  runTvAnimeTaskAgent,
  type MovieTarget,
  type TvAnimeTarget,
} from "./task-agents.js";

/**
 * Phase 6 — the composition root. Given the real provider + executor, a model,
 * a target, and the already-resolved scoped handles, it wires the registry +
 * both real adapters + the task sandbox (with the coverage need) and runs the
 * matching strong task agent's loop. This is the inner orchestration; the outer
 * workflow still owns resolving the handles (show/staging/season dirs) from the
 * media DB and persisting the trace.
 */
export type AcquisitionV2Target =
  | ({ kind: "tv" } & TvAnimeTarget)
  | ({ kind: "movie" } & MovieTarget);

export interface RunAcquisitionV2Request {
  provider: ResourceProvider;
  executor: StorageExecutor;
  model: LanguageModel;
  workflowRunId: string;
  target: AcquisitionV2Target;
  /** The scoped staging dir (under the show dir / storage parent — NEVER inside the Season dir). */
  stagingDirectoryId: string;
  /** TV: season number -> scoped Season directory. A multi-season pack's files are
   *  distributed across these; supply one entry per season the task covers. */
  targetSeasonDirectoryIds?: Record<number, string>;
  /** Movie: the single scoped movie directory this task may write into. */
  targetMovieDirectoryId?: string;
  searchBudget?: number;
  /** 预搜退避重试的等待毫秒数(sandbox 默认 PRESEARCH_RETRY_DELAY_MS)。测试注入 0。 */
  presearchRetryDelayMs?: number;
  maxSteps?: number;
  preferredLanguage?: string;
  /** TMDB origin_country of the title — when it includes CN the movie prompt skips
   *  the 中文 subtitle floor (国产片 natively Chinese-spoken). */
  originCountries?: string[];
  /** This title's per-media-type PanSou keyword recipe, injected into the prompt. */
  searchHints?: string;
  /** Rendered quality-preference guidance (召回后选片优先级), injected into the prompt. */
  qualityGuidance?: string;
  /** The task's fine-grained search profile — enables the anime taboo-keyword
   *  validator (warnings only, never blocking). 病2b。 */
  searchProfile?: SearchProfile;
  /** The run's drive brand — selects the brand transfer model + dead-links section. */
  storageProvider?: string;
  /** Filters known-dead candidates from search results before the agent sees them,
   *  and records newly-proven-dead links from failed transfers (#15). */
  deadLinkStore?: DeadLinkStore;
  /** assrt token (Settings → 字幕来源). When set AND origin is non-CN AND the
   *  drive is 115, the orchestrator pre-warms a subtitle snapshot and the agent
   *  gets viewSubtitleSnapshot/transferSubtitle tools. Undefined/empty = no
   *  subtitle flow (the agent never sees those tools). */
  assrtToken?: string;
  /** Injectable assrt provider (tests pass a spy). When absent, the orchestrator
   *  builds a real AssrtSubtitleProvider from assrtToken. */
  assrtProvider?: AssrtProviderPort;
  /** Optional Jev candidate prefilter. When present, request.provider is wrapped so
   *  the pre-warm AND every agent search are judged before the agent sees them.
   *  Absent = bare provider, byte-identical to before. Tests pass a spy. */
  jevJudge?: JevJudge;
  /** Per-tool-call live progress for the activity page (best-effort). */
  onProgress?: (event: AgentToolEvent) => void;
  /** Agent memory (design: docs/superpowers/specs/2026-09-25-agent-memory-design.md).
   *  Present + target.tmdbId known → this work's memory is injected into the prompt
   *  and a post-run reflection turn may write/update/delete it. Every memory step is
   *  best-effort: a failing store never affects the acquisition. */
  memory?: {
    store: AgentMemoryStore;
    accountId: string;
    /** The concrete drive this run lands on (connected-storage id; the brand when the
     *  run has none). Notes are tagged with it and other drives' notes are read-only
     *  to this run — two 115 accounts are two drives. */
    drive?: string;
    now?: () => string;
  };
  /** Episodes of this work that carry an old + replacement copy on purpose (the
   *  episode_sources rows). Present = the files already in the target dirs are
   *  protected for the whole run, so keep-larger dedup never undoes a replacement;
   *  the episodes are named in the prompt. "unknown" = the rows could not be read:
   *  protection stays on (fail closed), the prompt names no episode. */
  protectExisting?: { episodes: string[] | "unknown" };
  /** This work's rejected resources (account + work scoped: the user said "not this
   *  one", on any drive). Read on every search to filter them out, and again at every
   *  transfer — in EVERY run of the work, not only replace runs, so a patrol never
   *  lands what the user rejected. A failing read fails open (logged). On a replace
   *  run userRequest.rejectedStore is the source instead (same rows). */
  rejectedLookup?: {
    list: () => Promise<Array<{ episode?: string; linkKey: string | null; label: string; sizeBytes: number | null }>>;
  };
  /** This work's recent transfers, read once at run start and shown on candidates.
   *  A failing read fails open (logged, no notes). */
  linkHistory?: { list: () => Promise<LinkHistoryRow[]> };
  /** Leftover staging: no search, no transfer, no memory reflection. Season files stay protected. */
  stagingRecovery?: boolean;
  /** A replace_request run (user message). See docs/superpowers/specs/2026-09-26-user-message-replace-design.md. */
  userRequest?: {
    /** Episodes the user named or that are still pending (movie: ["MOVIE"]). Added to the need. */
    requestedEpisodes: string[];
    prompt: UserRequestPromptInput;
    /** Episode → link key of the copy an earlier replace run put in place (the
     *  episode_sources rows). A rejection of that episode carries the link, so the same
     *  resource is refused under any name: in the store, and for the rest of this run
     *  even when the store write fails. The fallback for a file landingLinkKeys has no
     *  link for. */
    sourceLinkKeys?: Record<string, string>;
    /** File id → link key of the resource whose transfer landed that file (this account + drive's
     *  transfer history), null when that link has no key; a file landed before the history was pruned
     *  is absent. How a rejection of a file an ordinary run landed carries its link: its name and size
     *  rarely match the search titles (a magnet's title is not its file name). */
    landingLinkKeys?: (fileIds: string[]) => Promise<Record<string, string | null>>;
    rejectedStore: {
      /** `episode` lets a repeated rejection be skipped (see onReject). */
      list: () => Promise<Array<{ episode?: string; linkKey: string | null; label: string; sizeBytes: number | null }>>;
      add: (rows: Array<{ episode: string; linkKey: string | null; label: string; sizeBytes: number | null; reason: string }>) => Promise<void>;
    };
  };
  /** Filled with the sandbox reader as soon as the sandbox exists, including when
   *  the agent loop later throws. The harness cleanup reads it from `finally`. */
  unmovedStaging?: { read: (() => string[]) | null };
  /** Same lifetime as unmovedStaging. True once the agent called discardStaging. */
  terminalCleanup?: { read: (() => boolean) | null };
}

/** The persistable trace of a V2 run, in the same shape the old serial path
 *  produced — so the workflow records snapshots/decisions/attempts unchanged. */
export interface AcquisitionV2Outcome {
  resourceSnapshots: ResourceSnapshot[];
  decisions: AgentDecision[];
  transferAttempts: TransferAttempt[];
}

export interface RunAcquisitionV2Result extends AcquisitionAgentResult {
  outcome: AcquisitionV2Outcome;
  auditEvents: AuditEvent[];
  /** Present only on a replace_request run. */
  replacement?: {
    /** One entry per episode (the last report wins). candidateId here is the
     *  PROVIDER's real id (mapped back from the agent's alias), with the title and
     *  link identity of the resource that landed. sizeBytes (replaced only) is the real
     *  total size of the episode's named video file(s) in its target dir — the title of
     *  a season pack would carry the whole pack's size. */
    results: Array<{
      episode: string;
      outcome: "replaced" | "not_found";
      candidateId?: string;
      label?: string;
      linkKey?: string | null;
      sizeBytes?: number;
      note: string;
    }>;
    /** The copies this run rejected that were not on the list yet (by episode, name and size) —
     *  what counts as the user asking for an episode again. A listed copy that only gained its
     *  link is recorded but not here. linkKey: the link it was rejected by too — of the transfer
     *  that landed the file, else the episode's recorded source (null = none known). */
    rejected: Array<{ episode: string; label: string; sizeBytes: number | null; linkKey: string | null; reason: string }>;
    /** Paths (relative to the library dir) of the rejected files, still in place. */
    oldFiles: string[];
    /** Whether the agent identified an episode in this run (a successful
     *  rejectCurrentSource, a no-file declaration included). False with a TV message
     *  without tags = no episode came out of its words (see UserMessageReply.unidentified). */
    identified: boolean;
    /** The rejected list could not be saved: this run still honoured it, the next
     *  run will not know it (the reply says so). */
    rejectedPersistFailed?: boolean;
  };
}

/** Which rejection items become rows, per episode. The sandbox guarantees one group
 *  per episode, so per group and per episode are the same thing. A video is a row; a
 *  subtitle (or anything else) beside one is not — it can never match a search
 *  candidate. An episode that names no video still records every file, so a rejection
 *  is never empty. One place. */
function rejectionRowItems<T extends { episode: string; isVideo: boolean }>(items: T[]): T[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = groups.get(item.episode);
    if (group) group.push(item);
    else groups.set(item.episode, [item]);
  }
  const rows: T[] = [];
  for (const group of groups.values()) {
    const videos = group.filter((item) => item.isVideo);
    rows.push(...(videos.length > 0 ? videos : group));
  }
  return rows;
}

export async function runAcquisitionV2(request: RunAcquisitionV2Request): Promise<RunAcquisitionV2Result> {
  // Before the provider exists, so the pre-warmed snapshot is annotated too.
  const linkNotes = await loadLinkHistory(request);
  const registry = new CandidateRegistry();
  // Where the stored rejected list comes from (see rejectedLookup). Absent = no
  // rejection filtering at all (callers that do not know the work).
  const rejectedSource: RunAcquisitionV2Request["rejectedLookup"] = request.userRequest?.rejectedStore ?? request.rejectedLookup;
  // A user replace run reads the rejected list strictly (fail closed): its whole point
  // is that a rejected source never comes back. Ordinary runs read it best-effort.
  const strictRejected = request.userRequest !== undefined;
  // Wrapping HERE (not at the call site) is what makes the pre-warm and every agent
  // searchResources go through the same filter — they all funnel through this adapter.
  const searchProvider = request.jevJudge
    ? new JevPrefilterProvider({ inner: request.provider, target: jevTargetOf(request.target), judge: request.jevJudge })
    : request.provider;
  const provider = new RealResourceProviderV2({
    provider: searchProvider,
    registry,
    workflowRunId: request.workflowRunId,
    ...(request.deadLinkStore ? { deadLinkStore: request.deadLinkStore } : {}),
    // Re-read on every search (closure over the collectors declared below; first
    // called only once the agent searches).
    ...(rejectedSource ? { rejectedResources: { list: () => listRejected(), ...(strictRejected ? { strict: true } : {}) } } : {}),
    ...(linkNotes.size > 0 ? { linkHistory: linkNotes } : {}),
  });
  const storage = new RealStorageV2({
    executor: request.executor,
    registry,
    workflowRunId: request.workflowRunId,
    ...(request.deadLinkStore ? { deadLinkStore: request.deadLinkStore } : {}),
  });
  const need = request.target.kind === "tv" ? needForTvTarget(request.target) : needForMovie();
  const userRequest = request.userRequest;
  const protectExisting =
    request.protectExisting && (request.protectExisting.episodes === "unknown" || request.protectExisting.episodes.length > 0)
      ? request.protectExisting
      : undefined;
  if (userRequest) {
    // The replace tools must never be registered without the rules that go with them;
    // the prompt block renders only when there is a message or a pending episode.
    if (userRequest.prompt.messages.length === 0 && userRequest.prompt.pending.length === 0) {
      throw new Error("USER_REQUEST_EMPTY: a replace run needs at least one message or pending episode");
    }
    for (const e of userRequest.requestedEpisodes) if (!need.includes(e)) need.push(e);
  }
  // Replace run collectors. Rejections made this run are also kept here, with the link
  // they are rejected by, so they are honoured for the rest of the run even when the
  // store write failed (spec §7).
  const replaceResults = new Map<string, NonNullable<RunAcquisitionV2Result["replacement"]>["results"][number]>();
  // Every row this run recorded (the filters read them); newlyRejected only the new copies.
  const replaceRejected: NonNullable<RunAcquisitionV2Result["replacement"]>["rejected"] = [];
  const newlyRejected: NonNullable<RunAcquisitionV2Result["replacement"]>["rejected"] = [];
  const oldFiles = new Set<string>();
  let rejectedPersistFailed = false;
  // Concurrent callers share one in-flight read (the sandbox re-checks every cached
  // candidate at once after a rejection); nothing is cached past that read.
  let storedInFlight: Promise<Array<{ linkKey: string | null; label: string; sizeBytes: number | null }>> | null = null;
  const readStored = () => {
    if (!storedInFlight) {
      storedInFlight = Promise.resolve()
        .then(() => rejectedSource?.list() ?? [])
        .finally(() => {
          storedInFlight = null;
        });
    }
    return storedInFlight;
  };
  const listRejected = async (): Promise<Array<{ linkKey: string | null; label: string; sizeBytes: number | null }>> => {
    let stored: Array<{ linkKey: string | null; label: string; sizeBytes: number | null }> = [];
    try {
      stored = await readStored();
    } catch (error) {
      // A user replace run reads strictly: an unreadable rejected list must not let a
      // rejected source through (the search / transfer fails instead and says so).
      // Ordinary runs filter on a best-effort basis and carry on.
      if (strictRejected) throw error;
      console.log(`[user-message] run ${request.workflowRunId} rejected list read failed: ${errorText(error)}`);
    }
    return [...stored, ...replaceRejected.map((r) => ({ linkKey: r.linkKey, label: r.label, sizeBytes: r.sizeBytes }))];
  };
  // The title key is computed HERE from the target — the agent never supplies it.
  const memoryNow = request.memory?.now ?? (() => new Date().toISOString());
  const memoryDrive = request.memory?.drive ?? request.storageProvider;
  const memoryBinding =
    request.memory && typeof request.target.tmdbId === "number" && request.target.tmdbId > 0
      ? {
          store: request.memory.store,
          accountId: request.memory.accountId,
          titleKey: memoryTitleKey({ kind: request.target.kind, tmdbId: request.target.tmdbId }),
          runId: request.workflowRunId,
          ...(memoryDrive ? { provider: memoryDrive } : {}),
          ...(memoryDrive && request.storageProvider && request.storageProvider !== memoryDrive
            ? { legacyProvider: request.storageProvider }
            : {}),
          now: memoryNow,
        }
      : undefined;
  const sandbox = new TaskSandbox({
    provider,
    storage,
    // The agent names aliases, never urls. Two PanSou titles of one share only
    // meet here, via the registry the provider recorded them under.
    linkOf: (id) => resourceLinkKey(String(registry.get(id)?.providerPayload?.["url"] ?? "")),
    // Movie-only 中文字幕软兜底: 8+2 budget + last-resort raw landing (the prompt's
    // soft floor authorizes it). TV/anime omit it → hard floor + hard 8-budget.
    ...(request.target.kind === "movie" ? { subtitleFallback: true } : {}),
    stagingDirectoryId: request.stagingDirectoryId,
    ...(request.targetSeasonDirectoryIds === undefined
      ? {}
      : { targetSeasonDirectoryIds: request.targetSeasonDirectoryIds }),
    ...(request.targetMovieDirectoryId === undefined
      ? {}
      : { targetMovieDirectoryId: request.targetMovieDirectoryId }),
    need,
    // The agent's search keywords must reference the title — reject genre/year-only
    // fallbacks ("2026 电影") at the tool boundary so they never burn a search.
    titleTerms: [request.target.title, ...request.target.aliases],
    ...(request.searchBudget === undefined ? {} : { searchBudget: request.searchBudget }),
    ...(request.presearchRetryDelayMs === undefined
      ? {}
      : { presearchRetryDelayMs: request.presearchRetryDelayMs }),
    ...(request.searchProfile === undefined ? {} : { searchProfile: request.searchProfile }),
    ...(memoryBinding ? { memory: memoryBinding } : {}),
    ...(protectExisting ? { protectExistingFiles: true } : {}),
    ...(request.stagingRecovery ? { stagingListDepth: JANITOR_LIST_DEPTH } : {}),
    ...(rejectedSource
      ? {
          isRejected: async (candidate: { id: string; title: string }) => {
            // Transfer-time guard for what the search filter could not catch (the raw
            // pre-search may predate a rejection; a repeated keyword is cached).
            try {
              const rows = await listRejected();
              const key = resourceLinkKey(String(registry.get(candidate.id)?.providerPayload?.["url"] ?? ""));
              return rows.some(
                (r) => (key !== null && r.linkKey === key) || resourceFingerprintMatches(candidate.title, r),
              );
            } catch (error) {
              // Replace run: fail closed — refuse the transfer (the agent sees why and can
              // retry) rather than risk landing the very source the user rejected.
              if (strictRejected) {
                throw new Error(
                  `SANDBOX_REJECTED_LIST_UNAVAILABLE: could not read the user's rejected list (${errorText(error)}) — try again in a moment`,
                );
              }
              console.log(`[user-message] run ${request.workflowRunId} rejected check failed (allowing): ${errorText(error)}`);
              return false;
            }
          },
        }
      : {}),
    ...(userRequest
      ? {
          replace: {
            requestedEpisodes: userRequest.requestedEpisodes,
            // A message is words to read episodes from (an untagged TV message requests
            // none up front); a pending-only re-check has only its 待换 episodes.
            hasMessages: userRequest.prompt.messages.length > 0,
            // An untagged TV message needs an episode identified in THIS run: the
            // episodes already requested (older 待换 rows, other messages' tags) say
            // nothing about it. A movie message means the film (requested as MOVIE).
            untaggedMessages:
              request.target.kind === "tv" ? userRequest.prompt.messages.filter((m) => m.episodeTags.length === 0).length : 0,
            // Stored rejections from earlier runs let a PENDING-ONLY re-check (no new
            // message this run — the earlier rejection is why we are here) skip
            // rejecting again. A NEW message means the user is unhappy with what is in
            // place NOW (which may itself be an earlier replacement) — that file must
            // be rejected this run before anything transfers, so the bypass is withheld.
            alreadyRejectedEpisodes:
              userRequest.prompt.messages.length === 0
                ? [...new Set(userRequest.prompt.rejected.map((r) => r.episode))]
                : [],
            onReject: async (items) => {
              // Rows only: videos, or every file of a group that has none. oldFiles below
              // still keeps every path, subtitle included.
              const recorded = rejectionRowItems(items);
              // Every recorded file's link first, before anything is recorded: two files can
              // share a name and size yet come from different resources. A rejection without
              // its link is the very hole this closes, so an unreadable history refuses the
              // whole call (fail closed, like the run's other strict reads) and the agent
              // can call again.
              let landed = new Map<string, string | null>();
              if (userRequest.landingLinkKeys) {
                try {
                  landed = new Map(Object.entries(await userRequest.landingLinkKeys([...new Set(recorded.map((i) => i.fileId))])));
                } catch (error) {
                  throw new Error(
                    `SANDBOX_REJECT_SOURCE_UNAVAILABLE: could not read which transfer landed these files (${errorText(error)}) — try again in a moment`,
                  );
                }
              }
              // Reject by link too, not only name+size — here and in the store: the link of
              // the transfer that landed the file (an episode replaced once has two files,
              // each with its own source; null when its link has no key — still that file's
              // own source), else, for a file whose transfer is no longer on record, the
              // episode's recorded source.
              const rows = recorded.map((i) => ({
                episode: i.episode,
                linkKey: landed.has(i.fileId) ? (landed.get(i.fileId) ?? null) : (userRequest.sourceLinkKeys?.[i.episode] ?? null),
                label: i.label,
                sizeBytes: i.sizeBytes,
                reason: i.reason,
              }));
              // Skip what adds nothing, in the store or earlier this run (the agent may reject
              // the same file twice): a row of the same episode, name and size that already
              // carries this link — or, for a row without a link, any such row. A row stored
              // without a link still gains one.
              type Seen = { episode: string; label: string; sizeBytes: number | null; linkKey: string | null };
              const plainKey = (r: Seen) => JSON.stringify([r.episode, r.label, r.sizeBytes]);
              const exactKey = (r: Seen) => JSON.stringify([r.episode, r.label, r.sizeBytes, r.linkKey]);
              const plain = new Set<string>();
              const exact = new Set<string>();
              const note = (r: Seen) => {
                plain.add(plainKey(r));
                exact.add(exactKey(r));
              };
              for (const r of replaceRejected) note(r);
              try {
                for (const r of await userRequest.rejectedStore.list()) {
                  if (r.episode !== undefined) note({ episode: r.episode, label: r.label, sizeBytes: r.sizeBytes, linkKey: r.linkKey });
                }
              } catch (error) {
                console.log(`[user-message] run ${request.workflowRunId} rejected list read failed (not deduping): ${errorText(error)}`);
              }
              const fresh: typeof rows = [];
              const newCopies: typeof rows = [];
              for (const r of rows) {
                if (exact.has(exactKey(r)) || (r.linkKey === null && plain.has(plainKey(r)))) continue;
                // A copy already listed (same episode, name and size) that only gains a link is
                // recorded, for the filters, but asks for nothing new: re-rejecting a listed copy
                // never re-opens an episode the user let go.
                if (!plain.has(plainKey(r))) newCopies.push(r);
                note(r);
                fresh.push(r);
              }
              for (const i of items) oldFiles.add(i.path);
              if (fresh.length === 0) return;
              replaceRejected.push(...fresh);
              newlyRejected.push(...newCopies);
              try {
                await userRequest.rejectedStore.add(fresh);
              } catch (error) {
                // Best-effort (spec §7): the run goes on and the reply says the list was not saved.
                rejectedPersistFailed = true;
                console.log(`[user-message] run ${request.workflowRunId} rejected list write failed: ${errorText(error)}`);
              }
            },
            onReport: async (results) => {
              for (const r of results) {
                // The agent speaks in short aliases (s2-14); persistence needs the real
                // candidate, its title and its link identity (for episode_sources and a
                // future rejection of this same resource).
                // Only a replaced result names what landed; a not_found never carries one.
                const candidate = r.outcome === "replaced" && r.candidateId ? registry.get(r.candidateId) : undefined;
                // A not_found may be upgraded to replaced later in the run: the last report wins.
                replaceResults.set(r.episode, {
                  episode: r.episode,
                  outcome: r.outcome,
                  note: r.note,
                  ...(candidate
                    ? {
                        candidateId: candidate.id,
                        label: candidate.title,
                        linkKey: resourceLinkKey(String(candidate.providerPayload?.["url"] ?? "")),
                      }
                    : {}),
                  ...(r.outcome === "replaced" && r.sizeBytes !== undefined ? { sizeBytes: r.sizeBytes } : {}),
                });
              }
            },
          },
        }
      : {}),
  });
  if (request.unmovedStaging) {
    request.unmovedStaging.read = () => sandbox.unmovedStagingFileIds();
  }
  if (request.terminalCleanup) {
    request.terminalCleanup.read = () => sandbox.stagingDiscarded();
  }
  // Replace run (or protected existing files): record every file already in the target dirs
  // BEFORE anything can touch them. Not best-effort — the protection is the whole
  // safety story, so a failing listing fails the run.
  if (userRequest || protectExisting) await sandbox.captureProtectedFiles();
  const loadedMemory = await loadMemoryForRun(request, memoryBinding);

  // Pre-warm the raw snapshot (bare title) BEFORE building the system prompt, so the
  // prefetchedCandidateCount pointer can be injected. If the provider fails (network
  // error, etc.), gracefully degrade: no pointer, agent searches normally.
  // A staging recovery does not search at all.
  let prefetchedCandidateCount: number | undefined;
  if (!request.stagingRecovery) {
    try {
      const rawKeyword = request.target.title; // bare title (中文名), no quality/subtitle/year
      await sandbox.primeRawSnapshot(rawKeyword);
      prefetchedCandidateCount = sandbox.viewResourceSnapshot().candidateCount;
    } catch (error) {
      // Provider unavailable → no pre-warm; agent will searchResources normally.
      // Do NOT crash the workflow.
      prefetchedCandidateCount = undefined;
    }
  }

  // Pre-warm the assrt subtitle snapshot when all three gates pass: token
  // configured, KNOWN non-CN origin, and the EXECUTOR can land external
  // subtitle urls. UNKNOWN origin (undefined/empty originCountries — missing
  // TMDB metadata) counts as NOT eligible: niche 国产短剧 are precisely the
  // titles most likely to lack origin metadata, while mainstream foreign
  // titles essentially always carry it — and a false positive here recurs on
  // EVERY patrol tick, burning the shared assrt quota (20/min) and confusing
  // the agent with subtitle tools on a natively-Chinese title. Requiring known
  // non-CN loses almost nothing and matches the UI copy (仅对非国产内容生效).
  // The third gate is a CAPABILITY probe (transferSubtitleUrl presence), not a
  // brand string — a brand's executor that implements the method lights
  // subtitles up automatically, and the gate can never disagree with what the
  // executor can actually do (today 115 / 光鸭 / 123 implement it; 夸克 and
  // 天翼 have no offline-download API).
  // Soft-fail: a flaky assrt / empty search sets an empty snapshot, never
  // blocks the video task. When the gates don't pass, the subtitle tools are
  // simply not registered (the agent never knows subtitles were an option).
  // The probe deliberately targets the SINGLE-FILE method even though
  // RealStorageV2 prefers a brand's batch transferSubtitleUrls: every brand
  // that lands subtitles implements the single one (115's is a thin delegate
  // to its batch), so a brand adding only the batch must add the delegate
  // too — see the 加品牌 touch-point list.
  const origins = request.originCountries ?? [];
  const subtitleActive =
    !request.stagingRecovery &&
    request.assrtToken !== undefined &&
    request.assrtToken.trim() !== "" &&
    origins.length > 0 &&
    origins.every((c) => c !== "CN") &&
    typeof request.executor.transferSubtitleUrl === "function";
  let subtitleCandidateCount: number | undefined;
  if (subtitleActive) {
    const subtitleProvider: AssrtProviderPort =
      request.assrtProvider ?? new AssrtSubtitleProvider({ token: request.assrtToken! });
    try {
      await sandbox.primeSubtitleSnapshot(request.target.title, subtitleProvider);
      // Feed the prompt pointer line (the 活期文档 twin of prefetchedCandidateCount).
      subtitleCandidateCount = sandbox.viewSubtitleSnapshot().candidateCount;
    } catch {
      // assrt unavailable → empty snapshot; the subtitle tools still register
      // (viewSubtitleSnapshot will show "no snapshot"), agent decides from there.
    }
  }

  const common = {
    sandbox,
    model: request.model,
    ...(request.maxSteps === undefined ? {} : { maxSteps: request.maxSteps }),
    ...(request.preferredLanguage === undefined ? {} : { preferredLanguage: request.preferredLanguage }),
    ...(request.originCountries === undefined ? {} : { originCountries: request.originCountries }),
    ...(request.searchHints === undefined ? {} : { searchHints: request.searchHints }),
    ...(request.qualityGuidance === undefined ? {} : { qualityGuidance: request.qualityGuidance }),
    ...(request.storageProvider === undefined ? {} : { storageProvider: request.storageProvider }),
    ...(subtitleActive ? { subtitle: true } : {}),
    ...(subtitleCandidateCount ? { subtitleCandidateCount } : {}),
    ...(request.onProgress ? { onProgress: request.onProgress } : {}),
    // Real 115 exposes its cumulative call count → drives the budget soft-warning
    // in the agent loop; fakes/sim omit apiCallCount → no nudge.
    ...(request.executor.apiCallCount ? { apiCallCount: () => request.executor.apiCallCount!() } : {}),
    // Soft threshold derived from the agent-facing budget (apiCallBudget is the
    // hard limit minus the harness cleanup reserve) so the nudge lands before the
    // wall the agent can hit, including when MEDIA_TRACK_115_MAX_API_CALLS overrides it.
    ...(request.executor.apiCallBudget
      ? { budgetSoftAt: budgetSoftThreshold(request.executor.apiCallBudget()) }
      : {}),
    // Inject the prefetched candidate count into the prompt so the pointer renders.
    ...(prefetchedCandidateCount === undefined ? {} : { prefetchedCandidateCount }),
    ...(loadedMemory
      ? {
          memory: {
            ...loadedMemory,
            ...(memoryDrive ? { currentDrive: memoryDrive } : {}),
            ...(request.storageProvider ? { currentBrand: request.storageProvider } : {}),
          },
        }
      : {}),
    ...(userRequest ? { userRequests: userRequest.prompt } : {}),
    ...(protectExisting ? { protectExisting } : {}),
    ...(request.stagingRecovery ? { stagingRecovery: true as const } : {}),
  };

  const result =
    request.target.kind === "tv"
      ? await runTvAnimeTaskAgent({ ...common, target: stripKind(request.target) })
      : await runMovieTaskAgent({ ...common, target: stripKind(request.target) });
  // Every requested/rejected episode the agent did not report becomes not_found
  // (stays 待换). After the loop — the content-filter recovery turn included.
  if (userRequest) await sandbox.finalizeReplacement();

  // The agent transferred candidates by id; the storage adapter recorded the
  // domain attempts and the provider adapter the domain snapshots. Assemble the
  // same AcquisitionOutcome shape the old serial path persisted. No episode
  // mapping (§1.13): the decision records what was selected/observed, not a
  // fileId↔episode map.
  const transferAttempts = storage.attempts().map((attempt) => {
    const fate = sandbox.materializedFateOf(attempt.materializedFileIds);
    return fate ? { ...attempt, fate } : attempt;
  });
  const resourceSnapshots = provider.snapshots();

  // Post-run reflection: best-effort, never changes the outcome.
  // A staging recovery is not an acquisition the next run should learn from.
  if (memoryBinding && !request.stagingRecovery) {
    // Built from outside data (candidate titles, provider messages) — inside the
    // best-effort boundary: a digest that cannot be built falls back to the coverage
    // line; it never turns a finished acquisition into a failed run.
    let digest: string;
    try {
      digest = buildReflectionDigest({
        searches: sandbox.searchHistory(),
        ...(memoryDrive ? { drive: memoryDrive } : {}),
        ...(request.storageProvider ? { driveBrand: request.storageProvider } : {}),
        // Attempts store the provider's real candidate id; the sandbox tracked each
        // file under the alias the agent passed. The file ids are the same on both.
        attempts: transferAttempts.map((attempt) =>
          attempt.fate ? { ...attempt, kept: attempt.fate.kept, thrownAway: attempt.fate.thrownAway } : attempt,
        ),
        candidateTitle: (id) => registry.get(id)?.title,
        coverage: result.coverage,
        auditEvents: sandbox.auditTrail(),
      });
    } catch (error) {
      digest = `COVERAGE: ${result.coverage.coverageMet ? "met" : "NOT met"} (details unavailable: ${error instanceof Error ? error.message.slice(0, 120) : "unknown"})`;
    }
    if (userRequest) {
      // Facts only: the matching instruction goes outside the fence (userRequest below).
      const outcomes = [...replaceResults.values()].map((r) => `${r.episode} ${r.outcome}`).join(", ");
      digest += `\nUSER REQUEST: ${outcomes || "(no episodes reported)"}`;
    }
    const reflection = await runMemoryReflection({
      sandbox,
      model: request.model,
      digest,
      memory: loadedMemory ?? { title: [], globalIndex: [] },
      ...(userRequest ? { userRequest: true } : {}),
    });
    console.log(
      `[memory] run ${request.workflowRunId} title=${memoryBinding.titleKey} ${reflection.ran ? `changes=${reflection.changes}` : `skipped=${reflection.skipped ?? "-"}`}`,
    );
  }
  const decisions = buildAgentDecisions({
    transferAttempts,
    resourceSnapshots,
    coverageMet: result.coverage.coverageMet,
    // The finish terminal stop ends the loop AT the finish step, so a SUCCESSFUL
    // run has no closing free-text turn — fall back to the honest coverage summary
    // for that case. Other mechanical stops (systemic block / no-coverage) also
    // leave text empty; their reasons already persist elsewhere (each attempt's
    // providerMessage / the reportNoCoverage reason), so they keep the pre-existing
    // empty-reason behavior here.
    reason:
      result.text ||
      (result.coverage.coverageMet
        ? `已完成:obtained=${result.coverage.obtained.join(",") || "-"}(finish 终结即停)`
        : result.text),
  });
  return {
    ...result,
    outcome: { resourceSnapshots, decisions, transferAttempts },
    auditEvents: sandbox.auditTrail(),
    ...(userRequest
      ? {
          replacement: {
            results: [...replaceResults.values()],
            rejected: newlyRejected,
            oldFiles: [...oldFiles],
            identified: sandbox.identifiedThisRun(),
            ...(rejectedPersistFailed ? { rejectedPersistFailed: true } : {}),
          },
        }
      : {}),
  };
}

/** A log-sized error message (outside errors can carry whole response bodies). */
function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 160 ? `${message.slice(0, 160)}…` : message;
}

/**
 * Assemble the persistable AgentDecision[] from the run's transfers + observed
 * snapshots. The agent may search SEVERAL times and transfer a candidate from a
 * LATER snapshot; persist validation (repository.ts) requires each decision's
 * selected candidates to belong to THAT decision's snapshot — so we group the
 * selected candidates by their REAL snapshot and emit one decision per snapshot.
 * (Tagging a single decision with resourceSnapshots[0] failed live e2e when the
 * agent transferred from a non-first search.)
 */
export function buildAgentDecisions(input: {
  transferAttempts: TransferAttempt[];
  resourceSnapshots: ResourceSnapshot[];
  coverageMet: boolean;
  reason: string;
}): AgentDecision[] {
  const snapshotByCandidate = new Map<string, string>();
  for (const snapshot of input.resourceSnapshots) {
    for (const candidate of snapshot.candidates) {
      snapshotByCandidate.set(candidate.id, snapshot.id);
    }
  }
  const selectedBySnapshot = new Map<string, string[]>();
  for (const candidateId of new Set(input.transferAttempts.map((attempt) => attempt.candidateId))) {
    const snapshotId = snapshotByCandidate.get(candidateId);
    if (snapshotId === undefined) continue; // unknown candidate — the transferAttempts validation catches it
    const selected = selectedBySnapshot.get(snapshotId) ?? [];
    selected.push(candidateId);
    selectedBySnapshot.set(snapshotId, selected);
  }
  return [...selectedBySnapshot.entries()].map(([snapshotId, selectedCandidateIds]) => ({
    node: "acquisition_v2_sandbox_agent",
    snapshotId,
    selectedCandidateIds,
    episodeMapping: {},
    providerAheadEpisodeMapping: {},
    rejectedCandidateIds: [],
    confidence: input.coverageMet ? "high" : "low",
    reason: input.reason.slice(0, 2000),
  }));
}

function stripKind<T extends { kind: unknown }>(target: T): Omit<T, "kind"> {
  const { kind: _kind, ...rest } = target;
  return rest;
}

/** The judge sees only what identifies the work: title, aliases, kind, and the
 *  first-air/release year when it is actually known. A 0 (movie-workflow's
 *  `year ?? 0` for an undated film) or a NaN must NEVER reach the judge — its
 *  「候选标注年份比首播年份早2年及以上判否」 rule would then reject every dated candidate. */
function jevTargetOf(target: AcquisitionV2Target): JevJudgeTarget {
  // `typeof` first so the narrowing is real, not a cast asserting what we hope is true.
  const y = target.year;
  const year = typeof y === "number" && Number.isFinite(y) && y > 0 ? y : undefined;
  const base = { title: target.title, aliases: target.aliases, ...(year === undefined ? {} : { year }) };
  switch (target.kind) {
    case "movie":
      return { kind: "movie", ...base };
    case "tv":
      return { kind: "tv", ...base };
    default: {
      const never: never = target;
      throw new Error(`unknown target kind: ${String((never as { kind?: unknown }).kind)}`);
    }
  }
}

/** This work's link notes, or an empty map. A failing read never fails the run. */
async function loadLinkHistory(request: RunAcquisitionV2Request): Promise<Map<string, string>> {
  if (!request.linkHistory) return new Map();
  try {
    return linkHistoryByKey(await request.linkHistory.list());
  } catch (error) {
    console.log(`[link-history] run ${request.workflowRunId} read failed (no history this run): ${errorText(error)}`);
    return new Map();
  }
}

/** Load this work's memory (full) and the global index for the prompt, and mark the
 *  injected entries as used. Any store failure → no memory for this run. */
async function loadMemoryForRun(
  request: RunAcquisitionV2Request,
  binding: { store: AgentMemoryStore; accountId: string; titleKey: string; now: () => string } | undefined,
): Promise<{ title: AgentMemory[]; globalIndex: AgentMemory[] } | undefined> {
  if (!binding) return undefined;
  try {
    const [title, global] = await Promise.all([
      binding.store.listAgentMemories({ accountId: binding.accountId, scope: "title", titleKey: binding.titleKey }),
      binding.store.listAgentMemories({ accountId: binding.accountId, scope: "global" }),
    ]);
    const ids = [...title, ...global].map((m) => m.id);
    if (ids.length > 0) {
      await binding.store.touchAgentMemories({ accountId: binding.accountId, ids, now: binding.now() }).catch(() => undefined);
    }
    return { title, globalIndex: global };
  } catch (error) {
    console.log(`[memory] run ${request.workflowRunId} load failed (no memory this run): ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}
