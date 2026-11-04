"use client";

/* Hallmark · component: user-message thread (work detail page) · genre: modern-minimal
 * theme: project (apps/web/DESIGN.md, Spotify) · pixel standard: docs/superpowers/design/2026-09-26-user-message-mockup.html
 * states: resting · composing + chips · picking episodes · waiting for the patrol (修改 / 撤回 / 现在处理) · editing
 * · queued behind a run · processing (equalizer + live activity) · answered (track list · 不换了 + undo toast
 * · copy path) · film 待换 bar · unidentified · rejected list not saved · error */

import { useEffect, useId, useRef, useState, useTransition, type FocusEvent, type KeyboardEvent, type MouseEvent } from "react";
import { createPortal, flushSync } from "react-dom";
import { useRouter } from "../lib/use-router";
import {
  editUserMessageAction,
  keepEpisodesAsIsAction,
  postUserMessageAction,
  processMessagesNowAction,
  restoreEpisodesToPendingAction,
  withdrawUserMessageAction,
} from "../app/actions";
import { KEEP_SAVE_FAILED, KEEP_UNDO_FAILED, createKeepUndo, type KeepToast } from "../lib/keep-undo";
import { relativeDayLabel } from "../lib/relative-day";
import { runAction } from "../lib/run-action";
import type { MessageRunView, MessageThreadView } from "../lib/user-message-server";
import {
  EDIT_SETTLE_MS,
  KEEP_BUSY_HINT,
  answeredMeta,
  appendChipText,
  composerPlaceholder,
  draftIsSendable,
  editorAfterRefresh,
  editorAfterSettleTimeout,
  editorNotice,
  episodeLabel,
  groupEpisodesBySeason,
  isMultiSeason,
  keepToastText,
  mergeIntoComposer,
  missedEpisodes,
  nowButtonMessageId,
  replacedLaterByRun,
  replyView,
  statusLabel,
  threadExchanges,
  toggleEpisode,
  visibleExchanges,
  type EditingMessage,
  type Exchange,
  type ReplyRow,
  type ThreadMessage,
} from "../lib/user-message-state";
import { useSwapKeep } from "./swap-keep";
import { copyText } from "../lib/copy-text";

/** How long 撤销 stays on screen after 「不换了」 (saved at once; 撤销 puts it back). */
const UNDO_MS = 6000;
const COPIED_MS = 2500;
/** USER_MESSAGE_LIMITS.bodyMax — the card cannot import the workflow package; the
 *  server validates the same limit. */
const BODY_MAX = 500;
const MISSED_EPISODES_HINT = "没看出是哪几集——用「选集数」标出来，再发一次";

/** The common ways to say what is wrong (mockup ②): the chip, and what it adds to the draft. */
const CHIPS = [
  { label: "画面偏色", fill: "画面发蓝 / 偏色" },
  { label: "假片 / 不是这部", fill: "是假片，不是这部" },
  { label: "没有中字", fill: "没有中文字幕" },
  { label: "画质太差", fill: "画质太差，想要 1080p 以上" },
  { label: "音画不同步", fill: "音画不同步" },
] as const;

const OUT_TONE = { replaced: "is-ok", looking: "is-bad", replacedLater: "is-off", stopped: "is-off" } as const;

interface Work {
  tmdbId: number;
  mediaType: "movie" | "tv";
  /** The page's workspace drive (undefined = primary). The server resolves the work. */
  storageId: string | undefined;
}

export interface UserMessageThreadProps {
  work: Work;
  view: MessageThreadView;
  run: MessageRunView;
  /** 「明早 06:00」: when the next patrol reads a message left now. */
  nextPatrol: string;
  /** Episode codes in the library (TV): the picker's cells. [] for a film. */
  episodes: string[];
  /** Server "now", so the server render and hydration write the same times. */
  now: string;
}

