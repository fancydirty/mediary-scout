import { describe, it, expect, vi } from "vitest";
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
    expect(res.headers.get("Allow")).toBe("GET");
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
    // Physical TTL = freshness window + the 14d stale tail kept for outage fallback.
    expect(movieKv.puts[0]?.ttl).toBe(7 * 24 * 60 * 60 + 14 * 24 * 60 * 60);
    expect(tvKv.puts[0]?.ttl).toBe(60 * 60 + 14 * 24 * 60 * 60);
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

describe("handleTmdbProxy — upstream flap absorption (timeout + stale fallback)", () => {
  // 2026-07-16 incident: TMDB's origin flapped for 1h+ — the worker's origin
  // fetch hung with NO timeout, every live-fetch path stalled until the client
  // gave up, and (search having no stale to fall back on) every default-config
  // instance's search crashed. These tests pin the absorption contract.

  /** An origin that never answers but honors AbortSignal — proves the handler
   *  actually wires a timeout signal into originFetch. */
  const hangingFetch: typeof fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      const signal = (init as RequestInit | undefined)?.signal;
      if (!signal) {
        reject(new Error("handler passed no AbortSignal to originFetch"));
        return;
      }
      signal.addEventListener("abort", () => reject(signal.reason));
    });

  function envelope(body: string, freshUntil: number): string {
    return JSON.stringify({ v: 1, freshUntil, body });
  }

  it("cold MISS + hanging origin → fast 504 JSON error, bounded by the injected timeout", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const started = Date.now();
    const res = await handleTmdbProxy({
      request: new Request("https://w.example/search/multi?query=bebop", {
        headers: { Origin: "https://mediaryscout.app" },
      }),
      kv: fakeKv(),
      token: "k",
      originFetch: hangingFetch,
      upstreamTimeoutMs: 20,
    });
    expect(res.status).toBe(504);
    expect(Date.now() - started).toBeLessThan(2000);
    // Exact body: a stable public contract — an enum reason, and NO raw error
    // detail (a public endpoint must not leak internal runtime strings).
    expect(await res.json()).toEqual({ error: "tmdb_upstream_unreachable", reason: "timeout" });
    // The failure must stay debuggable from the landing site (CORS on error branch).
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://mediaryscout.app");
    // Server-side log keeps the failing endpoint + a coarse error kind, and
    // NEVER query values or the raw error string (some runtimes embed the full
    // request URL — and thus user search terms — in error messages).
    const logged = errSpy.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(logged).toContain("search/multi");
    expect(logged).toContain("TimeoutError");
    expect(logged).not.toContain("bebop");
    expect(logged).not.toContain("aborted"); // fragment of the raw message
    errSpy.mockRestore();
  });

  it("stale envelope + failing origin → serves the stale body with X-Cache: STALE", async () => {
    const kv = fakeKv({ "movie/278": envelope('{"id":278}', 1_000) });
    const res = await handleTmdbProxy({
      request: new Request("https://w.example/movie/278"),
      kv,
      token: "k",
      originFetch: hangingFetch,
      upstreamTimeoutMs: 20,
      now: () => 2_000,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Cache")).toBe("STALE");
    expect(await res.json()).toEqual({ id: 278 });
  });

  it("stale envelope + origin 5xx/429 → STALE; semantic 404 passes through instead", async () => {
    for (const status of [500, 503, 429]) {
      const kv = fakeKv({ "movie/278": envelope('{"id":278}', 1_000) });
      const res = await handleTmdbProxy({
        request: new Request("https://w.example/movie/278"),
        kv,
        token: "k",
        originFetch: async () => new Response("upstream sad", { status }),
        now: () => 2_000,
      });
      expect(res.headers.get("X-Cache")).toBe("STALE");
      expect(await res.json()).toEqual({ id: 278 });
    }
    // A real TMDB 404 is an answer, not an outage — never masked by stale data.
    const kv = fakeKv({ "movie/278": envelope('{"id":278}', 1_000) });
    const notFound = await handleTmdbProxy({
      request: new Request("https://w.example/movie/278"),
      kv,
      token: "k",
      originFetch: async () => new Response('{"status_message":"gone"}', { status: 404 }),
      now: () => 2_000,
    });
    expect(notFound.status).toBe(404);
  });

  it("stale envelope + healthy origin → refreshes: MISS response and a rewritten envelope", async () => {
    const kv = fakeKv({ "movie/278": envelope('{"id":1}', 1_000) });
    const res = await handleTmdbProxy({
      request: new Request("https://w.example/movie/278"),
      kv,
      token: "k",
      originFetch: async () => new Response('{"id":2}', { status: 200 }),
      now: () => 2_000,
    });
    expect(res.headers.get("X-Cache")).toBe("MISS");
    expect(await res.json()).toEqual({ id: 2 });
    const stored = JSON.parse((await kv.get("movie/278"))!);
    expect(stored).toMatchObject({ v: 1, body: '{"id":2}' });
    expect(stored.freshUntil).toBe(2_000 + 7 * 24 * 60 * 60 * 1000);
  });

  it("fresh envelope → HIT without touching origin", async () => {
    const kv = fakeKv({ "movie/278": envelope('{"id":278}', 10_000) });
    let originCalls = 0;
    const res = await handleTmdbProxy({
      request: new Request("https://w.example/movie/278"),
      kv,
      token: "k",
      originFetch: async () => {
        originCalls += 1;
        return new Response("{}", { status: 200 });
      },
      now: () => 2_000,
    });
    expect(res.headers.get("X-Cache")).toBe("HIT");
    expect(await res.json()).toEqual({ id: 278 });
    expect(originCalls).toBe(0);
  });

  it("legacy raw KV value (pre-envelope) still serves as HIT", async () => {
    const kv = fakeKv({ "movie/278": '{"id":278}' });
    const res = await handleTmdbProxy({
      request: new Request("https://w.example/movie/278"),
      kv,
      token: "k",
      originFetch: async () => new Response("SHOULD_NOT_FETCH", { status: 500 }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Cache")).toBe("HIT");
    expect(await res.json()).toEqual({ id: 278 });
  });

  it("a successful MISS writes an envelope whose physical TTL = fresh TTL + 14d stale tail", async () => {
    const kv = fakeKv();
    await handleTmdbProxy({
      request: new Request("https://w.example/movie/278"),
      kv,
      token: "k",
      originFetch: async () => new Response('{"id":278}', { status: 200 }),
      now: () => 2_000,
    });
    expect(kv.puts[0]?.ttl).toBe(7 * 24 * 60 * 60 + 14 * 24 * 60 * 60);
    const stored = JSON.parse((await kv.get("movie/278"))!);
    expect(stored).toMatchObject({ v: 1, body: '{"id":278}' });
  });

  it("/img with a hanging origin → fast 502, no-store", async () => {
    const started = Date.now();
    const res = await handleTmdbProxy({
      request: new Request("https://w.example/img/t/p/w342/abc.jpg"),
      kv: fakeKv(),
      token: "k",
      originFetch: hangingFetch,
      upstreamTimeoutMs: 20,
    });
    expect(res.status).toBe(502);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
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
      expect(put.ttl).toBe(25 * 60 * 60 + 14 * 24 * 60 * 60);
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
    expect(kv.puts[0]?.ttl).toBe(25 * 60 * 60 + 14 * 24 * 60 * 60);

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
    expect(animeKv.puts[0]?.ttl).toBe(25 * 60 * 60 + 14 * 24 * 60 * 60);

    // A non-feed discover/tv call keeps its ordinary short TTL (feed-specific, not
    // a blanket discover override).
    const other = fakeKv();
    await handleTmdbProxy({
      request: new Request("https://w.example/discover/tv?with_genres=99"),
      kv: other,
      token: "k",
      originFetch: async () => new Response("{}", { status: 200 }),
    });
    expect(other.puts[0]?.ttl).toBe(60 * 60 + 14 * 24 * 60 * 60);
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

describe("poster image proxy", () => {
  it("proxies an allowlisted poster path, passing body/Content-Type through with an immutable Cache-Control", async () => {
    let seenUrl = "";
    const res = await handleTmdbProxy({
      request: new Request("https://w.example/img/t/p/w342/abc123.jpg"),
      kv: fakeKv(),
      token: "authorkey",
      originFetch: async (url) => {
        seenUrl = String(url);
        return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), {
          status: 200,
          headers: { "Content-Type": "image/jpeg" },
        });
      },
    });
    expect(res.status).toBe(200);
    expect(seenUrl).toBe("https://image.tmdb.org/t/p/w342/abc123.jpg");
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]));
  });

  it("rejects sizes outside the allowlist (original, w9999) with 404 and never hits origin", async () => {
    let originCalls = 0;
    const originFetch: typeof fetch = async () => {
      originCalls += 1;
      return new Response("nope", { status: 200 });
    };
    for (const path of ["/img/t/p/original/abc.jpg", "/img/t/p/w9999/abc.jpg"]) {
      const res = await handleTmdbProxy({
        request: new Request(`https://w.example${path}`),
        kv: fakeKv(),
        token: "k",
        originFetch,
      });
      expect(res.status).toBe(404);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    }
    expect(originCalls).toBe(0);
  });

  it("rejects path shenanigans (traversal, non-t/p shapes) with 404 and never hits origin", async () => {
    let originCalls = 0;
    const originFetch: typeof fetch = async () => {
      originCalls += 1;
      return new Response("nope", { status: 200 });
    };
    for (const path of ["/img/t/p/w342/../../secret", "/img/x/y/z.jpg"]) {
      const res = await handleTmdbProxy({
        request: new Request(`https://w.example${path}`),
        kv: fakeKv(),
        token: "k",
        originFetch,
      });
      expect(res.status).toBe(404);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    }
    expect(originCalls).toBe(0);
  });

  it("rejects POST to an img path with 405 (existing method gate fires first)", async () => {
    const res = await handleTmdbProxy({
      request: new Request("https://w.example/img/t/p/w342/abc.jpg", { method: "POST" }),
      kv: fakeKv(),
      token: "k",
      originFetch: async () => new Response("nope", { status: 200 }),
    });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET");
  });

  it("allows underscores in filenames (future-proofing)", async () => {
    let seenUrl = "";
    const res = await handleTmdbProxy({
      request: new Request("https://w.example/img/t/p/w342/abc_123.jpg"),
      kv: fakeKv(),
      token: "k",
      originFetch: async (url) => {
        seenUrl = String(url);
        return new Response(new Uint8Array([0xff]), { status: 200 });
      },
    });
    expect(res.status).toBe(200);
    expect(seenUrl).toBe("https://image.tmdb.org/t/p/w342/abc_123.jpg");
  });

  it("does NOT cache non-OK image responses (no-store, not immutable)", async () => {
    const res = await handleTmdbProxy({
      request: new Request("https://w.example/img/t/p/w342/valid_shape.jpg"),
      kv: fakeKv(),
      token: "k",
      originFetch: async () => new Response("nope", { status: 404 }),
    });
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("CORS for the landing site", () => {
  it("echoes an allowlisted Origin and sets Vary: Origin", async () => {
    // build deps exactly like neighboring tests do, with KV pre-seeded:
    // key "trending/movie/week?language=zh-CN" -> "{\"ok\":1}"
    const kv = fakeKv({ "trending/movie/week?language=zh-CN": '{"ok":1}' });
    const res = await handleTmdbProxy({
      request: new Request("https://w.example/trending/movie/week?language=zh-CN", {
        headers: { Origin: "https://mediary.dirtyfancy.sbs" },
      }),
      kv,
      token: "t",
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://mediary.dirtyfancy.sbs");
    expect(res.headers.get("Vary")).toBe("Origin");
  });

  it("does NOT set CORS for an unknown Origin, but still varies on Origin", async () => {
    const kv = fakeKv({ "trending/movie/week?language=zh-CN": '{"ok":1}' });
    const res = await handleTmdbProxy({
      request: new Request("https://w.example/trending/movie/week?language=zh-CN", {
        headers: { Origin: "https://evil.example" },
      }),
      kv,
      token: "t",
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    // CORS spec: caches must be told the response varies by Origin even when
    // no ACAO is emitted, else a cached no-ACAO response poisons allowed origins.
    expect(res.headers.get("Vary")).toBe("Origin");
  });

  it("sets CORS on the MISS path too (cold KV, allowlisted Origin)", async () => {
    const res = await handleTmdbProxy({
      request: new Request("https://w.example/trending/movie/week?language=zh-CN", {
        headers: { Origin: "https://mediary.dirtyfancy.sbs" },
      }),
      kv: fakeKv(),
      token: "t",
      originFetch: async () => new Response('{"ok":1}', { status: 200 }),
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://mediary.dirtyfancy.sbs");
    expect(res.headers.get("Vary")).toBe("Origin");
  });

  it("sets neither ACAO nor Vary when the request has no Origin header", async () => {
    const kv = fakeKv({ "trending/movie/week?language=zh-CN": '{"ok":1}' });
    const res = await handleTmdbProxy({
      request: new Request("https://w.example/trending/movie/week?language=zh-CN"),
      kv,
      token: "t",
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(res.headers.get("Vary")).toBeNull();
  });

  it("echoes ACAO + Vary on the 405 branch for an allowlisted Origin (inspectable error, not an opaque CORS TypeError)", async () => {
    const res = await handleTmdbProxy({
      request: new Request("https://w.example/movie/278", {
        method: "POST",
        headers: { Origin: "https://mediary.dirtyfancy.sbs" },
      }),
      kv: fakeKv(),
      token: "t",
      originFetch: async () => new Response("{}"),
    });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://mediary.dirtyfancy.sbs");
    expect(res.headers.get("Vary")).toBe("Origin");
  });

  it("echoes ACAO + Vary on the 404 branch for an allowlisted Origin hitting a non-allowlisted path", async () => {
    const res = await handleTmdbProxy({
      request: new Request("https://w.example/account/secret", {
        headers: { Origin: "https://mediary.dirtyfancy.sbs" },
      }),
      kv: fakeKv(),
      token: "t",
      originFetch: async () => new Response("{}"),
    });
    expect(res.status).toBe(404);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://mediary.dirtyfancy.sbs");
    expect(res.headers.get("Vary")).toBe("Origin");
  });

  it("echoes ACAO for the new mediaryscout.app origin (domain migration)", async () => {
    const kv = fakeKv({ "trending/movie/week?language=zh-CN": '{"ok":1}' });
    const res = await handleTmdbProxy({
      request: new Request("https://w.example/trending/movie/week?language=zh-CN", {
        headers: { Origin: "https://mediaryscout.app" },
      }),
      kv,
      token: "t",
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://mediaryscout.app");
    expect(res.headers.get("Vary")).toBe("Origin");
  });

  it("sets neither ACAO nor Vary on a 404 when the request has no Origin header", async () => {
    const res = await handleTmdbProxy({
      request: new Request("https://w.example/account/secret"),
      kv: fakeKv(),
      token: "t",
      originFetch: async () => new Response("{}"),
    });
    expect(res.status).toBe(404);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(res.headers.get("Vary")).toBeNull();
  });
});
