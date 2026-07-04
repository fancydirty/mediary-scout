import { describe, it, expect } from "vitest";
import { getTrendingFeeds, handleTmdbProxy, runScheduledRefresh, type KvLike } from "./handler";

function fakeKv(initial: Record<string, string> = {}): KvLike & { puts: Array<{ key: string; ttl: number | undefined }> } {
  const store = new Map(Object.entries(initial));
  const puts: Array<{ key: string; ttl: number | undefined }> = [];
  return {
    puts,
    async get(key) {
      return store.get(key) ?? null;
    },
    async put(key, value, options) {
      store.set(key, value);
      puts.push({ key, ttl: options?.expirationTtl });
    },
  };
}

describe("handleTmdbProxy — proxy & guards", () => {
  it("rejects non-GET with 405", async () => {
    const res = await handleTmdbProxy({
      request: new Request("https://w.example/movie/278", { method: "POST" }),
      kv: fakeKv(),
      token: "authorkey",
      originFetch: async () => new Response("{}"),
    });
    expect(res.status).toBe(405);
  });

  it("rejects non-allowlisted paths with 404", async () => {
    const res = await handleTmdbProxy({
      request: new Request("https://w.example/account/secret"),
      kv: fakeKv(),
      token: "authorkey",
      originFetch: async () => new Response("{}"),
    });
    expect(res.status).toBe(404);
  });

  it("proxies an allowlisted path, injecting the author bearer token", async () => {
    let seenUrl = "";
    let seenAuth = "";
    const res = await handleTmdbProxy({
      request: new Request("https://w.example/movie/278?language=zh-CN"),
      kv: fakeKv(),
      token: "authorkey",
      originFetch: async (url, init) => {
        seenUrl = String(url);
        seenAuth = (init?.headers as Record<string, string>)?.Authorization ?? "";
        return new Response(JSON.stringify({ id: 278 }), { status: 200 });
      },
    });
    expect(res.status).toBe(200);
    expect(seenUrl).toBe("https://api.themoviedb.org/3/movie/278?language=zh-CN");
    expect(seenAuth).toBe("Bearer authorkey");
    expect(await res.json()).toEqual({ id: 278 });
  });

  it("passes through TMDB non-2xx without caching", async () => {
    const kv = fakeKv();
    const res = await handleTmdbProxy({
      request: new Request("https://w.example/movie/278"),
      kv,
      token: "authorkey",
      originFetch: async () => new Response('{"status_message":"invalid"}', { status: 401 }),
    });
    expect(res.status).toBe(401);
    expect(kv.puts).toHaveLength(0);
  });
});

describe("handleTmdbProxy — KV cache", () => {
  it("caches a 2xx body and serves the second call from KV without hitting origin", async () => {
    const kv = fakeKv();
    let originCalls = 0;
    const call = () =>
      handleTmdbProxy({
        request: new Request("https://w.example/movie/278?language=zh-CN"),
        kv,
        token: "authorkey",
        originFetch: async () => {
          originCalls += 1;
          return new Response(JSON.stringify({ id: 278 }), { status: 200 });
        },
      });

    const first = await call();
    expect(first.headers.get("X-Cache")).toBe("MISS");
    const second = await call();
    expect(second.headers.get("X-Cache")).toBe("HIT");
    expect(await second.json()).toEqual({ id: 278 });
    expect(originCalls).toBe(1);
  });

  it("uses a long TTL for movie paths and a short TTL for tv paths", async () => {
    const movieKv = fakeKv();
    await handleTmdbProxy({
      request: new Request("https://w.example/movie/278"),
      kv: movieKv,
      token: "k",
      originFetch: async () => new Response("{}", { status: 200 }),
    });
    const tvKv = fakeKv();
    await handleTmdbProxy({
      request: new Request("https://w.example/tv/1399/season/1"),
      kv: tvKv,
      token: "k",
      originFetch: async () => new Response("{}", { status: 200 }),
    });
    expect(movieKv.puts[0]?.ttl).toBe(7 * 24 * 60 * 60);
    expect(tvKv.puts[0]?.ttl).toBe(60 * 60);
  });

  it("normalizes query order so the cache key is stable", async () => {
    const kv = fakeKv();
    let originCalls = 0;
    const fetchOnce: typeof fetch = async () => {
      originCalls += 1;
      return new Response("{}", { status: 200 });
    };
    await handleTmdbProxy({ request: new Request("https://w.example/movie/1?a=1&b=2"), kv, token: "k", originFetch: fetchOnce });
    await handleTmdbProxy({ request: new Request("https://w.example/movie/1?b=2&a=1"), kv, token: "k", originFetch: fetchOnce });
    expect(originCalls).toBe(1);
  });
});