/**
 * The detail page's message card: one sentence to the agent about a bad episode or a bad
 * film; the agent's reply under it. Every action refreshes the page itself afterwards
 * (the actions do not revalidate), and the live progress while a run works arrives
 * through the page's AcquiringPoller — this card never polls.
 */
export function UserMessageThread(props: UserMessageThreadProps) {
  // One instance per work: the App Router reuses components across /show pages, and no
  // draft, editor or undo toast may carry to the next work.
  const { work } = props;
  return <ThreadForOneWork key={`${work.mediaType}:${work.tmdbId}:${work.storageId ?? ""}`} {...props} />;
}

/** A message action's answer for the keep/undo module: null when it went through, else
 *  the card's error line. */
async function savedOr(action: () => Promise<{ success: boolean; message?: string }>, fallback: string): Promise<string | null> {
  const r = await runAction(action, () => undefined);
  if (r.ok && r.value.success) return null;
  return (r.ok && r.value.message) || fallback;
}

function ThreadForOneWork({ work, view, run, nextPatrol, episodes, now }: UserMessageThreadProps) {
  const router = useRouter();
  const [sending, startSend] = useTransition();
  const [acting, startAct] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // The composer.
  const [draft, setDraft] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [picking, setPicking] = useState(false);
  const [focused, setFocused] = useState(false);
  /** 「再留一条」 was pressed under an answer. */
  const [revealed, setRevealed] = useState(false);
  /** Just sent: the composer stays until the fresh render shows the new message. */
  const [holdOpen, setHoldOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // One waiting message edited in place.
  const [editing, setEditing] = useState<EditingMessage | null>(null);
  // 不换了 and its undo. The episodes are shared with the page (the 待换 cells, the badge).
  const { kept, add: keepOnPage, remove: unkeepOnPage } = useSwapKeep();
  const [toast, setToast] = useState<KeepToast | null>(null);
  // Where the focus goes once the toast is gone (its 撤销 may hold it, and a vanished button
  // drops it to <body>): see returnFocus below.
  const toastRowRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const movieBarRef = useRef<HTMLDivElement>(null);
  /** Where the card last put the focus while waiting for the rows' 不换了 to come back. */
  const focusParked = useRef<HTMLElement | null>(null);
  /** Asked for by the keeper, done after the next commit (when the page draws the rows). */
  const focusWanted = useRef<{ episodes: string[] | null } | null>(null);
  const [focusTick, setFocusTick] = useState(0);
  // Saved at once; 撤销 puts the rows back (lib/keep-undo.ts). Nothing waits for the page
  // to go away: a send from an unmounting page posted to the next route and was lost.
  const [keeper] = useState(() =>
    createKeepUndo({
      commit: (list) => savedOr(() => keepEpisodesAsIsAction({ ...work, episodes: list }), KEEP_SAVE_FAILED),
      restore: (rows) => savedOr(() => restoreEpisodesToPendingAction({ ...work, episodes: rows }), KEEP_UNDO_FAILED),
      hide: keepOnPage,
      show: unkeepOnPage,
      toast: setToast,
      error: setError,
      refresh: () => router.refresh(),
      // Only a focus that is still ours to move: on the toast (going now), where the card
      // parked it, or lost to <body> while the card is on screen (Safari does not focus a
      // clicked button). Not one the user took elsewhere, nor on a page the router hid.
      returnFocus: (list) => {
        const active = document.activeElement;
        const onScreen = (sectionRef.current?.getClientRects().length ?? 0) > 0;
        const lost = !active || active === document.body;
        const ours = toastRowRef.current?.contains(active) || active === focusParked.current || (lost && onScreen);
        if (!ours) return;
        focusWanted.current = { episodes: list };
        setFocusTick((n) => n + 1);
      },
      undoMs: UNDO_MS,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    }),
  );
  const focusUndo = useRef(false);
  const undoRef = useRef<HTMLButtonElement>(null);
  /** The toast lives in <body> (above every card on the page); only once mounted. */
  const [mounted, setMounted] = useState(false);
  const lastView = useRef(view);
  const pickerId = useId();
  const keepHintId = useId();

  const movie = work.mediaType === "movie";
  const exchanges = threadExchanges(view.messages);
  const { earlier, recent, earlierCount } = visibleExchanges(exchanges);
  const last = exchanges.at(-1);
  const latestAnswered = [...recent].reverse().find((e) => e.kind === "answered");
  const replacedLater = replacedLaterByRun(exchanges);
  const pending = new Set(view.pendingReplacements.filter((e) => !kept.has(e)));
  const multiSeason = isMultiSeason([
    ...episodes,
    ...view.pendingReplacements,
    ...view.messages.flatMap((m) => [...m.episodeTags, ...(m.reply?.results.map((r) => r.episode) ?? [])]),
  ]);
  const obtained = new Set(episodes);
  // An urgent message waits for the run in flight rather than going with a queued one.
  const busy = view.busy || run.waitsForRun;
  // A replace run of this work is processing: 「不换了」 waits (its bookkeeping would undo it).
  const keepBusy = view.busy || run.running;
  const nowId = nowButtonMessageId([...view.messages].reverse());
  const active = view.messages.some((m) => m.status === "pending" || m.status === "processing");
  const open = focused || draft !== "" || tags.length > 0 || picking;
  // Under an answer the composer folds into 「再留一条」 (mockup ⑤); otherwise it is always there.
  const composerShown = last?.kind !== "answered" || revealed || open || holdOpen;
  const canPick = !movie && episodes.length > 0;
  const editingId = editing && view.messages.some((m) => m.id === editing.id && m.status === "pending") ? editing.id : null;

  useEffect(() => setMounted(true), []);

  // A fresh server render. Not when the page merely shows again (the router keeps a
  // page it left hidden, and effects run anew when it comes back): same props, no news.
  useEffect(() => {
    if (lastView.current === view) return;
    lastView.current = view;
    keeper.viewChanged();
    setHoldOpen(false);
    if (!editing) return;
    const verdict = editorAfterRefresh(editing, view.messages.find((m) => m.id === editing.id));
    if (verdict.kind === "keep") return;
    setEditing(null);
    if (verdict.kind === "close") return;
    // A run took the message, or it was withdrawn elsewhere, while its editor was open: what
    // was typed is not dropped — it moves into the composer, and the card says why.
    const typed = verdict.typed;
    if (typed) {
      setDraft((cur) => mergeIntoComposer({ draft: cur, tags: [] }, typed).draft);
      setTags((cur) => mergeIntoComposer({ draft: "", tags: cur }, typed).tags);
    }
    setError(editorNotice(verdict));
    // `editing` is read as of the render that brought this view: only a new view re-runs this.
  }, [view, keeper]);

  // Saved, but the fresh render with the new words is late (a slow or lost refresh): after a
  // while the editor is given back instead of staying disabled, and the render asked again.
  const settlingId = editing?.saved ? editing.id : null;
  useEffect(() => {
    if (!settlingId) return;
    const timer = setTimeout(() => {
      setEditing((cur) => editorAfterSettleTimeout(cur, settlingId));
      router.refresh();
    }, EDIT_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [settlingId, router]);

  // The 不换了 button just went away with its row state: 撤销 takes the focus.
  useEffect(() => {
    if (toast && focusUndo.current) {
      focusUndo.current = false;
      undoRef.current?.focus({ preventScroll: true });
    }
  }, [toast]);

  // The toast is gone or the rows came back (keeper.returnFocus): the rows' 不换了 when one
  // is there to take the focus, else the card's heading (the composer when there is none).
  useEffect(() => {
    const wanted = focusWanted.current;
    if (!wanted) return;
    focusWanted.current = null;
    const button = wanted.episodes ? keepButtonFor([movieBarRef.current, sectionRef.current], wanted.episodes) : null;
    const target = button ?? headingRef.current ?? textareaRef.current;
    if (!target) return;
    target.focus({ preventScroll: true });
    // Parked on the heading: a 撤销 still in flight moves it on to the row's 不换了 once
    // the row is 待换 again. Never parked in the composer: the user may be typing there.
    focusParked.current = !button && target === headingRef.current ? target : null;
  }, [focusTick]);

  const send = () => {
    if (!draftIsSendable(draft) || sending) return;
    setError(null);
    const input = { ...work, body: draft, episodeTags: tags };
    startSend(async () => {
      const r = await runAction(() => postUserMessageAction(input), setError);
      if (!r.ok) return;
      if (!r.value.success) {
        setError(r.value.message ?? "留言没发出去，再试一次");
        return;
      }
      setDraft("");
      setTags([]);
      setPicking(false);
      setRevealed(false);
      setHoldOpen(true);
      textareaRef.current?.blur();
      router.refresh();
    });
  };

  const onDraftKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends, Shift+Enter breaks the line; never while an IME is composing.
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    send();
  };

  const onComposeBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setFocused(false);
    if (draft.trim() === "" && tags.length === 0 && !picking) setRevealed(false);
  };

  // A click on the pill's padding lands in the text box, as the mockup's <label> does.
  const onComposerMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button, textarea")) return;
    event.preventDefault();
    textareaRef.current?.focus();
  };

  const togglePicking = () => {
    const next = !picking;
    setPicking(next);
    // The grid is below the box: let a phone's keyboard go down while picking.
    if (next) textareaRef.current?.blur();
  };

  const reveal = () => {
    flushSync(() => setRevealed(true));
    textareaRef.current?.focus();
  };

  const saveEdit = () => {
    if (!editing || editing.saved || !draftIsSendable(editing.body) || acting) return;
    const { id } = editing;
    const input = { id, body: editing.body, episodeTags: editing.tags };
    // What the store keeps (it trims).
    const saved = { body: editing.body.trim(), tags: editing.tags };
    setError(null);
    startAct(async () => {
      const r = await runAction(() => editUserMessageAction(input), setError);
      if (!r.ok) return;
      // Saved: the editor stays, disabled, with the new words until the refreshed render
      // carries them — closing now would flash the old text first.
      if (r.value.success) setEditing((cur) => (cur?.id === id ? { ...cur, body: saved.body, saved } : cur));
      else setError(r.value.message ?? "修改没成功，再试一次");
      // Either way: a message a run took meanwhile then shows locked, and what was typed
      // moves into the composer.
      router.refresh();
    });
  };

  const withdraw = (id: string) => {
    setError(null);
    startAct(async () => {
      const r = await runAction(() => withdrawUserMessageAction({ id }), setError);
      if (!r.ok) return;
      if (!r.value.success) setError(r.value.message ?? "撤回没成功，再试一次");
      router.refresh();
    });
  };

  const processNow = () => {
    setError(null);
    startAct(async () => {
      const r = await runAction(() => processMessagesNowAction(work), setError);
      if (!r.ok) return;
      if (!r.value.success) {
        setError(r.value.message ?? "没能开始处理，再试一次");
        return;
      }
      router.refresh();
    });
  };

  const keep = (episodesToKeep: string[]) => {
    const rows = view.pendingRows.filter((r) => episodesToKeep.includes(r.episode));
    const text = keepToastText(episodesToKeep, { mediaType: work.mediaType, multiSeason, obtained });
    if (keeper.keep({ rows, text, busy: keepBusy })) focusUndo.current = true;
  };

  const undo = () => {
    void keeper.undo();
  };

  const tagChip = (code: string, remove: (() => void) | null) => {
    const label = episodeLabel(code, multiSeason);
    return (
      <button type="button" key={code} className="um-chip um-ep-tag" aria-label={`去掉 ${label}`} onClick={remove ?? undefined} disabled={remove === null}>
        {label}
        <b aria-hidden="true">×</b>
      </button>
    );
  };

  const renderEditor = () => {
    if (!editing) return null;
    // Saved and waiting for the refreshed render: shown, not editable.
    const settled = editing.saved !== null;
    return (
      <div className="um-edit">
        <div className="um-composer is-open">
          <textarea
            aria-label="修改留言"
            rows={1}
            maxLength={BODY_MAX}
            value={editing.body}
            disabled={settled}
            autoFocus
            onChange={(event) => {
              const body = event.target.value;
              setEditing((cur) => (cur ? { ...cur, body } : cur));
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") setEditing(null);
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                event.preventDefault();
                saveEdit();
              }
            }}
          />
          {editing.tags.length > 0 ? (
            <div className="um-tools">
              {editing.tags.map((code) =>
                tagChip(code, settled ? null : () => setEditing((cur) => (cur ? { ...cur, tags: cur.tags.filter((t) => t !== code) } : cur))),
              )}
            </div>
          ) : null}
        </div>
        <div className="um-msg-actions">
          <button type="button" className="um-btn is-ghost" onClick={() => setEditing(null)} disabled={settled}>
            取消
          </button>
          <button type="button" className="um-btn is-go" onClick={saveEdit} disabled={settled || acting || !draftIsSendable(editing.body)}>
            保存
          </button>
        </div>
      </div>
    );
  };

  const renderUserMessage = (m: ThreadMessage) => {
    const label = statusLabel(m, nextPatrol, busy);
    const inline = m.episodeTags.map((code) => episodeLabel(code, multiSeason)).filter(Boolean);
    const snippet = m.body.length > 30 ? `${m.body.slice(0, 30)}…` : m.body;
    return (
      <div className="um-msg" key={m.id}>
        <div className="um-av is-me" aria-hidden="true">
          我
        </div>
        <div>
          <div className="um-who">
            <b>你</b>
            <span>{relativeDayLabel(m.createdAt, now)}</span>
            {label ? <span className={`um-status ${m.status === "pending" ? "is-wait" : "is-done"}`}>{label}</span> : null}
          </div>
          {editingId === m.id ? (
            renderEditor()
          ) : (
            <>
              <div className={`um-body${m.status === "pending" ? "" : " is-locked"}`}>
                {inline.map((tag) => (
                  <span className="um-ep-inline" key={tag}>
                    {tag}
                  </span>
                ))}
                {inline.length > 0 ? " " : null}
                {m.body}
              </div>
              {/* The run could not tell which episodes this one meant (it named none). */}
              {missedEpisodes(m, work.mediaType) ? <p className="um-note">{MISSED_EPISODES_HINT}</p> : null}
              {m.status === "pending" ? (
                <div className="um-msg-actions">
                  <button
                    type="button"
                    className="um-btn is-ghost"
                    onClick={() => {
                      setError(null);
                      setEditing({ id: m.id, body: m.body, tags: m.episodeTags, original: { body: m.body, tags: m.episodeTags }, saved: null });
                    }}
                    disabled={acting}
                    aria-label={`修改这条留言：${snippet}`}
                  >
                    修改
                  </button>
                  <button type="button" className="um-btn is-ghost" onClick={() => withdraw(m.id)} disabled={acting} aria-label={`撤回这条留言：${snippet}`}>
                    撤回
                  </button>
                  {nowId === m.id ? (
                    <button type="button" className="um-btn is-go" onClick={processNow} disabled={acting}>
                      <PlayIcon />
                      现在处理
                    </button>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    );
  };

  const renderWorking = (fallback: string, key: string) => (
    <div className="um-msg" key={key}>
      <div className="um-av is-agent" aria-hidden="true">
        <AgentIcon />
      </div>
      <div>
        <div className="um-who">
          <b>agent</b>
          <span className="um-status is-run">
            <span className="um-eq" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            正在处理
          </span>
        </div>
        <div className="um-ticker" role="status" aria-live="polite">
          <span>{run.activity ?? fallback}</span>
        </div>
      </div>
    </div>
  );

  const renderReply = (exchange: Extract<Exchange, { kind: "answered" }>) => {
    if (!exchange.reply) return null;
    const reply = replyView(exchange.reply, { mediaType: work.mediaType, multiSeason, pending, replacedLater: replacedLater.get(exchange.reply.runId) });
    const latest = exchange === latestAnswered;
    const foot = latest ? reply.foot : null;
    const another = latest && !composerShown;
    return (
      <div className="um-msg" key={`reply-${exchange.reply.runId}`}>
        <div className="um-av is-agent" aria-hidden="true">
          <AgentIcon />
        </div>
        <div>
          <div className="um-who">
            <b>agent</b>
            {reply.summary ? <span>{reply.summary}</span> : null}
          </div>
          {reply.rows.length > 0 ? <Tracks rows={reply.rows} movie={movie} onKeep={keep} keepBlockedBy={keepBusy ? keepHintId : null} /> : null}
          {reply.rejectedNotSaved ? <p className="um-note is-faint">这次拒掉的版本没能记下来，之后搜索时可能还会看到它</p> : null}
          {reply.oldFilesLabel ? <OldFiles label={reply.oldFilesLabel} paths={reply.oldFiles} /> : null}
          {foot || another ? (
            <div className="um-reply-foot">
              {foot ? <span>{foot}</span> : null}
              {another ? (
                <button type="button" className="um-btn is-outline" onClick={reveal}>
                  再留一条
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    );
  };

  const renderExchange = (exchange: Exchange) => {
    const messages = exchange.messages.map(renderUserMessage);
    if (exchange.kind === "working") return [...messages, renderWorking("正在看你的留言", `working-${exchange.messages[0]!.id}`)];
    if (exchange.kind === "answered") return [...messages, renderReply(exchange)];
    return messages;
  };

  const meta = last?.kind === "answered" && last.processedAt ? answeredMeta(last.processedAt, now) : "";
  const pickGroups = picking ? groupEpisodesBySeason(episodes) : [];

  return (
    <>
      {movie && pending.has("MOVIE") ? (
        <div className="um-movie-state" ref={movieBarRef}>
          <span>
            <b>还在找别的版本。</b>现在这份先留着，之后每次巡检都会接着找。
          </span>
          <button
            type="button"
            className="um-btn is-outline"
            data-keep-episode="MOVIE"
            onClick={() => keep(["MOVIE"])}
            disabled={keepBusy}
            title={keepBusy ? KEEP_BUSY_HINT : undefined}
            aria-describedby={keepBusy ? keepHintId : undefined}
          >
            不换了
          </button>
        </div>
      ) : null}
      {/* The reason a disabled 不换了 gives (title for the pointer, this for screen readers). */}
      {keepBusy ? (
        <span id={keepHintId} hidden>
          {KEEP_BUSY_HINT}
        </span>
      ) : null}
      <section className="um-thread" aria-label="给 agent 的留言" ref={sectionRef}>
        {view.messages.length > 0 ? (
          <div className="um-thread-head">
            {/* Focusable from script only: where the focus lands when the undo toast goes. */}
            <h3 ref={headingRef} tabIndex={-1}>
              给 agent 的留言
            </h3>
            {meta ? <span className="um-meta">{meta}</span> : null}
          </div>
        ) : null}
        {recent.flatMap(renderExchange)}
        {/* A run looking for 待换 episodes with no new message (queued by the patrol). */}
        {run.running && !exchanges.some((e) => e.kind === "working") ? renderWorking("正在接着找待换的集", "working-pending") : null}
        {composerShown ? (
          <div className={`um-compose${view.messages.length > 0 ? " is-below" : ""}`} onFocus={() => setFocused(true)} onBlur={onComposeBlur}>
            <div className={`um-composer${open ? " is-open" : ""}`} onMouseDown={onComposerMouseDown}>
              <textarea
                ref={textareaRef}
                aria-label="留言内容"
                rows={1}
                maxLength={BODY_MAX}
                value={draft}
                placeholder={composerPlaceholder({ mediaType: work.mediaType, active, open })}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={onDraftKeyDown}
              />
              {open ? <div className="um-tools">{tags.map((code) => tagChip(code, () => setTags((cur) => cur.filter((t) => t !== code))))}</div> : null}
              {open && canPick ? (
                <button
                  type="button"
                  className="um-btn is-ghost"
                  aria-pressed={picking}
                  aria-controls={picking ? pickerId : undefined}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={togglePicking}
                >
                  选集数
                </button>
              ) : null}
              <button type="button" className="um-go" aria-label="发送" disabled={!draftIsSendable(draft) || sending} onClick={send}>
                <SendIcon />
              </button>
            </div>
            {open && picking ? (
              <div className="um-pick" id={pickerId}>
                {pickGroups.map((group) => (
                  <div key={group.season}>
                    {multiSeason ? <div className="um-pick-season">{`第 ${group.season} 季`}</div> : null}
                    <div className="episode-grid um-pick-grid" role="group" aria-label={multiSeason ? `第 ${group.season} 季：选要换的集` : "选要换的集"}>
                      {group.episodes.map((code) => {
                        const selected = tags.includes(code);
                        const swapping = !selected && pending.has(code);
                        return (
                          <button
                            type="button"
                            key={code}
                            className={`episode-cell obtained${swapping ? " swap" : ""}`}
                            aria-pressed={selected}
                            onClick={() => setTags((cur) => toggleEpisode(cur, code))}
                          >
                            <strong>{code.replace(/^S\d+/, "")}</strong>
                            <span>{selected ? "要换" : swapping ? "待换" : "已获取"}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
                <div className="um-pick-bar">
                  <span>{tags.length > 0 ? `选了 ${tags.length} 集` : "在格子上点要换的集"}</span>
                  <button type="button" className="um-btn is-ghost" onClick={() => setTags([])} disabled={tags.length === 0}>
                    清空
                  </button>
                </div>
              </div>
            ) : null}
            {open ? (
              <div className="um-chips" role="group" aria-label="常见说法">
                {CHIPS.map((chip) => (
                  <button
                    type="button"
                    key={chip.label}
                    className="um-chip"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      setDraft((cur) => appendChipText(cur, chip.fill));
                      textareaRef.current?.focus();
                    }}
                  >
                    {chip.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        {error ? (
          <p className="um-error" role="status">
            {error}
          </p>
        ) : null}
        {earlierCount > 0 ? (
          <details className="um-earlier">
            <summary>{`之前的留言 · ${earlierCount} 条`}</summary>
            <div className="um-earlier-body">{earlier.flatMap(renderExchange)}</div>
          </details>
        ) : null}
      </section>
      {/* In <body>: inside the page it painted under the agent-notes card that follows (the
          card is its own stacking context). Hidden with the page when the router keeps it. */}
      {mounted
        ? createPortal(
            <div className="um-toast-row" role="status" aria-live="polite" ref={toastRowRef}>
              {toast ? (
                <div className="um-toast" key={toast.id}>
                  <span>{toast.text}</span>
                  <button type="button" ref={undoRef} onClick={undo}>
                    撤销
                  </button>
                </div>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

/** The 不换了 of one of these episodes that can take the focus: enabled, and laid out (not
 *  in a folded 「之前的留言」). The first in page order — the latest reply's. */
function keepButtonFor(roots: Array<HTMLElement | null>, episodes: string[]): HTMLButtonElement | null {
  for (const root of roots) {
    for (const button of root?.querySelectorAll<HTMLButtonElement>("button[data-keep-episode]") ?? []) {
      if (episodes.includes(button.dataset.keepEpisode ?? "") && !button.disabled && button.getClientRects().length > 0) return button;
    }
  }
  return null;
}

/** The reply as a track list (集 / 这次用的资源 / 大小 / 结果). `keepBlockedBy`: the id of the
 *  reason 不换了 is disabled (a replace run of the work is processing), else null. */
function Tracks({
  rows,
  movie,
  onKeep,
  keepBlockedBy,
}: {
  rows: ReplyRow[];
  movie: boolean;
  onKeep: (episodes: string[]) => void;
  keepBlockedBy: string | null;
}) {
  return (
    <div className={`um-tracks${movie ? " is-movie" : ""}`} role="table" aria-label="这次的处理结果">
      {movie ? null : (
        <div className="um-tracks-head" role="row">
          <span role="columnheader">集</span>
          <span role="columnheader">这次用的资源</span>
          <span role="columnheader">大小</span>
          <span role="columnheader">结果</span>
        </div>
      )}
      {rows.map((row) => (
        <div key={row.episode} className={`um-track${row.state === "replaced" ? "" : " is-fail"}`} role="row">
          {movie ? null : (
            <span className="um-no" role="cell">
              {row.label}
            </span>
          )}
          <span className="um-res" role="cell">
            <b title={row.resource}>{row.resource}</b>
            {row.note ? <small title={row.note}>{row.note}</small> : null}
          </span>
          <span className="um-size" role="cell">
            {row.size}
          </span>
          <span className={`um-out ${OUT_TONE[row.state]}`} role="cell">
            {row.state === "replaced" ? (
              <>
                <CheckIcon />
                {row.driveLabel ? `换好了 · ${row.driveLabel}` : "换好了"}
              </>
            ) : row.state === "looking" ? (
              <>
                <span className="um-out-label">
                  <RetryIcon />
                  继续找
                </span>
                {/* A film's 不换了 is on the red bar above the card. */}
                {movie ? null : (
                  <button
                    type="button"
                    className="um-keep"
                    data-keep-episode={row.episode}
                    onClick={() => onKeep([row.episode])}
                    aria-label={`${row.label} 不换了`}
                    disabled={keepBlockedBy !== null}
                    title={keepBlockedBy !== null ? KEEP_BUSY_HINT : undefined}
                    aria-describedby={keepBlockedBy ?? undefined}
                  >
                    不换了
                  </button>
                )}
              </>
            ) : row.state === "replacedLater" ? (
              "后来换好了"
            ) : (
              "不再待换"
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Where the old files are (never deleted by the agent), each with 复制路径. */
function OldFiles({ label, paths }: { label: string; paths: string[] }) {
  const id = useId();
  return (
    <div className={`um-oldfile${paths.length > 1 ? " is-list" : ""}`}>
      <span>{label}</span>
      <div className="um-oldfile-files">
        {paths.map((path, i) => (
          <div className="um-oldfile-row" key={path}>
            <code id={`${id}-${i}`} title={path}>
              {path}
            </code>
            <CopyPathButton path={path} describedBy={`${id}-${i}`} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** 「复制路径」 → 「已复制」 for a moment; no toast. */
function CopyPathButton({ path, describedBy }: { path: string; describedBy: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = async () => {
    const ok = await copyText(path);
    setState(ok ? "copied" : "failed");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), COPIED_MS);
  };
  return (
    <button type="button" className="um-copy" data-state={state === "copied" ? "copied" : undefined} aria-describedby={describedBy} onClick={() => void copy()}>
      {state === "copied" ? "已复制" : state === "failed" ? "复制失败" : "复制路径"}
    </button>
  );
}

// The mockup's icon set, 16×16, drawn in currentColor.
function SendIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M2 8h10M8.5 4.5 12 8l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M4.5 2.8v10.4L13 8z" fill="currentColor" />
    </svg>
  );
}

function AgentIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="8" cy="8" r="2.2" fill="currentColor" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function RetryIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5V5h-2.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
