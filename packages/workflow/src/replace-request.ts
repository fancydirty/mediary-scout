import type { LanguageModel } from "ai";
import type { QueueClaimOptions, TrackedSeasonState, WorkflowRepository } from "./repository.js";
import { claimNextQueuedRun } from "./repository.js";
import type { AuditEvent, EpisodeState, TrackedSeason } from "./domain.js";
import { syncSeasonAgainstMetadata } from "./season-sync.js";
import type { ResourceProvider, StorageExecutor } from "./ports.js";
import type { JevJudge } from "./jev-judge.js";
import type { RunAcquisitionV2Request, RunAcquisitionV2Result } from "./acquisition-v2/orchestrator.js";
import { resourceLinkKey } from "./acquisition-v2/resource-link.js";
import {
  parseSizeFromTitle,
  userMessageDrive,
  type EpisodeSource,
  type ReplacementResult,
  type UserMessage,
  type UserMessageReply,
  type UserMessageScope,
} from "./user-requests.js";
import type { WorkflowStatus } from "./domain.js";
import { runMovieAcquisitionV2AndPersist, runReplaceRequestV2AndPersist } from "./runner-v2.js";
import {
  handleWorkflowRunFailure,
  requireCategoryParent,
  resolveWorkerDeps,
  storageParentForTitle,
  type AccountWorkerContext,
  type MayStartRun,
  type QueuedType2WorkerResult,
  type ResolveAccountWorkerContext,
  type SeasonMetadataSync,
} from "./worker.js";

/**
 * The replace_request run: a user left a message on a work ("13、24 集发蓝", "这是假片")
 * or an earlier request left episodes 待换. One run covers every tracked season of the
 * work on one drive (the message is about the whole work), holds a title-level lock,
 * and is queued by the patrol (Task 11), by "现在处理", or by the idle-queue scan for
 * urgent messages. Design: docs/superpowers/specs/2026-09-26-user-message-replace-design.md.
 */

/** The tracked states of ONE work on ONE drive (all seasons, or the movie anchor). */
async function workStates(repository: WorkflowRepository, work: UserMessageScope): Promise<TrackedSeasonState[]> {
  // A null storage scope is account-wide, so the exact-drive filter stays.
  const states = await repository.listTrackedSeasonStates({
    accountId: work.accountId,
    connectedStorageId: work.drive === "" ? null : work.drive,
  });
  return states
    .filter((s) => userMessageDrive(s.connectedStorageId) === work.drive && s.title.id === work.titleKey)
    .sort((a, b) => a.season.seasonNumber - b.season.seasonNumber);
}

/** Who queued a replace run: the patrol (its report joins the daily digest) or the
 *  user (现在处理 / the idle scan for urgent messages — pushed on its own). */
export type ReplaceRequestOrigin = "patrol" | "user";

/** Reservations tried before giving up on a work whose lock season keeps being
 *  untracked between the read and the reservation (see queueReplaceRequest). */
const QUEUE_ATTEMPTS = 3;

export async function queueReplaceRequest(input: {
  repository: WorkflowRepository;
  work: UserMessageScope;
  now?: () => string;
  createWorkflowRunId?: () => string;
  /** Default "user". Recorded on the queued audit event. */
  origin?: ReplaceRequestOrigin;
}): Promise<{ status: "queued" | "already_running" | "not_tracked"; workflowRunId: string | null }> {
  const now = input.now ?? (() => new Date().toISOString());
  const workflowRunId = input.createWorkflowRunId?.() ?? crypto.randomUUID();
  const queuedAt = now();
  for (let attempt = 0; attempt < QUEUE_ATTEMPTS; attempt++) {
    const states = await workStates(input.repository, input.work);
    // The lowest season is the lock: the run is reserved on it, title-level exclusive.
    const lock = states[0];
    if (!lock) return { status: "not_tracked", workflowRunId: null };
    const reservation = await input.repository.reserveWorkflowRun({
      accountId: lock.accountId,
      ...(lock.connectedStorageId != null ? { connectedStorageId: lock.connectedStorageId } : {}),
      title: lock.title,
      season: lock.season,
      workflowRun: {
        id: workflowRunId,
        kind: "replace_request",
        status: "queued",
        trackedSeasonId: lock.season.id,
        startedAt: queuedAt,
        finishedAt: null,
        auditEvents: [
          {
            type: "replace_request_queued",
            message: `Queued replace request ${workflowRunId}`,
            data: { origin: input.origin ?? "user" },
          },
        ],
      },
      // Not written (keepCurrentEpisodes below): the season's stored episodes stay as they are.
      episodes: lock.episodes,
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
      blockIfTitleHasActiveRun: true,
      // The states were read before this call: a season untracked in between must not
      // be tracked again by the reservation. It writes nothing then, and the states are
      // read again — the lowest season still tracked becomes the lock, none left means
      // the work is gone from this drive.
      requireTrackedSeason: true,
      // …and a run of the lock season that saved in between (an episode landed) must not
      // be rolled back to this copy: the reservation writes only the run.
      keepCurrentEpisodes: true,
    });
    if (reservation.status === "not_tracked") continue;
    if (reservation.status === "already_active") {
      return { status: "already_running", workflowRunId: reservation.snapshot.workflowRun.id };
    }
    if (reservation.status !== "reserved") return { status: "already_running", workflowRunId: null };
    return { status: "queued", workflowRunId };
  }
  return { status: "not_tracked", workflowRunId: null };
}

