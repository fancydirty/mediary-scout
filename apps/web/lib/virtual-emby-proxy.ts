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
 *     answers `403` or `412`, cancel its body, invalidate the link cache, resolve
 *     a fresh download link ONCE, and retry.
 *  5. Isolate active web content: never serve upstream HTML/SVG/JS error pages inline
 *     on the application origin (`nosniff` + `sandbox` CSP + safe media Content-Type).
 */
import {
  buildDriveDownloadCacheKey,
  DriveDownloadLinkCache,
  type ConnectedStorage,
  type DriveDownloadLink,
} from "@media-track/workflow";
import { createPlaybackExecutorForStorage } from "./workflow-runtime";

const PROXY_CONNECT_TIMEOUT_MS = 25_000;

const UNSAFE_INLINE_CONTENT_TYPE_RE =
  /^(?:text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/javascript|application\/javascript|application\/ecmascript|text\/xml|application\/xml)\b/i;

const globalForVirtualEmby = globalThis as typeof globalThis & {
  __mediaryDownloadLinkCache?: DriveDownloadLinkCache;
};

export function getDownloadLinkCache(): DriveDownloadLinkCache {
  if (!globalForVirtualEmby.__mediaryDownloadLinkCache) {
    globalForVirtualEmby.__mediaryDownloadLinkCache = new DriveDownloadLinkCache();
  }
  return globalForVirtualEmby.__mediaryDownloadLinkCache;
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

/** Stream a non-redirectable cloud CDN file (Quark / UC) with full Range + HEAD + Abort propagation. */
export async function streamProxiedDownload(input: {
  method: string;
  rangeHeader: string | null;
  signal?: AbortSignal;
  link: DriveDownloadLink;
  storageId: string;
  fileId: string;
  resolveFreshLink: () => Promise<DriveDownloadLink>;
  cache?: DriveDownloadLinkCache;
  fetchImpl?: ProxyFetchFn;
  corsHeaders?: Record<string, string>;
}): Promise<Response> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const cache = input.cache ?? getDownloadLinkCache();
  const isHead = input.method.toUpperCase() === "HEAD";

  const attemptFetch = async (
    targetLink: DriveDownloadLink,
  ): Promise<{ upstream: Response; controller: AbortController; cleanup: () => void }> => {
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
    }, PROXY_CONNECT_TIMEOUT_MS);

    try {
      const headers: Record<string, string> = { ...targetLink.headers };
      if (input.rangeHeader) {
        headers["Range"] = input.rangeHeader;
      }
      // Always GET upstream (some Chinese cloud CDNs reject HEAD with 403/405);
      // for client HEAD requests we read headers and immediately cancel the body.
      const upstream = await fetchImpl(targetLink.url, {
        method: "GET",
        headers,
        redirect: "follow",
        signal: controller.signal,
      });
      clearTimeout(connectTimer);
      return { upstream, controller, cleanup };
    } catch (error) {
      clearTimeout(connectTimer);
      cleanup();
      throw error;
    }
  };

  let activeLink = input.link;
  let attempt = await attemptFetch(activeLink);

  // Self-heal once on expired signed CDN URL / rotated __puus cookie (403 / 412).
  if (attempt.upstream.status === 403 || attempt.upstream.status === 412) {
    await attempt.upstream.body?.cancel().catch(() => undefined);
    attempt.controller.abort();
    attempt.cleanup();
    cache.invalidateFile(input.storageId, input.fileId);
    activeLink = await input.resolveFreshLink();
    attempt = await attemptFetch(activeLink);
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

  // Zero-buffering passthrough stream that connects downstream cancel/EOF to upstream abort + listener cleanup.
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
