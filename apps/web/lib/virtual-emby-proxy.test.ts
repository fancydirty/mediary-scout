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
});
