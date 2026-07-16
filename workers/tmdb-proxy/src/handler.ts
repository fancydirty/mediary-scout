const TMDB_ORIGIN = "https://api.themoviedb.org/3";
const TMDB_IMAGE_ORIGIN = "https://image.tmdb.org";

// Poster image proxy: image.tmdb.org is GFW-blocked for mainland visitors, so
// the landing site loads posters through the worker. Tight shape allowlist
// (two sizes, hash-like filename) keeps this from being a general image proxy.
const IMG_PATH_RE = /^t\/p\/(w342|w500)\/[A-Za-z0-9_]+\.(jpg|png)$/;

// Only the metadata read paths the app actually uses — keeps the worker from
// being abusable as a general HTTP proxy. Prefix match after the leading slash.
const ALLOWED_PREFIXES = ["movie/", "tv/", "search/", "discover/", "find/", "genre/", "configuration", "trending/"];

const CORS_ALLOWED_ORIGINS = new Set([
  "https://mediaryscout.app",
  "https://demo.mediaryscout.app",
  // Old .sbs origins kept during the domain transition (will 301 to mediaryscout.app).
  "https://mediary.dirtyfancy.sbs",
  "https://demo.dirtyfancy.sbs",
  "http://localhost:8788",
  "http://127.0.0.1:8788",
]);

function corsHeadersFor(request: Request): Record<string, string> {
  const origin = request.headers.get("Origin"); // case-insensitive per Fetch spec
  if (origin !== null && CORS_ALLOWED_ORIGINS.has(origin)) {
    return { "Access-Control-Allow-Origin": origin, Vary: "Origin" };
  }
  // Vary must be emitted for ANY request carrying an Origin, even when no ACAO
  // is granted — caches must know the response differs by origin (CORS spec).
  return origin !== null ? { Vary: "Origin" } : {};
}

const MOVIE_TTL_SECONDS = 7 * 24 * 60 * 60; // movie metadata is effectively static
const SHORT_TTL_SECONDS = 60 * 60;          // tv/season/search: 追更 needs hourly freshness

/** 2026-07-16 incident: TMDB's origin flapped (hangs + instant 504s) for 1h+ and
 *  the worker — whose origin fetch had NO timeout — stalled every live path with
 *  it. Absorption contract: bound the origin fetch, and keep every cached body
 *  around past its freshness window so an outage degrades to stale data instead
 *  of an error. Stale is only served when origin is outage-shaped (network
 *  failure/timeout/5xx/429) — semantic answers like 404 pass through. */
const STALE_TAIL_SECONDS = 14 * 24 * 60 * 60;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 3500; // below the app client's 4.5s budget

/** KV value envelope. Legacy entries are the raw TMDB body (a JSON object with
 *  none of these fields) — parseEnvelope returns null for them and they serve
 *  as fresh until their own physical TTL cycles them out. */
interface CacheEnvelope {
  v: 1;
  freshUntil: number; // epoch ms
  body: string;
}

function parseEnvelope(raw: string): CacheEnvelope | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { v?: unknown }).v === 1 &&
      typeof (parsed as { freshUntil?: unknown }).freshUntil === "number" &&
      typeof (parsed as { body?: unknown }).body === "string"
    ) {
      return parsed as unknown as CacheEnvelope;
    }
  } catch {
    // Not JSON at all — fall through.
  }
  // Reaching here usually means a LEGACY value: a raw TMDB body, which is valid
  // JSON but fails the envelope shape check above (no v/freshUntil/body).
  return null;
}

function envelopeFor(body: string, freshTtlSeconds: number, nowMs: number): string {
  const envelope: CacheEnvelope = { v: 1, freshUntil: nowMs + freshTtlSeconds * 1000, body };
  return JSON.stringify(envelope);
}

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

const TRENDING_TTL_SECONDS = 25 * 60 * 60; // > 24h 刷新间隔,断刷时兜底一小时

/** Last-calendar-year floor (rolls yearly): the anime feed shows RECENT seasons,
 *  not TMDB's all-time-popularity classics (全职猎人1999/死神2004…). MUST match
 *  apps/web/lib/trending.ts animeFirstAirDateFloor. */
export function animeFirstAirDateFloor(now: Date = new Date()): string {
  return `${now.getUTCFullYear() - 1}-01-01`;
}

