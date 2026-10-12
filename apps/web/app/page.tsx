import Link from "next/link";
import { Suspense } from "react";
import { Library, TriangleAlert } from "lucide-react";
import { AcquiringPoller } from "../components/acquiring-poller";
import { AppSidebar } from "../components/app-sidebar";
import { RequestTrackButton } from "../components/request-track-button";
import { AcquireProgressBadge } from "../components/acquire-progress-badge";
import { DemoSessionLibrary } from "../components/demo-session-library";
import { LibraryQuickFind } from "../components/library-quick-find";
import { RememberQuery } from "../components/search-memory";
import { SearchForm } from "../components/search-form";
import { SeasonRequestMenu } from "../components/season-request-menu";
import { TrendingRow } from "../components/trending-row";
import { ConnectNoticeBanner } from "../components/connect-notice-banner";
import { GitHubNameplate } from "../components/github-nameplate";
import type { TrendingKind } from "../lib/trending";
import { getSearchView } from "../lib/search-page";
import { getInProgressTitles, getLibraryWall } from "../lib/title-hub";
import {
  ensureDemoSeeded,
  getActiveWorkspaceScope,
  getRegisteredDriveCount,
  getWorkflowRepository,
} from "../lib/workflow-runtime";
import { resolveConnectNoticeConditions } from "../lib/connect-notice-server";
import { shouldShowConnectNotice } from "../lib/connect-notice";
import { showHref } from "@media-track/workflow";
import type { SearchCandidateCard, TrackedSeasonState } from "@media-track/workflow";

/** Workspace base path: "/" is the account's primary drive, "/w/<id>" a
 *  specific drive. Library links must route within the current workspace —
 *  hardcoding "/" silently jumps to the primary drive from any other drive. */
function workspaceBasePath(storageId?: string): string {
  return storageId ? `/w/${storageId}` : "/";
}

