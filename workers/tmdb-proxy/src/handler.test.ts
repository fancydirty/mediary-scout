import { describe, it, expect } from "vitest";
import { handleTmdbProxy, type KvLike } from "./handler";

function fakeKv(initial: Record<string, string> = {}): KvLike & { puts: Array<{ key: string; ttl?: number }> } {
  const store = new Map(Object.entries(initial));
  const puts: Array<{ key: string; ttl?: number }> = [];
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