/** The three discovery feeds the search page shows, aligned to 电影/剧集/动漫.
 *  Movie/TV are TMDB weekly trending. Anime has no "trending" endpoint, so it's
 *  discover/tv (日语动画) with a ROLLING first_air_date.gte (recent seasons only —
 *  bare popularity.desc surfaces decade-old classics) + vote_count.gte=50 +
 *  include_adult=false (mainstream, drops 里番/borderline). The Cron warms these
 *  and the frontend reads the SAME feed — the contract is that the PARAM SET
 *  (names+values) matches apps/web/lib/trending.ts trendingFeedQuery for the same
 *  `now`; ORDER does not matter (cacheKeyFor sorts both sides before keying). */
export function getTrendingFeeds(now: Date = new Date()): string[] {
  const floor = animeFirstAirDateFloor(now);
  return [
    "trending/movie/week?language=zh-CN",
    "trending/tv/week?language=zh-CN",
    `discover/tv?first_air_date.gte=${floor}&include_adult=false&language=zh-CN&sort_by=popularity.desc&vote_count.gte=50&with_genres=16&with_original_language=ja`,
  ];
}

/** Is this request one of the daily-cadence feeds? A reactive MISS on one must
 *  cache with the daily TTL (else a feed that fell out of KV re-hits TMDB every
 *  hour — ttlForPath gives non-movie paths 1h). Feed-specific: an ordinary
 *  discover/tv call keeps its short TTL. Computed per-call (feeds roll by date). */
function isTrendingFeedRequest(key: string, now: Date = new Date()): boolean {
  return getTrendingFeeds(now).some((feed) => cacheKeyFor(new Request(`https://proxy/${feed}`)) === key);
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
  /** Bound on the origin fetch (default 3.5s — below the app client's 4.5s). */
  upstreamTimeoutMs?: number;
  /** Clock (epoch ms) for envelope freshness; injectable for tests. */
  now?: () => number;
}

function pathOf(request: Request): string {
  return new URL(request.url).pathname.replace(/^\/+/, "");
}

function isAllowed(path: string): boolean {
  return ALLOWED_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix));
}

/** Binary passthrough for poster images. No KV (binary content; the immutable
 *  Cache-Control lets the CF edge cache own it) and no CORS (loaded via <img>
 *  tags, which need none). Anything off the strict shape allowlist is 404. */
