"use client";

/* Hallmark · component: agent-memory (work notes + settings numbers) · genre: modern-minimal
 * theme: project (apps/web/DESIGN.md, Spotify) · states: collapsed · expanded (first 5) · show-more
 * · row hover · delete :focus-visible · pending · deleted + undo · error · empty (hidden) */

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { deleteAgentMemoryAction, setAgentMemoryEnabledAction } from "../app/actions";
import { runAction } from "../lib/run-action";
import { relativeDayLabel } from "../lib/relative-day";
import type { MemoryItem, MemoryStats } from "../lib/agent-memory-server";
import { restoreNote, visibleAfterRefresh } from "../lib/memory-notes-state";

type Address = { scope: "global" } | { scope: "title"; mediaType: "movie" | "tv"; tmdbId: number };

/** Rows shown before「再显示 N 条」. A work holds at most 20 notes, so the list never grows past one screen. */
const FIRST_ROWS = 5;
const UNDO_MS = 6000;

const VERDICT_LABEL = { works: "管用", avoid: "别再用" } as const;

/**
 * One work's notes (detail page), or the shared general notes (settings page).
 * Delete is the only action: the agent writes the notes and the user never has to;
 * a wrong one is deleted in one click. The delete is DEFERRED: the row disappears at
 * once and the server call happens after UNDO_MS unless the user hits 撤销 (so undo
 * needs no restore path that would let the client write note content). Leaving the
 * page flushes a pending delete immediately.
 */
export function AgentMemoryNotes(props: NotesProps) {
  // One instance per work: the App Router reuses components across /show pages, and
  // no list/pending-delete state may carry from one work to the next. The old
  // instance's unmount flushes its waiting delete against its own work.
  return <NotesForOneWork key={JSON.stringify(props.address)} {...props} />;
}

interface NotesProps {
  address: Address;
  items: MemoryItem[];
  /** The collapsed line, e.g. 「agent 补缺集时记了 {n} 条笔记」. */
  summaryLabel: string;
  /** Server "now" so relative days match between server and client render. */
  now: string;
}

