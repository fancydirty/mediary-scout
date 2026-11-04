/**
 * Server-side logic behind a work's message card on the detail page: which work a
 * message belongs to, the thread the card shows, and when the next patrol comes. Kept
 * apart from the server actions so it can be unit-tested against a plain repository.
 * Design: docs/superpowers/specs/2026-09-26-user-message-replace-design.md.
 */
import {
  userMessageDrive,
  type PersistedWorkflowRunSnapshot,
  type UserMessageScope,
  type UserRequestStore,
  type WorkflowRepository,
  type WorkflowScope,
} from "@media-track/workflow";
import type { PendingRow, ThreadMessage } from "./user-message-state";

// The badge label is shared with the client card (which must not import this module).
export { swapBadgeLabel } from "./user-message-state";

/**
 * All drive-scoped message works of a title inside `scope`. In unified workspace
 * mode (`scope.connectedStorageId === null`) a title may have tracked season rows
 * across multiple drives (e.g. an initial run on 123 and a cross-drive replacement
 * on Quark). Returning all of them in deterministic drive order (drives with
 * obtained episodes first, then lexicographical drive ID) lets the detail page
 * merge messages and 待换 across drives and keeps `resolveMessageWork`'s primary
 * work stable.
 */
export async function resolveMessageWorksWithStates(input: {
  repo: Pick<WorkflowRepository, "listTrackedSeasonStates">;
  scope: WorkflowScope;
  tmdbId: number;
  mediaType: "movie" | "tv";
}): Promise<{ works: UserMessageScope[]; states: Awaited<ReturnType<WorkflowRepository["listTrackedSeasonStates"]>> }> {
  if (input.mediaType !== "movie" && input.mediaType !== "tv") return { works: [], states: [] };
  if (!Number.isInteger(input.tmdbId) || input.tmdbId <= 0) return { works: [], states: [] };
  const titleKey = input.mediaType === "movie" ? `tmdb_movie_${input.tmdbId}` : `tmdb_tv_${input.tmdbId}`;
  const states = (await input.repo.listTrackedSeasonStates(input.scope)).filter((s) => s.title.id === titleKey);
  if (states.length === 0) return { works: [], states: [] };
  const obtainedCountByDrive = new Map<string, number>();
  for (const s of states) {
    const drive = userMessageDrive(s.connectedStorageId);
    const count = s.episodes.filter((e) => e.obtained).length;
    obtainedCountByDrive.set(drive, (obtainedCountByDrive.get(drive) ?? 0) + count);
  }
  const drives = [...new Set(states.map((s) => userMessageDrive(s.connectedStorageId)))].sort((a, b) => {
    const hasA = (obtainedCountByDrive.get(a) ?? 0) > 0 ? 1 : 0;
    const hasB = (obtainedCountByDrive.get(b) ?? 0) > 0 ? 1 : 0;
    if (hasA !== hasB) return hasB - hasA;
    return a.localeCompare(b);
  });
  return {
    works: drives.map((drive) => ({ accountId: input.scope.accountId, drive, titleKey })),
    states,
  };
}

export async function resolveMessageWorks(input: {
  repo: Pick<WorkflowRepository, "listTrackedSeasonStates">;
  scope: WorkflowScope;
  tmdbId: number;
  mediaType: "movie" | "tv";
}): Promise<UserMessageScope[]> {
  const { works } = await resolveMessageWorksWithStates(input);
  return works;
}

/**
 * The work a message is filed under — the one the engine looks up: the page's own
 * workspace scope, and the drive key taken from the title's tracked seasons there
 * (userMessageDrive of their connected storage, "" when unbound). The page and every
 * message action resolve it this way. On the primary drive the page has no storageId,
 * yet its seasons carry the real drive id: a message filed under "" instead would never
 * be found by the engine, never processed. Null when the title is not tracked here.
 */
export async function resolveMessageWork(input: {
  repo: Pick<WorkflowRepository, "listTrackedSeasonStates">;
  scope: WorkflowScope;
  tmdbId: number;
  mediaType: "movie" | "tv";
}): Promise<UserMessageScope | null> {
  const works = await resolveMessageWorks(input);
  return works[0] ?? null;
}

export interface MessageThreadView {
  /** Newest first; withdrawn ones are gone. */
  messages: ThreadMessage[];
  /** Episode codes still 待换 (sorted); "MOVIE" for a film. */
  pendingReplacements: string[];
  /** The same 待换 rows with the message that asked and when (same order): what 撤销
   *  after 「不换了」 puts back. */
  pendingRows: PendingRow[];
  /** A run holds one of the messages right now. */
  busy: boolean;
}

