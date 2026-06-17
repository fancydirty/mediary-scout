"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { CheckCircle2, ChevronDown, ChevronRight, Clock3, Loader2, TriangleAlert, X } from "lucide-react";
import type { ActivityActiveRun, ActivityCompletedItem, ActivityView } from "../lib/activity-view";

const POLL_MS = 2600;
const POSTER = "https://image.tmdb.org/t/p/w154";

export function ActivityFeed() {
  // since is fixed at mount → 已完成 is session-scoped (a fresh open sees none).
  const since = useRef<string | null>(null);
  const [view, setView] = useState<ActivityView>({ active: [], justCompleted: [] });

  useEffect(() => {
    if (since.current === null) {
      since.current = new Date().toISOString();
    }
    let alive = true;
    const poll = async () => {
      try {
        const res = await fetch(`/api/activity?since=${encodeURIComponent(since.current!)}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as ActivityView;
        if (alive) setView(data);
      } catch {
        // transient — keep the last view, retry next tick
      }
    };
    poll(); // immediate first load (the page renders this client component in the static shell)
    const id = setInterval(poll, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const running = view.active.filter((run) => run.status === "running");
  const queued = view.active
    .filter((run) => run.status === "queued")
    .sort((a, b) => (a.queuePosition ?? 0) - (b.queuePosition ?? 0));

  return (
    <div className="activity">
      <section className="act-section">
        <div className="act-section-head act-section-head-static">获取中</div>
        {running.length === 0 ? (
          <p className="act-empty">当前没有正在处理的任务。</p>
        ) : (
          running.map((run) => <RunningRow run={run} key={run.runId} />)
        )}
      </section>

      <CollapsibleSection title="排队中" count={queued.length} defaultOpen>
        {queued.length === 0 ? (
          <p className="act-empty">没有排队的任务。</p>
        ) : (
          queued.map((run) => <QueuedRow run={run} key={run.runId} />)
        )}
      </CollapsibleSection>

      <CollapsibleSection title="已完成" count={view.justCompleted.length} note="仅本次浏览" defaultOpen>
        {view.justCompleted.length === 0 ? (
          <p className="act-empty">本次浏览还没有完成的任务，历史可在通知查看。</p>
        ) : (
          view.justCompleted.map((item) => <CompletedRow item={item} key={item.workflowRunId} />)
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

function RunningRow({ run }: { run: ActivityActiveRun }) {
  const percent = Math.max(3, Math.min(100, run.progress?.percent ?? 3));
  const headline =
    run.progress?.needed && run.progress.needed > 0
      ? `已确认 ${run.progress.obtained ?? 0} / ${run.progress.needed} 集`
      : null;
  return (
    <Link className="act-row act-row-active" href={`/show/${run.tmdbId}?from=library`}>
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
  const [stack, setStack] = useState<string[]>([text]);
  const [shift, setShift] = useState(false);
  const prev = useRef(text);

  useEffect(() => {
    if (text === prev.current) {
      return;
    }
    const previous = prev.current;
    prev.current = text;
    setStack([previous, text]);
    setShift(false);
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setShift(true)));
    const timer = setTimeout(() => {
      setStack([text]);
      setShift(false);
    }, 360);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  }, [text]);

  return (
    <div className="act-ticker" aria-live="polite">
      <div className="act-ticker-track" style={{ transform: shift ? "translateY(-1.45em)" : "translateY(0)" }}>
        {stack.map((line, index) => (
          <div className="act-ticker-line" key={`${index}-${line}`}>
            {line}
          </div>
        ))}
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

function CompletedRow({ item }: { item: ActivityCompletedItem }) {
  const ok = item.status === "complete" || item.status === "acquired" || item.status === "airing";
  return (
    <div className="act-row act-row-done">
      {poster(item.posterPath, item.title, ok ? "success" : "warn")}
      <div className="act-row-body act-row-inline">
        <strong>{item.title}</strong>
        {item.seasonLabel ? <span className="act-sub">{item.seasonLabel}</span> : null}
        <span className={`act-pill ${ok ? "tone-success" : "tone-warn"}`}>
          {ok ? <CheckCircle2 size={12} aria-hidden /> : <TriangleAlert size={12} aria-hidden />}
          {item.status === "no_coverage" ? "暂无资源" : item.status === "partial" ? "部分入库" : "已入库"}
        </span>
        {item.sizeText ? <span className="act-sub">{item.sizeText}</span> : null}
      </div>
    </div>
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
