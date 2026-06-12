import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { ArrowLeft, Bell, CheckCircle2, CircleSlash, DownloadCloud, Layers, ShieldCheck } from "lucide-react";
import type { NotificationEvent } from "@media-track/workflow";
import { ensureDemoSeeded, getWorkflowRepository } from "../../lib/workflow-runtime";

const kindMeta: Record<string, { label: string; tone: string; icon: typeof Bell }> = {
  tracking_initialized: { label: "开始追踪", tone: "green", icon: CheckCircle2 },
  series_initialized: { label: "全剧入库", tone: "green", icon: Layers },
  package_initialized: { label: "资源包入库", tone: "green", icon: Layers },
  episodes_restored: { label: "缺集修复", tone: "blue", icon: DownloadCloud },
  already_current: { label: "已是最新", tone: "muted", icon: ShieldCheck },
  no_coverage: { label: "暂无资源", tone: "amber", icon: CircleSlash },
};

export default function NotificationsPage() {
  return (
    <div className="app-shell">
      <main className="main product-main">
        <Link className="nav-item" href="/" style={{ display: "inline-flex", marginBottom: 16 }}>
          <ArrowLeft size={16} aria-hidden />
          返回
        </Link>
        <div className="section-heading library-heading">
          <div>
            <h1>通知</h1>
            <p>每天的资源获取与追踪日报</p>
          </div>
        </div>
        <Suspense fallback={<FeedSkeleton />}>
          <NotificationFeed />
        </Suspense>
      </main>
    </div>
  );
}

async function NotificationFeed() {
  // SQLite reads + "today/yesterday" labels are request-time work; declare it
  // so the PPR shell stays static and this hole streams per request.
  await connection();
  const repository = getWorkflowRepository();
  await ensureDemoSeeded(repository);
  const notifications = await repository.listNotifications({ limit: 100 });

  if (notifications.length === 0) {
    return (
      <div className="quiet-state">
        <Bell size={24} aria-hidden />
        <strong>还没有任何记录</strong>
        <span>发起获取或等待 Type 3 例行检查后，这里会按日期展示结果。</span>
      </div>
    );
  }

  const groups = groupByDay(notifications);
  return (
    <section className="feed">
      {groups.map((group) => (
        <section className="feed-day" key={group.dateKey}>
          <header className="feed-day-header">
            <span className="feed-day-label">{group.dayLabel}</span>
            <span className="feed-day-summary">{daySummary(group.items)}</span>
          </header>
          <ul className="feed-list">
            {group.items.map((item) => {
              const meta = kindMeta[item.kind] ?? { label: item.kind, tone: "muted", icon: Bell };
              const Icon = meta.icon;
              return (
                <li className="feed-item" key={item.id}>
                  <span className={`feed-icon tone-${meta.tone}`}>
                    <Icon size={15} aria-hidden />
                  </span>
                  <span className="feed-body">
                    <span className="feed-title-row">
                      <strong>{item.title}</strong>
                      <span className={`feed-badge tone-${meta.tone}`}>{meta.label}</span>
                    </span>
                    <span className="feed-text">{item.body}</span>
                  </span>
                  <time className="feed-time" dateTime={item.createdAt}>
                    {timeLabel(item.createdAt)}
                  </time>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </section>
  );
}

function groupByDay(notifications: NotificationEvent[]) {
  const groups = new Map<string, NotificationEvent[]>();
  for (const notification of notifications) {
    const key = dateKey(notification.createdAt);
    const list = groups.get(key) ?? [];
    list.push(notification);
    groups.set(key, list);
  }
  return [...groups.entries()].map(([key, items]) => ({
    dateKey: key,
    dayLabel: dayLabel(key),
    items,
  }));
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

function daySummary(items: NotificationEvent[]): string {
  const obtained = items
    .map((item) => /(\d+) episodes (obtained|restored)/.exec(item.body)?.[1])
    .filter((value): value is string => value !== undefined)
    .reduce((sum, value) => sum + Number(value), 0);
  const noCoverage = items.filter((item) => item.kind === "no_coverage").length;
  const parts = [`${items.length} 条记录`];
  if (obtained > 0) parts.push(`${obtained} 集入库`);
  if (noCoverage > 0) parts.push(`${noCoverage} 项暂无资源`);
  return parts.join(" · ");
}

function FeedSkeleton() {
  return (
    <section className="feed">
      <div className="skeleton skeleton-heading" />
      <div className="skeleton skeleton-metric" />
      <div className="skeleton skeleton-metric" />
      <div className="skeleton skeleton-metric" />
    </section>
  );
}
