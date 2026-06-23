import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { collapseToRanges } from "../../lib/episode-ranges";
import {
  Bell,
  CalendarClock,
  CheckCircle2,
  CircleSlash,
  Clock3,
  DownloadCloud,
  Film,
  Layers,
  PartyPopper,
  RotateCcw,
  TriangleAlert,
  XCircle,
} from "lucide-react";
import type { NotificationEvent, NotificationReportStatus } from "@media-track/workflow";
import { landedSize } from "@media-track/workflow";
import { NotificationsSeenMarker } from "../../components/notifications-seen-marker";
import { DemoSessionNotifications } from "../../components/demo-session-notifications";
import { AppSidebar } from "../../components/app-sidebar";
import {
  ensureDemoSeeded,
  getCurrentAccountId,
  getWorkflowRepository,
  notificationWindowSince,
  resolveGlobalWorkspace,
} from "../../lib/workflow-runtime";

// The kind only drives the leading ICON now — its textual label used to render
// as a second badge next to the status pill ("开始追踪" beside "已完结"), which
// was redundant. The status pill is the single source of truth for state.
// TMDB's own CDN — same source the push notification uses; w154 is a crisp
// thumbnail for the feed card without shipping a self-hosted image.
const TMDB_FEED_POSTER = "https://image.tmdb.org/t/p/w154";

const kindIcon: Record<string, { tone: string; icon: typeof Bell }> = {
  series_initialized: { tone: "green", icon: Layers },
  package_initialized: { tone: "green", icon: Film },
  tracking_initialized: { tone: "indigo", icon: DownloadCloud },
  episodes_restored: { tone: "indigo", icon: DownloadCloud },
  tracking_completed: { tone: "green", icon: PartyPopper },
  already_current: { tone: "muted", icon: CheckCircle2 },
  no_coverage: { tone: "amber", icon: CircleSlash },
  foreign_work_detected: { tone: "amber", icon: Film },
};

const statusMeta: Record<NotificationReportStatus, { label: string; tone: string; icon: typeof Bell }> = {
  complete: { label: "已完结", tone: "green", icon: CheckCircle2 },
  acquired: { label: "已入库", tone: "green", icon: CheckCircle2 },
  airing: { label: "追更中", tone: "indigo", icon: Clock3 },
  partial: { label: "有缺集", tone: "amber", icon: TriangleAlert },
  no_coverage: { label: "暂无资源", tone: "amber", icon: CircleSlash },
  failed: { label: "获取失败", tone: "amber", icon: XCircle },
  retrying: { label: "重试中", tone: "indigo", icon: RotateCcw },
};

// `searchParams` (the active drive `?w`) is a dynamic input + a DB read; reading it
// inside a Suspense boundary lets the static app shell prerender instead of the
// whole route blocking on it (cacheComponents "blocking-route"). Mirrors page.tsx.
export default function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<{ w?: string }>;
}) {
  return (
    <Suspense fallback={<NotificationsShell />}>
      <NotificationsSurface searchParams={searchParams} />
    </Suspense>
  );
}

function NotificationsShell() {
  return (
    <div className="app-shell">
      <AppSidebar active="notifications" />
      <main className="main product-main" aria-busy="true" />
    </div>
  );
}

async function NotificationsSurface({ searchParams }: { searchParams: Promise<{ w?: string }> }) {
  const { w } = await searchParams;
  const workspace = await resolveGlobalWorkspace(w);
  return (
    <div className="app-shell">
      <AppSidebar active="notifications" basePath={workspace.basePath} activeStorageId={workspace.activeStorageId} />
      <main className="main product-main">
        <NotificationsSeenMarker />
        <div className="section-heading library-heading">
          <div>
            <h1>通知</h1>
            <p>每天的资源获取与追踪日报</p>
          </div>
        </div>
        <DemoSessionNotifications />
        <Suspense fallback={<FeedSkeleton />}>
          <NotificationFeed connectedStorageId={workspace.connectedStorageId} />
        </Suspense>
      </main>
    </div>
  );
}

