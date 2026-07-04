import { fetchTmdbList } from "@media-track/workflow";
import { getTmdbAccesses, getAccountScopedSettings, getCurrentAccountId } from "./workflow-runtime";

export type TrendingKind = "movie" | "tv" | "anime";

export interface TrendingCard {
  tmdbId: number;
  title: string;
  year: number | null;
  posterPath: string | null;
  mediaType: "movie" | "tv";
}

/** The three discovery feeds, aligned to the app's 电影/剧集/动漫 library types.
 *  path + query MUST match workers/tmdb-proxy TRENDING_FEEDS so the proxy serves
 *  the Cron-warmed KV entry (cacheKey = path + sorted query). */
export const TRENDING_KINDS: Record<
  TrendingKind,
  { label: string; path: string; query: Record<string, string>; mediaType: "movie" | "tv" }
> = {
  movie: { label: "热门电影", path: "trending/movie/week", query: { language: "zh-CN" }, mediaType: "movie" },
  tv: { label: "热门剧集", path: "trending/tv/week", query: { language: "zh-CN" }, mediaType: "tv" },
  anime: {
    label: "热门动漫",
    path: "discover/tv",
    // include_adult=false + vote_count.gte=200 是 NECESSARY:裸 popularity.desc 会
    // 把成人/里番动画顶上首屏(popularity 被刷高、adult 标记不可靠),vote 门槛只留
    // 主流。必须与 workers/tmdb-proxy TRENDING_FEEDS 的 anime feed 逐字一致(cacheKey)。
    query: {
      include_adult: "false",
      language: "zh-CN",
      sort_by: "popularity.desc",
      "vote_count.gte": "200",
      with_genres: "16",
      with_original_language: "ja",
    },
    mediaType: "tv",
  },
};

export const TRENDING_KIND_ORDER: TrendingKind[] = ["movie", "tv", "anime"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function yearOf(value: unknown): number | null {
  if (typeof value !== "string" || value.length < 4) return null;
  const year = Number(value.slice(0, 4));
  return Number.isFinite(year) ? year : null;
}

/** Pure: TMDB list body → cards. Tolerates movie(title/release_date) and
 *  tv(name/first_air_date); drops idless/titleless rows; [] on any bad shape. */
export function mapTrendingResults(raw: unknown, kind: TrendingKind): TrendingCard[] {
  const results = isRecord(raw) && Array.isArray(raw.results) ? raw.results : [];
  const mediaType = TRENDING_KINDS[kind].mediaType;
  const cards: TrendingCard[] = [];
  for (const item of results) {
    if (!isRecord(item)) continue;
    const tmdbId = typeof item.id === "number" ? item.id : null;
    const title =
      typeof item.title === "string" ? item.title : typeof item.name === "string" ? item.name : null;
    if (tmdbId === null || !title) continue;
    const poster = typeof item.poster_path === "string" ? item.poster_path : null;
    cards.push({
      tmdbId,
      title,
      year: yearOf(item.release_date) ?? yearOf(item.first_air_date),
      posterPath: poster,
      mediaType,
    });
  }
  return cards;
}

/** Fetch + map one feed. Any failure → [] (silent degrade; the row hides and the
 *  search page falls back to its original empty state). Never throws. */
export async function getTrending(kind: TrendingKind): Promise<TrendingCard[]> {
  try {
    const accesses = await getTmdbAccesses(getAccountScopedSettings(await getCurrentAccountId()));
    const raw = await fetchTmdbList(accesses, TRENDING_KINDS[kind].path, TRENDING_KINDS[kind].query);
    return mapTrendingResults(raw, kind).slice(0, 12);
  } catch {
    return [];
  }
}
