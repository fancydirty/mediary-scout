/**
 * Zero-buffering HTTP Range proxy + singleton download-link cache for Virtual Emby.
 *
 * Design invariants (verified against live Quark/UC CDNs + peach-study §5):
 *  1. NEVER buffer video bytes in memory (pipe `upstream.body` directly).
 *  2. Propagate incoming `request.signal` into an upstream `AbortController` so
 *     seeking or closing the player cancels upstream TCP downloads immediately.
 *  3. Forward exact `Range` headers and preserve upstream `200` / `206` / `416`
 *     responses and `Content-Range` / `Content-Length` / `Accept-Ranges` headers.
 *  4. Self-heal on stale signed CDN links / rotated `__puus` cookies: if upstream
 *     answers `403` or `412`, cancel its body, invalidate the link cache, resolve
 *     a fresh download link ONCE, and retry.
 */
import {
  buildDriveDownloadCacheKey,
  DriveDownloadLinkCache,
  type ConnectedStorage,
  type DriveDownloadLink,
} from "@media-track/workflow";
import { createPlaybackExecutorForStorage } from "./workflow-runtime";

const PROXY_CONNECT_TIMEOUT_MS = 25_000;

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
  ): Promise<{ upstream: Response; cleanup: () => void }> => {
    const controller = new AbortController();
    const onClientAbort = () => controller.abort(input.signal?.reason);
    const cleanup = () => {
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
      return { upstream, cleanup };
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
    attempt.cleanup();
    cache.invalidateFile(input.storageId, input.fileId);
    activeLink = await input.resolveFreshLink();
    attempt = await attemptFetch(activeLink);
  }
  const { upstream, cleanup } = attempt;

  const outHeaders = new Headers(input.corsHeaders);
  outHeaders.set("Accept-Ranges", upstream.headers.get("accept-ranges") ?? "bytes");
  outHeaders.set("Cache-Control", "no-store");

  const passthroughHeaders = [
    "content-type",
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
  if (!outHeaders.has("content-type")) {
    outHeaders.set("content-type", inferMimeType(activeLink.fileName));
  }
  if (activeLink.fileName && !outHeaders.has("content-disposition")) {
    const encoded = encodeURIComponent(activeLink.fileName);
    outHeaders.set("content-disposition", `inline; filename*=UTF-8''${encoded}`);
  }

  if (isHead) {
    await upstream.body?.cancel().catch(() => undefined);
    cleanup();
    return new Response(null, { status: upstream.status, headers: outHeaders });
  }

  return new Response(upstream.body, {
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