async function handleImageProxy(
  rest: string,
  originFetch: typeof fetch,
  timeoutMs: number,
): Promise<Response> {
  if (!IMG_PATH_RE.test(rest)) {
    return new Response("Not Found", { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  // NOTE: no cf cache overrides on purpose. cacheEverything+cacheTtl would
  // pin origin 404s/5xx at the edge for a year, and per-status TTLs
  // (cacheTtlByStatus) are Enterprise-only. Default rules cache jpg/png by
  // extension honoring origin headers, with short negative caching — the
  // right behavior here.
  let originResponse: Response;
  try {
    originResponse = await originFetch(`${TMDB_IMAGE_ORIGIN}/${rest}`, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // A hung image origin must not hold the request open — the <img> breaks
    // and the browser retries on the next paint; nothing to serve stale here.
    return new Response("Bad Gateway", { status: 502, headers: { "Cache-Control": "no-store" } });
  }
  const headers: Record<string, string> = {
    "Cache-Control": originResponse.ok ? "public, max-age=31536000, immutable" : "no-store",
  };
  const contentType = originResponse.headers.get("Content-Type");
  if (contentType !== null) {
    headers["Content-Type"] = contentType;
  }
  return new Response(originResponse.body, { status: originResponse.status, headers });
}

function jsonHeaders(cache: "HIT" | "MISS" | "STALE", request: Request): Record<string, string> {
  return { "Content-Type": "application/json;charset=utf-8", "X-Cache": cache, ...corsHeadersFor(request) };
}

export async function handleTmdbProxy(deps: HandleTmdbProxyDeps): Promise<Response> {
  const { request, token } = deps;
  const originFetch = deps.originFetch ?? fetch;

  if (request.method !== "GET") {
    // CORS on error branches: without ACAO an allowlisted origin sees an opaque
    // CORS TypeError instead of an inspectable 405/404 (debuggability, not caching).
    return new Response("Method Not Allowed", { status: 405, headers: { ...corsHeadersFor(request), Allow: "GET" } });
  }

  const timeoutMs = deps.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
  const now = deps.now ?? Date.now;

  const path = pathOf(request);
  if (path.startsWith("img/")) {
    return handleImageProxy(path.slice("img/".length), originFetch, timeoutMs);
  }
  if (!isAllowed(path)) {
    return new Response("Not Found", { status: 404, headers: corsHeadersFor(request) });
  }

  const key = cacheKeyFor(request);
  const cachedRaw = await deps.kv.get(key);
  let staleBody: string | null = null;
  if (cachedRaw !== null) {
    const cached = parseEnvelope(cachedRaw);
    if (cached === null || now() < cached.freshUntil) {
      // Legacy raw value (fresh until its own physical TTL) or a fresh envelope.
      return new Response(cached === null ? cachedRaw : cached.body, {
        status: 200,
        headers: jsonHeaders("HIT", request),
      });
    }
    staleBody = cached.body;
  }

  const originUrl = `${TMDB_ORIGIN}/${key}`;
  let originResponse: Response;
  let body: string;
  try {
    originResponse = await originFetch(originUrl, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json;charset=utf-8" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    body = await originResponse.text();
  } catch (error) {
    if (staleBody !== null) {
      return new Response(staleBody, { status: 200, headers: jsonHeaders("STALE", request) });
    }
    // Public endpoint: keep the error contract to a stable enum. The log gets
    // only the path (the querystring carries user search terms) and the error
    // NAME — never the raw message, which some runtimes stuff the full request
    // URL into.
    const kind = error instanceof Error ? error.name : "unknown";
    console.error(`tmdb origin fetch failed for ${key.split("?")[0]}: ${kind}`);
    const reason = kind === "TimeoutError" ? "timeout" : "network";
    return new Response(JSON.stringify({ error: "tmdb_upstream_unreachable", reason }), {
      status: 504,
      headers: jsonHeaders("MISS", request),
    });
  }

  if (!originResponse.ok) {
    // Outage-shaped statuses degrade to stale; semantic answers (404 …) pass through.
    if (staleBody !== null && (originResponse.status >= 500 || originResponse.status === 429)) {
      return new Response(staleBody, { status: 200, headers: jsonHeaders("STALE", request) });
    }
    return new Response(body, { status: originResponse.status, headers: jsonHeaders("MISS", request) });
  }
  const ttl = isTrendingFeedRequest(key) ? TRENDING_TTL_SECONDS : ttlForPath(path);
  await deps.kv.put(key, envelopeFor(body, ttl, now()), { expirationTtl: ttl + STALE_TAIL_SECONDS });
  return new Response(body, { status: 200, headers: jsonHeaders("MISS", request) });
}

export interface RunScheduledRefreshDeps {
  kv: KvLike;
  token: string;
  originFetch?: typeof fetch;
  /** Bound per feed fetch — one hung feed must not eat the cron invocation. */
  upstreamTimeoutMs?: number;
  now?: () => number;
}

/** Daily Cron: pre-warm each feed's KV entry so NO user open triggers a TMDB
 *  request. Computes the key via the proxy's own cacheKeyFor (through a synthetic
 *  Request), so it is byte-identical to what handleTmdbProxy derives for the same
 *  feed. A feed whose origin fetch fails or throws is skipped — its prior KV value
 *  (if any) lives on under its TTL, and one bad feed never aborts the others. */
export async function runScheduledRefresh(deps: RunScheduledRefreshDeps): Promise<void> {
  const originFetch = deps.originFetch ?? fetch;
  const timeoutMs = deps.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
  const now = deps.now ?? Date.now;
  for (const feed of getTrendingFeeds()) {
    const key = cacheKeyFor(new Request(`https://proxy/${feed}`));
    try {
      const originResponse = await originFetch(`${TMDB_ORIGIN}/${key}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${deps.token}`, "Content-Type": "application/json;charset=utf-8" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!originResponse.ok) {
        continue;
      }
      const body = await originResponse.text();
      await deps.kv.put(key, envelopeFor(body, TRENDING_TTL_SECONDS, now()), {
        expirationTtl: TRENDING_TTL_SECONDS + STALE_TAIL_SECONDS,
      });
    } catch {
      // network hiccup on one feed must not abort the rest
    }
  }
}
