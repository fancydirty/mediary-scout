import Link from "next/link";
import { Suspense } from "react";
import { CalendarClock, CheckCircle2, Clock3, Library, LoaderCircle, Search, TriangleAlert } from "lucide-react";
import { AcquiringPoller } from "../components/acquiring-poller";
import { AppSidebar } from "../components/app-sidebar";
import { RequestTrackButton } from "../components/request-track-button";
import { DemoSessionLibrary } from "../components/demo-session-library";
import { RememberQuery } from "../components/search-memory";
import { SearchForm } from "../components/search-form";
import { SeasonRequestMenu } from "../components/season-request-menu";
import { getSearchView } from "../lib/search-page";
import {
  getInProgressTitles,
  getLibraryWall,
  type InProgressTitle,
  type LibraryWallEntry,
} from "../lib/title-hub";
import {
  ensureDemoSeeded,
  getActiveWorkspaceScope,
  getRegisteredDriveCount,
  getWorkflowRepository,
} from "../lib/workflow-runtime";
import { showHref } from "@media-track/workflow";
import type { SearchCandidateCard, TrackedSeasonState } from "@media-track/workflow";

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
  // Tree model: keep searches inside the ACTIVE workspace so an acquisition lands
  // on the drive you're viewing — not silently on the primary drive. Root route
  // (no storageId) posts to "/" as before.
  const basePath = storageId ? `/w/${storageId}` : "/";
  const driveCount = await getRegisteredDriveCount();

  return (
    <div className="app-shell">
      <AppSidebar active={activeTab} searchQuery={query} basePath={basePath} activeStorageId={storageId} />

      <main className="main product-main">
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
              <SearchResults query={query} storageId={storageId} />
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
      </main>
    </div>
  );
}

async function SearchResults({ query, storageId }: { query: string; storageId?: string | undefined }) {
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
              <span className="hub-badge tone-green" title="后台正在获取">
                <LoaderCircle size={12} className="spin" aria-hidden />
                获取中
              </span>
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

  // Homepage: every type as a horizontal row, with in-progress titles shown
  // inline (as 获取中 cards) alongside the landed ones — plus the dedicated
  // 获取中 row at the very top.
  if (mediaType === "all") {
    const byType = (type: "movie" | "tv" | "anime") => ({
      inProgressTitles: inProgress.filter((title) => title.type === type),
      wallEntries: wall.filter((entry) => entry.type === type),
    });
    return (
      <section className="library-surface">
        <div className="section-heading library-heading">
          <div>
            <h1>我的媒体库</h1>
          </div>
        </div>

        {inProgress.length > 0 ? <AcquiringPoller /> : null}
        <InProgressRow titles={inProgress} />

        <CategoryRow label="电影" type="movie" {...byType("movie")} storageId={storageId} />
        <CategoryRow label="电视剧" type="tv" {...byType("tv")} storageId={storageId} />
        <CategoryRow label="动漫" type="anime" {...byType("anime")} storageId={storageId} />
      </section>
    );
  }

  // Category detail page
  const filteredWall = wall.filter((entry) => {
    // Type filter
    if (mediaType === "movie" && entry.type !== "movie") return false;
    if (mediaType === "tv" && entry.type !== "tv") return false;
    if (mediaType === "anime" && entry.type !== "anime") return false;
    // State filter
    if (filter === "complete") return entry.state === "complete";
    if (filter === "tracking") return entry.state === "tracking";
    if (filter === "partial") return entry.state === "partial";
    return true;
  });

  const typeLabel = mediaType === "movie" ? "电影" : mediaType === "tv" ? "电视剧" : "动漫";
  const trackingCount = wall
    .filter((entry) => entry.type === mediaType)
    .filter((entry) => entry.state === "tracking" || entry.state === "partial").length;

  return (
    <section className="library-surface">
      <div className="section-heading library-heading">
        <div>
          <h1>
            <Link href="/?tab=library" style={{ marginRight: 12, opacity: 0.6 }}>
              ‹
            </Link>
            {typeLabel}
          </h1>
          <p>{trackingCount > 0 && `${trackingCount} 部正在追踪`}</p>
        </div>
      </div>

      <div style={{ marginBottom: 16, display: "flex", gap: 8 }}>
        <Link
          className={`filter-pill ${filter === "all" ? "is-active" : ""}`}
          href={`/?tab=library&type=${mediaType}&filter=all`}
        >
          全部
        </Link>
        <Link
          className={`filter-pill ${filter === "complete" ? "is-active" : ""}`}
          href={`/?tab=library&type=${mediaType}&filter=complete`}
        >
          已完结
        </Link>
        <Link
          className={`filter-pill ${filter === "tracking" ? "is-active" : ""}`}
          href={`/?tab=library&type=${mediaType}&filter=tracking`}
        >
          追更中
        </Link>
        <Link
          className={`filter-pill ${filter === "partial" ? "is-active" : ""}`}
          href={`/?tab=library&type=${mediaType}&filter=partial`}
        >
          有缺集
        </Link>
      </div>

      {inProgress.length > 0 ? <AcquiringPoller /> : null}
      <InProgressRow titles={inProgress.filter((title) => title.type === mediaType)} />

      <div className="poster-wall">
        {filteredWall.map((entry) => (
          <PosterCard entry={entry} activeStorageId={storageId} key={entry.tmdbId} />
        ))}
      </div>
    </section>
  );
}