export async function loadMessageThread(
  repo: Pick<UserRequestStore, "listUserMessages" | "listPendingReplacements">,
  workOrWorks: UserMessageScope | readonly UserMessageScope[],
): Promise<MessageThreadView> {
  const works = Array.isArray(workOrWorks) ? workOrWorks : [workOrWorks as UserMessageScope];
  if (works.length === 0) {
    return { messages: [], pendingReplacements: [], pendingRows: [], busy: false };
  }
  const perWork = await Promise.all(
    works.map(async (w) => {
      const [messages, pending] = await Promise.all([repo.listUserMessages(w), repo.listPendingReplacements(w)]);
      return { messages, pending };
    }),
  );
  const seenMessageIds = new Set<string>();
  const allMessages = perWork
    .flatMap((p) => p.messages)
    .filter((m) => {
      if (seenMessageIds.has(m.id)) return false;
      seenMessageIds.add(m.id);
      return true;
    })
    .sort((a, b) => {
      if (b.createdAt !== a.createdAt) return b.createdAt < a.createdAt ? -1 : 1;
      if (b.id !== a.id) return b.id < a.id ? -1 : 1;
      return 0;
    });
  const pendingByEpisode = new Map<string, PendingRow>();
  for (const p of perWork) {
    for (const { episode, messageId, requestedAt } of p.pending) {
      const existing = pendingByEpisode.get(episode);
      if (!existing || requestedAt > existing.requestedAt) {
        pendingByEpisode.set(episode, { episode, messageId, requestedAt });
      }
    }
  }
  const pendingRows = [...pendingByEpisode.values()].sort((a, b) => {
    if (a.episode === b.episode) return 0;
    return a.episode < b.episode ? -1 : 1;
  });
  return {
    messages: allMessages.map(({ id, body, episodeTags, status, urgent, createdAt, processedAt, reply }) => ({
      id,
      body,
      episodeTags,
      status,
      urgent,
      createdAt,
      processedAt,
      reply,
    })),
    pendingReplacements: pendingRows.map((p) => p.episode),
    pendingRows,
    busy: holdsMessage(allMessages),
  };
}

/** A run holds one of these messages right now. */
function holdsMessage(messages: ReadonlyArray<{ status: string }>): boolean {
  return messages.some((m) => m.status === "processing");
}

/** What the work's active run means for its messages. */
export interface MessageRunView {
  /** A replace run of this work is running now. */
  running: boolean;
  /** Its live line (progress.activity), for the ticker; null before the first one. */
  activity: string | null;
  /** An urgent message waits for the run in flight: a replace run already running (it
   *  took what was pending when it started) or any other kind of run on the title (the
   *  title lock). A replace run that is only queued is not one — it takes every pending
   *  message along when it starts. */
  waitsForRun: boolean;
}

/** `runs`: active runs of the page's scope (listActiveWorkflowRuns). */
export function messageRunView(
  runs: ReadonlyArray<Pick<PersistedWorkflowRunSnapshot, "title" | "connectedStorageId" | "workflowRun">>,
  workOrWorks: UserMessageScope | readonly UserMessageScope[],
): MessageRunView {
  const works = Array.isArray(workOrWorks) ? workOrWorks : [workOrWorks as UserMessageScope];
  const titleKey = works[0]?.titleKey;
  if (!titleKey) {
    return { running: false, activity: null, waitsForRun: false };
  }
  const drives = new Set(works.map((w) => w.drive));
  const mine = runs.filter(
    (r) =>
      r.workflowRun.kind !== "staging_recovery" &&
      r.title.id === titleKey &&
      drives.has(userMessageDrive(r.connectedStorageId)),
  );
  const replaceRunning = mine.find((r) => r.workflowRun.kind === "replace_request" && r.workflowRun.status === "running");
  return {
    running: replaceRunning !== undefined,
    activity: replaceRunning?.workflowRun.progress?.activity.trim() || null,
    waitsForRun: mine.some((r) => r.workflowRun.kind !== "replace_request" || r.workflowRun.status === "running"),
  };
}

/**
 * Whether 「不换了」 must wait, read when it is pressed: the card's keepBusy (a run holds one
 * of the work's messages, or a replace run of the work is running) worked out the same way
 * from fresh data. That run's end-of-run bookkeeping would put the episode back as 待换 and
 * silently undo the choice. The card's gate is only as fresh as its page: a run that started
 * after the page rendered would slip through it.
 */
export async function keepMustWait(input: {
  repo: Pick<WorkflowRepository, "listUserMessages" | "listActiveWorkflowRuns">;
  /** The page's workspace scope, as for readTitleMessages. */
  scope: WorkflowScope;
  work: UserMessageScope;
  works?: readonly UserMessageScope[];
}): Promise<boolean> {
  const targetWorks = input.works && input.works.length > 0 ? input.works : [input.work];
  const [messageLists, runs] = await Promise.all([
    Promise.all(targetWorks.map((w) => input.repo.listUserMessages(w))),
    input.repo.listActiveWorkflowRuns(input.scope),
  ]);
  return holdsMessage(messageLists.flat()) || messageRunView(runs, targetWorks).running;
}

