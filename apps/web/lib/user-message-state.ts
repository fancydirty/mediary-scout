/**
 * Pure helpers behind the message card on a work's detail page (components/user-message-thread.tsx).
 * The card is a client component: nothing here imports the workflow package at runtime
 * (it pulls in the database drivers) — types only.
 * Design: docs/superpowers/specs/2026-09-26-user-message-replace-design.md · pixel standard:
 * docs/superpowers/design/2026-09-26-user-message-mockup.html.
 */
// The narrow subpath, NOT the root barrel: client components import this module, and
// the barrel `export *`s ./postgres.js (pg) — see request-track-button.tsx. user-requests
// has no imports at all, so nothing can carry pg in.
import type { PendingReplacement, UserMessage, UserMessageReply } from "@media-track/workflow/user-requests";
import { relativeDayLabel } from "./relative-day";

/** What the card gets of each message. */
export type ThreadMessage = Pick<UserMessage, "id" | "body" | "episodeTags" | "status" | "urgent" | "createdAt" | "processedAt" | "reply">;

/** Why 「不换了」 waits while a replace run of the work is processing: the run's end-of-run
 *  bookkeeping would put the episode back as 待换 and silently undo the choice. The card's
 *  disabled button says it, and keepEpisodesAsIsAction answers it when the page was stale. */
export const KEEP_BUSY_HINT = "处理中，完了再操作";

/** A 待换 row as the card gets it: what 撤销 after 「不换了」 puts back (same message,
 *  same time — the episode is not re-requested). */
export type PendingRow = Pick<PendingReplacement, "episode" | "messageId" | "requestedAt">;

const EPISODE_CODE = /^S(\d+)E(\d+)$/;