function NotesForOneWork({
  address,
  items: initialItems,
  summaryLabel,
  now,
}: NotesProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [items, setItems] = useState(initialItems);
  const [showAll, setShowAll] = useState(false);
  const [removed, setRemoved] = useState<{ item: MemoryItem; index: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The address is snapshotted per delete: the App Router can reuse this component
  // across /show pages, and a waiting delete must never land on the next work.
  const pending = useRef<{ name: string; address: Address; timer: ReturnType<typeof setTimeout> } | null>(null);
  // Every note the user deleted whose server delete has not resolved yet — waiting out
  // the undo window OR in flight. The page refreshes on its own (AcquiringPoller,
  // router.refresh) and fresh props still contain those rows; keep them hidden, or a
  // deleted note would reappear (and 撤销 would then insert a duplicate).
  const deleting = useRef(new Set<string>());
  useEffect(() => {
    setItems(visibleAfterRefresh(initialItems, deleting.current));
  }, [initialItems]);
  const commit = (target: Address, name: string, item: MemoryItem, index: number) => {
    pending.current = null;
    startTransition(async () => {
      const r = await runAction(() => deleteAgentMemoryAction(target, name), (msg) => setError(msg));
      // Resolved either way: from now on the server's answer is the truth.
      deleting.current.delete(name);
      const failed = !r.ok ? true : !r.value.success;
      if (failed) {
        // Put it back where it was: the note still exists.
        if (r.ok) setError(r.value.message ?? "删除没成功，再试一次");
        setItems((prev) => restoreNote(prev, item, index));
      }
      setRemoved((cur) => (cur?.item.name === name ? null : cur));
      router.refresh();
    });
  };

  // Leaving the page (or this instance unmounting) must not drop a delete the user
  // asked for; it is sent right away, against the work it was made on.
  useEffect(() => {
    const flush = () => {
      const p = pending.current;
      if (!p) return;
      clearTimeout(p.timer);
      pending.current = null;
      void deleteAgentMemoryAction(p.address, p.name)
        .catch(() => undefined)
        .finally(() => deleting.current.delete(p.name));
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, []);

  if (items.length === 0 && !removed) return null;

  const latest = items[0]?.updatedAt ?? removed?.item.updatedAt ?? now;
  const visible = showAll ? items : items.slice(0, FIRST_ROWS);
  const hidden = items.length - visible.length;

  const handleDelete = (item: MemoryItem) => {
    setError(null);
    // One undo at a time: a second delete commits the first right away.
    if (pending.current && removed) {
      clearTimeout(pending.current.timer);
      commit(pending.current.address, pending.current.name, removed.item, removed.index);
    }
    const index = items.findIndex((i) => i.name === item.name);
    deleting.current.add(item.name);
    setItems((prev) => prev.filter((i) => i.name !== item.name));
    setRemoved({ item, index });
    const target = address;
    pending.current = { name: item.name, address: target, timer: setTimeout(() => commit(target, item.name, item, index), UNDO_MS) };
  };

  const handleUndo = () => {
    if (!removed || !pending.current) return;
    clearTimeout(pending.current.timer);
    pending.current = null;
    const { item, index } = removed;
    deleting.current.delete(item.name);
    setItems((prev) => restoreNote(prev, item, index));
    setRemoved(null);
  };

  return (
    <details className="memory-notes">
      <summary>
        <span className="memory-notes-dot" aria-hidden />
        <span>
          {summaryLabel.replace("{n}", String(items.length))} · 最近 {relativeDayLabel(latest, now)}
        </span>
      </summary>
      <ul className="memory-notes-list">
        {visible.map((item) => (
          <li key={item.name} className="memory-note">
            <p className="memory-note-text">
              {item.verdict ? (
                <span className={`memory-note-verdict is-${item.verdict}`}>{VERDICT_LABEL[item.verdict]}</span>
              ) : null}
              {item.text}
              <small>
                {item.driveLabel ? `${item.driveLabel} · ` : ""}
                {relativeDayLabel(item.updatedAt, now)}
              </small>
            </p>
            <button
              type="button"
              className="memory-note-delete"
              onClick={() => handleDelete(item)}
              disabled={isPending}
              aria-label={`删除这条笔记：${item.text}`}
              title="删除"
            >
              <X size={15} aria-hidden />
            </button>
          </li>
        ))}
      </ul>
      {hidden > 0 ? (
        <button type="button" className="memory-notes-more" onClick={() => setShowAll(true)}>
          再显示 {hidden} 条
        </button>
      ) : null}
      {removed ? (
        <div className="memory-notes-toast" role="status">
          <span>已删除，agent 下次不会再读到这条</span>
          <button type="button" onClick={handleUndo} disabled={isPending}>
            撤销
          </button>
        </div>
      ) : null}
      {error ? (
        <p className="memory-notes-error" role="alert">
          {error}
        </p>
      ) : null}
    </details>
  );
}

/** Settings → AI 模型: the numbers and the on/off switch. No note is listed here. */
export function AgentMemoryStats({
  stats,
  enabled: initialEnabled,
  now,
}: {
  stats: MemoryStats;
  enabled: boolean;
  now: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [enabled, setEnabled] = useState(initialEnabled);
  useEffect(() => setEnabled(initialEnabled), [initialEnabled]);
  const [error, setError] = useState<string | null>(null);

  const handleToggle = (next: boolean) => {
    setError(null);
    startTransition(async () => {
      const r = await runAction(() => setAgentMemoryEnabledAction(next), (msg) => setError(msg));
      if (!r.ok) return;
      if (r.value.success) {
        setEnabled(next);
        router.refresh();
      } else {
        setError(r.value.message ?? "保存没成功");
      }
    });
  };

  return (
    <div className="memory-stats">
      <div className="memory-stats-grid">
        <div className="memory-stat">
          <b>{stats.titleEntries}</b>
          <span>
            条作品笔记{stats.titleWorks > 0 ? ` · 覆盖 ${stats.titleWorks} 部` : ""}
          </span>
        </div>
        <div className="memory-stat">
          <b>{stats.globalEntries}</b>
          <span>条通用经验</span>
        </div>
      </div>
      {stats.latest ? (
        <p className="memory-stats-recent">
          近 7 天新增 <strong>+{stats.recentAdded}</strong> · 最近一次 {relativeDayLabel(stats.latest.updatedAt, now)}
          {stats.latest.scope === "global" ? " · 通用经验" : stats.latest.workTitle ? `《${stats.latest.workTitle}》` : ""}
        </p>
      ) : (
        <p className="memory-stats-recent">还没有笔记。agent 获取或补缺集后，觉得值得记的会自己写下来。</p>
      )}
      <label className="service-toggle">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => handleToggle(event.target.checked)}
          disabled={isPending}
        />
        启用 agent 记忆
      </label>
      {error ? (
        <p className="memory-notes-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
