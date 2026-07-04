const TMDB_ORIGIN = "https://api.themoviedb.org/3";

// Only the metadata read paths the app actually uses — keeps the worker from
// being abusable as a general HTTP proxy. Prefix match after the leading slash.
const ALLOWED_PREFIXES = ["movie/", "tv/", "search/", "discover/", "find/", "genre/", "configuration", "trending/"];

const MOVIE_TTL_SECONDS = 7 * 24 * 60 * 60; // movie metadata is effectively static
const SHORT_TTL_SECONDS = 60 * 60;          // tv/season/search: 追更 needs hourly freshness

function ttlForPath(path: string): number {
  return path.startsWith("movie/") ? MOVIE_TTL_SECONDS : SHORT_TTL_SECONDS;
}

/** Stable cache key: path + query with keys sorted (剔除 auth 无关顺序差异). */
function cacheKeyFor(request: Request): string {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/+/, "");
  const entries = [...url.searchParams.entries()].sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  );
  const qs = new URLSearchParams(entries).toString();
  return qs ? `${path}?${qs}` : path;
}

export interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export interface HandleTmdbProxyDeps {
  request: Request;
  kv: KvLike;
  token: string;
  originFetch?: typeof fetch;
}

function pathOf(request: Request): string {
  return new URL(request.url).pathname.replace(/^\/+/, "");
}

function isAllowed(path: string): boolean {
  return ALLOWED_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix));
}

function jsonHeaders(cache: "HIT" | "MISS"): Record<string, string> {
  return { "Content-Type": "application/json;charset=utf-8", "X-Cache": cache };
}

export async function handleTmdbProxy(deps: HandleTmdbProxyDeps): Promise<Response> {
  const { request, token } = deps;
  const originFetch = deps.originFetch ?? fetch;

  if (request.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const path = pathOf(request);
  if (!isAllowed(path)) {
    return new Response("Not Found", { status: 404 });
  }

  const key = cacheKeyFor(request);
  const cached = await deps.kv.get(key);
  if (cached !== null) {
    return new Response(cached, { status: 200, headers: jsonHeaders("HIT") });
  }

  const originUrl = `${TMDB_ORIGIN}/${key}`;
  const originResponse = await originFetch(originUrl, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json;charset=utf-8" },
  });

  const body = await originResponse.text();
  if (!originResponse.ok) {
    return new Response(body, { status: originResponse.status, headers: jsonHeaders("MISS") });
  }
  await deps.kv.put(key, body, { expirationTtl: ttlForPath(path) });
  return new Response(body, { status: 200, headers: jsonHeaders("MISS") });
}

const TRENDING_TTL_SECONDS = 25 * 60 * 60; // > 24h 刷新间隔,断刷时兜底一小时

/** The three discovery feeds the search page shows, aligned to the app's
 *  电影/剧集/动漫 library types. Single source of truth: the Cron refresh writes
 *  these and the frontend reads the SAME path+query, so cacheKeyFor matches. */
export const TRENDING_FEEDS = [
  "trending/movie/week?language=zh-CN",
  "trending/tv/week?language=zh-CN",
  // 动漫:日语动画按热度排。include_adult=false + vote_count.gte=200 是 NECESSARY,
  // 不是可选 —— 裸 popularity.desc 会把大量成人/里番动画顶上来(其 popularity 被
  // 刷高、adult 标记不可靠);vote_count 门槛把它们挡掉,只留主流(咒术/死神/JOJO)。
  // 必须与 apps/web/lib/trending.ts TRENDING_KINDS.anime.query 逐字一致(cacheKey 命中)。
  "discover/tv?include_adult=false&language=zh-CN&sort_by=popularity.desc&vote_count.gte=200&with_genres=16&with_original_language=ja",
];

export interface RunScheduledRefreshDeps {
  kv: KvLike;
  token: string;
  originFetch?: typeof fetch;
}

/** Daily Cron: pre-warm each feed's KV entry so NO user open triggers a TMDB
 *  request. Computes the key via the proxy's own cacheKeyFor (through a synthetic
 *  Request), so it is byte-identical to what handleTmdbProxy derives for the same
 *  feed. A feed whose origin fetch fails or throws is skipped — its prior KV value
 *  (if any) lives on under its TTL, and one bad feed never aborts the others. */
export async function runScheduledRefresh(deps: RunScheduledRefreshDeps): Promise<void> {
  const originFetch = deps.originFetch ?? fetch;
  for (const feed of TRENDING_FEEDS) {
    const key = cacheKeyFor(new Request(`https://proxy/${feed}`));
    try {
      const originResponse = await originFetch(`${TMDB_ORIGIN}/${key}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${deps.token}`, "Content-Type": "application/json;charset=utf-8" },
      });
      if (!originResponse.ok) {
        continue;
      }
      const body = await originResponse.text();
      await deps.kv.put(key, body, { expirationTtl: TRENDING_TTL_SECONDS });
    } catch {
      // network hiccup on one feed must not abort the rest
    }
  }
}