export default function Page({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <HomeView searchParams={searchParams} />;
}

/**
 * Shared home surface for both the root route (storageId undefined → the
 * account's primary drive) and the /w/<storageId> workspace route (a specific
 * drive). The library + search awareness are scoped to that workspace.
 */
export function HomeView({
  searchParams,
  storageId,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>> | undefined;
  storageId?: string | undefined;
}) {
  // searchParams is a dynamic input. Reading it inside a Suspense boundary lets
  // the static app shell prerender instead of the whole route blocking on it —
  // this is what silences the cacheComponents "blocking-route" warning. The await
  // resolves from the request URL (no I/O), so the fallback is effectively instant.
  return (
    <Suspense fallback={<HomeShell />}>
      <HomeSurface searchParams={searchParams} storageId={storageId} />
    </Suspense>
  );
}

function HomeShell() {
  return (
    <div className="app-shell">
      <AppSidebar active="search" />
      <main className="main product-main" aria-busy="true" />
    </div>
  );
}

async function HomeSurface({
  searchParams,
  storageId,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>> | undefined;
  storageId?: string | undefined;
}) {
  const params = (await searchParams) ?? {};
  const query = stringParam(params.q);
  const activeTab = stringParam(params.tab) === "library" ? "library" : "search";
  const mediaType = stringParam(params.type) || "all";
  const filter = stringParam(params.filter) || "all";
  const trendingParam = stringParam(params.trending);
  const activeTrending: TrendingKind =
    trendingParam === "tv" ? "tv" : trendingParam === "anime" ? "anime" : "movie";
  // Tree model: keep searches inside the ACTIVE workspace so an acquisition lands
  // on the drive you're viewing — not silently on the primary drive. Root route
  // (no storageId) posts to "/" as before.
  const basePath = workspaceBasePath(storageId);
  const driveCount = await getRegisteredDriveCount();

  // Connect notice: only on the root home page (no storageId), only on search tab
  const connectConditions = await resolveConnectNoticeConditions();
  const showConnectNotice =
    !storageId && activeTab === "search" && shouldShowConnectNotice(connectConditions);

  return (
    <div className="app-shell">
      <AppSidebar active={activeTab} searchQuery={query} basePath={basePath} activeStorageId={storageId} />

      <main className="main product-main">
        {showConnectNotice ? (
          <ConnectNoticeBanner hasTunnelToken={connectConditions.hasTunnelToken} />
        ) : null}
        {activeTab === "search" ? (
          <section className="search-surface">
            <RememberQuery query={query} basePath={basePath} />
            <div className="search-hero">
              <div>
                <h1>搜索</h1>
                <p>找到目标后发起获取，后台会处理资源判断、转存和验证。</p>
              </div>
              <SearchForm basePath={basePath} defaultQuery={query} />
            </div>
            {driveCount >= 2 ? (
              <p className="panel-note" style={{ marginTop: -4, marginBottom: 4 }}>
                搜索与获取按网盘隔离 —— 想为某块盘获取资源，请切到该盘后在它的搜索页操作。
              </p>
            ) : null}
            <Suspense key={`search-${query}`} fallback={<SearchResultsSkeleton />}>
              <SearchResults
                query={query}
                storageId={storageId}
                activeTrending={activeTrending}
                basePath={basePath}
              />
            </Suspense>
          </section>
        ) : (
          <>
            <DemoSessionLibrary />
            <Suspense fallback={<LibrarySurfaceSkeleton />}>
              <LibrarySurface mediaType={mediaType} filter={filter} storageId={storageId} />
            </Suspense>
          </>
        )}
        <GitHubNameplate />
      </main>
    </div>
  );
}

async function SearchResults({
  query,
  storageId,
  activeTrending,
  basePath,
}: {
  query: string;
  storageId?: string | undefined;
  activeTrending: TrendingKind;
  basePath: string;
}) {
  const searchView = await getSearchView(query, storageId);
  // Library awareness on results: a tracked title shows WHICH seasons are
  // obtained and routes to the same title page as the library — search must
  // anticipate re-searching something already obtained. Scoped to the active
  // workspace (drive), so "已获取" reflects THIS drive.
  const repository = getWorkflowRepository();
  await ensureDemoSeeded(repository);
  const scope = await getActiveWorkspaceScope(storageId);
  const trackedByTmdbId = new Map<number, TrackedSeasonState[]>();
  for (const state of await repository.listTrackedSeasonStates(scope)) {
    // Season-awareness covers anything tracked with seasons — TV AND anime
    // (anime is a TV-shaped title routed to its own library). Only movies, which
    // have no season menu, are excluded. (Was `!== "tv"`, which wrongly hid every
    // acquired anime's tracked state on the search card.)
    if (state.title.type === "movie") {
      continue;
    }
    const list = trackedByTmdbId.get(state.title.tmdbId) ?? [];
    list.push(state);
    trackedByTmdbId.set(state.title.tmdbId, list);
  }

  // Search results auto-update like the library: while ANY acquisition is in
  // flight, mount the poller so the card flips 已请求 → 已获取 the moment the run
  // finishes, with no manual refresh. (Previously only the library mounted it,
  // so a result acquired from search stayed stuck on 已请求.)
  const inProgress = await getInProgressTitles(storageId);
  const inProgressIds = new Set(inProgress.map((title) => title.tmdbId));

  return (
    <>
      {inProgress.length > 0 ? <AcquiringPoller /> : null}
      {searchView.state === "empty" ? (
        <TrendingRow activeKind={activeTrending} basePath={basePath} />
      ) : searchView.state === "provider_error" ? (
        // Every TMDB access (direct + proxy) is unreachable from this deployment —
        // a GFW-blocked network without a proxy (issue #134). Degrade with
        // actionable guidance instead of letting the server component 500.
        <section className="search-results" aria-label="搜索结果">
          <div className="quiet-state compact" role="alert">
            <TriangleAlert size={22} aria-hidden />
            <strong>搜索暂时不可用：连不上元数据服务（TMDB）</strong>
            <span>
              当前部署环境连不上 TMDB，内置代理也不通。国内网络未配置代理时常见——
              给部署主机（或容器）配置可访问外网的代理后重试。
            </span>
            {/* Deliberately a full-reload <a>, not <Link>: retry must re-run the
                server render (re-probe TMDB). A client-side navigation to the
                SAME URL can be served from the router cache as a no-op. */}
            <a className="primary-button" href={`${basePath}?q=${encodeURIComponent(searchView.query)}`}>
              重试
            </a>
            {searchView.providerError ? (
              <span className="panel-note">{searchView.providerError}</span>
            ) : null}
          </div>
        </section>
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
                <CandidateCard
                  candidate={candidate}
                  acquiring={inProgressIds.has(candidate.tmdbId)}
                  trackedLabel={
                    // The per-season summary ("第 N 季已获取/追更中") is a TV concept.
                    // A movie has no seasons — let it fall through to its own
                    // 已获取/已追踪 action label instead of an invented "第 1 季".
                    candidate.mediaType === "tv"
                      ? trackedSummaryLabel(
                          trackedByTmdbId.get(candidate.tmdbId) ?? [],
                          candidate.seasonNumbers.length,
                        )
                      : null
                  }
                  trackedSeasonNumbers={(trackedByTmdbId.get(candidate.tmdbId) ?? []).map(
                    (state) => state.season.seasonNumber,
                  )}
                  storageId={storageId}
                  key={`${candidate.mediaType}_${candidate.tmdbId}`}
                />
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
    </>
  );
}

/**
 * Concrete library awareness for a result card: not just "tracked", but
 * WHICH seasons are obtained / airing / missing.
 */
function trackedSummaryLabel(states: TrackedSeasonState[], totalSeasonCount: number): string | null {
  if (states.length === 0) {
    return null;
  }
  const seasonNumber = (state: TrackedSeasonState) => state.season.seasonNumber;
  const obtainedCount = (state: TrackedSeasonState) =>
    state.episodes.filter((episode) => episode.obtained).length;
  const complete = states
    .filter(
      (state) =>
        state.season.status === "completed" && obtainedCount(state) >= state.season.totalEpisodes,
    )
    .map(seasonNumber)
    .sort((a, b) => a - b);
  const active = states
    .filter((state) => state.season.status === "active")
    .map(seasonNumber)
    .sort((a, b) => a - b);
  if (totalSeasonCount > 0 && complete.length === totalSeasonCount) {
    return `全 ${totalSeasonCount} 季已获取`;
  }
  const parts: string[] = [];
  if (complete.length > 0) {
    parts.push(`第 ${complete.join("、")} 季已获取`);
  }
  if (active.length > 0) {
    parts.push(`第 ${active.join("、")} 季追更中`);
  }
  const rest = states.length - complete.length - active.length;
  if (rest > 0) {
    parts.push(`${rest} 季有缺集`);
  }
  return parts.join(" · ") || "已追踪";
}

function CandidateCard({
  candidate,
  acquiring,
  trackedLabel,
  trackedSeasonNumbers,
  storageId,
}: {
  candidate: SearchCandidateCard;
  /** This title has a queued/running acquisition — show 获取中, not its
   *  (possibly "有缺集") tracked snapshot, which is misleading mid-acquisition. */
  acquiring: boolean;
  trackedLabel: string | null;
  trackedSeasonNumbers: number[];
  /** Tree model: the active workspace drive — acquisition lands HERE. */
  storageId?: string | undefined;
}) {
  const isTv = candidate.mediaType === "tv";
  const trackedSet = new Set(trackedSeasonNumbers);
  // Only seasons NOT yet tracked are offered as acquisition scopes.
  const untrackedSeasons = candidate.seasonNumbers.filter(
    (seasonNumber) => !trackedSet.has(seasonNumber),
  );
  return (
    <article className="candidate-card">
      <Link className="candidate-poster" href={showHref(candidate.tmdbId, "search", storageId, candidate.mediaType)} aria-hidden tabIndex={-1}>
        {candidate.posterPath ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`https://image.tmdb.org/t/p/w342${candidate.posterPath}`} alt="" loading="lazy" />
        ) : (
          <span>{candidate.title.slice(0, 4)}</span>
        )}
      </Link>
      <div className="candidate-body">
        <div className="candidate-title-row">
          <div>
            <h3>
              <Link href={showHref(candidate.tmdbId, "search", storageId, candidate.mediaType)}>{candidate.title}</Link>
            </h3>
            <p>
              {candidate.year} · {isTv ? "剧集" : "电影"}
            </p>
          </div>
          <div className="candidate-actions">
            {acquiring ? (
              // #3a: while the run is RUNNING, show an inline live progress bar in
              // place (real /api/activity data) — the demo-style elegance the author
              // wanted instead of a bare spinner. When queued/just-finished it falls
              // back to the static 已请求 pill, which still links to the live 活动 page
              // (#6: "真实情况要去活动里看"). seasonNumber null = match this title's
              // running season; storageId scopes the 活动 link with ?w.
              <AcquireProgressBadge
                tmdbId={candidate.tmdbId}
                seasonNumber={null}
                storageId={storageId}
                title="后台正在获取——点查看进度（活动）"
              />
            ) : null}
            {!acquiring && isTv && untrackedSeasons.length > 0 ? (
              <SeasonRequestMenu
                tmdbId={candidate.tmdbId}
                seasonNumbers={untrackedSeasons}
                totalSeasonCount={candidate.seasonNumbers.length}
                allLabel={
                  trackedLabel !== null ? `获取剩余 ${untrackedSeasons.length} 季` : "获取所有季"
                }
                storageId={storageId}
                demoEntry={{
                  tmdbId: candidate.tmdbId,
                  title: candidate.title,
                  year: candidate.year,
                  type: candidate.mediaType,
                  posterPath: candidate.posterPath,
                }}
              />
            ) : null}
            {/* The clickable title is the detail entry already. Only surface an
                explicit 查看详情 when the show is FULLY tracked (no 获取 action
                left) — never crammed next to a 获取 button. */}
            {!acquiring && isTv && trackedLabel !== null && untrackedSeasons.length === 0 ? (
              <Link className="primary-button" href={showHref(candidate.tmdbId, "search", storageId, candidate.mediaType)}>
                查看详情
              </Link>
            ) : null}
            {!acquiring && !isTv && trackedLabel === null ? (
              <RequestTrackButton
                candidateId={candidate.id}
                tmdbId={candidate.tmdbId}
                actionState={candidate.action.state}
                disabled={candidate.action.disabled}
                label={candidate.action.label}
                storageId={storageId}
                demoEntry={{
                  tmdbId: candidate.tmdbId,
                  title: candidate.title,
                  year: candidate.year,
                  type: candidate.mediaType,
                  posterPath: candidate.posterPath,
                }}
              />
            ) : null}
          </div>
        </div>
        {candidate.overview ? (
          <p className="candidate-overview">{candidate.overview}</p>
        ) : null}
        <div className="candidate-meta">
          {isTv && candidate.seasonNumbers.length > 0 ? (
            <span>共 {candidate.seasonNumbers.length} 季</span>
          ) : null}
          {!acquiring && trackedLabel !== null ? (
            <span className="hub-badge tone-green">{trackedLabel}</span>
          ) : null}
        </div>
      </div>
    </article>
  );
}

async function LibrarySurface({ mediaType, filter, storageId }: { mediaType: string; filter: string; storageId?: string | undefined }) {
  const [rawWall, inProgress] = await Promise.all([getLibraryWall(storageId), getInProgressTitles(storageId)]);
  const inProgressIds = new Set(inProgress.map((title) => title.tmdbId));
  // A title still being fetched shows as a 获取中 placeholder, not (yet) a card.
  const wall = rawWall.filter((entry) => !inProgressIds.has(entry.tmdbId));

  if (wall.length === 0 && inProgress.length === 0) {
    return (
      <section className="library-surface">
        <div className="quiet-state">
          <Library size={24} aria-hidden />
          <strong>媒体库还是空的</strong>
          <span>去搜索页发起第一次获取吧。</span>
        </div>
      </section>
    );
  }

  // The type param is always one of the three (every link generates it that way);
  // anything else falls back to the rows overview.
  const category = mediaType === "movie" || mediaType === "tv" || mediaType === "anime" ? mediaType : null;
  return (
    <section className="library-surface">
      {inProgress.length > 0 ? <AcquiringPoller /> : null}
      <LibraryQuickFind
        wallEntries={wall}
        inProgressTitles={inProgress}
        storageId={storageId}
        mode={category ? "category" : "home"}
        mediaType={category ?? undefined}
        filter={filter === "complete" || filter === "tracking" || filter === "partial" ? filter : "all"}
      />
    </section>
  );
}

function SearchResultsSkeleton() {
  return (
    <div className="candidate-grid" style={{ marginTop: 24 }}>
      <div className="skeleton-card" />
      <div className="skeleton-card" />
    </div>
  );
}

function LibrarySurfaceSkeleton() {
  return (
    <section className="library-surface">
      <div className="skeleton skeleton-heading" />
      <div className="poster-wall">
        <div className="skeleton skeleton-poster" />
        <div className="skeleton skeleton-poster" />
        <div className="skeleton skeleton-poster" />
        <div className="skeleton skeleton-poster" />
      </div>
    </section>
  );
}

function stringParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}