async function NotificationFeed({ connectedStorageId }: { connectedStorageId: string | null }) {
  // SQLite reads + "today/yesterday" labels are request-time work; declare it
  // so the PPR shell stays static and this hole streams per request.
  await connection();
  const repository = getWorkflowRepository();
  const accountId = await getCurrentAccountId();
  await ensureDemoSeeded(repository);
  const notifications = await repository.listNotifications({
    limit: 100,
    accountId,
    connectedStorageId,
    // Only the last 7 days — old notifications shouldn't pile up forever.
    since: notificationWindowSince(),
  });

  // Poster backfill: older notifications predate report.posterPath. Source the
  // poster from the still-tracked title (by tmdbId, then name) so cards show a
  // real poster instead of nothing.
  const trackedStates = await repository.listTrackedSeasonStates({ accountId, connectedStorageId });
  const posterByTmdb = new Map<number, string>();
  const posterByName = new Map<string, string>();
  for (const state of trackedStates) {
    if (state.title.posterPath) {
      posterByTmdb.set(state.title.tmdbId, state.title.posterPath);
      posterByName.set(state.title.title, state.title.posterPath);
    }
  }
  const fallbackPoster = (report: { posterPath?: string | null; tmdbId?: number; titleName: string }): string | null =>
    report.posterPath ??
    (report.tmdbId != null ? posterByTmdb.get(report.tmdbId) : undefined) ??
    posterByName.get(report.titleName) ??
    null;

  if (notifications.length === 0) {
    return (
      <div className="quiet-state">
        <Bell size={24} aria-hidden />
        <strong>还没有任何记录</strong>
        <span>发起获取或等待例行检查后，这里会按日期展示结果。</span>
      </div>
    );
  }

  const days = buildDays(notifications);
  return (
    <section className="feed">
      {days.map((day) => (
        <section className="feed-day" key={day.dateKey}>
          <header className="feed-day-header">
            <span className="feed-day-label">{day.dayLabel}</span>
            <span className="feed-day-summary">{day.summary}</span>
          </header>
          <div className="feed-cards">
            {day.blocks.map((block) =>
              block.type === "routine" ? (
                <RoutineCard key={block.id} items={block.items} time={block.time} />
              ) : (
                <NotificationCard
                  key={block.id}
                  notification={block.notification}
                  fallbackPoster={
                    block.notification.report ? fallbackPoster(block.notification.report) : null
                  }
                />
              ),
            )}
          </div>
        </section>
      ))}
    </section>
  );
}

/** One acquisition/tracking event — its own separated card. */
function NotificationCard({
  notification,
  fallbackPoster = null,
}: {
  notification: NotificationEvent;
  fallbackPoster?: string | null;
}) {
  const icon = kindIcon[notification.kind] ?? { tone: "muted", icon: Bell };
  const KindIcon = icon.icon;
  const report = notification.report;

  // Legacy / report-less events (foreign work, old plain records).
  if (!report) {
    return (
      <article className="feed-card" data-created-at={notification.createdAt}>
        <div className="feed-card-head">
          <span className={`feed-icon tone-${icon.tone}`}>
            <KindIcon size={15} aria-hidden />
          </span>
          <strong className="feed-card-title">{notification.title}</strong>
          <time className="feed-time" dateTime={notification.createdAt}>
            {timeLabel(notification.createdAt)}
          </time>
        </div>
        <p className="feed-card-line">{notification.body}</p>
        {notification.kind === "foreign_work_detected" ? (
          <Link
            className="feed-action"
            href={`/foreign-work/${encodeURIComponent(notification.workflowRunId)}`}
          >
            去处理 →
          </Link>
        ) : null}
      </article>
    );
  }

  const status = statusMeta[report.status];
  const StatusIcon = status.icon;
  const heading = report.seasonLabel
    ? `${report.titleName} ${report.seasonLabel}`
    : report.year
      ? `${report.titleName} (${report.year})`
      : report.titleName;
  // A movie's only line is "已获取入库", which the "已入库" pill already conveys —
  // drop it so the card carries no duplicated sentence. Seasons keep their
  // informative progress line(s).
  const lines = report.status === "acquired" ? [] : report.lines;
  const size = landedSize(report);
  const hasChips = report.newlyObtained.length > 0 || report.realMissing.length > 0 || Boolean(size);
  // The same TMDB poster the push uses — a small thumbnail turns the row into a
  // proper media card (parity with the WeChat/Bark notification).
  const posterPath = report.posterPath ?? fallbackPoster;
  const posterUrl = posterPath ? `${TMDB_FEED_POSTER}${posterPath}` : null;

  return (
    <article className={`feed-card${posterUrl ? " has-poster" : ""}`} data-created-at={notification.createdAt}>
      {posterUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="feed-poster" src={posterUrl} alt="" loading="lazy" />
      ) : null}
      <div className="feed-card-body">
      <div className="feed-card-head">
        <span className={`feed-icon tone-${icon.tone}`}>
          <KindIcon size={15} aria-hidden />
        </span>
        <strong className="feed-card-title">{heading}</strong>
        <span className={`feed-status-pill tone-${status.tone}`}>
          <StatusIcon size={11} aria-hidden />
          {status.label}
        </span>
        <time className="feed-time" dateTime={notification.createdAt}>
          {timeLabel(notification.createdAt)}
        </time>
      </div>

      {lines.length > 0 ? (
        <div className="feed-card-lines">
          {lines.map((line) => (
            <p className="feed-card-line" key={line}>
              {line}
            </p>
          ))}
        </div>
      ) : null}

      {hasChips ? (
        <div className="feed-card-chips">
          <ChipGroup label="本次新增" codes={report.newlyObtained} variant="is-new" />
          <ChipGroup label="缺集" codes={report.realMissing} variant="is-missing" />
          {size ? (
            <span className="feed-chip-group">
              <span className="feed-chip-label">{size.label}</span>
              <span className="feed-chips">
                <span className="feed-chip">{size.value}</span>
              </span>
            </span>
          ) : null}
        </div>
      ) : null}
      </div>
    </article>
  );
}