// The 待换 rows 撤销 sends back (restoreEpisodesToPendingAction). The page handed them to the
// card, but the call comes from the client like any other: unchecked, it could file any
// episode under any message at any time.
/** The episode codes the engine writes for a show (replace-request.ts episodeScope): SxxEyy
 *  with two or more digits in each part. A film's one row is "MOVIE". */
const SHOW_EPISODE_CODE = /^S(\d{2,})E\d{2,}$/;
const MESSAGE_ID = /^msg_[\w-]{1,80}$/;
/** A time as the store writes it (toISOString), or with an offset instead of Z. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** The rows as they will be written back, or null when any is malformed or not this kind
 *  of work's episode. Checked before any lookup. */
export function parsePendingRows(input: unknown, mediaType: "movie" | "tv", max: number): PendingRow[] | null {
  if (!Array.isArray(input) || input.length === 0 || input.length > max) return null;
  const rows: PendingRow[] = [];
  for (const row of input as unknown[]) {
    if (typeof row !== "object" || row === null) return null;
    const { episode, messageId, requestedAt } = row as Record<string, unknown>;
    if (typeof episode !== "string" || !(mediaType === "movie" ? episode === "MOVIE" : SHOW_EPISODE_CODE.test(episode))) return null;
    if (typeof messageId !== "string" || !MESSAGE_ID.test(messageId)) return null;
    if (typeof requestedAt !== "string" || !ISO_TIME.test(requestedAt) || !Number.isFinite(Date.parse(requestedAt))) return null;
    rows.push({ episode, messageId, requestedAt: new Date(requestedAt).toISOString() });
  }
  return rows;
}

/** Pick the drive work to file a new user message under when the title has tracked
 *  seasons across multiple drives in unified workspace mode: prefer the drive that
 *  tracks all (or most) of the tagged episodes, falling back to `works[0]` (which
 *  already prefers drives with obtained episodes). */
export async function pickWorkForMessage(input: {
  repo: Pick<WorkflowRepository, "listTrackedSeasonStates">;
  scope: WorkflowScope;
  works: readonly UserMessageScope[];
  episodeTags: readonly string[];
  states?: Awaited<ReturnType<WorkflowRepository["listTrackedSeasonStates"]>>;
}): Promise<UserMessageScope | null> {
  const first = input.works[0] ?? null;
  if (!first || input.works.length <= 1 || input.episodeTags.length === 0) {
    return first;
  }
  const states = (input.states ?? (await input.repo.listTrackedSeasonStates(input.scope))).filter(
    (s) => s.title.id === first.titleKey,
  );
  const obtainedByDrive = new Map<string, Set<string>>();
  const trackedByDrive = new Map<string, Set<string>>();
  for (const s of states) {
    const drive = userMessageDrive(s.connectedStorageId);
    let obtainedSet = obtainedByDrive.get(drive);
    if (!obtainedSet) {
      obtainedSet = new Set<string>();
      obtainedByDrive.set(drive, obtainedSet);
    }
    let trackedSet = trackedByDrive.get(drive);
    if (!trackedSet) {
      trackedSet = new Set<string>();
      trackedByDrive.set(drive, trackedSet);
    }
    for (const e of s.episodes) {
      trackedSet.add(e.episodeCode);
      if (e.obtained) obtainedSet.add(e.episodeCode);
    }
  }
  let best = first;
  let bestObtainedHits = -1;
  let bestTrackedHits = -1;
  for (const w of input.works) {
    const obtainedSet = obtainedByDrive.get(w.drive);
    const trackedSet = trackedByDrive.get(w.drive);
    const obtainedHits = obtainedSet ? input.episodeTags.filter((tag) => obtainedSet.has(tag)).length : 0;
    const trackedHits = trackedSet ? input.episodeTags.filter((tag) => trackedSet.has(tag)).length : 0;
    if (obtainedHits > bestObtainedHits || (obtainedHits === bestObtainedHits && trackedHits > bestTrackedHits)) {
      bestObtainedHits = obtainedHits;
      bestTrackedHits = trackedHits;
      best = w;
    }
  }
  return best;
}

/** Whether every row could be one of this work's own 待换 rows: filed under one of its
 *  messages, for an episode it has (a show: a season tracked here, on this drive — the
 *  engine's rule), at a time not later than now. */
