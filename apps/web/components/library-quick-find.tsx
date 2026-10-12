"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type JSX, type KeyboardEvent } from "react";
import { CalendarClock, CheckCircle2, Clock3, LoaderCircle, Search, TriangleAlert, X } from "lucide-react";
// Client components must take the /scope subpath, not the barrel — the barrel
// drags pg/postgres into the client bundle (see request-state.tsx).
import { showHref } from "@media-track/workflow/scope";
import type { InProgressTitle, LibraryWallEntry } from "../lib/title-hub";

/** Mirror of page.tsx's workspaceBasePath: "/" is the account's primary drive,
 *  "/w/<id>" a specific drive. Library links must route within the workspace. */
function workspaceBasePath(storageId?: string): string {
  return storageId ? `/w/${storageId}` : "/";
}

/** Title contains match (case-insensitive, whitespace-trimmed); empty query → 全量. */
export function filterLibraryEntries<T extends { title: string }>(entries: T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    return entries;
  }
  return entries.filter((entry) => entry.title.toLowerCase().includes(needle));
}

export function LibraryQuickFind({
  wallEntries,
  inProgressTitles,
  storageId,
  mode,
  mediaType,
  filter,
}: {
  wallEntries: LibraryWallEntry[];
  inProgressTitles: InProgressTitle[];
  storageId?: string | undefined;
  /** "home"=分类行总览；"category"=单分类页（与 filter 叠加） */
  mode: "home" | "category";
  mediaType?: "movie" | "tv" | "anime" | undefined;
  filter?: "all" | "complete" | "tracking" | "partial" | undefined;
}): JSX.Element {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  // 清空统一入口：清完把焦点还给搜索框（✕/0 匹配清空按钮随后会 unmount，
  // 不接住焦点就掉回 document）。
  const clearQuery = () => {
    setQuery("");
    inputRef.current?.focus();
  };

  // category 模式：先按现有 filter（complete/tracking/partial）过滤，再按 query 过滤。
  const scopedWall =
    mode === "category"
      ? wallEntries.filter((entry) => {
          if (mediaType && entry.type !== mediaType) return false;
          if (filter === "complete") return entry.state === "complete";
          if (filter === "tracking") return entry.state === "tracking";
          if (filter === "partial") return entry.state === "partial";
          return true;
        })
      : wallEntries;
  const scopedInProgress =
    mode === "category" && mediaType
      ? inProgressTitles.filter((title) => title.type === mediaType)
      : inProgressTitles;

  const matchedWall = filterLibraryEntries(scopedWall, query);
  const matchedInProgress = filterLibraryEntries(scopedInProgress, query);
  const totalCount = matchedWall.length + matchedInProgress.length;

  // Enter 直达：query 时可达（非「获取中」占位）匹配恰好 1 且总匹配恰好 1 → 海报卡同一链接进详情页。
  // 唯一匹配是「获取中」占位（aria-disabled「完成后可进入」）时不导航——Enter 不绕过该契约。
  const soleMatchHref = (): string | null => {
    if (query.trim() === "" || totalCount !== 1 || matchedWall.length !== 1) return null;
    const sole = matchedWall[0];
    return sole ? showHref(sole.tmdbId, "library", storageId, sole.type) : null;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // 中文输入法用 Enter 确认候选词也会走到这里——那是选字，不是导航/清空。
    // WebKit 变体：compositionend 先于 keydown 时 keyCode 229 是文档化兜底。
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === "Enter") {
      const href = soleMatchHref();
      if (href) router.push(href);
    } else if (event.key === "Escape") {
      clearQuery();
    }
  };

  const typeLabel = mediaType === "movie" ? "电影" : mediaType === "tv" ? "电视剧" : "动漫";
  const trackingCount = wallEntries
    .filter((entry) => entry.type === mediaType)
    .filter((entry) => entry.state === "tracking" || entry.state === "partial").length;

  return (
    <>
      <div className="section-heading library-heading library-find-heading">
        <div>
          {mode === "home" ? (
            <h1>我的媒体库</h1>
          ) : (
            <h1>
              <Link href={`${workspaceBasePath(storageId)}?tab=library`} style={{ marginRight: 12, opacity: 0.6 }}>
                ‹
              </Link>
              {typeLabel}
            </h1>
          )}
          {mode === "category" ? <p>{trackingCount > 0 && `${trackingCount} 部正在追踪`}</p> : null}
        </div>
        <div className="search-box search-box-compact">
          <Search size={16} aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            aria-label="在库中查找"
            placeholder="在库中查找…"
          />
          {query.trim() !== "" ? (
            <button
              type="button"
              className="search-box-compact-clear"
              aria-label="清空查找"
              onClick={clearQuery}
            >
              <X size={14} aria-hidden />
            </button>
          ) : null}
        </div>
      </div>
      {query.trim() !== "" ? (
        <p className="panel-note" aria-live="polite" aria-atomic="true">
          匹配 {totalCount} 部
        </p>
      ) : null}
      {mode === "category" ? (
        <div style={{ marginBottom: 16, display: "flex", gap: 8 }}>
          <Link
            className={`filter-pill ${filter === "all" ? "is-active" : ""}`}
            href={`${workspaceBasePath(storageId)}?tab=library&type=${mediaType}&filter=all`}
          >
            全部
          </Link>
          <Link
            className={`filter-pill ${filter === "complete" ? "is-active" : ""}`}
            href={`${workspaceBasePath(storageId)}?tab=library&type=${mediaType}&filter=complete`}
          >
            已完结
          </Link>
          <Link
            className={`filter-pill ${filter === "tracking" ? "is-active" : ""}`}
            href={`${workspaceBasePath(storageId)}?tab=library&type=${mediaType}&filter=tracking`}
          >
            追更中
          </Link>
          <Link
            className={`filter-pill ${filter === "partial" ? "is-active" : ""}`}
            href={`${workspaceBasePath(storageId)}?tab=library&type=${mediaType}&filter=partial`}
          >
            有缺集
          </Link>
        </div>
      ) : null}
      {totalCount === 0 && query.trim() !== "" ? (
        <div className="quiet-state compact">
          <TriangleAlert size={22} aria-hidden />
          <strong>没找到『{query}』</strong>
          <button type="button" className="secondary-button" onClick={clearQuery}>
            清空
          </button>
        </div>
      ) : mode === "home" ? (
        <>
          <InProgressRow titles={matchedInProgress} />
          <CategoryRow
            label="电影"
            type="movie"
            inProgressTitles={matchedInProgress.filter((title) => title.type === "movie")}
            wallEntries={matchedWall.filter((entry) => entry.type === "movie")}
            storageId={storageId}
          />
          <CategoryRow
            label="电视剧"
            type="tv"
            inProgressTitles={matchedInProgress.filter((title) => title.type === "tv")}
            wallEntries={matchedWall.filter((entry) => entry.type === "tv")}
            storageId={storageId}
          />
          <CategoryRow
            label="动漫"
            type="anime"
            inProgressTitles={matchedInProgress.filter((title) => title.type === "anime")}
            wallEntries={matchedWall.filter((entry) => entry.type === "anime")}
            storageId={storageId}
          />
        </>
      ) : (
        <>
          <InProgressRow titles={matchedInProgress} />
          <div className="poster-wall">
            {matchedWall.map((entry) => (
              <PosterCard entry={entry} activeStorageId={storageId} key={entry.tmdbId} />
            ))}
          </div>
        </>
      )}
    </>
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
      <Link className="category-header" href={`${workspaceBasePath(storageId)}?tab=library&type=${type}&filter=all`}>
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
