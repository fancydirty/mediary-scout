import { NextResponse, type NextRequest } from "next/server";
import { handleVirtualEmbyRequest, isDriveFileNotFoundError } from "@media-track/workflow";
import { getWorkflowRepository } from "../../../lib/workflow-runtime";
import {
  getDownloadLinkCache,
  resolveCachedDriveDownloadLink,
  streamProxiedDownload,
} from "../../../lib/virtual-emby-proxy";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, HEAD, OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization, X-Emby-Authorization, X-Emby-Token, X-MediaBrowser-Token, Content-Type, Range",
  "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges, Content-Length, ETag",
};

function mergeCors(extra?: Record<string, string>): Record<string, string> {
  return { ...CORS_HEADERS, ...(extra ?? {}) };
}

async function parseRequestBody(request: NextRequest): Promise<unknown> {
  if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") {
    return undefined;
  }
  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
  const text = await request.text().catch(() => "");
  if (!text.trim()) return undefined;
  if (contentType.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(text).entries());
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function firstHeaderValue(value: string | null): string | null {
  if (!value) return null;
  const first = value.split(",")[0]?.trim();
  return first || null;
}

function resolveOrigin(request: NextRequest): string {
  const proto = firstHeaderValue(request.headers.get("x-forwarded-proto")) ?? request.nextUrl.protocol.replace(/:$/, "");
  const host = firstHeaderValue(request.headers.get("x-forwarded-host")) ?? firstHeaderValue(request.headers.get("host")) ?? request.nextUrl.host;
  return `${proto}://${host}`;
}

async function dispatch(
  request: NextRequest,
  context: { params: Promise<{ path?: string[] }> },
): Promise<Response> {
  const { path = [] } = await context.params;
  const body = await parseRequestBody(request);
  const repository = getWorkflowRepository();
  const cache = getDownloadLinkCache();

  const result = await handleVirtualEmbyRequest(
    {
      method: request.method,
      pathSegments: path,
      query: request.nextUrl.searchParams,
      headers: request.headers,
      body,
      origin: resolveOrigin(request),
    },
    {
      repository,
      resolveDownloadLink: (input) => resolveCachedDriveDownloadLink({ ...input, cache }),
    },
  );

  switch (result.kind) {
    case "json":
      return NextResponse.json(result.body, {
        status: result.status,
        headers: mergeCors(result.headers),
      });
    case "text":
      return new Response(result.body, {
        status: result.status,
        headers: mergeCors({ "Content-Type": "text/plain; charset=utf-8", ...(result.headers ?? {}) }),
      });
    case "empty":
      return new Response(null, {
        status: result.status,
        headers: mergeCors(result.headers),
      });
    case "redirect":
      return new Response(null, {
        status: result.status,
        headers: mergeCors({ Location: result.location, ...(result.headers ?? {}) }),
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
          corsHeaders: CORS_HEADERS,
          resolveFreshLink: () =>
            resolveCachedDriveDownloadLink({
              storage: result.storage,
              fileId: result.fileId,
              ...(userAgent ? { userAgent } : {}),
              cache,
            }),
        });
      } catch (error) {
        if (isDriveFileNotFoundError(error)) {
          await repository
            .setEpisodeCopyFileStatus?.({
              trackedSeasonId: result.trackedSeasonId,
              episodeCode: result.episodeCode,
              storageId: result.storage.id,
              fileStatus: "missing_on_drive",
              verifiedAt: new Date().toISOString(),
            })
            .catch(() => undefined);
          return new Response("File missing on drive", {
            status: 404,
            headers: mergeCors({ "Content-Type": "text/plain; charset=utf-8" }),
          });
        }
        return new Response("Upstream media stream unavailable", {
          status: 502,
          headers: mergeCors({ "Content-Type": "text/plain; charset=utf-8" }),
        });
      }
    }
  }
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