export async function pendingRowsFitWork(input: {
  repo: Pick<WorkflowRepository, "listUserMessages" | "listTrackedSeasonStates">;
  /** The page's workspace scope, as for resolveMessageWork. */
  scope: WorkflowScope;
  work: UserMessageScope;
  works?: readonly UserMessageScope[];
  states?: Awaited<ReturnType<WorkflowRepository["listTrackedSeasonStates"]>>;
  workByMessageId?: Map<string, UserMessageScope>;
  mediaType: "movie" | "tv";
  rows: readonly PendingRow[];
  now: Date;
}): Promise<boolean> {
  const targetWorks = input.works && input.works.length > 0 ? input.works : [input.work];
  const titleKey = targetWorks[0]!.titleKey;
  const drives = new Set(targetWorks.map((w) => w.drive));
  const [messageLists, states] = await Promise.all([
    Promise.all(targetWorks.map((w) => input.repo.listUserMessages(w))),
    input.states ? Promise.resolve(input.states) : input.repo.listTrackedSeasonStates(input.scope),
  ]);
  const driveByMessageId = new Map<string, string>();
  for (const [index, messages] of messageLists.entries()) {
    const w = targetWorks[index]!;
    for (const m of messages) {
      driveByMessageId.set(m.id, w.drive);
      input.workByMessageId?.set(m.id, w);
    }
  }
  // The episodes that exist in this work's seasons tracked on each drive — a season number
  // alone would let a forged code (S01E9999 in a two-episode season) through.
  const episodesByDrive = new Map<string, Set<string>>();
  for (const s of states) {
    const drive = userMessageDrive(s.connectedStorageId);
    if (s.title.id !== titleKey || !drives.has(drive)) continue;
    let driveEpisodes = episodesByDrive.get(drive);
    if (!driveEpisodes) {
      driveEpisodes = new Set<string>();
      episodesByDrive.set(drive, driveEpisodes);
    }
    for (const e of s.episodes) {
      driveEpisodes.add(e.episodeCode);
    }
  }
  // The rows come back from this same server (web and worker share its clock), written
  // in the past — a time later than now is forged.
  const latest = input.now.getTime();
  return input.rows.every((row) => {
    const drive = driveByMessageId.get(row.messageId);
    if (drive === undefined) return false;
    const validEpisode = input.mediaType === "movie" ? row.episode === "MOVIE" : (episodesByDrive.get(drive)?.has(row.episode) ?? false);
    return validEpisode && Date.parse(row.requestedAt) <= latest;
  });
}

export interface TitleMessages {
  thread: MessageThreadView;
  run: MessageRunView;
  /** The daily patrol times (Beijing "HH:MM"), for 「等巡检 · 明早 06:00」. */
  sweepTimes: string[];
}

/**
 * The detail page's message decorations — the 待换 badge and cells, and the message
 * card — for the work on the page's drive; null when the title is not tracked there.
 * They are decorations: a failed read logs one short line and leaves them out, it
 * never takes the whole detail page down.
 */
export async function readTitleMessages(input: {
  repo: Pick<WorkflowRepository, "listTrackedSeasonStates" | "listUserMessages" | "listPendingReplacements" | "listActiveWorkflowRuns">;
  /** The page's workspace scope — a lookup of its own, so its failure is caught too. */
  scope: () => Promise<WorkflowScope>;
  tmdbId: number;
  mediaType: "movie" | "tv";
  /** The patrol times setting (getDailySweepTimes). */
  sweepTimes: () => Promise<string[]>;
  log?: (line: string) => void;
}): Promise<TitleMessages | null> {
  try {
    const scope = await input.scope();
    const works = await resolveMessageWorks({ repo: input.repo, scope, tmdbId: input.tmdbId, mediaType: input.mediaType });
    if (works.length === 0) return null;
    const [thread, runs, sweepTimes] = await Promise.all([
      loadMessageThread(input.repo, works),
      input.repo.listActiveWorkflowRuns(scope),
      input.sweepTimes(),
    ]);
    return { thread, run: messageRunView(runs, works), sweepTimes };
  } catch (error) {
    (input.log ?? console.error)(
      `[user-message] tmdb ${input.mediaType} ${input.tmdbId}: messages read failed, page shown without the 待换 badge/cells and the message card: ${shortError(error)}`,
    );
    return null;
  }
}

/** A log-sized error message (a DB error can carry a whole query). */
function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 160 ? `${message.slice(0, 160)}…` : message;
}

/** When a message left now gets read: the next patrol time (Beijing "HH:MM") today,
 *  else tomorrow's first — 「明早」 when that is before noon. */
export function nextPatrolLabel(times: string[], hhmm: string): string {
  const sorted = [...times].sort();
  const today = sorted.find((t) => t > hhmm);
  if (today) return `今天 ${today}`;
  const first = sorted[0] ?? "06:00";
  return first < "12:00" ? `明早 ${first}` : `明天 ${first}`;
}
