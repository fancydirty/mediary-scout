"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { CheckCircle2, ChevronDown, ChevronRight, Clock3, Loader2, RotateCcw, TriangleAlert, X } from "lucide-react";
import { showHref } from "@media-track/workflow/scope";
import type { ActivityActiveRun, ActivityCompletedItem, ActivityView } from "../lib/activity-view";
import { isDemoModeClient } from "../lib/demo-mode";
import { demoCompletedItems, demoInProgressActivityItems } from "../lib/demo-session";
import { useDemoAcquisitions, useDemoInProgress } from "../lib/use-demo-session";

const POLL_MS = 2600;
const POSTER = "https://image.tmdb.org/t/p/w185";

export function ActivityFeed({ storageId }: { storageId?: string | undefined }) {
  // 已完成 is session-scoped by OBSERVATION: the runIds this browser saw active.
  // Robust to notification createdAt timing (a since-filter wrongly dropped runs
  // the user opened the page after — createdAt ≈ run-start, not finish).
  const seenActive = useRef<Set<string>>(new Set());
  const [view, setView] = useState<ActivityView>({ active: [], recentCompleted: [] });

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const url = storageId ? `/api/activity?w=${encodeURIComponent(storageId)}` : "/api/activity";
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as ActivityView;
        for (const run of data.active) {
          seenActive.current.add(run.runId);
        }
        if (alive) setView(data);
      } catch {
        // transient — keep the last view, retry next tick
      }
    };
    void poll(); // immediate first load (the page renders this client component in the static shell)
    const id = setInterval(() => void poll(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [storageId]);

  const running = view.active.filter((run) => run.status === "running");
  const queued = view.active
    .filter((run) => run.status === "queued")
    .sort((a, b) => (a.queuePosition ?? 0) - (b.queuePosition ?? 0));
  // Only show completions for runs THIS session watched go active → done.
  const completed = view.recentCompleted.filter((item) => seenActive.current.has(item.workflowRunId));
  // Demo: acquisitions are client-only (no DB run) → surface this session's
  // acquired titles as completed items, and in-progress playbacks as live 获取中
  // rows, so the activity page reflects them like production.
  const demoAcq = useDemoAcquisitions();
  const isDemo = isDemoModeClient();
  const demoDone = isDemo ? demoCompletedItems(demoAcq) : [];
  const demoActive = demoInProgressActivityItems(useDemoInProgress());
  const allCompleted = [...demoDone, ...completed];

  return (
    <div className="activity">
      <section className="act-section">
        <div className="act-section-head act-section-head-static">获取中</div>
        {running.length === 0 && demoActive.length === 0 ? (
          <p className="act-empty">当前没有正在处理的任务。</p>
        ) : (
          <>
            {demoActive.map((item) => (
              <DemoRunningRow item={item} key={item.id} />
            ))}
            {running.map((run) => (
              <RunningRow run={run} storageId={storageId} key={run.runId} />
            ))}
          </>
        )}
      </section>

      <CollapsibleSection title="排队中" count={queued.length} defaultOpen>
        {queued.length === 0 ? (
          <p className="act-empty">没有排队的任务。</p>
        ) : (
          queued.map((run) => <QueuedRow run={run} key={run.runId} />)
        )}
      </CollapsibleSection>

      <CollapsibleSection title="已完成" count={allCompleted.length} note="仅本次浏览" defaultOpen>
        {allCompleted.length === 0 ? (
          <p className="act-empty">本次浏览还没有完成的任务，历史可在通知查看。</p>
        ) : (
          allCompleted.map((item) => <CompletedRow item={item} key={item.workflowRunId} />)
        )}
      </CollapsibleSection>
    </div>
  );
}

function poster(posterPath: string | null, title: string, tone: string) {
  return posterPath ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img className="act-poster" src={`${POSTER}${posterPath}`} alt="" loading="lazy" />
  ) : (
    <span className={`act-poster act-poster-fallback tone-${tone}`}>{title.slice(0, 2)}</span>
  );
}