/** Season, then episode number (numeric: E99 before E100); anything else after, by text. */
export function compareEpisodeCodes(a: string, b: string): number {
  const x = EPISODE_CODE.exec(a);
  const y = EPISODE_CODE.exec(b);
  if (x && y) return Number(x[1]) - Number(y[1]) || Number(x[2]) - Number(y[2]);
  if (x || y) return x ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function toggleEpisode(tags: string[], episode: string): string[] {
  return tags.includes(episode) ? tags.filter((t) => t !== episode) : [...tags, episode].sort(compareEpisodeCodes);
}

/** The pill beside a message of yours. `busy`: an urgent message waits for the run in
 *  flight (one already holding messages, or another kind of run on the title). */
export function statusLabel(m: { status: string; urgent: boolean }, nextPatrol: string, busy: boolean): string {
  if (m.status === "processing") return "已锁定";
  if (m.status !== "pending") return "";
  if (!m.urgent) return `等巡检 · ${nextPatrol}`;
  return busy ? "排队中 · 这次处理完接着处理" : "排队中 · 马上处理";
}

export function draftIsSendable(draft: string): boolean {
  return draft.trim().length > 0;
}

/** 「E13」 on a one-season work, 「S02E13」 once several seasons show; "" for the film. */
export function episodeLabel(code: string, multiSeason: boolean): string {
  if (code === "MOVIE") return "";
  const match = EPISODE_CODE.exec(code);
  if (!match) return code;
  return multiSeason ? code : `E${match[2]}`;
}

export function isMultiSeason(codes: Iterable<string>): boolean {
  const seasons = new Set<number>();
  for (const code of codes) {
    const match = EPISODE_CODE.exec(code);
    if (match) seasons.add(Number(match[1]));
  }
  return seasons.size > 1;
}

/** The episode picker's groups, one per season, in order. */
export function groupEpisodesBySeason(codes: readonly string[]): Array<{ season: number; episodes: string[] }> {
  const bySeason = new Map<number, string[]>();
  for (const code of codes) {
    const match = EPISODE_CODE.exec(code);
    if (!match) continue;
    const season = Number(match[1]);
    const list = bySeason.get(season) ?? [];
    list.push(code);
    bySeason.set(season, list);
  }
  return [...bySeason.entries()]
    .sort(([a], [b]) => a - b)
    .map(([season, episodes]) => ({ season, episodes: episodes.sort(compareEpisodeCodes) }));
}

/** One turn of the conversation: a message still waiting (each has its own 修改 / 撤回),
 *  the messages a run holds right now, or the messages a run answered with its reply. */
export type Exchange =
  | { kind: "waiting"; messages: ThreadMessage[] }
  | { kind: "working"; messages: ThreadMessage[] }
  | { kind: "answered"; messages: ThreadMessage[]; reply: UserMessageReply | null; processedAt: string | null };

/** The thread oldest first, grouped into exchanges. Every message one run answered
 *  carries the same reply (its runId), and they sit next to each other: a run takes
 *  every message pending when it starts. */
export function threadExchanges(newestFirst: readonly ThreadMessage[]): Exchange[] {
  const out: Exchange[] = [];
  for (const m of [...newestFirst].reverse()) {
    const last = out.at(-1);
    if (m.status === "processing") {
      if (last?.kind === "working") last.messages.push(m);
      else out.push({ kind: "working", messages: [m] });
    } else if (m.status === "done") {
      const runId = m.reply?.runId;
      if (last?.kind === "answered" && runId !== undefined && last.reply?.runId === runId) {
        last.messages.push(m);
        if (m.processedAt !== null && (last.processedAt === null || m.processedAt > last.processedAt)) last.processedAt = m.processedAt;
      } else {
        out.push({ kind: "answered", messages: [m], reply: m.reply, processedAt: m.processedAt });
      }
    } else {
      out.push({ kind: "waiting", messages: [m] });
    }
  }
  return out;
}

/** The latest answer and everything after it stay in view; older exchanges fold into
 *  「之前的留言 · N 条」 (N = messages, as the mockup counts them). */
export function visibleExchanges(exchanges: readonly Exchange[]): { earlier: Exchange[]; recent: Exchange[]; earlierCount: number } {
  let lastAnswered = -1;
  exchanges.forEach((e, i) => {
    if (e.kind === "answered") lastAnswered = i;
  });
  const cut = Math.max(0, lastAnswered);
  const earlier = exchanges.slice(0, cut);
  return { earlier, recent: exchanges.slice(cut), earlierCount: earlier.reduce((n, e) => n + e.messages.length, 0) };
}

/** One row of the reply's track list. `looking`: not replaced and still 待换 (the patrol
 *  keeps looking, 「不换了」 is offered); `replacedLater`: no longer 待换 because a newer
 *  reply replaced it; `stopped`: no longer 待换 otherwise (the user kept it, or a run
 *  without a message replaced it). */
export interface ReplyRow {
  episode: string;
  label: string;
  resource: string;
  note: string;
  size: string;
  driveLabel?: string;
  state: "replaced" | "looking" | "replacedLater" | "stopped";
}

export interface ReplyView {
  /** Beside 「agent」: 「换好 1 集，1 集还在找」. "" when nothing was worked out. */
  summary: string;
  rows: ReplyRow[];
  oldFiles: string[];
  oldFilesLabel: string | null;
  /** The note under the latest reply: where the new files went. */
  foot: string | null;
  rejectedNotSaved: boolean;
}

export function replyView(
  reply: UserMessageReply,
  ctx: { mediaType: "movie" | "tv"; multiSeason: boolean; pending: ReadonlySet<string>; replacedLater?: ReadonlySet<string> | undefined },
): ReplyView {
  const rows = [...reply.results]
    .sort((a, b) => compareEpisodeCodes(a.episode, b.episode))
    .map((r): ReplyRow => {
      const replaced = r.outcome === "replaced";
      const driveLabel = replaced && r.driveLabel?.trim() ? r.driveLabel.trim() : undefined;
      let state: ReplyRow["state"] = "stopped";
      if (replaced) {
        state = "replaced";
      } else if (ctx.pending.has(r.episode)) {
        state = "looking";
      } else if (ctx.replacedLater?.has(r.episode)) {
        state = "replacedLater";
      }
      return {
        episode: r.episode,
        label: episodeLabel(r.episode, ctx.multiSeason),
        resource: replaced ? r.label?.trim() || "没记下资源名" : "没有找到别的版本",
        note: r.note,
        size: replaced && typeof r.sizeBytes === "number" && r.sizeBytes > 0 ? formatSize(r.sizeBytes) : "—",
        ...(driveLabel ? { driveLabel } : {}),
        state,
      };
    });
  const replaced = rows.filter((r) => r.state === "replaced");
  const looking = rows.filter((r) => r.state === "looking").length;
  const notReplaced = rows.length - replaced.length;
  const stillLooking = looking > 0 ? `，${looking} 集还在找` : "";

  let summary = "";
  if (rows.length > 0) {
    if (ctx.mediaType === "movie") summary = replaced.length > 0 ? "换好了" : "这次没找到能换的";
    else summary = replaced.length > 0 ? `换好 ${replaced.length} 集${stillLooking}` : `这次没找到能换的${stillLooking}`;
  }

  // An episode that was not replaced still plays from its old file: never invite deleting
  // every old file when some of them are the only copy.
  let oldFilesLabel: string | null = null;
  if (reply.oldFiles.length > 0) {
    if (replaced.length === 0) oldFilesLabel = "旧文件还在：";
    else oldFilesLabel = notReplaced > 0 ? "旧文件都还在，换好的集确认新的能看再删：" : "旧文件还在，确认新的能看再删：";
  }

  let foot: string | null = null;
  if (replaced.length > 0) {
    if (ctx.mediaType === "movie") foot = "新文件和旧文件放在一起，播放器里会看到两个版本。";
    else if (replaced.length === 1) foot = `换好的那集和旧文件放在一起，播放器里会看到两个 ${replaced[0]!.label}。`;
    else foot = "换好的几集和旧文件放在一起，播放器里每集会看到两个。";
  }

  return {
    summary,
    rows,
    oldFiles: reply.oldFiles,
    oldFilesLabel,
    foot,
    rejectedNotSaved: reply.rejectedNotSaved === true,
  };
}

/** Whether a message gets the 「没看出是哪几集」 hint: the agent could not tell which
 *  episodes were meant. `reply.unidentified` is one flag per run, shared by every message
 *  the run answered, so it belongs only under a message that named no episode (a tagged
 *  one said which). A film always has its one file, so never for a film. */
export function missedEpisodes(message: Pick<ThreadMessage, "episodeTags" | "reply">, mediaType: "movie" | "tv"): boolean {
  return mediaType === "tv" && message.reply?.unidentified === true && message.episodeTags.length === 0;
}

/** Per answered run (by runId): the episodes some newer reply replaced — an older row
 *  about one of them reads 「后来换好了」, not just 「不再待换」. */
export function replacedLaterByRun(oldestFirst: readonly Exchange[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const later = new Set<string>();
  for (const exchange of [...oldestFirst].reverse()) {
    if (exchange.kind !== "answered" || !exchange.reply) continue;
    out.set(exchange.reply.runId, new Set(later));
    for (const r of exchange.reply.results) if (r.outcome === "replaced") later.add(r.episode);
  }
  return out;
}

/** One waiting message edited in place. `original`: its words when the editor opened;
 *  `saved`: set once 保存 went through (the body as stored, trimmed) — the editor then
 *  stays open, disabled, until a fresh render carries the new words (no flash of the old). */
export interface EditingMessage {
  id: string;
  body: string;
  tags: string[];
  original: { body: string; tags: string[] };
  saved: { body: string; tags: string[] } | null;
}

/** What a fresh render means for an open editor: keep it; close it; or it can no longer
 *  be edited — a run took the message ("taken": the card says so) or it left the thread
 *  ("gone") — and whatever was typed, if it changed anything, goes to the composer. */
export type EditorVerdict =
  | { kind: "keep" }
  | { kind: "close" }
  | { kind: "taken" | "gone"; typed: { body: string; tags: string[] } | null };

const sameWords = (a: { body: string; tags: readonly string[] }, b: { body: string; tags: readonly string[] }) =>
  a.body === b.body && a.tags.length === b.tags.length && a.tags.every((t, i) => t === b.tags[i]);

export function editorAfterRefresh(
  editing: EditingMessage,
  message: Pick<ThreadMessage, "body" | "episodeTags" | "status"> | undefined,
): EditorVerdict {
  const shown = message ? { body: message.body, tags: message.episodeTags } : null;
  if (editing.saved) {
    // Still the old words: a render fetched before the save landed.
    return shown && sameWords(shown, editing.original) && !sameWords(editing.saved, editing.original) ? { kind: "keep" } : { kind: "close" };
  }
  if (message?.status === "pending") return { kind: "keep" };
  const typed = { body: editing.body.trim(), tags: editing.tags };
  const changed = !sameWords(typed, editing.original);
  return { kind: message ? "taken" : "gone", typed: changed ? { body: editing.body, tags: editing.tags } : null };
}

const MOVED_TO_COMPOSER = "改过的内容挪到了输入框里，可以再发一条";

/** The card's line when an editor closed on its own ("taken" / "gone"): why, and where the
 *  words typed went when there were any. Null when it stays or was closed as asked. */
export function editorNotice(verdict: EditorVerdict): string | null {
  if (verdict.kind === "keep" || verdict.kind === "close") return null;
  const why = verdict.kind === "taken" ? "agent 已经开始处理这条留言了" : "这条留言已经撤回了";
  return verdict.typed ? `${why}。${MOVED_TO_COMPOSER}` : why;
}

/** How long a saved editor waits, disabled, for the fresh render that carries its new
 *  words before it gives the editor back (the refresh was slow, or lost). */
export const EDIT_SETTLE_MS = 8000;

/** EDIT_SETTLE_MS after 保存 on message `id`, and still no render with the new words: the
 *  editor is editable again, on the words as stored — from then on an ordinary editor, not
 *  one stuck disabled. Any other state is returned as it is. */
export function editorAfterSettleTimeout(editing: EditingMessage | null, id: string): EditingMessage | null {
  if (!editing || editing.id !== id || !editing.saved) return editing;
  return { ...editing, original: editing.saved, saved: null };
}

/** Words from an editor that closed on its own join the composer: they fill an empty
 *  draft or go on a new line; the tags join in episode order, without repeats. */
export function mergeIntoComposer(
  composer: { draft: string; tags: string[] },
  typed: { body: string; tags: string[] },
): { draft: string; tags: string[] } {
  const body = typed.body.trim();
  const draft = composer.draft.trim() === "" ? body : `${composer.draft.trimEnd()}\n${body}`;
  const tags = [...new Set([...composer.tags, ...typed.tags])].sort(compareEpisodeCodes);
  return { draft, tags };
}

/** Byte size the way the rest of the app writes it (notifications, the activity page):
 *  KB below 1 MB, whole MB below 1 GB, else GB to one decimal. A copy of the workflow
 *  package's formatBytes (the card cannot import the package); a test keeps them equal. */
export function formatSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${Math.round(bytes / 1024)} KB`;
  if (mb < 1024) return `${Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/** A common phrase (chip) joins the draft: fills an empty one, is added after what is
 *  written (with a 「，」 unless it already ends in punctuation), never twice. */
export function appendChipText(draft: string, fill: string): string {
  if (draft.trim() === "") return fill;
  if (draft.includes(fill)) return draft;
  return /[，,。.；;、！!？?\s]$/.test(draft) ? `${draft}${fill}` : `${draft}，${fill}`;
}

/** The badge beside the title while something is 待换: how many episodes of a show, or
 *  「待换资源」 for a film. Null when nothing is. */
export function swapBadgeLabel(mediaType: "movie" | "tv", pendingReplacements: readonly string[]): string | null {
  if (mediaType === "movie") return pendingReplacements.includes("MOVIE") ? "待换资源" : null;
  return pendingReplacements.length > 0 ? `${pendingReplacements.length} 集待换` : null;
}

/** Whether a work's detail page shows the message card: tracked on this drive, and
 *  either something is in the library to complain about, or there are messages / 待换
 *  to show. Not the film's display state: a film whose replace run is queued or running
 *  reads 「获取中」, and the card must not vanish exactly while it is processing. */
export function showsMessageCard(input: { tracked: boolean; hasFile: boolean; messageCount: number; pendingCount: number }): boolean {
  return input.tracked && (input.hasFile || input.messageCount > 0 || input.pendingCount > 0);
}

/** The message that carries the green 「现在处理」: the newest waiting one, while it
 *  still waits for the patrol (现在处理 hurries every waiting message of the work). */
export function nowButtonMessageId(oldestFirst: ReadonlyArray<Pick<ThreadMessage, "id" | "status" | "urgent">>): string | null {
  const newestPending = [...oldestFirst].reverse().find((m) => m.status === "pending");
  return newestPending && !newestPending.urgent ? newestPending.id : null;
}

/** The undo toast after 「不换了」. */
export function keepToastText(
  episodes: readonly string[],
  ctx: { mediaType: "movie" | "tv"; multiSeason: boolean; obtained: ReadonlySet<string> },
): string {
  if (ctx.mediaType === "movie") return "不换了，保留现在这份";
  const labels = episodes.map((e) => episodeLabel(e, ctx.multiSeason)).join("、");
  // A 待换 episode without its file goes back to 缺集, not 已获取.
  return episodes.every((e) => ctx.obtained.has(e)) ? `${labels} 不换了，恢复成已获取` : `${labels} 不换了`;
}

export function composerPlaceholder(input: { mediaType: "movie" | "tv"; active: boolean; open: boolean }): string {
  if (input.open) return "说说哪里不对，想换成什么样";
  if (input.active) return "还有别的？写在这里，排在上面这条后面";
  return input.mediaType === "movie" ? "这部有问题？告诉 agent，下次巡检它会换一个" : "哪一集有问题？告诉 agent，下次巡检它会换一个";
}

/** 「今天 14:31 处理完」 / 「昨天处理完」 beside the card's title. */
export function answeredMeta(processedAt: string, now: string): string {
  const when = relativeDayLabel(processedAt, now);
  if (!when) return "";
  return when.startsWith("今天") ? `${when} 处理完` : `${when}处理完`;
}