function ChipGroup({ label, codes, variant }: { label: string; codes: string[]; variant: string }) {
  if (codes.length === 0) {
    return null;
  }
  // Collapse contiguous episodes into ranges so a 164-episode acquisition is a few
  // tokens (E01–E164 · E170 · E175–E178), not 164 chips that stretch the card.
  const ranges = collapseToRanges(codes);
  return (
    <span className="feed-chip-group">
      <span className="feed-chip-label">
        {label} {codes.length}
      </span>
      <span className="feed-chips">
        {ranges.map((range) => (
          <span className={`feed-chip ${variant}`} key={range}>
            {range}
          </span>
        ))}
      </span>
    </span>
  );
}

/**
 * A scheduled sweep that found nothing to do for a set of shows collapses into a
 * single quiet "例行巡检" card that NAMES each show it checked (rather than a
 * "其余 N 部" count), with the current state of each.
 */
function RoutineCard({ items, time }: { items: NotificationEvent[]; time: string }) {
  return (
    <article className="feed-card routine-card">
      <div className="feed-card-head">
        <span className="feed-icon tone-muted">
          <CalendarClock size={15} aria-hidden />
        </span>
        <strong className="feed-card-title">例行巡检</strong>
        <span className="feed-status-pill tone-muted">
          <CheckCircle2 size={11} aria-hidden />
          {items.length} 项已最新
        </span>
        <time className="feed-time" dateTime={time}>
          {timeLabel(time)}
        </time>
      </div>
      <ul className="routine-list">
        {items.map((item) => {
          const report = item.report;
          const heading = report
            ? report.seasonLabel
              ? `${report.titleName} ${report.seasonLabel}`
              : report.titleName
            : item.title;
          const line = report?.lines[0] ?? item.body;
          return (
            <li className="routine-item" key={item.id}>
              <span className="routine-name">{heading}</span>
              {line ? <span className="routine-line">{line}</span> : null}
            </li>
          );
        })}
      </ul>
    </article>
  );
}

type Block =
  | { type: "event"; id: string; time: string; notification: NotificationEvent }
  | { type: "routine"; id: string; time: string; items: NotificationEvent[] };

interface DayGroup {
  dateKey: string;
  dayLabel: string;
  summary: string;
  blocks: Block[];
}

/**
 * Turn the flat notification log into day sections of separated, strictly
 * time-ordered cards:
 *  - every acquisition/tracking event becomes its own card;
 *  - duplicate same-day events for the same (title · season · kind) collapse to
 *    the latest one (re-running a sweep shouldn't show 校园之外 twice);
 *  - routine "nothing changed" checks fold into a single 例行巡检 card.
 */
