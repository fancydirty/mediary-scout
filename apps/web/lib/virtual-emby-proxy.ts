/**
 * Zero-buffering HTTP Range proxy + singleton download-link cache for Virtual Emby.
 *
 * Design invariants (verified against live Quark/UC CDNs + peach-study §5):
 *  1. NEVER buffer video bytes in memory (stream chunks directly from upstream reader).
 *  2. Propagate incoming `request.signal` AND downstream body cancellation into an
 *     upstream `AbortController` so seeking or closing the player cancels upstream TCP
 *     downloads immediately and detaches listeners cleanly.
 *  3. Forward exact `Range` headers and preserve upstream `200` / `206` / `416`
 *     responses and `Content-Range` / `Content-Length` / `Accept-Ranges` headers.
 *  4. Self-heal on stale signed CDN links / rotated `__puus` cookies: if upstream
 *     answers `403`, `412`, or `404`, cancel its body, invalidate the link cache,
 *     resolve a fresh download link ONCE, and retry (or let `DriveFileNotFoundError`
 *     bubble to the route for tombstoning + sibling-drive failover).
 *  5. Connection-time SSRF enforcement: validate initial URL and every manual redirect
 *     hop via `assertSafeExternalHttpUrl` AND connect through a dedicated non-keepalive
 *     undici Agent using `createGuardedDnsLookup` so DNS rebinding cannot reach private IPs.
 *  6. Isolate active web content: never serve upstream HTML/SVG/JS error pages inline
 *     on the application origin (`nosniff` + `sandbox` CSP + safe media Content-Type).
 */
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from "undici";
import {
  assertSafeExternalHttpUrl,
  buildDriveDownloadCacheKey,
  createGuardedDnsLookup,
  DriveDownloadLinkCache,
  type ConnectedStorage,
  type DriveDownloadLink,
} from "@media-track/workflow";
import { createPlaybackExecutorForStorage } from "./workflow-runtime";

const PROXY_CONNECT_TIMEOUT_MS = 25_000;
const MAX_PROXY_REDIRECT_HOPS = 5;

const UNSAFE_INLINE_CONTENT_TYPE_RE =
  /^(?:text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/javascript|application\/javascript|application\/ecmascript|text\/xml|application\/xml)\b/i;

const globalForVirtualEmby = globalThis as typeof globalThis & {
  __mediaryDownloadLinkCache?: DriveDownloadLinkCache;
  __mediaryGuardedProxyAgent?: Agent;
};

export function getDownloadLinkCache(): DriveDownloadLinkCache {
  if (!globalForVirtualEmby.__mediaryDownloadLinkCache) {
    globalForVirtualEmby.__mediaryDownloadLinkCache = new DriveDownloadLinkCache();
  }
  return globalForVirtualEmby.__mediaryDownloadLinkCache;
}

function getGuardedProxyAgent(): Agent {
  if (!globalForVirtualEmby.__mediaryGuardedProxyAgent) {
    // Dedicated non-keepalive agent: every upstream media connection passes through
    // `createGuardedDnsLookup`, closing both pooled-socket bypass and DNS-rebinding windows.
    globalForVirtualEmby.__mediaryGuardedProxyAgent = new Agent({
      keepAliveTimeout: 1,
      keepAliveMaxTimeout: 1,
      pipelining: 0,
      connect: {
        lookup: createGuardedDnsLookup("VIRTUAL_EMBY_PROXY"),
      },
    });
  }
  return globalForVirtualEmby.__mediaryGuardedProxyAgent;
}

/** Resolve a drive download link through the shared singleflight TTL cache. */
export async function resolveCachedDriveDownloadLink(input: {
  storage: ConnectedStorage;
  fileId: string;
  userAgent?: string;
  cache?: DriveDownloadLinkCache;
}): Promise<DriveDownloadLink> {
  const cache = input.cache ?? getDownloadLinkCache();
  const key = buildDriveDownloadCacheKey({
    storageId: input.storage.id,
    provider: input.storage.provider,
    fileId: input.fileId,
    ...(input.userAgent ? { userAgent: input.userAgent } : {}),
  });
  return cache.getOrResolve(key, async () => {
    const executor = createPlaybackExecutorForStorage(input.storage);
    if (!executor.getDownloadUrl) {
      throw new Error(`Storage provider ${input.storage.provider} does not support direct playback`);
    }
    return executor.getDownloadUrl({
      fileId: input.fileId,
      ...(input.userAgent ? { userAgent: input.userAgent } : {}),
    });
  });
}

export type ProxyFetchFn = (url: string, init: RequestInit) => Promise<Response>;

async function defaultGuardedProxyFetch(url: string, init: RequestInit): Promise<Response> {
  const dispatcher = getGuardedProxyAgent();
  const res = await undiciFetch(url, {
    ...(init as unknown as UndiciRequestInit),
    dispatcher,
  });
  return res as unknown as Response;
}

