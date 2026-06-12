import Link from "next/link";
import { Suspense } from "react";
import {
  Bell,
  CheckCircle2,
  Clock3,
  DownloadCloud,
  Film,
  FolderOpen,
  Library,
  Search,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { RequestSeriesButton } from "../components/request-series-button";
import { RequestTrackButton } from "../components/request-track-button";
import { getLibraryDashboard, getSearchView } from "../lib/search-page";
import type { SearchCandidateCard } from "@media-track/workflow";

const displayLabels = {
  obtained: "已获取",
  provider_ahead: "超前",
  missing_aired: "缺集",
  unaired: "未播",
  unknown: "未知",
} as const;

const episodeTone = {
  obtained: "episode-cell obtained",
  provider_ahead: "episode-cell provider-ahead",
  missing_aired: "episode-cell missing-aired",
  unaired: "episode-cell unaired",
  unknown: "episode-cell unknown",
} as const;

export default async function Page({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = (await searchParams) ?? {};
  const query = stringParam(params.q);
  const activeTab = stringParam(params.tab) === "library" ? "library" : "search";

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <Film size={18} aria-hidden />
          </span>
          <span className="brand-copy">
            <strong>Media Track</strong>
            <span>115 library ops</span>
          </span>
        </div>

        <nav aria-label="主导航">
          <ul className="nav-list">
            <li>
              <Link className={`nav-item ${activeTab === "search" ? "is-active" : ""}`} href={`/?tab=search&q=${encodeURIComponent(query)}`}>
                <Search size={16} aria-hidden />
                搜索
              </Link>
            </li>
            <li>
              <Link className={`nav-item ${activeTab === "library" ? "is-active" : ""}`} href="/?tab=library">
                <Library size={16} aria-hidden />
                媒体库
              </Link>
            </li>
          </ul>
        </nav>

        <div className="sidebar-footer">
          <div className="health-card">
            <span className="health-icon">
              <ShieldCheck size={16} aria-hidden />
            </span>
            <span>
              <strong>115 已连接</strong>
              <span>最近验证 2 分钟前</span>
            </span>
          </div>
        </div>
      </aside>

      <main className="main product-main">
        <div className="product-tabs" role="tablist" aria-label="媒体工作区">
          <Link className={activeTab === "search" ? "is-active" : ""} href={`/?tab=search&q=${encodeURIComponent(query)}`}>
            搜索获取
          </Link>
          <Link className={activeTab === "library" ? "is-active" : ""} href="/?tab=library">
            我的媒体库
          </Link>
        </div>

        {activeTab === "search" ? (
          <Suspense key={`search-${query}`} fallback={<SearchSurfaceSkeleton query={query} />}>
            <SearchSurface query={query} />
          </Suspense>
        ) : (
          <Suspense fallback={<LibrarySurfaceSkeleton />}>
            <LibrarySurface />
          </Suspense>
        )}
      </main>
    </div>
  );
}

async function SearchSurface({ query }: { query: string }) {
  const searchView = await getSearchView(query);

  return (
    <section className="search-surface">
      <div className="search-hero">
        <div>
          <h1>搜索</h1>
          <p>找到目标后发起获取，后台会处理资源判断、转存和验证。</p>
        </div>
        <form className="search-form" action="/" role="search">
          <input type="hidden" name="tab" value="search" />
          <label className="search-box search-box-large">
            <Search size={18} aria-hidden />
            <input name="q" aria-label="搜索媒体" placeholder="片名 / 剧名" defaultValue={query} />
          </label>
          <button className="primary-button" type="submit">
            <Search size={16} aria-hidden />
            搜索
          </button>
        </form>
      </div>

      {searchView.state === "empty" ? (
        <div className="quiet-state">
          <Search size={24} aria-hidden />
          <strong>输入目标名称</strong>
          <span>搜索后才会请求元数据。</span>
        </div>
      ) : (
        <section className="search-results" aria-label="搜索结果">
          <div className="section-heading">
            <div>
              <h2>结果</h2>
              <p>
                {searchView.candidates.length} 个候选
                {searchView.cacheStatus === "hit" ? "，来自缓存" : ""}
              </p>
            </div>
          </div>
          {searchView.candidates.length > 0 ? (
            <div className="candidate-grid">
              {searchView.candidates.map((candidate) => (
                <CandidateCard candidate={candidate} key={candidate.id} />
              ))}
            </div>
          ) : (
            <div className="quiet-state compact">
              <TriangleAlert size={22} aria-hidden />
              <strong>没有匹配结果</strong>
              <span>{searchView.query}</span>
            </div>
          )}
        </section>
      )}
    </section>
  );
}

function CandidateCard({ candidate }: { candidate: SearchCandidateCard }) {
  return (
    <article className="candidate-card">
      <div className="candidate-poster" aria-hidden>
        <span>{candidate.title.slice(0, 4)}</span>
      </div>
      <div className="candidate-body">
        <div className="candidate-title-row">
          <div>
            <h3>
              <Link href={`/show/${candidate.tmdbId}/${candidate.selectedSeasonNumber ?? 1}`}>
                {candidate.title}
              </Link>
            </h3>
            <p>
              {candidate.year} · {candidate.mediaType === "tv" ? `第 ${candidate.selectedSeasonNumber} 季` : "电影"}
            </p>
          </div>
          <div className="candidate-actions">
            <RequestTrackButton
              candidateId={candidate.id}
              actionState={candidate.action.state}
              disabled={candidate.action.disabled}
              label={candidate.action.label}
            />
            {candidate.mediaType === "tv" ? <RequestSeriesButton candidateId={candidate.id} /> : null}
          </div>
        </div>
        <p className="candidate-overview">{candidate.overview}</p>
        <div className="candidate-meta">
          {candidate.totalEpisodes ? <span>{candidate.totalEpisodes} 集</span> : null}
          {candidate.latestAiredEpisode ? <span>已播 {candidate.latestAiredEpisode}</span> : null}
          <span>TMDB {candidate.tmdbId}</span>
        </div>
      </div>
    </article>
  );
}

async function LibrarySurface() {
  const dashboard = await getLibraryDashboard();
  const tracked = dashboard.trackedSeason;
  const seasonCode = `S${String(tracked.seasonNumber).padStart(2, "0")}`;
  const obtainedPercent = Math.round((tracked.obtainedCount / tracked.totalEpisodes) * 100);
  const airedPercent = Math.round((tracked.latestAiredEpisode / tracked.totalEpisodes) * 100);
  const missingEpisodes = tracked.episodes
    .filter((episode) => episode.displayState === "missing_aired")
    .map((episode) => episodeLabel(episode.episodeCode, seasonCode));
  const unavailableCount = tracked.totalEpisodes - tracked.latestAiredEpisode;

  return (
    <section className="library-surface">
      <div className="section-heading library-heading">
        <div>
          <h1>我的媒体库</h1>
          <p>{tracked.title} 正在自动追踪</p>
        </div>
      </div>

      <section className="overview-grid" aria-label={`${tracked.title} 工作台`}>
        <article className="title-stage">
          <div className="poster-tile" aria-hidden>
            <span>{tracked.title}</span>
            <small>S{String(tracked.seasonNumber).padStart(2, "0")}</small>
          </div>

          <div className="stage-content">
            <div className="stage-kicker">
              <span className="live-dot" />
              正在追踪
            </div>
            <h2>
              {tracked.title} 第 {tracked.seasonNumber} 季
            </h2>
            <div className="stage-meta">
              <span>4K</span>
              <span>TMDB 已播 {tracked.latestAiredEpisode}</span>
              <span>总集数 {tracked.totalEpisodes}</span>
            </div>

            <div className="season-progress" aria-label={`已获取 ${obtainedPercent}%`}>
              <div className="progress-track">
                <span className="aired-track" style={{ width: `${airedPercent}%` }} />
                <span className="obtained-track" style={{ width: `${obtainedPercent}%` }} />
              </div>
              <div className="progress-copy">
                <span>{tracked.obtainedCount} 集可看</span>
                <span>{missingEpisodes.length ? `${missingEpisodes.join("、")} 缺失` : "无缺集"}</span>
              </div>
            </div>
          </div>
        </article>

        <div className="metric-strip">
          <MetricTile icon={CheckCircle2} label="已获取" value={tracked.obtainedCount} tone="green" />
          <MetricTile icon={TriangleAlert} label="已播缺集" value={tracked.missingAiredCount} tone="coral" />
          <MetricTile icon={Clock3} label="未播出" value={unavailableCount} tone="amber" />
          <MetricTile icon={DownloadCloud} label="资源超前" value={tracked.providerAheadEpisodes.length} tone="blue" />
        </div>
      </section>

      <section className="dashboard-grid">
        <article className="panel episode-panel">
          <div className="panel-header">
            <div>
              <h2 className="panel-title">集数状态</h2>
              <p className="panel-note">
                {seasonCode}E01 至 {seasonCode}E{String(tracked.totalEpisodes).padStart(2, "0")}
              </p>
            </div>
            <div className="legend-row" aria-label="状态图例">
              <span className="legend-item obtained">已获取</span>
              <span className="legend-item missing">缺集</span>
              <span className="legend-item unaired">未播</span>
            </div>
          </div>

          <div className="episode-grid" aria-label={`${tracked.title} episode status`}>
            {tracked.episodes.map((episode) => (
              <div className={episodeTone[episode.displayState]} key={episode.episodeCode}>
                <strong>{episodeLabel(episode.episodeCode, seasonCode)}</strong>
                <span>{displayLabels[episode.displayState]}</span>
              </div>
            ))}
          </div>
        </article>

        <aside className="side-stack">
          <section className="panel notice-panel">
            <div className="panel-header">
              <div>
                <h2 className="panel-title">通知</h2>
                <p className="panel-note">最近的工作流结果</p>
              </div>
              <Bell size={18} aria-hidden />
            </div>
            <ul className="event-list">
              {dashboard.events.map((event, index) => (
                <li className="event-item" key={event.title}>
                  <span className={`event-icon tone-${index}`}>
                    {index === 1 ? (
                      <TriangleAlert size={15} aria-hidden />
                    ) : index === 2 ? (
                      <ShieldCheck size={15} aria-hidden />
                    ) : (
                      <CheckCircle2 size={15} aria-hidden />
                    )}
                  </span>
                  <span>
                    <span className="event-title">{event.title}</span>
                    <span className="event-body">{event.body}</span>
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section className="panel ops-panel">
            <div className="panel-header">
              <div>
                <h2 className="panel-title">目标目录</h2>
                <p className="panel-note">Season {String(tracked.seasonNumber).padStart(2, "0")}</p>
              </div>
              <FolderOpen size={18} aria-hidden />
            </div>
            <div className="ops-body">
              <div className="ops-line">
                <span className="ops-icon">
                  <FolderOpen size={16} aria-hidden />
                </span>
                <span>
                  <strong>{tracked.title}/Season {String(tracked.seasonNumber).padStart(2, "0")}</strong>
                  <small>目标目录保持扁平化</small>
                </span>
              </div>
            </div>
          </section>
        </aside>
      </section>
    </section>
  );
}

function SearchSurfaceSkeleton({ query }: { query: string }) {
  return (
    <section className="search-surface">
      <div className="search-hero">
        <div>
          <h1>搜索</h1>
          <p>正在准备搜索界面。</p>
        </div>
        <div className="search-form">
          <div className="skeleton skeleton-input">{query || "片名 / 剧名"}</div>
          <div className="skeleton skeleton-button" />
        </div>
      </div>
      <div className="candidate-grid">
        <div className="skeleton-card" />
        <div className="skeleton-card" />
      </div>
    </section>
  );
}

function LibrarySurfaceSkeleton() {
  return (
    <section className="library-surface">
      <div className="skeleton skeleton-heading" />
      <div className="overview-grid">
        <div className="skeleton skeleton-stage" />
        <div className="metric-strip">
          <div className="skeleton skeleton-metric" />
          <div className="skeleton skeleton-metric" />
          <div className="skeleton skeleton-metric" />
          <div className="skeleton skeleton-metric" />
        </div>
      </div>
    </section>
  );
}

function episodeLabel(episodeCode: string, seasonCode: string) {
  return episodeCode.startsWith(seasonCode) ? episodeCode.slice(seasonCode.length) : episodeCode;
}

function MetricTile({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: typeof CheckCircle2;
  label: string;
  value: number;
  tone: "green" | "coral" | "amber" | "blue";
}) {
  return (
    <div className={`metric-tile tone-${tone}`}>
      <span className="metric-icon">
        <Icon size={18} aria-hidden />
      </span>
      <span>
        <span className="metric-label">{label}</span>
        <strong className="metric-value">{value}</strong>
      </span>
    </div>
  );
}

function stringParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}
