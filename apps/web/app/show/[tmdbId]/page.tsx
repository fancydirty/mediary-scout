import Link from "next/link";
import { connection } from "next/server";
import { Suspense, cache, type ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { formatByteSize, isMovieUnreleased, type EpisodeDisplayState } from "@media-track/workflow";
import { AcquiringPoller } from "../../../components/acquiring-poller";
import { AcquisitionLockProvider } from "../../../components/acquisition-lock";
import { AppSidebar } from "../../../components/app-sidebar";
import { GitHubNameplate } from "../../../components/github-nameplate";
import { BackLink } from "../../../components/back-link";
import { MovieSynopsis } from "../../../components/movie-synopsis";
import { RequestTrackButton } from "../../../components/request-track-button";
import { SeasonDetails } from "../../../components/season-details";
import { SwapBadgeLive, SwapEpisodeCell, SwapKeepProvider } from "../../../components/swap-keep";
import {
  RequestRemainingButton,
  RequestSeasonButton,
} from "../../../components/title-action-buttons";
import { UntrackButton } from "../../../components/untrack-button";
import { AgentMemoryNotes } from "../../../components/agent-memory-panel";
import { UserMessageThread } from "../../../components/user-message-thread";
import { isDemoMode } from "../../../lib/demo-mode";
import type { DemoAcquisitionEntry } from "../../../lib/demo-session";
import {
  getDetailView,
  type MovieHubView,
  type TitleHubSeason,
  type TitleHubView,
} from "../../../lib/title-hub";
import { seasonBadgeState } from "../../../lib/title-aggregate";
import { nextPatrolLabel, readTitleMessages } from "../../../lib/user-message-server";
import { showsMessageCard } from "../../../lib/user-message-state";
import {
  beijingDateTime,
  getActiveWorkspaceScope,
  getDailySweepTimes,
  getWorkflowRepository,
  resolveGlobalWorkspace,
} from "../../../lib/workflow-runtime";

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
      <Suspense
        fallback={
          <ShowShell active="none">
            <HubSkeleton backLabel="返回" backHref="/?tab=search" />
          </ShowShell>
        }
      >
        <ShowContent params={params} searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

function ShowShell({
  active,
  basePath = "/",
  activeStorageId,
  children,
}: {
  active: "search" | "library" | "none";
  basePath?: string;
  activeStorageId?: string | undefined;
  children: ReactNode;
}) {
  return (
    <>
      <AppSidebar active={active} basePath={basePath} activeStorageId={activeStorageId} />
      <main className="main product-main product-main-hub">{children}</main>
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

  const backLabel = from === "search" ? "搜索" : from === "library" ? "媒体库" : "返回";
  const backHref =
    from === "library" ? `${workspace.basePath}?tab=library` : `${workspace.basePath}?tab=search`;

  return (
    <ShowShell
      active={from ?? "none"}
      basePath={workspace.basePath}
      activeStorageId={workspace.activeStorageId}
    >
      {view ? (
        view.kind === "movie" ? (
          <MovieHub
            view={view}
            storageId={workspace.activeStorageId}
            basePath={workspace.basePath}
            backLabel={backLabel}
            backHref={backHref}
          />
        ) : (
          <TvHub
            view={view}
            storageId={workspace.activeStorageId}
            basePath={workspace.basePath}
            backLabel={backLabel}
            backHref={backHref}
          />
        )
      ) : (
        <div className="quiet-state">
          <BackLink label={backLabel} fallbackHref={backHref} />
          <TriangleAlert size={24} aria-hidden />
          <strong>没有找到这部影片</strong>
          <span>回到搜索页重新查找。</span>
        </div>
      )}
      <GitHubNameplate />
    </ShowShell>
  );
}

function TvHub({
  view,
  storageId,
  basePath,
  backLabel,
  backHref,
}: {
  view: TitleHubView;
  storageId: string | undefined;
  basePath: string;
  backLabel: string;
  backHref: string;
}) {
  const badge = aggregateBadge[view.aggregate];
  // The message card's episode picker: every episode of a tracked season in the library.
  const libraryEpisodes = view.seasons
    .filter((season) => season.tracked)
    .flatMap((season) => season.episodes.filter((episode) => episode.obtained).map((episode) => episode.episodeCode));
  return (
    <AcquisitionLockProvider>
    <SwapKeepProvider key={`tv:${view.tmdbId}:${storageId ?? ""}`}>
    {view.acquiring ? <AcquiringPoller /> : null}
    <section className="title-hub title-hub-immersive">
      {/* Backdrop clipped to hub-hero only — seasons stay on plain page bg. */}
      <div className="hub-hero">
        {view.backdropPath ? (
          <div
            className="hub-backdrop"
            style={{ backgroundImage: `url(https://image.tmdb.org/t/p/w1280${view.backdropPath})` }}
            aria-hidden
          />
        ) : null}
        <BackLink label={backLabel} fallbackHref={backHref} />
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
              <SwapBadge tmdbId={view.tmdbId} mediaType="tv" storageId={storageId} />
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
            {view.aggregate !== "untracked" ? (
              <UntrackButton tmdbId={view.tmdbId} storageId={storageId} mediaKind="tv" basePath={basePath} />
            ) : null}
          </div>
        </div>
      </header>
      </div>

      <div className="hub-body">
        {view.overview ? <MovieSynopsis overview={view.overview} /> : null}
      </div>

      <section className="hub-seasons" aria-label="季列表">
        <ul className="hub-season-list">
          <SeasonRowsWithSwap view={view} storageId={storageId} basePath={basePath} />
        </ul>
      </section>
      {view.aggregate !== "untracked" ? (
        <TitleMessageSection
          tmdbId={view.tmdbId}
          mediaType="tv"
          storageId={storageId}
          hasFile={libraryEpisodes.length > 0}
          episodes={libraryEpisodes}
        />
      ) : null}
      {view.aggregate !== "untracked" ? <TitleMemorySection mediaType="tv" tmdbId={view.tmdbId} /> : null}
    </section>
    </SwapKeepProvider>
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

/** A movie's detail page: immersive hero + full synopsis body (no season grid). */
function MovieHub({
  view,
  storageId,
  basePath,
  backLabel,
  backHref,
}: {
  view: MovieHubView;
  storageId: string | undefined;
  basePath: string;
  backLabel: string;
  backHref: string;
}) {
  const meta = movieStateMeta[view.state];
  const activityHref = storageId ? `/activity?w=${encodeURIComponent(storageId)}` : "/activity";
  const nowIso = new Date().toISOString();
  const unreleased =
    view.state === "untracked" && isMovieUnreleased(view.releaseDate, nowIso);
  const movieCandidateId = `tmdb_movie_${view.tmdbId}`;
  const chips: Array<{ label: string; value: string }> = [];
  if (view.releaseDate) chips.push({ label: "上映", value: formatMovieDate(view.releaseDate) });
  if (view.originalTitle && view.originalTitle !== view.title) {
    chips.push({ label: "原名", value: view.originalTitle });
  }
  chips.push({ label: "类型", value: "电影" });

  return (
    <AcquisitionLockProvider>
    <SwapKeepProvider key={`movie:${view.tmdbId}:${storageId ?? ""}`}>
      {view.acquiring ? <AcquiringPoller /> : null}
      <section className="title-hub title-hub-immersive">
        {/* Backdrop lives inside hub-hero only — must NOT cover synopsis body. */}
        <div className="hub-hero">
          {view.backdropPath ? (
            <div
              className="hub-backdrop"
              style={{ backgroundImage: `url(https://image.tmdb.org/t/p/w1280${view.backdropPath})` }}
              aria-hidden
            />
          ) : null}
          <BackLink label={backLabel} fallbackHref={backHref} />
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
              <div className="hub-badges">
                <span className={`hub-badge tone-${meta.tone}`}>{meta.label}</span>
                {view.state !== "untracked" ? (
                  <SwapBadge tmdbId={view.tmdbId} mediaType="movie" storageId={storageId} />
                ) : null}
              </div>
              <h1>
                {view.title} <span className="hub-year">({view.year})</span>
              </h1>
              <p className="hub-attributes">电影</p>
              <div className="hub-actions">
                {view.state === "untracked" ? (
                  <RequestTrackButton
                    candidateId={movieCandidateId}
                    tmdbId={view.tmdbId}
                    actionState={unreleased ? "can_reserve" : "can_request"}
                    label={unreleased ? "预定" : "获取"}
                    storageId={storageId}
                  />
                ) : null}
                {view.state === "acquiring" ? (
                  <Link className="primary-button" href={activityHref}>
                    查看活动
                  </Link>
                ) : null}
                {view.state !== "untracked" ? (
                  <UntrackButton tmdbId={view.tmdbId} storageId={storageId} mediaKind="movie" basePath={basePath} />
                ) : null}
              </div>
              {view.state === "missing" ? (
                <p className="hub-missing-note">已上映但仍缺资源，日常巡检会继续尝试。</p>
              ) : null}
            </div>
          </header>
        </div>
        <div className="hub-body">
          {view.overview ? <MovieSynopsis overview={view.overview} /> : null}
          {chips.length > 0 ? (
            <div className="movie-meta-chips">
              {chips.map((chip) => (
                <span key={`${chip.label}-${chip.value}`} className="movie-meta-chip">
                  {chip.label} <strong>{chip.value}</strong>
                </span>
              ))}
            </div>
          ) : null}
        </div>
        {view.state !== "untracked" ? (
          <TitleMessageSection tmdbId={view.tmdbId} mediaType="movie" storageId={storageId} hasFile={view.obtained} episodes={[]} />
        ) : null}
        {view.state !== "untracked" ? <TitleMemorySection mediaType="movie" tmdbId={view.tmdbId} /> : null}
      </section>
    </SwapKeepProvider>
    </AcquisitionLockProvider>
  );
}

function formatMovieDate(releaseDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(releaseDate);
  return match ? `${match[1]}年${Number(match[2])}月${Number(match[3])}日` : releaseDate;
}

/** Shared placeholder while the hub streams. Header-only — no fake TV season
 *  rows (movies have none; TV content replaces this quickly). */
function HubSkeleton({ backLabel, backHref }: { backLabel: string; backHref: string }) {
  return (
    <section className="title-hub title-hub-immersive">
      <div className="hub-hero">
        <BackLink label={backLabel} fallbackHref={backHref} />
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
      </div>
      <div className="hub-body movie-synopsis" aria-hidden>
        <div className="skeleton skeleton-hub-section" />
        <div className="skeleton skeleton-hub-line" />
        <div className="skeleton skeleton-hub-line" />
        <div className="skeleton skeleton-hub-line short" />
      </div>
    </section>
  );
}

/** What an episode cell says for its state. */
const EPISODE_STATE_LABEL: Record<EpisodeDisplayState, string> = {
  obtained: "已获取",
  missing_aired: "缺集",
  provider_ahead: "超前",
  unaired: "未播",
  unknown: "未知",
};

function SeasonRow({
  season,
  tmdbId,
  storageId,
  basePath,
  acquiring,
  swap,
  demoEntry,
}: {
  season: TitleHubSeason;
  tmdbId: number;
  /** Tree model: the active workspace drive — acquisition lands HERE. */
  storageId: string | undefined;
  /** Library path to return to after a whole-show untrack. */
  basePath: string;
  acquiring: boolean;
  /** Episodes a user asked to replace that are still 待换 (their old file stays). */
  swap: ReadonlySet<string>;
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
      <SeasonDetails initiallyOpen={season.episodes.some((episode) => swap.has(episode.episodeCode))}>
        <summary className="hub-season-row">{rowBody}</summary>
        <div className="episode-grid hub-episode-grid">
          {season.episodes.map((episode) => {
            const stateClass = episode.displayState.replace("_", "-");
            const baseLabel = EPISODE_STATE_LABEL[episode.displayState];
            const firstDrive = episode.driveBadges?.[0];
            const stateLabel =
              episode.obtained && firstDrive ? `${baseLabel} · ${firstDrive.label}` : baseLabel;
            const tooltip =
              episode.obtained && episode.driveBadges && episode.driveBadges.length > 0
                ? episode.driveBadges
                    .map((d) =>
                      [
                        d.label,
                        d.quality ?? null,
                        d.sizeBytes !== null && d.sizeBytes > 0 ? formatByteSize(d.sizeBytes) : null,
                      ]
                        .filter(Boolean)
                        .join(" · "),
                    )
                    .join(" / ")
                : undefined;
            // A 待换 cell is a client piece: 「不换了」 on the message card restores it at once.
            return swap.has(episode.episodeCode) ? (
              <SwapEpisodeCell key={episode.episodeCode} code={episode.episodeCode} stateClass={stateClass} stateLabel={stateLabel} />
            ) : (
              <div className={`episode-cell ${stateClass}`} key={episode.episodeCode} title={tooltip}>
                <strong>{episode.episodeCode.replace(/^S\d+/, "")}</strong>
                <span>{stateLabel}</span>
              </div>
            );
          })}
        </div>
        <div className="season-untrack-row">
          <UntrackButton
            tmdbId={tmdbId}
            storageId={storageId}
            mediaKind="tv"
            seasonNumber={season.seasonNumber}
            basePath={basePath}
            label={`取消第 ${season.seasonNumber} 季追踪`}
          />
        </div>
      </SeasonDetails>
    </li>
  );
}

/** This work's messages and 待换 episodes, read once per request (the title badge and
 *  the season grid both use them). The work is resolved the way the message actions
 *  resolve it, so the page shows what the engine acts on. Null when the title is not
 *  tracked on this drive — or when the read failed: these are decorations, logged and
 *  left out rather than failing the whole page. */
const loadTitleMessages = cache((tmdbId: number, mediaType: "movie" | "tv", storageId: string | undefined) => {
  const repo = getWorkflowRepository();
  return readTitleMessages({
    repo,
    scope: () => getActiveWorkspaceScope(storageId),
    tmdbId,
    mediaType,
    sweepTimes: () => getDailySweepTimes(repo),
  });
});

/** 「N 集待换」 (show) /「待换资源」 (film) beside the title's status badge. */
async function SwapBadge({
  tmdbId,
  mediaType,
  storageId,
}: {
  tmdbId: number;
  mediaType: "movie" | "tv";
  storageId: string | undefined;
}) {
  const messages = await loadTitleMessages(tmdbId, mediaType, storageId);
  // A client piece: 「不换了」 on the message card takes it down at once.
  return messages ? <SwapBadgeLive mediaType={mediaType} pending={messages.thread.pendingReplacements} /> : null;
}

/** The message card: under the season rows (TV) or the synopsis (film), above
 *  the agent's notes. Shown while the work has a file on this drive, or messages / 待换
 *  to show — never keyed off the film's 已入库: a film whose replace run is in flight
 *  reads 获取中, and the card must not vanish exactly then. Not on the read-only demo. */
async function TitleMessageSection({
  tmdbId,
  mediaType,
  storageId,
  hasFile,
  episodes,
}: {
  tmdbId: number;
  mediaType: "movie" | "tv";
  storageId: string | undefined;
  hasFile: boolean;
  /** The picker's cells (TV); [] for a film. */
  episodes: string[];
}) {
  if (isDemoMode()) return null;
  const messages = await loadTitleMessages(tmdbId, mediaType, storageId);
  if (!messages) return null;
  const { thread, run, sweepTimes } = messages;
  if (!showsMessageCard({ tracked: true, hasFile, messageCount: thread.messages.length, pendingCount: thread.pendingReplacements.length })) {
    return null;
  }
  return (
    <div className="hub-message">
      <UserMessageThread
        work={{ tmdbId, mediaType, storageId }}
        view={thread}
        run={run}
        nextPatrol={nextPatrolLabel(sweepTimes, beijingDateTime().hhmm)}
        episodes={episodes}
        now={new Date().toISOString()}
      />
    </div>
  );
}

/** The season rows, each episode a user asked to replace drawn 「待换」 in red. */
async function SeasonRowsWithSwap({
  view,
  storageId,
  basePath,
}: {
  view: TitleHubView;
  storageId: string | undefined;
  basePath: string;
}) {
  const messages = view.aggregate === "untracked" ? null : await loadTitleMessages(view.tmdbId, "tv", storageId);
  const swap = new Set(messages?.thread.pendingReplacements ?? []);
  return (
    <>
      {view.seasons.map((season) => (
        <SeasonRow
          key={season.seasonNumber}
          season={season}
          tmdbId={view.tmdbId}
          storageId={storageId}
          basePath={basePath}
          acquiring={view.acquiring}
          swap={swap}
          demoEntry={{
            tmdbId: view.tmdbId,
            title: view.title,
            year: view.year,
            type: "tv",
            posterPath: view.posterPath,
          }}
        />
      ))}
    </>
  );
}


/** This work's agent notes, collapsed to one line under the episode progress (TV) or
 *  the synopsis (movie). Absent when the agent has written nothing for this work. */
async function TitleMemorySection({ mediaType, tmdbId }: { mediaType: "movie" | "tv"; tmdbId: number }) {
  const { getWorkflowRepository, getCurrentAccountId } = await import("../../../lib/workflow-runtime");
  const { driveLabelerFor, listMemoriesForUi, toMemoryItem } = await import("../../../lib/agent-memory-server");
  const accountId = await getCurrentAccountId();
  const items = await listMemoriesForUi(getWorkflowRepository(), accountId, { scope: "title", mediaType, tmdbId });
  if (items.length === 0) return null;
  const driveLabel = await driveLabelerFor(getWorkflowRepository(), accountId);
  return (
    <div className="hub-memory">
      <AgentMemoryNotes
        address={{ scope: "title", mediaType, tmdbId }}
        items={items.map((m) => toMemoryItem(m, driveLabel))}
        summaryLabel={mediaType === "tv" ? "agent 补缺集时记了 {n} 条笔记" : "agent 获取时记了 {n} 条笔记"}
        now={new Date().toISOString()}
      />
    </div>
  );
}