/** Stream a non-redirectable cloud CDN file (Quark / UC) with full Range + HEAD + Abort propagation. */
export async function streamProxiedDownload(input: {
  method: string;
  rangeHeader: string | null;
  signal?: AbortSignal;
  link: DriveDownloadLink;
  storageId: string;
  fileId: string;
  resolveFreshLink: (signal: AbortSignal) => Promise<DriveDownloadLink>;
  cache?: DriveDownloadLinkCache;
  fetchImpl?: ProxyFetchFn;
  corsHeaders?: Record<string, string>;
}): Promise<Response> {
  const fetchImpl = input.fetchImpl ?? defaultGuardedProxyFetch;
  const cache = input.cache ?? getDownloadLinkCache();
  const isHead = input.method.toUpperCase() === "HEAD";

  const startupDeadline = Date.now() + PROXY_CONNECT_TIMEOUT_MS;

  const stripCredentialsOnCrossOrigin = (
    headers: Record<string, string>,
  ): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      const lower = k.toLowerCase();
      if (lower === "cookie" || lower === "authorization" || lower === "proxy-authorization") {
        continue;
      }
      out[k] = v;
    }
    return out;
  };

  const attemptFetch = async (
    targetLink: DriveDownloadLink,
    deadlineMs: number,
  ): Promise<{ upstream: Response; controller: AbortController; cleanup: () => void }> => {
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) {
      throw new Error("Upstream CDN response headers timed out");
    }
    const controller = new AbortController();
    const onClientAbort = () => controller.abort(input.signal?.reason);
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (input.signal) {
        input.signal.removeEventListener("abort", onClientAbort);
      }
    };
    if (input.signal) {
      if (input.signal.aborted) {
        controller.abort(input.signal.reason);
      } else {
        input.signal.addEventListener("abort", onClientAbort, { once: true });
      }
    }
    const connectTimer = setTimeout(() => {
      controller.abort(new Error("Upstream CDN response headers timed out"));
    }, remainingMs);

    try {
      let headers: Record<string, string> = { ...targetLink.headers };
      if (input.rangeHeader) {
        headers["Range"] = input.rangeHeader;
      }
      // Follow redirects manually so every intermediate Location is validated by SSRF rules,
      // and strip Cookie/Authorization headers on cross-origin redirects.
      // Always GET upstream (some Chinese cloud CDNs reject HEAD with 403/405);
      // for client HEAD requests we read headers and immediately cancel the body.
      let currentUrl = assertSafeExternalHttpUrl(targetLink.url, "VIRTUAL_EMBY_PROXY");
      let currentOrigin = new URL(currentUrl).origin;
      let upstream: Response | null = null;
      for (let hop = 0; hop <= MAX_PROXY_REDIRECT_HOPS; hop += 1) {
        const res = await fetchImpl(currentUrl, {
          method: "GET",
          headers,
          redirect: "manual",
          signal: controller.signal,
        });
        const isRedirect =
          res.status === 301 ||
          res.status === 302 ||
          res.status === 303 ||
          res.status === 307 ||
          res.status === 308;
        if (isRedirect) {
          const location = res.headers.get("location")?.trim();
          await res.body?.cancel().catch(() => undefined);
          if (!location || hop === MAX_PROXY_REDIRECT_HOPS) {
            throw new Error("VIRTUAL_EMBY_PROXY: invalid or excessive redirects from upstream CDN");
          }
          const nextUrl = assertSafeExternalHttpUrl(new URL(location, currentUrl).toString(), "VIRTUAL_EMBY_PROXY");
          const nextOrigin = new URL(nextUrl).origin;
          if (nextOrigin !== currentOrigin) {
            headers = stripCredentialsOnCrossOrigin(headers);
            currentOrigin = nextOrigin;
          }
          currentUrl = nextUrl;
          continue;
        }
        upstream = res;
        break;
      }
      clearTimeout(connectTimer);
      if (!upstream) {
        throw new Error("VIRTUAL_EMBY_PROXY: upstream CDN did not return a terminal response");
      }
      return { upstream, controller, cleanup };
    } catch (error) {
      clearTimeout(connectTimer);
      cleanup();
      throw error;
    }
  };

  let activeLink = input.link;
  let attempt = await attemptFetch(activeLink, startupDeadline);

  // Self-heal once on expired signed CDN URL / rotated __puus cookie (403 / 412),
  // or CDN 404 (so resolveFreshLink() re-checks the drive API and throws
  // DriveFileNotFoundError if deleted, allowing route-level tombstoning + failover).
  if (
    attempt.upstream.status === 403 ||
    attempt.upstream.status === 412 ||
    attempt.upstream.status === 404
  ) {
    await attempt.upstream.body?.cancel().catch(() => undefined);
    attempt.controller.abort();
    attempt.cleanup();
    cache.invalidateFile(input.storageId, input.fileId);
    const refreshBudgetMs = startupDeadline - Date.now();
    if (refreshBudgetMs <= 0) {
      throw new Error("Upstream CDN response headers timed out");
    }
    const refreshController = new AbortController();
    const onRefreshClientAbort = () => refreshController.abort(input.signal?.reason);
    if (input.signal) {
      if (input.signal.aborted) {
        refreshController.abort(input.signal.reason);
      } else {
        input.signal.addEventListener("abort", onRefreshClientAbort, { once: true });
      }
    }
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      const refreshPromise = input.resolveFreshLink(refreshController.signal);
      // Prevent unhandled rejections if timeout/abort wins the race while the resolver finishes later.
      refreshPromise.catch(() => undefined);
      activeLink = await Promise.race([
        refreshPromise,
        new Promise<never>((_resolve, reject) => {
          const onAbort = () => reject(refreshController.signal.reason ?? new Error("Upstream CDN link refresh aborted"));
          if (refreshController.signal.aborted) {
            onAbort();
            return;
          }
          refreshController.signal.addEventListener("abort", onAbort, { once: true });
          refreshTimer = setTimeout(() => {
            refreshController.abort(new Error("Upstream CDN link refresh timed out"));
          }, refreshBudgetMs);
        }),
      ]);
    } finally {
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      if (input.signal) {
        input.signal.removeEventListener("abort", onRefreshClientAbort);
      }
    }
    attempt = await attemptFetch(activeLink, startupDeadline);
  }
  const { upstream, controller, cleanup } = attempt;

  const outHeaders = new Headers(input.corsHeaders);
  outHeaders.set("Accept-Ranges", upstream.headers.get("accept-ranges") ?? "bytes");
  outHeaders.set("Cache-Control", "no-store");
  outHeaders.set("X-Content-Type-Options", "nosniff");
  outHeaders.set("Content-Security-Policy", "sandbox");

  // Never relay upstream error HTML/SVG/JS bodies inline on the application origin.
  if (upstream.status >= 400 && upstream.status !== 416) {
    await upstream.body?.cancel().catch(() => undefined);
    controller.abort();
    cleanup();
    outHeaders.set("Content-Type", "text/plain; charset=utf-8");
    return new Response(isHead ? null : `Upstream media server returned HTTP ${upstream.status}`, {
      status: upstream.status,
      headers: outHeaders,
    });
  }

  const passthroughHeaders = [
    "content-length",
    "content-range",
    "etag",
    "last-modified",
  ] as const;
  for (const name of passthroughHeaders) {
    const val = upstream.headers.get(name);
    if (val) {
      outHeaders.set(name, val);
    }
  }

  const upstreamContentType = upstream.headers.get("content-type")?.trim() ?? "";
  if (upstreamContentType && !UNSAFE_INLINE_CONTENT_TYPE_RE.test(upstreamContentType)) {
    outHeaders.set("content-type", upstreamContentType);
  } else {
    outHeaders.set("content-type", inferMimeType(activeLink.fileName));
  }

  if (activeLink.fileName && !outHeaders.has("content-disposition")) {
    const encoded = encodeURIComponent(activeLink.fileName);
    outHeaders.set("content-disposition", `inline; filename*=UTF-8''${encoded}`);
  }

  if (isHead || !upstream.body) {
    await upstream.body?.cancel().catch(() => undefined);
    controller.abort();
    cleanup();
    return new Response(null, { status: upstream.status, headers: outHeaders });
  }

  // Zero-buffering passthrough stream that connects downstream cancel/EOF/error to upstream abort + listener cleanup.
  const reader = upstream.body.getReader();
  const passthrough = new ReadableStream<Uint8Array>({
    async pull(streamController) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          cleanup();
          streamController.close();
          return;
        }
        streamController.enqueue(value);
      } catch (error) {
        controller.abort(error);
        await reader.cancel(error).catch(() => undefined);
        cleanup();
        streamController.error(error);
      }
    },
    async cancel(reason) {
      controller.abort(reason);
      cleanup();
      await reader.cancel(reason).catch(() => undefined);
    },
  });

  return new Response(passthrough, {
    status: upstream.status,
    headers: outHeaders,
  });
}

function inferMimeType(fileName?: string): string {
  const lower = (fileName ?? "").toLowerCase();
  if (lower.endsWith(".mp4") || lower.endsWith(".m4v")) return "video/mp4";
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".mov")) return "video/quicktime";
  if (lower.endsWith(".ts") || lower.endsWith(".m2ts")) return "video/mp2t";
  if (lower.endsWith(".avi")) return "video/x-msvideo";
  return "video/x-matroska";
}