/** How long a finished run may still hold its messages: a failed run is saved before it
 *  releases them (releaseAfterFailure), which takes seconds, so anything older lost that
 *  write — or its reply write (a run that succeeded finishes its messages before its own
 *  terminal record). */
const ORPHANED_MESSAGE_GRACE_MS = 10 * 60 * 1000;

/** Idle-queue scan: every work with an urgent pending message and no active run. */
export async function enqueueUrgentReplaceRequests(input: {
  repository: WorkflowRepository;
  now?: () => string;
}): Promise<number> {
  const nowIso = (input.now ?? (() => new Date().toISOString()))();
  // A worker that died between claiming messages and finishing them leaves them in
  // processing with no live run: hand them back (to the patrol) first.
  await input.repository.releaseOrphanedUserMessages({
    now: nowIso,
    finishedBefore: new Date(Date.parse(nowIso) - ORPHANED_MESSAGE_GRACE_MS).toISOString(),
  });
  let n = 0;
  // A run that failed for good hands its whole work to the patrol (see
  // releaseAfterFailure), so a broken setup (dead LLM key, missing library dir) is never
  // retried here every few seconds; 现在处理 makes the work urgent again.
  for (const work of await input.repository.listWorksWithPendingMessages({ urgentOnly: true })) {
    const result = await queueReplaceRequest({ repository: input.repository, work, ...(input.now ? { now: input.now } : {}) });
    if (result.status === "queued") n += 1;
    // Nothing of the work is tracked on its drive any more: no run can ever take these
    // messages, so stop scanning them every tick (untracking withdraws them; this covers
    // whatever slipped past that).
    if (result.status === "not_tracked") await input.repository.clearUserMessagesUrgent({ ...work, now: nowIso });
  }
  return n;
}

/** After a failed run its messages go back to pending. A run queued again (a transient
 *  error, retried after a backoff of at least a minute — so this release always lands
 *  before the retry can claim them) keeps them urgent: they wait for that retry, and the
 *  idle scan cannot queue a second run beside it. A final failure — or one that could
 *  not even be recorded — hands the whole work to the patrol: none of its messages stays
 *  urgent (one written during the run included), or the idle scan would retry a broken
 *  setup every few seconds. Best-effort: logged, never thrown. */
async function releaseAfterFailure(input: {
  repository: WorkflowRepository;
  work: UserMessageScope;
  runId: string;
  requeued: boolean;
  now: () => string;
}): Promise<void> {
  try {
    await input.repository.releaseUserMessages({ runId: input.runId, now: input.now(), urgent: input.requeued });
  } catch (error) {
    console.error(`[user-message] run ${input.runId} could not release its messages: ${String(error)}`);
  }
  if (input.requeued) return;
  try {
    await input.repository.clearUserMessagesUrgent({ ...input.work, now: input.now() });
  } catch (error) {
    console.error(`[user-message] run ${input.runId} could not hand its work to the patrol: ${String(error)}`);
  }
}

type UserRequest = NonNullable<RunAcquisitionV2Request["userRequest"]>;

