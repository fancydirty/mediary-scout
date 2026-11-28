import { NextResponse, type NextRequest } from "next/server";
import {
  handleVirtualEmbyRequest,
  isDriveFileNotFoundError,
  isVirtualEmbyEnabled,
  type VirtualEmbyLoginThrottle,
} from "@media-track/workflow";
import {
  buildThrottleKey,
  checkLoginAllowed,
  recordLoginFailure,
  recordLoginSuccess,
} from "../../../lib/login-throttle";
import { resolveRequestOrigin } from "../../../lib/request-origin";
import { getWorkflowRepository } from "../../../lib/workflow-runtime";
import {
  getDownloadLinkCache,
  resolveCachedDriveDownloadLink,
  streamProxiedDownload,
} from "../../../lib/virtual-emby-proxy";

const MAX_REQUEST_BODY_BYTES = 64 * 1024;
const MAX_PROXY_FAILOVER_ATTEMPTS = 6;

const BASE_CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Methods": "GET, POST, DELETE, HEAD, OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization, X-Emby-Authorization, X-Emby-Token, X-MediaBrowser-Token, Content-Type, Range",
  "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges, Content-Length, ETag",
};

function allowedOriginsSet(requestOrigin: string): Set<string> {
  const allowed = new Set<string>([requestOrigin.toLowerCase()]);
  for (const raw of (process.env.MEDIA_TRACK_ALLOWED_ORIGINS ?? "").split(",")) {
    const trimmed = raw.trim().toLowerCase();
    if (!trimmed) continue;
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
      allowed.add(trimmed.replace(/\/+$/, ""));
    } else {
      allowed.add(`https://${trimmed}`);
      allowed.add(`http://${trimmed}`);
    }
  }
  return allowed;
}

function buildCorsHeaders(request: NextRequest, requestOrigin: string): Record<string, string> {
  const reqOrigin = request.headers.get("origin")?.trim();
  if (!reqOrigin) {
    return {};
  }
  const normalized = reqOrigin.replace(/\/+$/, "").toLowerCase();
  if (!allowedOriginsSet(requestOrigin).has(normalized)) {
    return { Vary: "Origin" };
  }
  return {
    ...BASE_CORS_HEADERS,
    "Access-Control-Allow-Origin": reqOrigin,
    Vary: "Origin",
  };
}

function mergeHeaders(
  corsHeaders: Record<string, string>,
  extra?: Record<string, string>,
): Record<string, string> {
  return { ...corsHeaders, ...(extra ?? {}) };
}

class RequestBodyTooLargeError extends Error {
  constructor() {
    super("Request body exceeds 64 KiB limit");
    this.name = "RequestBodyTooLargeError";
  }
}

async function readBoundedBodyText(request: NextRequest): Promise<string> {
  const declaredLen = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLen) && declaredLen > MAX_REQUEST_BODY_BYTES) {
    throw new RequestBodyTooLargeError();
  }
  if (!request.body) {
    return "";
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_REQUEST_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new RequestBodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

async function parseRequestBody(request: NextRequest): Promise<unknown> {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return undefined;
  }
  const text = await readBoundedBodyText(request);
  if (!text.trim()) return undefined;
  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(text).entries());
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

const embyLoginThrottle: VirtualEmbyLoginThrottle = {
  check: (headers, username) => checkLoginAllowed(buildThrottleKey(headers, username), Date.now()),
  recordFailure: (headers, username) => recordLoginFailure(buildThrottleKey(headers, username), Date.now()),
  recordSuccess: (headers, username) => recordLoginSuccess(buildThrottleKey(headers, username)),
};