describe("trending discovery", () => {
  it("anime feed = recent (first_air_date rolls to <year-1>-01-01) + vote_count.gte=50, matching the frontend", () => {
    const now = new Date("2026-07-04T00:00:00Z");
    const feeds = getTrendingFeeds(now);
    expect(feeds[0]).toBe("trending/movie/week?language=zh-CN");
    expect(feeds[1]).toBe("trending/tv/week?language=zh-CN");
    const animeParams = new URL(`https://x/${feeds[2]}`).searchParams;
    expect(animeParams.get("first_air_date.gte")).toBe("2025-01-01");
    expect(animeParams.get("vote_count.gte")).toBe("50");
    expect(animeParams.get("include_adult")).toBe("false");
    expect(animeParams.get("with_original_language")).toBe("ja");
    expect(animeParams.get("with_genres")).toBe("16");
    expect(animeParams.get("sort_by")).toBe("popularity.desc");
  });

  it("allows the trending/ prefix (was 404)", async () => {
    const res = await handleTmdbProxy({
      request: new Request("https://w.example/trending/movie/week?language=zh-CN"),
      kv: fakeKv(),
      token: "k",
      originFetch: async () => new Response(JSON.stringify({ results: [] }), { status: 200 }),
    });
    expect(res.status).toBe(200);
  });

  it("runScheduledRefresh writes every feed to KV under its cacheKey with a 25h TTL, and the frontend then reads a HIT", async () => {
    const kv = fakeKv();
    await runScheduledRefresh({
      kv,
      token: "k",
      originFetch: async () => new Response(JSON.stringify({ results: [{ id: 1 }] }), { status: 200 }),
    });
    expect(kv.puts).toHaveLength(getTrendingFeeds().length);
    for (const put of kv.puts) {
      expect(put.ttl).toBe(25 * 60 * 60);
    }
    expect(kv.puts[0]!.key.startsWith("trending/movie/week")).toBe(true);

    // A subsequent frontend request for the same feed must serve the warmed KV
    // entry WITHOUT hitting origin — proving the Cron key === proxy key.
    const hit = await handleTmdbProxy({
      request: new Request(`https://w.example/${getTrendingFeeds()[0]}`),
      kv,
      token: "k",
      originFetch: async () => new Response("SHOULD_NOT_FETCH", { status: 500 }),
    });
    expect(hit.status).toBe(200);
    expect(hit.headers.get("X-Cache")).toBe("HIT");
  });

  it("a reactive MISS on a trending feed caches with the 25h TTL, not the 1h short TTL", async () => {
    // Cold KV (cron delayed / right after deploy): the feed is fetched reactively.
    // It must still get the daily-cadence TTL, else the proxy re-hits TMDB hourly.
    const kv = fakeKv();
    await handleTmdbProxy({
      request: new Request(`https://w.example/${getTrendingFeeds()[1]}`), // trending/tv/week
      kv,
      token: "k",
      originFetch: async () => new Response(JSON.stringify({ results: [] }), { status: 200 }),
    });
    expect(kv.puts[0]?.ttl).toBe(25 * 60 * 60);

    // The DYNAMIC anime feed (first_air_date.gte rolls yearly) must get the same
    // daily TTL on a reactive MISS — isTrendingFeedRequest recomputes the feeds,
    // so the rolling date must still be recognized as a trending feed.
    const animeKv = fakeKv();
    await handleTmdbProxy({
      request: new Request(`https://w.example/${getTrendingFeeds()[2]}`), // discover/tv anime
      kv: animeKv,
      token: "k",
      originFetch: async () => new Response(JSON.stringify({ results: [] }), { status: 200 }),
    });
    expect(animeKv.puts[0]?.ttl).toBe(25 * 60 * 60);

    // A non-feed discover/tv call keeps its ordinary short TTL (feed-specific, not
    // a blanket discover override).
    const other = fakeKv();
    await handleTmdbProxy({
      request: new Request("https://w.example/discover/tv?with_genres=99"),
      kv: other,
      token: "k",
      originFetch: async () => new Response("{}", { status: 200 }),
    });
    expect(other.puts[0]?.ttl).toBe(60 * 60);
  });

  it("runScheduledRefresh skips a feed whose origin fetch fails (never aborts the rest)", async () => {
    const kv = fakeKv();
    await runScheduledRefresh({
      kv,
      token: "k",
      originFetch: async () => new Response("nope", { status: 500 }),
    });
    expect(kv.puts).toHaveLength(0);
  });
});
