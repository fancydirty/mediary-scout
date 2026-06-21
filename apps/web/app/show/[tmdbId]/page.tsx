import { connection } from "next/server";
import { Suspense, type ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { AcquiringPoller } from "../../../components/acquiring-poller";
import { AcquisitionLockProvider } from "../../../components/acquisition-lock";
import { AppSidebar } from "../../../components/app-sidebar";
import { BackLink } from "../../../components/back-link";
import {
  RequestRemainingButton,
  RequestSeasonButton,
} from "../../../components/title-action-buttons";
import type { DemoAcquisitionEntry } from "../../../lib/demo-session";
import {
  getDetailView,
  type MovieHubView,
  type TitleHubSeason,
  type TitleHubView,
} from "../../../lib/title-hub";
import { resolveGlobalWorkspace } from "../../../lib/workflow-runtime";
import { seasonBadgeState } from "../../../lib/title-aggregate";

const aggregateBadge = {
  untracked: null,
  tracking: { label: "追更中", tone: "indigo" },
  partial: { label: "部分入库", tone: "amber" },
  complete: { label: "已全部入库", tone: "green" },
} as const;

const seasonBadge = {
  untracked: null,
  missing: { label: "缺集", tone: "amber" },
  airing: { label: "追更中", tone: "indigo" },
  complete: { label: "已完结", tone: "green" },
} as const;

export default function ShowPage({
  params,
  searchParams,
}: {
  params: Promise<{ tmdbId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Everything here is dynamic (searchParams + params + DB), so the whole shell
  // streams inside one Suspense — cacheComponents forbids reading uncached data
  // outside a boundary. The fallback mirrors the shell (sidebar + hub skeleton).
  return (
    <div className="app-shell">
      <Suspense fallback={<ShowShell active="none" backLabel="返回" backHref="/?tab=search"><HubSkeleton /></ShowShell>}>
        <ShowContent params={params} searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

function ShowShell({
  active,
  backLabel,
  backHref,
  basePath = "/",
  activeStorageId,
  children,
}: {
  active: "search" | "library" | "none";
  backLabel: string;
  backHref: string;
  basePath?: string;
  activeStorageId?: string | undefined;
  children: ReactNode;
}) {
  return (
    <>
      <AppSidebar active={active} basePath={basePath} activeStorageId={activeStorageId} />
      <main className="main product-main">
        <BackLink label={backLabel} fallbackHref={backHref} />
        {children}
      </main>
    </>
  );
}

async function ShowContent({
  params,
  searchParams,
}: {
  params: Promise<{ tmdbId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>> | undefined;
}) {
  await connection();
  // 搜索是搜索，媒体库是媒体库: the title page belongs to whichever surface the
  // user came FROM. Entry links carry ?from=search|library; back keeps the
  // previous list state (history.back preserves the search query).
  const params0 = (await searchParams) ?? {};
  const fromParam = params0["from"];
  const from = fromParam === "library" ? "library" : fromParam === "search" ? "search" : null;
  // The title page is a global route (/show/<id>); it must resolve against the
  // drive the user came FROM (?w), NOT the primary drive — otherwise a non-primary
  // title isn't found in the (wrong) scope and falls back to a TMDB lookup of the
  // same numeric id in the OTHER namespace (movie 278 ≠ tv 278 = unrelated show).
  const wParam = params0["w"];
  const w = Array.isArray(wParam) ? wParam[0] : wParam;
  const workspace = await resolveGlobalWorkspace(w);
  // `t` (the card's media type) disambiguates TMDB's movie/tv id namespaces for an
  // untracked title — without it a movie id can resolve to an unrelated tv show.
  const tParam = params0["t"];
  const tRaw = Array.isArray(tParam) ? tParam[0] : tParam;
  const typeHint = tRaw === "movie" || tRaw === "tv" || tRaw === "anime" ? tRaw : undefined;
  const { tmdbId: tmdbIdParam } = await params;
  const tmdbId = Number(tmdbIdParam);
  const view = Number.isInteger(tmdbId)
    ? await getDetailView(tmdbId, workspace.connectedStorageId ?? undefined, typeHint)
    : null;

  return (
    <ShowShell
      active={from ?? "none"}
      backLabel={from === "search" ? "返回搜索" : from === "library" ? "返回媒体库" : "返回"}
      backHref={
        from === "library" ? `${workspace.basePath}?tab=library` : `${workspace.basePath}?tab=search`
      }
      basePath={workspace.basePath}
      activeStorageId={workspace.activeStorageId}
    >
      {view ? (
        view.kind === "movie" ? (
          <MovieHub view={view} />
        ) : (
          <TvHub view={view} storageId={workspace.activeStorageId} />
        )
      ) : (
        <div className="quiet-state">
          <TriangleAlert size={24} aria-hidden />
          <strong>没有找到这部影片</strong>
          <span>回到搜索页重新查找。</span>
        </div>
      )}
    </ShowShell>
  );
}

function TvHub({ view, storageId }: { view: TitleHubView; storageId: string | undefined }) {
  const badge = aggregateBadge[view.aggregate];
  return (
    <AcquisitionLockProvider>
    {view.acquiring ? <AcquiringPoller /> : null}
    <section className="title-hub">
      {view.backdropPath ? (
        <div
          className="hub-backdrop"
          style={{ backgroundImage: `url(https://image.tmdb.org/t/p/w1280${view.backdropPath})` }}
          aria-hidden
        />
      ) : null}

      <header className="hub-header">
        <div className="hub-poster">
          {view.posterPath ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`https://image.tmdb.org/t/p/w342${view.posterPath}`}
              alt={`${view.title} 海报`}
            />
          ) : (
            <span className="poster-fallback">{view.title.slice(0, 4)}</span>
          )}
        </div>
        <div className="hub-title-block">
          {/* 缺集 and 在更 are orthogonal: a partial title whose latest season is
              still releasing shows 追更中 alongside 部分入库 (斗破苍穹) — side by
              side in a row, not stacked. */}
          {badge ? (
            <div className="hub-badges">
              <span className={`hub-badge tone-${badge.tone}`}>{badge.label}</span>
              {view.airing && view.aggregate === "partial" ? (
                <span className="hub-badge tone-indigo">追更中</span>
              ) : null}
            </div>
          ) : null}
          <h1>
            {view.title} <span className="hub-year">({view.year})</span>
          </h1>
          <p className="hub-attributes">
            {view.seasons.length} 季
            {view.originalTitle && view.originalTitle !== view.title
              ? ` · ${view.originalTitle}`
              : ""}
          </p>
          {view.overview ? <p className="hub-overview">{view.overview}</p> : null}
          <div className="hub-actions">
            {/* Single-season titles get their button on the season row. */}
            {view.untrackedSeasonNumbers.length > 0 && view.seasons.length > 1 ? (
              <RequestRemainingButton
                tmdbId={view.tmdbId}
                storageId={storageId}
                titleAcquiring={view.acquiring}
                label={
                  view.aggregate === "untracked"
                    ? "获取所有季"
                    : `获取剩余 ${view.untrackedSeasonNumbers.length} 季`
                }
                demoEntry={{
                  tmdbId: view.tmdbId,
                  title: view.title,
                  year: view.year,
                  type: "tv",
                  posterPath: view.posterPath,
                }}
              />
            ) : null}
          </div>
        </div>
      </header>

      <section className="hub-seasons" aria-label="季列表">
        <div className="section-heading">
          <div>
            <h2>季</h2>
            <p>每季独立验证与监控；点击已追踪的季展开集数状态</p>
          </div>
        </div>
        <ul className="hub-season-list">
          {view.seasons.map((season) => (
            <SeasonRow
              key={season.seasonNumber}
              season={season}
              tmdbId={view.tmdbId}
              storageId={storageId}
              acquiring={view.acquiring}
              demoEntry={{
                tmdbId: view.tmdbId,
                title: view.title,
                year: view.year,
                type: "tv",
                posterPath: view.posterPath,
              }}
            />
          ))}
        </ul>
      </section>
    </section>
    </AcquisitionLockProvider>
  );
}

const movieStateMeta = {
  acquired: { label: "已入库", tone: "green" },
  reserved: { label: "预定 · 未上映", tone: "blue" },
  acquiring: { label: "获取中", tone: "indigo" },
  missing: { label: "未获取", tone: "amber" },
  untracked: { label: "未追踪", tone: "muted" },
} as const;

/** A movie's detail page: a single status, no season grid. */
function MovieHub({ view }: { view: MovieHubView }) {
  const meta = movieStateMeta[view.state];
  const releaseLine =
    view.state === "reserved" && view.releaseDate ? `${formatMovieDate(view.releaseDate)} 上映` : null;
  return (
    <AcquisitionLockProvider>
      {view.acquiring ? <AcquiringPoller /> : null}
      <section className="title-hub">
        {view.backdropPath ? (
          <div
            className="hub-backdrop"
            style={{ backgroundImage: `url(https://image.tmdb.org/t/p/w1280${view.backdropPath})` }}
            aria-hidden
          />
        ) : null}
        <header className="hub-header">
          <div className="hub-poster">
            {view.posterPath ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={`https://image.tmdb.org/t/p/w342${view.posterPath}`} alt={`${view.title} 海报`} />
            ) : (
              <span className="poster-fallback">{view.title.slice(0, 4)}</span>
            )}
          </div>
          <div className="hub-title-block">
            <span className={`hub-badge tone-${meta.tone}`}>{meta.label}</span>
            <h1>
              {view.title} <span className="hub-year">({view.year})</span>
            </h1>
            <p className="hub-attributes">
              电影
              {view.originalTitle && view.originalTitle !== view.title ? ` · ${view.originalTitle}` : ""}
              {releaseLine ? ` · ${releaseLine}` : ""}
            </p>
            {view.overview ? <p className="hub-overview">{view.overview}</p> : null}
          </div>
        </header>
      </section>
    </AcquisitionLockProvider>
  );
}

function formatMovieDate(releaseDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(releaseDate);
  return match ? `${match[1]}年${Number(match[2])}月${Number(match[3])}日` : releaseDate;
}

/** Contextual placeholder while the hub's first render streams in. Mirrors the
 *  real hub SHAPE (poster + title block header, then the season list) so the
 *  swap to real content doesn't reflow — reuses the same layout containers. A
 *  movie resolves with no seasons, but the header (the dominant region) matches
 *  both, and the season rows cover the common TV case. */
function HubSkeleton() {
  return (
    <section className="title-hub">
      <header className="hub-header">
        <div className="skeleton skeleton-hub-poster" />
        <div className="skeleton-hub-titleblock">
          <div className="skeleton skeleton-hub-badge" />
          <div className="skeleton skeleton-hub-h1" />
          <div className="skeleton skeleton-hub-line" />
          <div className="skeleton skeleton-hub-line short" />
          <div className="skeleton skeleton-hub-line short" />
        </div>
      </header>
      <section className="hub-seasons" aria-hidden>
        <div className="skeleton skeleton-hub-section" />
        <ul className="hub-season-list">
          <li className="skeleton skeleton-hub-row" />
          <li className="skeleton skeleton-hub-row" />
          <li className="skeleton skeleton-hub-row" />
        </ul>
      </section>
    </section>
  );
}

function SeasonRow({
  season,
  tmdbId,
  storageId,
  acquiring,
  demoEntry,
}: {
  season: TitleHubSeason;
  tmdbId: number;
  /** Tree model: the active workspace drive — acquisition lands HERE. */
  storageId: string | undefined;
  acquiring: boolean;
  demoEntry?: DemoAcquisitionEntry | undefined;
}) {
  const total = season.totalEpisodes;
  const aired = Math.min(season.latestAiredEpisode, total);
  // Obtained never exceeds aired for bar purposes (resource-ahead caps at aired).
  const obtained = Math.min(season.obtainedCount, aired);
  const airedPct = total > 0 ? (aired / total) * 100 : 0;
  const obtainedPct = total > 0 ? (obtained / total) * 100 : 0;

  const badge = seasonBadge[seasonBadgeState(season)];

  const rowBody = (
    <>
      <span className="season-cell-name">第 {season.seasonNumber} 季</span>
      <span className="season-cell-count">{total} 集</span>
      {badge ? (
        <span className={`hub-badge tone-${badge.tone}`}>{badge.label}</span>
      ) : (
        <span className="hub-badge tone-muted">未追踪</span>
      )}
      <span className="season-cell-progress" aria-hidden>
        {season.tracked ? (
          <>
            <span className="seg-aired" style={{ width: `${airedPct}%` }} />
            <span className="seg-obtained" style={{ width: `${obtainedPct}%` }} />
          </>
        ) : null}
      </span>
      {/* 已获取 / 已播 / 总集数 — so 6/6 of a 9-ep season isn't read as complete. */}
      <span className="season-cell-obtained">
        {season.tracked ? `${season.obtainedCount}/${aired}/${total}` : "—"}
      </span>
    </>
  );

  if (!season.tracked) {
    return (
      <li className="hub-season-row untracked">
        {rowBody}
        <RequestSeasonButton
          tmdbId={tmdbId}
          seasonNumber={season.seasonNumber}
          storageId={storageId}
          titleAcquiring={acquiring}
          demoEntry={demoEntry}
        />
      </li>
    );
  }

  return (
    <li>
      <details className="hub-season-details">
        <summary className="hub-season-row">{rowBody}</summary>
        <div className="episode-grid hub-episode-grid">
          {season.episodes.map((episode) => (
            <div
              className={`episode-cell ${episode.displayState.replace("_", "-")}`}
              key={episode.episodeCode}
            >
              <strong>{episode.episodeCode.replace(/^S\d+/, "")}</strong>
              <span>
                {episode.displayState === "obtained"
                  ? "已获取"
                  : episode.displayState === "missing_aired"
                    ? "缺集"
                    : episode.displayState === "provider_ahead"
                      ? "超前"
                      : episode.displayState === "unaired"
                        ? "未播"
                        : "未知"}
              </span>
            </div>
          ))}
        </div>
      </details>
    </li>
  );
}