function CategoryRow({
  label,
  type,
  inProgressTitles,
  wallEntries,
  storageId,
}: {
  label: string;
  type: string;
  inProgressTitles: InProgressTitle[];
  wallEntries: LibraryWallEntry[];
  storageId?: string | undefined;
}) {
  const count = inProgressTitles.length + wallEntries.length;
  if (count === 0) {
    return null;
  }
  return (
    <div className="category-section">
      <Link className="category-header" href={`/?tab=library&type=${type}&filter=all`}>
        <h2>
          {label} {count}
        </h2>
        <span className="category-arrow">›</span>
      </Link>
      <div className="poster-row">
        {inProgressTitles.map((title) => (
          <InProgressCard title={title} key={`ip_${title.tmdbId}`} />
        ))}
        {wallEntries.map((entry) => (
          <PosterCard entry={entry} activeStorageId={storageId} key={entry.tmdbId} />
        ))}
      </div>
    </div>
  );
}

function InProgressRow({ titles }: { titles: InProgressTitle[] }) {
  if (titles.length === 0) {
    return null;
  }
  return (
    <div className="category-section">
      <div className="category-header is-static">
        <h2>获取中 {titles.length}</h2>
      </div>
      <div className="poster-row">
        {titles.map((title) => (
          <InProgressCard title={title} key={title.tmdbId} />
        ))}
      </div>
    </div>
  );
}

function InProgressCard({ title }: { title: InProgressTitle }) {
  return (
    <div className="wall-card is-loading" aria-disabled title="获取中，完成后可进入">
      <span className="wall-poster">
        {title.posterPath ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`https://image.tmdb.org/t/p/w342${title.posterPath}`} alt="" loading="lazy" />
        ) : (
          <span className="poster-fallback">{title.title.slice(0, 4)}</span>
        )}
        <span className="wall-loading-overlay">
          <LoaderCircle size={20} className="spin" aria-hidden />
          <span>获取中</span>
        </span>
      </span>
      <span className="wall-copy">
        <strong>{title.title}</strong>
        <span>{title.year} · 正在获取</span>
      </span>
    </div>
  );
}

function PosterCard({ entry, activeStorageId }: { entry: LibraryWallEntry; activeStorageId?: string | undefined }) {
  // Completeness and "still airing" are orthogonal: a 缺集 title whose latest
  // season is still releasing shows BOTH ⚠️有缺集 and 追更中 (斗破苍穹), so the
  // blue/indigo "在更" signal isn't swallowed by the warning (parity with 达顿牧场).
  const badges =
    entry.state === "reserved"
      ? [{ tone: "blue", icon: CalendarClock, label: "预定（未上映）" }]
      : entry.state === "complete"
        ? [{ tone: "green", icon: CheckCircle2, label: "已全部入库" }]
        : entry.state === "tracking"
          ? [{ tone: "indigo", icon: Clock3, label: "追更中" }]
          : [
              { tone: "amber", icon: TriangleAlert, label: "有缺集" },
              ...(entry.airing ? [{ tone: "indigo", icon: Clock3, label: "追更中" }] : []),
            ];

  return (
    <Link className="wall-card" href={showHref(entry.tmdbId, "library", activeStorageId, entry.type)}>
      <span className="wall-poster">
        {entry.posterPath ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`https://image.tmdb.org/t/p/w342${entry.posterPath}`} alt="" loading="lazy" />
        ) : (
          <span className="poster-fallback">{entry.title.slice(0, 4)}</span>
        )}
        <span className="wall-states">
          {badges.map((badge) => {
            const BadgeIcon = badge.icon;
            return (
              <span className={`wall-state tone-${badge.tone}`} title={badge.label} key={badge.label}>
                <BadgeIcon size={13} aria-hidden />
              </span>
            );
          })}
        </span>
      </span>
      <span className="wall-copy">
        <strong>{entry.title}</strong>
        <span>
          {/* A movie has no seasons/episodes; reserved ones name the release date.
              Series show 已获取/已播/共 (e.g. 6/6/9) so 6/6 of a 9-ep season no
              longer reads as "100% complete". */}
          {entry.type === "movie"
            ? entry.state === "reserved"
              ? `预定 · ${formatReleaseDate(entry.releaseDate)}上映`
              : entry.year
            : `${entry.year} · ${entry.seasonCount} 季 · ${entry.obtainedEpisodes}/${entry.totalAiredEpisodes}/${entry.totalEpisodes} 集`}
        </span>
      </span>
    </Link>
  );
}

/** "2026-12-16" → "12月16日"; falls back to the year when only a year is known. */
function formatReleaseDate(releaseDate: string | null): string {
  if (!releaseDate) {
    return "";
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(releaseDate);
  if (!match) {
    return releaseDate;
  }
  return `${Number(match[2])}月${Number(match[3])}日`;
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