export async function runQueuedReplaceRequest(
  input: AccountWorkerContext & {
    repository: WorkflowRepository;
    resourceProvider: ResourceProvider;
    storage: StorageExecutor;
    model: LanguageModel;
    storageParentDirectoryId: string;
    moviesParentDirectoryId: string;
    /** TMDB refresh of aired/total counts. A work with 待换 episodes is skipped by
     *  the patrol, where the sync normally happens — so this run does it instead. */
    syncSeasonMetadata?: SeasonMetadataSync;
    now?: () => string;
    resolveAccountContext?: ResolveAccountWorkerContext;
    onAuthErrorFreeze?: (storageId: string, reason: string) => Promise<void>;
    mayStartRun?: MayStartRun;
    /** The worker's drive filter and claim callback when queued runs go side by side. */
    claim?: QueueClaimOptions;
  },
): Promise<QueuedType2WorkerResult> {
  const now = input.now ?? (() => new Date().toISOString());
  const repository = input.repository;
  if (input.mayStartRun && !input.mayStartRun()) return { status: "idle" };
  const claimed = await claimNextQueuedRun(repository, "replace_request", now(), input.claim);
  if (!claimed) return { status: "idle" };
  const runId = claimed.workflowRun.id;
  const work: UserMessageScope = {
    accountId: claimed.accountId,
    drive: userMessageDrive(claimed.connectedStorageId),
    titleKey: claimed.title.id,
  };

  let messages: UserMessage[] = [];
  let pendingRows: Awaited<ReturnType<WorkflowRepository["listPendingReplacements"]>> = [];
  let sources: EpisodeSource[] = [];
  let replacement: RunAcquisitionV2Result["replacement"];
  let workflowStatus: WorkflowStatus;
  /** Set once the run succeeded: writes the lock run's terminal record (see HeldLockRun). */
  let finishLockRun: (() => Promise<void>) | undefined;
  /** A TV message this run carries names no (in-scope) episode: its episodes are read
   *  from the words, so the reply says whether any came out (see UserMessageReply.unidentified). */
  let untaggedTvMessage = false;
  try {
    messages = await repository.claimUserMessages({ ...work, runId, now: now() });
    const states = await workStates(repository, work);
    if (!states.some((s) => s.season.id === claimed.season.id)) {
      throw new Error(`REPLACE_REQUEST_NOT_TRACKED: ${work.titleKey} is no longer tracked on this drive`);
    }
    const lockState = states.find((s) => s.season.id === claimed.season.id)!;
    const movie = claimed.title.type === "movie";
    // A film obtained before the run: its old file is in the library, so it stays
    // obtained whatever this run lands, and the prompt may say it is there.
    const filmObtained = movie && lockState.episodes.some((e) => e.obtained);

    // Only episodes of the seasons tracked here can be replaced (movie: the film). An
    // old tag or a 待换 row of a season untracked since would only be refused by the
    // sandbox; the stale 待换 rows are dropped for good.
    const inScope = episodeScope(movie, states);
    const allPending = await repository.listPendingReplacements(work);
    pendingRows = allPending.filter((p) => inScope(p.episode));
    const stale = allPending.filter((p) => !inScope(p.episode)).map((p) => p.episode);
    if (stale.length > 0) await repository.removePendingReplacements({ ...work, episodes: stale });
    const pending = pendingRows.map((p) => p.episode);

    if (messages.length === 0 && pending.length === 0) {
      // Everything was withdrawn (or already replaced) before the run started.
      await repository.saveWorkflowRunSnapshot({
        accountId: claimed.accountId,
        connectedStorageId: claimed.connectedStorageId,
        title: claimed.title,
        season: lockState.season,
        workflowRun: {
          ...claimed.workflowRun,
          status: "succeeded",
          finishedAt: now(),
          auditEvents: [...claimed.workflowRun.auditEvents, { type: "replace_request_empty", message: "No message or pending episode left" }],
        },
        episodes: lockState.episodes,
        resourceSnapshots: [],
        decisions: [],
        transferAttempts: [],
        notifications: [],
      });
      return { status: "ran", workflowRunId: runId, workflowStatus: "succeeded" };
    }

    const requested = [...new Set([...messages.flatMap((m) => m.episodeTags), ...pending])].filter(inScope);
    const requestedEpisodes = movie && requested.length === 0 ? ["MOVIE"] : requested;
    // Fail closed: the rejected list and the recorded source links are what keep a
    // rejected source from being landed again (by name + size, and by link — a copy
    // renamed and shared under the same link has only the link to go on). Without
    // them the run could re-land the very file the user rejected, so a read error
    // fails the run through the normal failure path (a transient error retries, a
    // final one hands the messages to the patrol). The tables are created at startup,
    // so this is a real outage, not an older database. Ordinary runs keep their
    // rejected-list read fail-open (runner-v2 rejectedLookupOption).
    const rejected = await repository.listRejectedResources({ accountId: work.accountId, titleKey: work.titleKey });
    sources = await repository.listEpisodeSources(work);
    const userRequest: UserRequest = {
      requestedEpisodes,
      prompt: {
        messages: messages.map((m) => ({ body: m.body, episodeTags: m.episodeTags.filter(inScope), createdAt: m.createdAt })),
        rejected: rejected.map((r) => ({ episode: r.episode, label: r.label, sizeBytes: r.sizeBytes, reason: r.reason })),
        pending,
        ...(movie ? { filmObtained } : {}),
      },
      // An episode replaced once before has a known link: a rejected file of it whose own
      // transfer is no longer on record carries that one.
      sourceLinkKeys: Object.fromEntries(sources.flatMap((s): Array<[string, string]> => (s.linkKey ? [[s.episode, s.linkKey]] : []))),
      // A file's own link, from the transfer that landed it: the only link a file an
      // ordinary run landed has (no episode source is recorded for it).
      landingLinkKeys: async (fileIds) => {
        const keys = new Map<string, string | null>();
        for (const s of await repository.listLandingSources({ accountId: work.accountId, drive: work.drive, fileIds })) {
          // The oldest transfer decides — a later one can only have claimed the file through
          // a lagging listing — even when its link is unusable or has no key (null, not left
          // out: the file has a source of its own, so the episode's recorded one is not lent).
          if (!keys.has(s.fileId)) keys.set(s.fileId, s.url === null ? null : resourceLinkKey(s.url));
        }
        return Object.fromEntries(keys);
      },
      rejectedStore: {
        list: async () =>
          (await repository.listRejectedResources({ accountId: work.accountId, titleKey: work.titleKey })).map((r) => ({
            episode: r.episode,
            linkKey: r.linkKey,
            label: r.label,
            sizeBytes: r.sizeBytes,
          })),
        add: (rows) =>
          repository.addRejectedResources({
            accountId: work.accountId,
            titleKey: work.titleKey,
            now: now(),
            items: rows.map((r) => ({ ...r, messageId: messageFor(messages, r.episode)?.id ?? null })),
          }),
      },
    };
    // Same message list the agent sees (tags narrowed to the tracked seasons). A film's
    // message always means the film.
    untaggedTvMessage = !movie && userRequest.prompt.messages.some((m) => m.episodeTags.length === 0);

    // A patrol-queued run reports into the daily digest; a 待换 re-check with no new
    // message that replaced nothing is routine (see stampReplaceNotification).
    const notice = {
      trigger: queuedBy(claimed.workflowRun.auditEvents) === "patrol" ? ("scheduled" as const) : ("user" as const),
      routineIfNothingReplaced: messages.length === 0,
    };
    const deps = await resolveWorkerDeps(input.resolveAccountContext, claimed.accountId, claimed.connectedStorageId, input);
    const common = {
      resourceProvider: deps.resourceProvider,
      storage: deps.storage,
      model: deps.model,
      repository,
      accountId: claimed.accountId,
      connectedStorageId: claimed.connectedStorageId,
      ...optionalDeps(deps),
      workflowRun: { id: runId, startedAt: claimed.workflowRun.startedAt, finishedAt: null },
      userRequest,
      notice,
      now,
    };

    if (movie) {
      const result = await runMovieAcquisitionV2AndPersist({
        ...common,
        title: claimed.title,
        categoryParentId: requireCategoryParent(deps.moviesParentDirectoryId ?? input.moviesParentDirectoryId),
        // The film stays obtained only if it was: the old file is still there.
        priorObtained: filmObtained,
        holdLockOpen: true,
      });
      replacement = result.replacement;
      workflowStatus = result.status;
      finishLockRun = result.finishLockRun;
    } else {
      const seasons = await syncedSeasons(states, claimed.title.tmdbId, input.syncSeasonMetadata);
      const result = await runReplaceRequestV2AndPersist({
        ...common,
        title: claimed.title,
        categoryParentId: requireCategoryParent(
          storageParentForTitle(claimed.title, deps.storageParentDirectoryId, deps.animeStorageParentDirectoryId),
        ),
        seasons,
        lockSeasonNumber: lockState.season.seasonNumber,
        lockAuditEvents: claimed.workflowRun.auditEvents,
        holdLockOpen: true,
      });
      replacement = result.replacement;
      workflowStatus = result.status;
      finishLockRun = result.finishLockRun;
    }
  } catch (error) {
    // The library stays as it was. The failure is recorded first: whether the run is
    // queued again decides who picks the messages up (see releaseAfterFailure).
    let requeued = false;
    try {
      // The failure record keeps the lock season's CURRENT episodes, not the queue-time
      // copy; none at all when the work is no longer tracked here. Only when the read
      // itself fails does the queue-time copy stand in (never wipe a real library).
      //
      // "No longer tracked" still saves the season (with no episodes): the repository port
      // has no status-only run write, and a run row without its season is worse — Postgres
      // and SQLite load a run through its tracked_seasons row (loading it throws; SQLite's
      // tracked list, built from run rows, throws too), and InMemory derives tracking from
      // the run records themselves. It does not happen to a claimed run in practice:
      // untrackTitle refuses while a replace run of the work is queued or running, so this
      // only covers a read that disagrees with the claim.
      const current = await workStates(repository, work).then(
        (states) => states.find((s) => s.season.id === claimed.season.id) ?? null,
        () => undefined,
      );
      const handled = await handleWorkflowRunFailure({
        claimed:
          current === undefined
            ? claimed
            : current === null
              ? { ...claimed, episodes: [] }
              : { ...claimed, season: current.season, episodes: current.episodes },
        error,
        repository,
        now,
        // A patrol-queued failure joins the daily digest (trigger "scheduled"), matching the
        // success path (see stampReplaceNotification / the `notice.trigger` above); a user
        // request keeps its individual "user" push.
        notificationTrigger: queuedBy(claimed.workflowRun.auditEvents) === "patrol" ? "scheduled" : "user",
        ...(input.onAuthErrorFreeze === undefined ? {} : { onAuthErrorFreeze: input.onAuthErrorFreeze }),
      });
      requeued = handled.status === "auto_requeued";
      return requeued
        ? { status: "ran", workflowRunId: handled.workflowRunId, workflowStatus: "queued" }
        : { status: "failed", workflowRunId: handled.workflowRunId, errorMessage: handled.errorMessage };
    } finally {
      // Also when the failure could not even be recorded (requeued stays false).
      await releaseAfterFailure({ repository, work, runId, requeued, now });
    }
  }

  // The run itself succeeded, but its lock run is still `running` (holdLockOpen): what
  // follows is part of the run. Until its last write the run is active, so untracking
  // the work is refused (in_flight) and nothing below can land on a work the user has
  // just untracked. The terminal record is that last write, in the finally, so a
  // bookkeeping failure still ends the run. A worker that dies before it (or a terminal
  // write that fails twice) leaves the run `running`: crash recovery requeues it and the
  // same run id claims its messages again (the claim is idempotent) — at worst the run
  // is done twice. The bookkeeping itself is best-effort: a failure is logged, never
  // turned into a failed run.
  try {
    // A replaced episode's size is its new video file(s) as they lie in the target dir
    // (a season pack's title carries the whole pack); the title is only a fallback.
    const results = (replacement?.results ?? []).map((r) => ({
      ...r,
      sizeBytes: r.sizeBytes ?? (r.label ? parseSizeFromTitle(r.label) : null),
    }));
    const rejectedEpisodes = (replacement?.rejected ?? []).map((r) => r.episode);
    const film = claimed.title.type === "movie";
    const outcome = { repository, work, runId, results, messages, pendingRows, rejectedEpisodes, film, now };
    try {
      await recordReplacementOutcome(outcome);
    } catch (firstError) {
      try {
        await recordReplacementOutcome(outcome);
      } catch (error) {
        // The 待换 rows / episode sources are what bring a not-replaced episode back,
        // so a reply without them would drop the request for good. Hand the messages
        // back to the patrol instead (not urgent: a store that keeps failing must not be
        // hit on every idle tick). The retry run may find the file this run landed and
        // reject it as "current" — worse than nothing only in that one run, far better
        // than silently forgetting the episode.
        console.error(
          `[user-message] run ${runId} bookkeeping failed twice (the run itself succeeded); messages go back to the patrol: ${String(firstError)} / ${String(error)}`,
        );
        if (messages.length > 0) {
          try {
            await repository.releaseUserMessages({ runId, now: now(), urgent: false });
          } catch (releaseError) {
            console.error(`[user-message] run ${runId} could not release its messages: ${String(releaseError)}`);
          }
        }
        return { status: "ran", workflowRunId: runId, workflowStatus };
      }
    }
    if (messages.length > 0) {
      const reply: UserMessageReply = {
        results: results.map((r): ReplacementResult => ({
          episode: r.episode,
          outcome: r.outcome,
          // Only a replaced episode names a resource.
          ...(r.outcome === "replaced" && r.label !== undefined ? { label: r.label } : {}),
          ...(r.outcome === "replaced" && r.sizeBytes !== null ? { sizeBytes: r.sizeBytes } : {}),
          note: r.note,
        })),
        oldFiles: replacement?.oldFiles ?? [],
        runId,
        ...(replacement?.rejectedPersistFailed ? { rejectedNotSaved: true } : {}),
        // No episode came out of a TV message without tags: none was worked out from its
        // words this run (the results, if any, are other messages' or older 待换 episodes),
        // or no episode at all came out of the run (a movie always has its MOVIE result).
        // Nothing is kept 待换 for that message, so say so. Releasing the messages instead
        // would only run the same thing again.
        ...(results.length === 0 || (untaggedTvMessage && replacement?.identified === false) ? { unidentified: true } : {}),
      };
      // One retry: a message left in processing is only released by the idle scan after
      // the grace period, and then re-run from scratch — a transient hiccup should not cost that.
      try {
        await repository.finishUserMessages({ runId, reply, now: now() });
      } catch (firstError) {
        try {
          await repository.finishUserMessages({ runId, reply, now: now() });
        } catch (error) {
          console.error(`[user-message] run ${runId} could not write the reply (retried once): ${String(firstError)} / ${String(error)}`);
        }
      }
    }
    return { status: "ran", workflowRunId: runId, workflowStatus };
  } finally {
    // Retried once like the other writes of this run: a run left `running` holds its work
    // (the patrol, untracking) until crash recovery at the next worker start.
    await finishLockRun?.().catch(() => finishLockRun?.());
  }
}

