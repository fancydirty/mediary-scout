import { describe, expect, it, vi } from "vitest";
import { DriveDownloadLinkCache } from "@media-track/workflow";
import { streamProxiedDownload } from "./virtual-emby-proxy";

describe("streamProxiedDownload (zero-buffering Range proxy)", () => {
  it("passes Range header, preserves 206 Partial Content & Content-Range, and supports HEAD", async () => {
    let capturedHeaders: Record<string, string> = {};
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      capturedHeaders = (init.headers ?? {}) as Record<string, string>;
      return new Response("0123456789", {
        status: 206,
        headers: {
          "Content-Type": "video/x-matroska",
          "Content-Length": "10",
          "Content-Range": "bytes 0-9/1000",
          "Accept-Ranges": "bytes",
        },
      });
    });

    const res = await streamProxiedDownload({
      method: "GET",
      rangeHeader: "bytes=0-9",
      link: {
        url: "https://dl.quark.example/file.mkv",
        headers: { Cookie: "__puus=fresh", Referer: "https://pan.quark.cn/" },
        supportsRedirect: false,
        fileName: "Movie.mkv",
      },
      storageId: "cs_qk",
      fileId: "fid1",
      resolveFreshLink: vi.fn(),
      cache: new DriveDownloadLinkCache(),
      fetchImpl,
    });

    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 0-9/1000");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(capturedHeaders["Range"]).toBe("bytes=0-9");
    expect(capturedHeaders["Cookie"]).toBe("__puus=fresh");
    expect(await res.text()).toBe("0123456789");

    // HEAD returns headers with null body
    const headRes = await streamProxiedDownload({
      method: "HEAD",
      rangeHeader: null,
      link: {
        url: "https://dl.quark.example/file.mkv",
        headers: {},
        supportsRedirect: false,
      },
      storageId: "cs_qk",
      fileId: "fid1",
      resolveFreshLink: vi.fn(),
      cache: new DriveDownloadLinkCache(),
      fetchImpl,
    });
    expect(headRes.status).toBe(206);
    expect(headRes.body).toBeNull();
  });

  it("evicts link cache and retries once on upstream 403/412 (expired signed URL / rotated __puus)", async () => {
    const cache = new DriveDownloadLinkCache();
    cache.set("cs_qk\u0000fid1\u0000*", {
      url: "https://dl.quark.example/stale",
      headers: { Cookie: "__puus=stale" },
      supportsRedirect: false,
    });

    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url);
      if (url.endsWith("/stale")) {
        return new Response("Forbidden", { status: 412 });
      }
      return new Response("fresh-bytes", {
        status: 206,
        headers: { "Content-Range": "bytes 0-10/100" },
      });
    });

    const resolveFreshLink = vi.fn(async () => ({
      url: "https://dl.quark.example/fresh",
      headers: { Cookie: "__puus=new" },
      supportsRedirect: false,
    }));

    const res = await streamProxiedDownload({
      method: "GET",
      rangeHeader: "bytes=0-10",
      link: {
        url: "https://dl.quark.example/stale",
        headers: { Cookie: "__puus=stale" },
        supportsRedirect: false,
      },
      storageId: "cs_qk",
      fileId: "fid1",
      resolveFreshLink,
      cache,
      fetchImpl,
    });

    expect(res.status).toBe(206);
    expect(await res.text()).toBe("fresh-bytes");
    expect(resolveFreshLink).toHaveBeenCalledTimes(1);
    expect(urls).toEqual(["https://dl.quark.example/stale", "https://dl.quark.example/fresh"]);
  });

  it("propagates client AbortSignal immediately to upstream fetch", async () => {
    const clientAbort = new AbortController();
    let upstreamAborted = false;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      return await new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          upstreamAborted = true;
          reject(new Error("aborted"));
        });
      });
    });

    const promise = streamProxiedDownload({
      method: "GET",
      rangeHeader: "bytes=0-",
      signal: clientAbort.signal,
      link: { url: "https://dl.quark.example/big.mkv", headers: {}, supportsRedirect: false },
      storageId: "cs_qk",
      fileId: "fid1",
      resolveFreshLink: vi.fn(),
      cache: new DriveDownloadLinkCache(),
      fetchImpl,
    });

    clientAbort.abort();
    await expect(promise).rejects.toThrow(/aborted/);
    expect(upstreamAborted).toBe(true);
  });

  it("blocks active HTML/SVG responses (XSS isolation) and aborts upstream on downstream stream cancel", async () => {
    // 1. Upstream 500 returning HTML error page -> replaced with plain text + nosniff + sandbox CSP
    const htmlErrRes = await streamProxiedDownload({
      method: "GET",
      rangeHeader: null,
      link: { url: "https://dl.quark.example/err.mkv", headers: {}, supportsRedirect: false, fileName: "a.mkv" },
      storageId: "cs_qk",
      fileId: "fid_err",
      resolveFreshLink: vi.fn(),
      cache: new DriveDownloadLinkCache(),
      fetchImpl: vi.fn(async () =>
        new Response("<script>alert(1)</script>", {
          status: 500,
          headers: { "Content-Type": "text/html" },
        }),
      ),
    });
    expect(htmlErrRes.status).toBe(500);
    expect(htmlErrRes.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(htmlErrRes.headers.get("x-content-type-options")).toBe("nosniff");
    expect(htmlErrRes.headers.get("content-security-policy")).toBe("sandbox");
    expect(await htmlErrRes.text()).not.toContain("<script>");

    // 2. Upstream 200 falsely tagged text/html -> rewritten to safe video MIME + nosniff + sandbox
    const htmlMediaRes = await streamProxiedDownload({
      method: "GET",
      rangeHeader: null,
      link: { url: "https://dl.quark.example/vid.mp4", headers: {}, supportsRedirect: false, fileName: "vid.mp4" },
      storageId: "cs_qk",
      fileId: "fid_media",
      resolveFreshLink: vi.fn(),
      cache: new DriveDownloadLinkCache(),
      fetchImpl: vi.fn(async () =>
        new Response("mp4bytes", {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }),
      ),
    });
    expect(htmlMediaRes.headers.get("content-type")).toBe("video/mp4");
    expect(htmlMediaRes.headers.get("x-content-type-options")).toBe("nosniff");
    expect(htmlMediaRes.headers.get("content-security-policy")).toBe("sandbox");

    // 3. Downstream body.cancel() aborts upstream controller immediately
    let aborted = false;
    const cancelRes = await streamProxiedDownload({
      method: "GET",
      rangeHeader: "bytes=0-",
      link: { url: "https://dl.quark.example/stream.mkv", headers: {}, supportsRedirect: false },
      storageId: "cs_qk",
      fileId: "fid_cancel",
      resolveFreshLink: vi.fn(),
      cache: new DriveDownloadLinkCache(),
      fetchImpl: vi.fn(async (_u: string, init: RequestInit) => {
        init.signal?.addEventListener("abort", () => {
          aborted = true;
        });
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new Uint8Array([1, 2, 3]));
          },
        });
        return new Response(stream, { status: 206 });
      }),
    });
    await cancelRes.body?.cancel("player seeked");
    expect(aborted).toBe(true);

    // 4. Redirect to internal/private host is blocked by SSRF guard
    await expect(
      streamProxiedDownload({
        method: "GET",
        rangeHeader: null,
        link: { url: "https://dl.quark.example/redir.mkv", headers: {}, supportsRedirect: false },
        storageId: "cs_qk",
        fileId: "fid_ssrf",
        resolveFreshLink: vi.fn(),
        cache: new DriveDownloadLinkCache(),
        fetchImpl: vi.fn(async () =>
          new Response(null, { status: 302, headers: { Location: "http://127.0.0.1:8080/admin" } }),
        ),
      }),
    ).rejects.toThrow(/private\/internal/);

    // 5. Cross-origin redirect strips Cookie/Authorization headers, and 304 is terminal (not treated as redirect error)
    const seenHeaders: Array<Record<string, string>> = [];
    const crossOriginRes = await streamProxiedDownload({
      method: "GET",
      rangeHeader: "bytes=0-3",
      link: {
        url: "https://origin-a.example/file.mkv",
        headers: { Cookie: "__puus=secret", Authorization: "Bearer tok", "User-Agent": "Quark" },
        supportsRedirect: false,
      },
      storageId: "cs_qk",
      fileId: "fid_xorigin",
      resolveFreshLink: vi.fn(),
      cache: new DriveDownloadLinkCache(),
      fetchImpl: vi.fn(async (url: string, init: RequestInit) => {
        seenHeaders.push({ ...((init.headers ?? {}) as Record<string, string>) });
        if (url.startsWith("https://origin-a.example")) {
          return new Response(null, { status: 302, headers: { Location: "https://origin-b.example/cdn.mkv" } });
        }
        return new Response("abcd", { status: 206, headers: { "Content-Range": "bytes 0-3/10" } });
      }),
    });
    expect(crossOriginRes.status).toBe(206);
    expect(seenHeaders[0]?.["Cookie"]).toBe("__puus=secret");
    expect(seenHeaders[1]?.["Cookie"]).toBeUndefined();
    expect(seenHeaders[1]?.["Authorization"]).toBeUndefined();
    expect(seenHeaders[1]?.["User-Agent"]).toBe("Quark");

    const notModifiedRes = await streamProxiedDownload({
      method: "GET",
      rangeHeader: null,
      link: { url: "https://dl.quark.example/cached.mkv", headers: {}, supportsRedirect: false },
      storageId: "cs_qk",
      fileId: "fid_304",
      resolveFreshLink: vi.fn(),
      cache: new DriveDownloadLinkCache(),
      fetchImpl: vi.fn(async () => new Response(null, { status: 304 })),
    });
    expect(notModifiedRes.status).toBe(304);
  });

  it("propagates client AbortSignal into resolveFreshLink during 403/412/404 link refresh", async () => {
    const clientAbort = new AbortController();
    let refreshSignalAborted = false;
    let notifyRefreshStarted!: () => void;
    const refreshStarted = new Promise<void>((resolve) => {
      notifyRefreshStarted = resolve;
    });

    const promise = streamProxiedDownload({
      method: "GET",
      rangeHeader: "bytes=0-10",
      signal: clientAbort.signal,
      link: { url: "https://dl.quark.example/expired.mkv", headers: {}, supportsRedirect: false },
      storageId: "cs_qk",
      fileId: "fid_refresh_abort",
      cache: new DriveDownloadLinkCache(),
      fetchImpl: vi.fn(async () => new Response("Forbidden", { status: 403 })),
      resolveFreshLink: (signal) => {
        notifyRefreshStarted();
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              refreshSignalAborted = true;
              reject(new Error("refresh aborted"));
            },
            { once: true },
          );
        });
      },
    });

    await refreshStarted;
    clientAbort.abort(new Error("client closed tab"));
    await expect(promise).rejects.toThrow(/client closed tab|refresh aborted/);
    expect(refreshSignalAborted).toBe(true);
  });
});