function buildDays(notifications: NotificationEvent[]): DayGroup[] {
  const sorted = [...notifications].sort((a, b) => compareDesc(a.createdAt, b.createdAt));
  const dayMap = new Map<string, NotificationEvent[]>();
  for (const notification of sorted) {
    const key = dateKey(notification.createdAt);
    const list = dayMap.get(key) ?? [];
    list.push(notification);
    dayMap.set(key, list);
  }

  return [...dayMap.entries()].map(([key, items]) => {
    const routineRaw = items.filter((item) => item.kind === "already_current");
    const eventsRaw = items.filter((item) => item.kind !== "already_current");

    // One card per show per day: the latest milestone wins regardless of kind,
    // so "开始追踪" in the morning and "追踪完成" at night don't both show — only
    // the freshest state of 校园之外 survives.
    const blocks: Block[] = [];
    const eventSubjects = new Set<string>();
    for (const notification of eventsRaw) {
      const subject = subjectKey(notification);
      if (eventSubjects.has(subject)) continue; // sorted desc → first seen is latest
      eventSubjects.add(subject);
      blocks.push({ type: "event", id: notification.id, time: notification.createdAt, notification });
    }

    // Routine checks only cover shows that didn't already get an event card today
    // (no point listing 抽烟 in 例行巡检 when its own card already states its state).
    const seenRoutine = new Set<string>();
    const routineItems: NotificationEvent[] = [];
    for (const notification of routineRaw) {
      const subject = subjectKey(notification);
      if (eventSubjects.has(subject) || seenRoutine.has(subject)) continue;
      seenRoutine.add(subject);
      routineItems.push(notification);
    }
    if (routineItems.length > 0) {
      blocks.push({ type: "routine", id: `routine_${key}`, time: routineItems[0]!.createdAt, items: routineItems });
    }

    blocks.sort((a, b) => compareDesc(a.time, b.time));
    return {
      dateKey: key,
      dayLabel: dayLabel(key),
      summary: daySummary(blocks),
      blocks,
    };
  });
}

/** Identity of the show a notification is about — kind-independent, so all of a
 *  day's events for one season collapse to its latest milestone. */
function subjectKey(notification: NotificationEvent): string {
  const name = notification.report?.titleName ?? notification.title;
  const season = notification.report?.seasonLabel ?? "";
  return `${name}|${season}`;
}

function compareDesc(a: string, b: string): number {
  return a < b ? 1 : a > b ? -1 : 0;
}

function dateKey(iso: string): string {
  return new Date(iso).toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
}

function dayLabel(key: string): string {
  const today = dateKey(new Date().toISOString());
  const yesterday = dateKey(new Date(Date.now() - 86_400_000).toISOString());
  if (key === today) return "今天";
  if (key === yesterday) return "昨天";
  const [year, month, day] = key.split("-");
  const thisYear = today.split("-")[0];
  return year === thisYear ? `${Number(month)}月${Number(day)}日` : `${year}年${Number(month)}月${Number(day)}日`;
}

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function daySummary(blocks: Block[]): string {
  const eventBlocks = blocks.filter((block): block is Extract<Block, { type: "event" }> => block.type === "event");
  const newly = eventBlocks.reduce((sum, block) => sum + (block.notification.report?.newlyObtained.length ?? 0), 0);
  const noCoverage = eventBlocks.filter((block) => block.notification.kind === "no_coverage").length;
  const routine = blocks.find((block): block is Extract<Block, { type: "routine" }> => block.type === "routine");

  const parts: string[] = [`${eventBlocks.length} 项更新`];
  if (newly > 0) parts.push(`${newly} 集新增`);
  if (noCoverage > 0) parts.push(`${noCoverage} 项暂无资源`);
  if (routine) parts.push(`巡检 ${routine.items.length} 部`);
  return parts.join(" · ");
}

function FeedSkeleton() {
  return (
    <section className="feed">
      <div className="skeleton skeleton-heading" />
      <div className="skeleton skeleton-feed-card" />
      <div className="skeleton skeleton-feed-card" />
      <div className="skeleton skeleton-feed-card" />
    </section>
  );
}