async function dispatch(
  request: NextRequest,
  context: { params: Promise<{ path?: string[] }> },
): Promise<Response> {
  const requestOrigin = resolveRequestOrigin(request.headers);
  const corsHeaders = buildCorsHeaders(request, requestOrigin);

  if (request.method.toUpperCase() === "OPTIONS") {
    const reqOrigin = request.headers.get("origin")?.trim();
    if (reqOrigin && !corsHeaders["Access-Control-Allow-Origin"]) {
      return new Response(null, { status: 403, headers: corsHeaders });
    }
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const repository = getWorkflowRepository();
  // Short-circuit BEFORE reading request body when the Virtual Emby server is disabled.
  if (!(await isVirtualEmbyEnabled(repository))) {
    return NextResponse.json(
      { error: "Virtual Emby server is disabled. Enable it in Settings." },
      { status: 404, headers: corsHeaders },
    );
  }

  let body: unknown;
  try {
    body = await parseRequestBody(request);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json(
        { error: "Request body too large" },
        { status: 413, headers: corsHeaders },
      );
    }
    throw error;
  }

  const { path = [] } = await context.params;
  const cache = getDownloadLinkCache();
  const excludeCopyKeys = new Set<string>();

  for (let attempt = 0; attempt < MAX_PROXY_FAILOVER_ATTEMPTS; attempt += 1) {
    const result = await handleVirtualEmbyRequest(
      {
        method: request.method,
        pathSegments: path,
        query: request.nextUrl.searchParams,
        headers: request.headers,
        body,
        origin: requestOrigin,
        ...(excludeCopyKeys.size > 0 ? { excludeCopyKeys } : {}),
      },
      {
        repository,
        resolveDownloadLink: (input) =>
          resolveCachedDriveDownloadLink({ ...input, cache, signal: request.signal }),
        loginThrottle: embyLoginThrottle,
      },
    );

    switch (result.kind) {
      case "json":
        return NextResponse.json(result.body, {
          status: result.status,
          headers: mergeHeaders(corsHeaders, result.headers),
        });
      case "text":
        return new Response(result.body, {
          status: result.status,
          headers: mergeHeaders(corsHeaders, { "Content-Type": "text/plain; charset=utf-8", ...(result.headers ?? {}) }),
        });
      case "empty":
        return new Response(null, {
          status: result.status,
          headers: mergeHeaders(corsHeaders, result.headers),
        });
      case "redirect":
        return new Response(null, {
          status: result.status,
          headers: mergeHeaders(corsHeaders, { Location: result.location, ...(result.headers ?? {}) }),
        });
      case "proxy": {
        const userAgent = request.headers.get("user-agent") ?? undefined;
        try {
          return await streamProxiedDownload({
            method: request.method,
            rangeHeader: request.headers.get("range"),
            signal: request.signal,
            link: result.link,
            storageId: result.storage.id,
            fileId: result.fileId,
            cache,
            corsHeaders,
            resolveFreshLink: (signal) =>
              resolveCachedDriveDownloadLink({
                storage: result.storage,
                fileId: result.fileId,
                ...(userAgent ? { userAgent } : {}),
                cache,
                signal,
              }),
          });
        } catch (error) {
          if (isDriveFileNotFoundError(error)) {
            const nowIso = new Date().toISOString();
            if (repository.markEpisodeCopyFileMissing) {
              await repository
                .markEpisodeCopyFileMissing({
                  trackedSeasonId: result.trackedSeasonId,
                  episodeCode: result.episodeCode,
                  storageId: result.storage.id,
                  fileId: result.fileId,
                  verifiedAt: nowIso,
                })
                .catch(() => undefined);
            } else {
              await repository
                .setEpisodeCopyFileStatus?.({
                  trackedSeasonId: result.trackedSeasonId,
                  episodeCode: result.episodeCode,
                  storageId: result.storage.id,
                  fileStatus: "missing_on_drive",
                  verifiedAt: nowIso,
                })
                .catch(() => undefined);
            }
            excludeCopyKeys.add(`${result.storage.id}::${result.fileId}`);
            // Retry dispatch excluding this newly-tombstoned copy so sibling drives can serve it.
            continue;
          }
          return new Response("Upstream media stream unavailable", {
            status: 502,
            headers: mergeHeaders(corsHeaders, { "Content-Type": "text/plain; charset=utf-8" }),
          });
        }
      }
    }
  }

  return new Response("Media file no longer exists on any connected drive", {
    status: 404,
    headers: mergeHeaders(corsHeaders, { "Content-Type": "text/plain; charset=utf-8" }),
  });
}

export async function GET(request: NextRequest, context: { params: Promise<{ path?: string[] }> }) {
  return dispatch(request, context);
}

export async function POST(request: NextRequest, context: { params: Promise<{ path?: string[] }> }) {
  return dispatch(request, context);
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ path?: string[] }> }) {
  return dispatch(request, context);
}

export async function HEAD(request: NextRequest, context: { params: Promise<{ path?: string[] }> }) {
  return dispatch(request, context);
}

export async function OPTIONS(request: NextRequest, context: { params: Promise<{ path?: string[] }> }) {
  return dispatch(request, context);
}