/** 待换 records and episode sources after a replace run. */
async function recordReplacementOutcome(input: {
  repository: WorkflowRepository;
  work: UserMessageScope;
  runId: string;
  results: Array<{ episode: string; outcome: "replaced" | "not_found"; label?: string; linkKey?: string | null; sizeBytes: number | null }>;
  messages: UserMessage[];
  /** The work's 待换 rows when the run claimed its work. */
  pendingRows: Array<{ episode: string; messageId: string }>;
  /** Episodes whose copy the agent rejected this run (a rejection this run added to the list). */
  rejectedEpisodes: string[];
  /** A film: each of its messages means the film, tagged or not. */
  film: boolean;
  now: () => string;
}): Promise<void> {
  const { repository, work, messages, pendingRows, now } = input;
  const replaced = input.results.filter((r) => r.outcome === "replaced");
  // An episode that was already 待换 when the run started is written back only when this
  // run asked for it again: a message the run carries names it (a film's message means
  // the film), or the agent rejected a copy of it this run. Otherwise its row is left as
  // it is — still there, or deleted by the user's 「不换了」 while the run worked, and then
  // it stays deleted.
  const pendingAtStart = new Set(pendingRows.map((p) => p.episode));
  const askedByMessages = input.film ? (messages.length > 0 ? ["MOVIE"] : []) : messages.flatMap((m) => m.episodeTags);
  const askedAgain = new Set([...askedByMessages, ...input.rejectedEpisodes]);
  const notFound = input.results
    .filter((r) => r.outcome === "not_found")
    .map((r) => r.episode)
    .filter((episode) => !pendingAtStart.has(episode) || askedAgain.has(episode));
  // Per episode, the source first and only then its 待换 row: a failed write leaves
  // the row in place, so the episode comes back next patrol. A pending-only run has no
  // message to release — the row is the only thing that remembers the request.
  for (const r of replaced) {
    await repository.upsertEpisodeSource({
      ...work,
      episode: r.episode,
      linkKey: r.linkKey ?? null,
      label: r.label ?? "",
      sizeBytes: r.sizeBytes,
      runId: input.runId,
      recordedAt: now(),
    });
    await repository.removePendingReplacements({ ...work, episodes: [r.episode] });
  }
  // Keep a still-pending episode on the message that first asked for it.
  const byMessage = new Map<string, string[]>();
  for (const episode of notFound) {
    const messageId =
      pendingRows.find((p) => p.episode === episode)?.messageId ?? messageFor(messages, episode)?.id ?? pendingRows[0]?.messageId;
    if (messageId === undefined) continue;
    byMessage.set(messageId, [...(byMessage.get(messageId) ?? []), episode]);
  }
  for (const [messageId, episodes] of byMessage) {
    await repository.addPendingReplacements({ ...work, episodes, messageId, now: now() });
  }
}

