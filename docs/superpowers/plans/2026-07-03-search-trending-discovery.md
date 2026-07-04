# 搜索页近期热门发现区 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 搜索页未搜索时的空白区变为「近期热门」发现区(电影/剧集/动漫三 Tab),数据由 CF Worker Cron 每日预热 KV,用户打开零 TMDB 请求;点击海报=用该片名发起搜索。

**Architecture:** Worker 加 `trending/` 白名单 + `scheduled()` 每日把三个榜单写进 KV(复用自身 `cacheKeyFor`,保证前端读时 key 命中)。`tmdb-provider.ts` 加一个导出的 `fetchTmdbList` seam 复用既有访问链(不复制 fallback)。`apps/web/lib/trending.ts` 映射为卡片模型,`trending-row.tsx` 渲染,`page.tsx` 空态挂载。任何失败静默降级回原占位符。

**Tech Stack:** Cloudflare Worker (KV + Cron)、Next.js server components、vitest。

---

## File Structure

- `workers/tmdb-proxy/src/handler.ts` — 加 `trending/` 白名单、`TRENDING_FEEDS` 常量、`runScheduledRefresh()`(复用 `cacheKeyFor`)。
- `workers/tmdb-proxy/src/index.ts` — 加 `scheduled` 导出,调 `runScheduledRefresh`。
- `workers/tmdb-proxy/wrangler.jsonc` — 加 `triggers.crons`。
- `workers/tmdb-proxy/src/handler.test.ts` — trending 白名单 + scheduled 写 KV 测试。
- `packages/workflow/src/tmdb-provider.ts` — 加导出 `fetchTmdbList(accesses, path, query?, opts?)` seam。
- `packages/workflow/tests/tmdb-trending-fetch.test.ts` — seam 测试(注入 fetchJson)。
- `apps/web/lib/trending.ts` — `TRENDING_KINDS`、`mapTrendingResults`(纯)、`getTrending`。
- `apps/web/lib/trending.test.ts` — `mapTrendingResults` 纯函数测试。
- `apps/web/components/trending-row.tsx` — 发现区组件。
- `apps/web/app/page.tsx` — 空态接线 + 读 `?trending`。
- `apps/web/app/globals.css` — 热门网格样式。

---

## Task 1: Worker 白名单 + TRENDING_FEEDS + runScheduledRefresh

**Files:**
- Modify: `workers/tmdb-proxy/src/handler.ts`
- Test: `workers/tmdb-proxy/src/handler.test.ts`

- [ ] **Step 1: Write failing tests**

在 `workers/tmdb-proxy/src/handler.test.ts` 末尾追加(先看文件顶部已有的 `import` 与 fake KV 写法,复用之;若无 fake，用下面自带的):