function seasonLabel(run: ActivityActiveRun): string {
  return run.type === "movie" || run.seasonNumber === null ? "" : `第 ${run.seasonNumber} 季`;
}

function RunningRow({ run, storageId }: { run: ActivityActiveRun; storageId?: string | undefined }) {
  const percent = Math.max(3, Math.min(100, run.progress?.percent ?? 3));
  const headline =
    run.progress?.needed && run.progress.needed > 0
      ? `已确认 ${run.progress.obtained ?? 0} / ${run.progress.needed} 集`
      : null;
  return (
    <Link className="act-row act-row-active" href={showHref(run.tmdbId, "library", storageId, run.type)}>
      {poster(run.posterPath, run.title, "info")}
      <div className="act-row-body">
        <div className="act-row-head">
          <strong>{run.title}</strong>
          {seasonLabel(run) ? <span className="act-sub">{seasonLabel(run)}</span> : null}
          {headline ? <span className="act-frac">{headline}</span> : null}
        </div>
        <div className="act-bar">
          <div className="act-bar-fill" style={{ width: `${percent}%` }} />
        </div>
        <div className="act-ticker-row">
          <Loader2 size={14} className="act-spin" aria-hidden />
          <Ticker text={run.progress?.activity ?? "正在准备…"} />
        </div>
      </div>
    </Link>
  );
}

function Ticker({ text }: { text: string }) {
  // Two absolutely-stacked lines: the outgoing slides up & out, the incoming slides
  // up into place. On collapse we keep ONLY the incoming — its key is stable, so
  // React preserves the element (no remount) and it's already at rest (translateY
  // 0 = the is-in end state) → seamless, no "jump in from the top" flash.
  const idRef = useRef(0);
  const [lines, setLines] = useState<{ id: number; text: string }[]>([{ id: 0, text }]);
  const prev = useRef(text);

  useEffect(() => {
    if (text === prev.current) {
      return;
    }
    prev.current = text;
    idRef.current += 1;
    const id = idRef.current;
    setLines((current) => {
      const outgoing = current[current.length - 1];
      return outgoing ? [outgoing, { id, text }] : [{ id, text }];
    });
    const timer = setTimeout(() => setLines([{ id, text }]), 380);
    return () => clearTimeout(timer);
  }, [text]);

  return (
    <div className="act-ticker" aria-live="polite">
      {lines.map((line, index) => (
        <div
          key={line.id}
          className={`act-ticker-line${lines.length > 1 ? (index === 0 ? " is-out" : " is-in") : ""}`}
        >
          {line.text}
        </div>
      ))}
    </div>
  );
}

type DemoActivityItem = ReturnType<typeof demoInProgressActivityItems>[number];

/** Demo-only 获取中 row: clock-driven progress, no DB run (not a link). Mirrors
 *  RunningRow's poster + progress bar + step layout. */
function DemoRunningRow({ item }: { item: DemoActivityItem }) {
  const percent = Math.max(3, Math.min(100, item.progress));
  return (
    <div className="act-row act-row-active">
      {poster(item.posterPath, item.title, "info")}
      <div className="act-row-body">
        <div className="act-row-head">
          <strong>{item.title}</strong>
        </div>
        <div className="act-bar">
          <div className="act-bar-fill" style={{ width: `${percent}%` }} />
        </div>
        <div className="act-ticker-row">
          <Loader2 size={14} className="act-spin" aria-hidden />
          <Ticker text={item.step} />
        </div>
      </div>
    </div>
  );
}

function QueuedRow({ run }: { run: ActivityActiveRun }) {
  return (
    <div className="act-row act-row-queued">
      {poster(run.posterPath, run.title, "muted")}
      <div className="act-row-body act-row-inline">
        <strong>{run.title}</strong>
        {seasonLabel(run) ? <span className="act-sub">{seasonLabel(run)}</span> : null}
        <span className="act-pill">
          <Clock3 size={12} aria-hidden />第 {run.queuePosition} 位{run.missingCount > 0 ? ` · 缺 ${run.missingCount} 集` : ""}
        </span>
        <CancelButton runId={run.runId} title={run.title} />
      </div>
    </div>
  );
}