/** Whether an episode code belongs to this work on this drive: "MOVIE" for a film,
 *  SxxEyy of a tracked season for a show. */
function episodeScope(movie: boolean, states: TrackedSeasonState[]): (episode: string) => boolean {
  if (movie) return (episode) => episode === "MOVIE";
  const seasons = new Set(states.map((s) => s.season.seasonNumber));
  return (episode) => {
    const m = /^S(\d{2,})E\d{2,}$/.exec(episode);
    return m !== null && seasons.has(Number(m[1]));
  };
}

/** Every season refreshed against TMDB (best-effort per season, as in the patrol). */
async function syncedSeasons(
  states: TrackedSeasonState[],
  tmdbId: number,
  sync: SeasonMetadataSync | undefined,
): Promise<Array<{ season: TrackedSeason; episodes: EpisodeState[] }>> {
  const out: Array<{ season: TrackedSeason; episodes: EpisodeState[] }> = [];
  for (const state of states) {
    let entry = { season: state.season, episodes: state.episodes };
    if (sync) {
      try {
        const meta = await sync({ tmdbId, seasonNumber: state.season.seasonNumber });
        if (meta) {
          const synced = syncSeasonAgainstMetadata({ ...entry, latestAiredEpisode: meta.latestAiredEpisode, totalEpisodes: meta.totalEpisodes });
          entry = { season: synced.season, episodes: synced.episodes };
        }
      } catch {
        // Metadata sync is best-effort; fall back to stored counts.
      }
    }
    out.push(entry);
  }
  return out;
}