```ts
import { handleTmdbProxy, runScheduledRefresh, TRENDING_FEEDS } from "./handler";

function fakeKv(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed));
  const puts: Array<{ key: string; value: string; ttl?: number }> = [];
  return {
    kv: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string, o?: { expirationTtl?: number }) => {
        store.set(k, v);
        puts.push({ key: k, value: v, ttl: o?.expirationTtl });
      },
    },
    puts,
    store,
  };
}

describe("trending discovery", () => {
  it("allows the trending/ prefix (was 404)", async () => {
    const { kv } = fakeKv();
    const originFetch = (async () =>
      new Response(JSON.stringify({ results: [] }), { status: 200 })) as unknown as typeof fetch;
    const res = await handleTmdbProxy({
      request: new Request("https://proxy/trending/movie/week?language=zh-CN"),
      kv,
      token: "t",
      originFetch,
    });
    expect(res.status).toBe(200);
  });

  it("runScheduledRefresh writes every feed to KV under its cacheKey with a 25h TTL", async () => {
    const { kv, puts } = fakeKv();
    const originFetch = (async () =>
      new Response(JSON.stringify({ results: [{ id: 1 }] }), { status: 200 })) as unknown as typeof fetch;
    await runScheduledRefresh({ kv, token: "t", originFetch });
    expect(puts).toHaveLength(TRENDING_FEEDS.length);
    for (const put of puts) {
      expect(put.ttl).toBe(25 * 60 * 60);
      expect(put.value).toContain("results");
    }
    const key = puts[0]!.key;
    const cachedHit = await handleTmdbProxy({
      request: new Request(`https://proxy/${TRENDING_FEEDS[0]}`),
      kv,
      token: "t",
      originFetch: (async () => new Response("SHOULD_NOT_FETCH", { status: 500 })) as unknown as typeof fetch,
    });
    expect(cachedHit.status).toBe(200);
    expect(cachedHit.headers.get("X-Cache")).toBe("HIT");
    expect(key.startsWith("trending/movie/week")).toBe(true);
  });

  it("runScheduledRefresh skips writing a feed whose origin fetch fails", async () => {
    const { kv, puts } = fakeKv();
    const originFetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    await runScheduledRefresh({ kv, token: "t", originFetch });
    expect(puts).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run workers/tmdb-proxy/src/handler.test.ts`
Expected: FAIL — `runScheduledRefresh`/`TRENDING_FEEDS` not exported; trending test 404.

- [ ] **Step 3: Implement in handler.ts**

改白名单一行(加 `"trending/"`):

```ts
const ALLOWED_PREFIXES = ["movie/", "tv/", "search/", "discover/", "find/", "genre/", "configuration", "trending/"];
```

在文件末尾(`handleTmdbProxy` 之后)新增:

```ts
const TRENDING_TTL_SECONDS = 25 * 60 * 60; // > 24h 刷新间隔,兜底一小时

/** The three discovery feeds the search page shows, aligned to the app's
 *  电影/剧集/动漫 library types. Single source of truth: the Cron refresh writes
 *  these and the frontend reads the SAME path+query, so cacheKeyFor matches. */
export const TRENDING_FEEDS = [
  "trending/movie/week?language=zh-CN",
  "trending/tv/week?language=zh-CN",
  "discover/tv?language=zh-CN&sort_by=popularity.desc&with_genres=16&with_original_language=ja",
];

export interface RunScheduledRefreshDeps {
  kv: KvLike;
  token: string;
  originFetch?: typeof fetch;
}

/** Daily Cron: pre-warm each feed's KV entry so NO user open triggers a TMDB
 *  request. Uses the proxy's own cacheKeyFor via a synthetic Request, so the key
 *  is byte-identical to what handleTmdbProxy computes for the same feed. A feed
 *  whose origin fetch fails is skipped (its previous KV value, if any, lives on
 *  under its TTL) — one bad feed never blocks the others. */
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
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run workers/tmdb-proxy/src/handler.test.ts`
Expected: PASS (all trending tests green + existing tests still green).

- [ ] **Step 5: Commit**

```bash
git add workers/tmdb-proxy/src/handler.ts workers/tmdb-proxy/src/handler.test.ts
git commit -m "feat(worker): trending 白名单 + runScheduledRefresh 每日预热 KV"
```

---

## Task 2: Worker Cron 接线(wrangler + index.ts)

**Files:**
- Modify: `workers/tmdb-proxy/wrangler.jsonc`
- Modify: `workers/tmdb-proxy/src/index.ts`

- [ ] **Step 1: 加 cron 到 wrangler.jsonc**

```jsonc
{
  "name": "media-track-tmdb-proxy",
  "main": "src/index.ts",
  "compatibility_date": "2026-06-01",
  "kv_namespaces": [
    { "binding": "TMDB_CACHE", "id": "252a662ac5594eec88b7c4d39fd6a5c5" }
  ],
  "triggers": {
    "crons": ["0 22 * * *"]
  }
}
```

- [ ] **Step 2: 加 scheduled 到 index.ts**

```ts
import { handleTmdbProxy, runScheduledRefresh, type KvLike } from "./handler";

export interface Env {
  TMDB_CACHE: KvLike;
  TMDB_READ_TOKEN: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!env.TMDB_READ_TOKEN) {
      return new Response("Proxy misconfigured: missing TMDB_READ_TOKEN secret", { status: 500 });
    }
    return handleTmdbProxy({ request, kv: env.TMDB_CACHE, token: env.TMDB_READ_TOKEN });
  },

  async scheduled(_event: unknown, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<void> {
    if (!env.TMDB_READ_TOKEN) {
      return;
    }
    ctx.waitUntil(runScheduledRefresh({ kv: env.TMDB_CACHE, token: env.TMDB_READ_TOKEN }));
  },
};
```

- [ ] **Step 3: Typecheck worker**

Run: `cd workers/tmdb-proxy && npx tsc --noEmit; cd -`
Expected: exit 0 (若 worker 无独立 tsconfig 则跳过,根 tsc 覆盖不到 worker 是已知的,靠 vitest 保证)。

- [ ] **Step 4: Commit**

```bash
git add workers/tmdb-proxy/wrangler.jsonc workers/tmdb-proxy/src/index.ts
git commit -m "feat(worker): 注册每日 cron scheduled → runScheduledRefresh"
```

---

## Task 3: tmdb-provider 导出 fetchTmdbList seam

**Files:**
- Modify: `packages/workflow/src/tmdb-provider.ts`
- Test: `packages/workflow/tests/tmdb-trending-fetch.test.ts`

- [ ] **Step 1: Write failing test**

`packages/workflow/tests/tmdb-trending-fetch.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { fetchTmdbList } from "../src/tmdb-provider.js";

describe("fetchTmdbList", () => {
  it("fetches a raw list path via the access chain and returns the parsed body", async () => {
    const fetchJson = vi.fn(async (url: string) => {
      expect(url).toContain("/trending/movie/week");
      expect(url).toContain("language=zh-CN");
      return { results: [{ id: 1 }] };
    });
    const result = await fetchTmdbList(
      [{ baseURL: "https://proxy.example" }],
      "trending/movie/week",
      { language: "zh-CN" },
      { fetchJson },
    );
    expect(result).toEqual({ results: [{ id: 1 }] });
    expect(fetchJson).toHaveBeenCalledTimes(1);
  });

  it("falls back to the second access when the first throws", async () => {
    const fetchJson = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ results: [] });
    const result = await fetchTmdbList(
      [{ baseURL: "https://a", readToken: "k" }, { baseURL: "https://b" }],
      "trending/tv/week",
      {},
      { fetchJson },
    );
    expect(result).toEqual({ results: [] });
    expect(fetchJson).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run packages/workflow/tests/tmdb-trending-fetch.test.ts`
Expected: FAIL — `fetchTmdbList` not exported.

- [ ] **Step 3: Implement seam in tmdb-provider.ts**

在 `tmdb-provider.ts` 末尾(`createTmdbMetadataProvider` 附近,`defaultFetchJson` 在同文件作用域内)新增:

```ts
/** Fetch an arbitrary TMDB list path (e.g. trending/discover) through the same
 *  user-key → proxy access chain every provider uses — the single chokepoint for
 *  fallback + timeout + dead-access memoization. Returns the raw parsed body
 *  (typically `{ results: [...] }`); callers map it. Kept here (not in apps/web)
 *  because defaultFetchJson is module-private and the fallback logic must not be
 *  duplicated. */
export async function fetchTmdbList(
  accesses: TmdbAccess[],
  path: string,
  query: Record<string, string> = {},
  opts: { fetchJson?: TmdbFetchJson } = {},
): Promise<unknown> {
  return fetchViaAccessChain(accesses, path, query, opts.fetchJson ?? defaultFetchJson);
}
```

- [ ] **Step 4: Run to verify pass + build workflow**

Run: `npx vitest run packages/workflow/tests/tmdb-trending-fetch.test.ts && npm run build:workflow`
Expected: PASS + build exit 0 (apps/web 依赖 `@media-track/workflow` 的 dist,导出新函数必须 build)。

- [ ] **Step 5: Commit**

```bash
git add packages/workflow/src/tmdb-provider.ts packages/workflow/tests/tmdb-trending-fetch.test.ts
git commit -m "feat(tmdb): 导出 fetchTmdbList seam 复用访问链取任意列表路径"
```

---

## Task 4: apps/web trending.ts(TRENDING_KINDS + mapTrendingResults + getTrending)

**Files:**
- Create: `apps/web/lib/trending.ts`
- Test: `apps/web/lib/trending.test.ts`

- [ ] **Step 1: Write failing test**

`apps/web/lib/trending.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mapTrendingResults } from "./trending";

describe("mapTrendingResults", () => {
  it("maps a movie result (title/release_date/poster_path)", () => {
    const cards = mapTrendingResults(
      { results: [{ id: 27205, title: "盗梦空间", release_date: "2010-07-15", poster_path: "/a.jpg" }] },
      "movie",
    );
    expect(cards).toEqual([
      { tmdbId: 27205, title: "盗梦空间", year: 2010, posterPath: "/a.jpg", mediaType: "movie" },
    ]);
  });

  it("maps a tv/anime result (name/first_air_date) to mediaType tv", () => {
    const cards = mapTrendingResults(
      { results: [{ id: 240411, name: "葬送的芙莉莲", first_air_date: "2023-09-29", poster_path: "/b.jpg" }] },
      "anime",
    );
    expect(cards).toEqual([
      { tmdbId: 240411, title: "葬送的芙莉莲", year: 2023, posterPath: "/b.jpg", mediaType: "tv" },
    ]);
  });

  it("keeps a missing poster_path as null", () => {
    const cards = mapTrendingResults({ results: [{ id: 1, title: "X", release_date: "2020-01-01" }] }, "movie");
    expect(cards[0]!.posterPath).toBeNull();
  });

  it("drops entries with no id or no title, and yields [] on a missing results array", () => {
    expect(mapTrendingResults({ results: [{ title: "no id" }, { id: 2 }] }, "movie")).toEqual([]);
    expect(mapTrendingResults({}, "movie")).toEqual([]);
    expect(mapTrendingResults(null, "movie")).toEqual([]);
  });

  it("null/empty air date → year null", () => {
    const cards = mapTrendingResults({ results: [{ id: 3, title: "Y" }] }, "movie");
    expect(cards[0]!.year).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run apps/web/lib/trending.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement trending.ts**

```ts
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
    query: {
      language: "zh-CN",
      sort_by: "popularity.desc",
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
    const title = typeof item.title === "string" ? item.title : typeof item.name === "string" ? item.name : null;
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
 *  search page falls back to its original placeholder). Never throws. */
export async function getTrending(kind: TrendingKind): Promise<TrendingCard[]> {
  try {
    const accesses = await getTmdbAccesses(getAccountScopedSettings(await getCurrentAccountId()));
    const raw = await fetchTmdbList(accesses, TRENDING_KINDS[kind].path, TRENDING_KINDS[kind].query);
    return mapTrendingResults(raw, kind).slice(0, 12);
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run apps/web/lib/trending.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/trending.ts apps/web/lib/trending.test.ts
git commit -m "feat(search): trending 卡片映射 + getTrending(三 Tab 榜单)"
```

---

## Task 5: trending-row.tsx 组件

**Files:**
- Create: `apps/web/components/trending-row.tsx`

- [ ] **Step 1: Implement component**

```tsx
import Link from "next/link";
import { Film, RefreshCw } from "lucide-react";
import { getTrending, TRENDING_KINDS, TRENDING_KIND_ORDER, type TrendingKind } from "../lib/trending";

const POSTER = "https://image.tmdb.org/t/p/w342";

/** The search page's empty-state discovery row. Renders nothing but the caller's
 *  fallback when getTrending yields [] (network/proxy down) — never blocks search.
 *  Poster clicks navigate to `?q=<title>` so the pick lands in the normal results
 *  flow where the user explicitly chooses 获取. */
export async function TrendingRow({
  activeKind,
  basePath,
}: {
  activeKind: TrendingKind;
  basePath: string;
}) {
  const cards = await getTrending(activeKind);
  if (cards.length === 0) {
    return null;
  }
  const sep = basePath.includes("?") ? "&" : "?";
  return (
    <section className="trending" aria-label="近期热门">
      <div className="trending-head">
        <div className="trending-tabs">
          <h2>近期热门</h2>
          {TRENDING_KIND_ORDER.map((kind) => (
            <Link
              key={kind}
              className={`filter-pill ${kind === activeKind ? "is-active" : ""}`}
              href={`${basePath}${sep}trending=${kind}`}
            >
              {TRENDING_KINDS[kind].label}
            </Link>
          ))}
        </div>
        <span className="trending-note">
          <RefreshCw size={12} aria-hidden /> 每日更新 · 来自 TMDB
        </span>
      </div>
      <div className="trending-grid">
        {cards.map((card, index) => (
          <Link
            key={`${card.mediaType}_${card.tmdbId}`}
            className="trending-card"
            href={`${basePath}${sep.replace("&", "?")}q=${encodeURIComponent(card.title)}`}
          >
            <div className="trending-poster">
              {card.posterPath ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={`${POSTER}${card.posterPath}`} alt="" loading="lazy" />
              ) : (
                <Film size={24} aria-hidden />
              )}
              <span className="trending-rank">#{index + 1}</span>
            </div>
            <span className="trending-title">{card.title}</span>
            <span className="trending-meta">
              {card.year ?? "—"} · {card.mediaType === "movie" ? "电影" : activeKind === "anime" ? "动漫" : "剧集"}
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}
```

> Note on the `q=` href: `basePath` is `/` or `/w/<id>` (no query). `sep` is `?`
> here. The `sep.replace("&","?")` is defensive for a future basePath already
> carrying a query — for the current `basePath` values it is simply `?`. The Tab
> links intentionally do NOT carry `q`, so switching tabs stays in the empty state.

- [ ] **Step 2: Commit (styles + wiring make it renderable; commit together in Task 6)**

No standalone run — server component renders via the page. Proceed to Task 6.

---

## Task 6: 接线 page.tsx 空态 + globals.css 样式

**Files:**
- Modify: `apps/web/app/page.tsx`
- Modify: `apps/web/app/globals.css`

- [ ] **Step 1: page.tsx — 读 ?trending + 传给 SearchResults**

在 `HomeSurface` 里 `const filter = ...` 之后加:

```tsx
  const trendingParam = stringParam(params.trending);
  const activeTrending: "movie" | "tv" | "anime" =
    trendingParam === "tv" ? "tv" : trendingParam === "anime" ? "anime" : "movie";
```

把 `<SearchResults query={query} storageId={storageId} />` 改为传入两个新 prop:

```tsx
            <Suspense key={`search-${query}`} fallback={<SearchResultsSkeleton />}>
              <SearchResults
                query={query}
                storageId={storageId}
                activeTrending={activeTrending}
                basePath={basePath}
              />
            </Suspense>
```

- [ ] **Step 2: page.tsx — SearchResults 签名 + 空态换成 TrendingRow**

改 `SearchResults` 函数签名:

```tsx
async function SearchResults({
  query,
  storageId,
  activeTrending,
  basePath,
}: {
  query: string;
  storageId?: string | undefined;
  activeTrending: "movie" | "tv" | "anime";
  basePath: string;
}) {
```

把 empty 分支(`searchView.state === "empty"` 的 `<div className="quiet-state">…</div>`)替换为:

```tsx
      {searchView.state === "empty" ? (
        <TrendingRow activeKind={activeTrending} basePath={basePath} />
      ) : (
```

并在文件顶部加 import:

```tsx
import { TrendingRow } from "../components/trending-row";
```

> `TrendingRow` returns `null` when trending is empty (proxy down) — the page then
> shows nothing in the empty state rather than the old placeholder. That is an
> accepted trade (an empty search page with just the search box). If you want the
> placeholder back as a hard fallback, wrap: `{cards.length ? <TrendingRow…/> :
> <placeholder/>}` — but TrendingRow can't know cards count from here, so keep the
> null-return and accept the bare state. (Spec §错误降级 allows this.)

- [ ] **Step 3: globals.css — 追加样式**

在 `globals.css` 末尾追加:

```css
.trending {
  margin-top: 8px;
}
.trending-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
  flex-wrap: wrap;
}
.trending-tabs {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.trending-tabs h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 500;
}
.trending-note {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--text-muted, #8a8a84);
}
.trending-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 14px;
}
.trending-card {
  display: flex;
  flex-direction: column;
  text-decoration: none;
  color: inherit;
}
.trending-poster {
  position: relative;
  aspect-ratio: 2 / 3;
  border-radius: 10px;
  overflow: hidden;
  background: var(--surface-1, #17171a);
  border: 0.5px solid var(--border, #2a2a2e);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted, #6a6a66);
}
.trending-poster img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.trending-rank {
  position: absolute;
  top: 6px;
  left: 6px;
  padding: 2px 7px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
  font-size: 11px;
  font-weight: 500;
}
.trending-title {
  margin-top: 7px;
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.trending-meta {
  margin-top: 1px;
  font-size: 12px;
  color: var(--text-muted, #8a8a84);
}
.trending-card:hover .trending-poster {
  border-color: var(--border-strong, #3a3a40);
}
```

> Reuse the existing `.filter-pill` / `.filter-pill.is-active` classes for the Tab
> pills (already styled in globals.css for the library filters) — no new pill CSS.

- [ ] **Step 4: Typecheck + build**

Run: `npx tsc -p apps/web/tsconfig.json --noEmit && npm run build:web`
Expected: exit 0 both.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/page.tsx apps/web/app/globals.css apps/web/components/trending-row.tsx
git commit -m "feat(search): 空态挂载近期热门发现区(三 Tab + 海报网格)"
```

---

## Task 7: 全量验证 + 真机 e2e

**Files:** none (verification only)

- [ ] **Step 1: 全量回归**

Run: `npx vitest run > /tmp/tr-full.log 2>&1; echo EXIT=$?; tail -3 /tmp/tr-full.log`
Expected: EXIT=0,全部通过。

- [ ] **Step 2: 双 tsc**

Run: `npm run typecheck && npx tsc -p apps/web/tsconfig.json --noEmit`
Expected: 两个 exit 0。

- [ ] **Step 3: build:web**

Run: `npm run build:web`
Expected: exit 0。

- [ ] **Step 4: PR + Copilot + 合并 + 部署 + 真机 e2e**

- push 分支 → 开 PR → 等 CI + Copilot(重审用 API:`gh api -X POST repos/fancydirty/mediary-scout/pulls/<n>/requested_reviewers -f "reviewers[]=copilot-pull-request-reviewer[bot]"`)→ 逐条判 → squash 合并(带 Co-Authored-By)。
- **Worker 单独部署**:`cd workers/tmdb-proxy && npx wrangler deploy`(作者 CF 账号;Cron 次日 22:00 UTC 首跑,当天前端走反应式回源不受影响)。手动预热可选:`npx wrangler triggers`/dashboard 触发一次 scheduled,或直接 `curl` 三个 feed 一次让 KV 填充。
- Next 侧随实例 `git pull` + `docker compose build web` 部署。
- 真机 e2e(`ssh -fN -L 3399:localhost:3300 media-router-tunnel` + agent-browser):落地 `/` 空态见「近期热门」三 Tab + 海报网格;切 Tab(点热门剧集/动漫)网格更新;点一张海报 → 落到 `?q=<片名>` 结果流。⚠️海报若因 image.tmdb.org 被墙而空,验证网格结构与点击跳转即可(海报代理不在本次范围)。

---

## Self-Review

**Spec coverage:** 榜单三 Tab(Task 4 TRENDING_KINDS)✓;Worker Cron 每日预热 + 白名单(Task 1/2)✓;点击=发起搜索(Task 5 `?q=`)✓;空态挂载/有 query 不渲染(Task 6)✓;失败静默降级(Task 4 getTrending catch→[]、Task 5 null)✓;纯函数 + Worker + seam 测试(Task 1/3/4)✓;海报兜底 + 被墙注记(Task 5/7)✓;Demo 纯读(getTrending 无写,天然安全)✓。
**Placeholder scan:** 无 TBD/TODO;每步含真实代码与命令。
**Type consistency:** `TrendingKind`/`TrendingCard`/`TRENDING_KINDS`/`mapTrendingResults`/`getTrending`/`fetchTmdbList`/`runScheduledRefresh`/`TRENDING_FEEDS` 全程一致;worker `TRENDING_FEEDS` 的 path+query 与 apps/web `TRENDING_KINDS` 的 path+query 逐字对齐(cacheKey 命中的前提)。
