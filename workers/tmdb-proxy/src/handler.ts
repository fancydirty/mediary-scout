const TMDB_ORIGIN = "https://api.themoviedb.org/3";

// Only the metadata read paths the app actually uses — keeps the worker from
// being abusable as a general HTTP proxy. Prefix match after the leading slash.
const ALLOWED_PREFIXES = ["movie/", "tv/", "search/", "discover/", "find/", "genre/", "configuration"];

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