/** Who queued the run (the queued audit event's origin); "user" when unknown. */
function queuedBy(events: AuditEvent[]): ReplaceRequestOrigin {
  const origin = events.find((e) => e.type === "replace_request_queued")?.data?.["origin"];
  return origin === "patrol" ? "patrol" : "user";
}

/** The message that named this episode, else the oldest one claimed. */
function messageFor(messages: UserMessage[], episode: string): UserMessage | undefined {
  return messages.find((m) => m.episodeTags.includes(episode)) ?? messages[0];
}

/** The per-account options the runners take, present only when resolved. */
function optionalDeps(deps: Awaited<ReturnType<typeof resolveWorkerDeps>>): {
  preferredLanguage?: string;
  qualityPreference?: "high" | "medium";
  storageProvider?: string;
  assrtToken?: string;
  jevJudge?: JevJudge;
  agentMemory?: boolean;
} {
  return {
    ...(deps.preferredLanguage === undefined ? {} : { preferredLanguage: deps.preferredLanguage }),
    ...(deps.qualityPreference === undefined ? {} : { qualityPreference: deps.qualityPreference }),
    ...(deps.storageProvider === undefined ? {} : { storageProvider: deps.storageProvider }),
    ...(deps.assrtToken === undefined ? {} : { assrtToken: deps.assrtToken }),
    ...(deps.jevJudge === undefined ? {} : { jevJudge: deps.jevJudge }),
    ...(deps.agentMemory === undefined ? {} : { agentMemory: deps.agentMemory }),
  };
}