function completedPillLabel(status: ActivityCompletedItem["status"]): string {
  switch (status) {
    case "no_coverage":
      return "暂无资源";
    case "partial":
      return "部分入库";
    case "failed":
      return "获取失败";
    case "retrying":
      return "重试中…";
    default:
      return "已入库";
  }
}

function CompletedRow({ item }: { item: ActivityCompletedItem }) {
  const ok = item.status === "complete" || item.status === "acquired" || item.status === "airing";
  const failed = item.status === "failed";
  return (
    <div className="act-row act-row-done">
      {poster(item.posterPath, item.title, ok ? "success" : "warn")}
      <div className="act-row-body act-row-inline">
        <strong>{item.title}</strong>
        {item.seasonLabel ? <span className="act-sub">{item.seasonLabel}</span> : null}
        <span className={`act-pill ${ok ? "tone-success" : "tone-warn"}`}>
          {ok ? <CheckCircle2 size={12} aria-hidden /> : <TriangleAlert size={12} aria-hidden />}
          {completedPillLabel(item.status)}
        </span>
        {item.sizeText ? <span className="act-sub">{item.sizeText}</span> : null}
        {failed ? <RetryButton runId={item.workflowRunId} title={item.title} /> : null}
      </div>
    </div>
  );
}

function RetryButton({ runId, title }: { runId: string; title: string }) {
  const [busy, setBusy] = useState(false);

  const retry = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/activity/retry", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId }),
      });
      const result = (await res.json()) as { status?: string };
      if (result.status !== "retried") {
        window.alert(`「${title}」无法重试（可能已在处理）。`);
      }
      // The next poll reconciles: the run re-appears in 排队中/获取中.
    } catch {
      window.alert("重试失败，请稍后再试。");
    } finally {
      // Always release the spinner — a "not_retriable" (or any non-error) response
      // must not leave the button stuck busy until a full page refresh.
      setBusy(false);
    }
  };

  if (busy) {
    return (
      <span className="act-cancel act-cancel-busy">
        <Loader2 size={14} className="act-spin" aria-hidden />
      </span>
    );
  }
  return (
    <button type="button" className="act-retry" aria-label={`重试获取 ${title}`} onClick={retry}>
      <RotateCcw size={13} aria-hidden /> 重试
    </button>
  );
}

function CancelButton({ runId, title }: { runId: string; title: string }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const cancel = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/activity/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId }),
      });
      const result = (await res.json()) as { status?: string };
      if (result.status !== "cancelled") {
        window.alert(`「${title}」已开始处理，无法取消。`);
      }
    } catch {
      window.alert("取消失败，请重试。");
    }
    // The next poll reconciles the list (removed if cancelled, or shown running).
  };

  if (busy) {
    return <span className="act-cancel act-cancel-busy"><Loader2 size={14} className="act-spin" aria-hidden /></span>;
  }
  if (confirming) {
    return (
      <span className="act-confirm">
        <button type="button" className="act-confirm-yes" onClick={cancel}>取消并移出</button>
        <button type="button" className="act-confirm-no" onClick={() => setConfirming(false)}>留着</button>
      </span>
    );
  }
  return (
    <button type="button" className="act-cancel" aria-label={`取消获取 ${title}`} onClick={() => setConfirming(true)}>
      <X size={15} aria-hidden />
    </button>
  );
}

function CollapsibleSection({
  title,
  count,
  note,
  defaultOpen,
  children,
}: {
  title: string;
  count: number;
  note?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen ?? true);
  return (
    <section className="act-section">
      <button type="button" className="act-section-head" onClick={() => setOpen((value) => !value)}>
        {open ? <ChevronDown size={15} aria-hidden /> : <ChevronRight size={15} aria-hidden />}
        {title} · {count}
        {note ? <span className="act-section-note">{note}</span> : null}
      </button>
      {open ? <div className="act-rows">{children}</div> : null}
    </section>
  );
}
