/**
 * Built-in Zero-Scan Virtual Emby Server ("虚拟 Emby 服务端").
 *
 * Serves Mediary Scout's existing DB catalog (Movies / TV / Anime across all 6
 * connected cloud drives) over the standard Emby REST API so native players
 * (网易爆米花 / Infuse / VidHub / SenPlayer / Emby / Jellyfin) connect directly
 * with ZERO STRM generation, ZERO CloudDrive2/rclone FUSE mounting, and ZERO
 * library scanning.
 *
 * Playback delivery:
 *  - 115 / 123 / 光鸭 / 天翼 → pure HTTP 302 redirect straight to cloud CDN
 *    (0 server bandwidth; 115 forwards the player's exact User-Agent).
 *  - 夸克 / UC → directive for the HTTP layer's zero-buffering Range proxy
 *    (injects rotated `__puus` Cookie + Referer + desktop UA).
 *  - Lazy invalidation: if a drive reports DriveFileNotFoundError (user deleted
 *    the file), ONLY that drive copy is marked `missing_on_drive` and playback
 *    automatically fails over to any healthy sibling drive copy. Daily patrol
 *    NEVER resurrects deleted files because `episode_states.obtained` stays true.
 */
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Account, ConnectedStorage } from "./account-credentials.js";
import { verifyPassword } from "./auth/password.js";
import {
  DEFAULT_ACCOUNT_ID,
  DRIVE_ORDER_SETTING_KEY,
  compareEpisodeCodes,
  episodePartsFromCode,
  formatByteSize,
  sortDrivesByOrder,
  type EpisodeCopy,
  type MediaTitle,
  type MediaType,
  type PlaybackProgress,
} from "./domain.js";
import { isDriveFileNotFoundError, type DriveDownloadLink } from "./ports.js";
import type { TrackedSeasonState, WorkflowRepository } from "./repository.js";
import { getStorageBrand, isRegisteredStorageProvider } from "./storage-brands.js";

export const VIRTUAL_EMBY_SETTING_KEYS = {
  /** Instance-level toggle ("1" = enabled). */
  enabled: "virtual_emby_enabled",
  /** Instance-level stable 32-hex Emby ServerId. */
  serverId: "virtual_emby_server_id",
  /** Per-account 48-hex Emby AccessToken (stored in account_settings). */
  token: "virtual_emby_token",
} as const;

export const VIRTUAL_EMBY_SERVER_NAME = "Mediary Scout (巡影)";
export const VIRTUAL_EMBY_VERSION = "4.8.10.0";
const DEFAULT_TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p";
const EMBY_TICKS_PER_SECOND = 10_000_000;
const COMPLETION_RATIO_THRESHOLD = 0.9;

const REDIRECT_PRIORITY_PROVIDERS = new Set(["pan115", "pan123", "guangya", "tianyi"]);

// ── Settings & Token Helpers ─────────────────────────────────────────────────

export async function isVirtualEmbyEnabled(repo: Pick<WorkflowRepository, "getSetting">): Promise<boolean> {
  return (await repo.getSetting(VIRTUAL_EMBY_SETTING_KEYS.enabled)) === "1";
}

export async function setVirtualEmbyEnabled(
  repo: Pick<WorkflowRepository, "setSetting">,
  enabled: boolean,
): Promise<void> {
  await repo.setSetting(VIRTUAL_EMBY_SETTING_KEYS.enabled, enabled ? "1" : "0");
}

export async function ensureVirtualEmbyServerId(
  repo: Pick<WorkflowRepository, "getSetting" | "setSetting" | "setSettingIfAbsent">,
): Promise<string> {
  const existing = (await repo.getSetting(VIRTUAL_EMBY_SETTING_KEYS.serverId))?.trim();
  if (existing && /^[0-9a-f]{32}$/i.test(existing)) {
    return existing;
  }
  const generated = randomBytes(16).toString("hex");
  if (repo.setSettingIfAbsent) {
    return repo.setSettingIfAbsent(VIRTUAL_EMBY_SETTING_KEYS.serverId, generated);
  }
  await repo.setSetting(VIRTUAL_EMBY_SETTING_KEYS.serverId, generated);
  return generated;
}

export async function ensureVirtualEmbyToken(
  repo: Pick<WorkflowRepository, "getAccountSetting" | "setAccountSetting" | "setAccountSettingIfAbsent">,
  accountId: string,
): Promise<string> {
  const existing = (await repo.getAccountSetting(accountId, VIRTUAL_EMBY_SETTING_KEYS.token))?.trim();
  if (existing && existing.length >= 24) {
    return existing;
  }
  const generated = randomBytes(24).toString("hex");
  if (repo.setAccountSettingIfAbsent) {
    return repo.setAccountSettingIfAbsent(accountId, VIRTUAL_EMBY_SETTING_KEYS.token, generated);
  }
  await repo.setAccountSetting(accountId, VIRTUAL_EMBY_SETTING_KEYS.token, generated);
  return generated;
}

const SCOPED_PLAYBACK_TOKEN_PREFIX = "pt_";
const DEFAULT_PLAYBACK_TOKEN_TTL_SECONDS = 6 * 60 * 60; // 6 hours

/** Mint a short-lived, item-scoped playback token signed with the account's Emby master token.
 *  Accepted ONLY on stream/download routes for that exact `itemId`, and automatically revoked
 *  whenever the account's master Emby token is regenerated. */
export function createVirtualEmbyPlaybackToken(input: {
  accountId: string;
  itemId: string;
  masterToken: string;
  nowMs?: number;
  ttlSeconds?: number;
}): string {
  const nowSec = Math.floor((input.nowMs ?? Date.now()) / 1000);
  const exp = nowSec + (input.ttlSeconds ?? DEFAULT_PLAYBACK_TOKEN_TTL_SECONDS);
  const payloadB64 = Buffer.from(
    JSON.stringify({ a: input.accountId, i: input.itemId, e: exp }),
    "utf8",
  ).toString("base64url");
  const sig = createHmac("sha256", input.masterToken).update(payloadB64).digest("base64url");
  return `${SCOPED_PLAYBACK_TOKEN_PREFIX}${payloadB64}.${sig}`;
}

export async function verifyVirtualEmbyPlaybackToken(input: {
  repo: WorkflowRepository;
  token: string;
  itemId: string;
  nowMs?: number;
}): Promise<Account | null> {
  if (!input.token.startsWith(SCOPED_PLAYBACK_TOKEN_PREFIX)) return null;
  const body = input.token.slice(SCOPED_PLAYBACK_TOKEN_PREFIX.length);
  const dot = body.indexOf(".");
  if (dot <= 0 || dot >= body.length - 1) return null;
  const payloadB64 = body.slice(0, dot);
  const sig = body.slice(dot + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const accountId = typeof parsed["a"] === "string" ? parsed["a"] : "";
  const scopedItemId = typeof parsed["i"] === "string" ? parsed["i"] : "";
  const exp = typeof parsed["e"] === "number" ? parsed["e"] : 0;
  if (!accountId || scopedItemId !== input.itemId) return null;
  const nowSec = Math.floor((input.nowMs ?? Date.now()) / 1000);
  if (exp <= nowSec) return null;
  const storedMasterToken = (
    await input.repo.getAccountSetting(accountId, VIRTUAL_EMBY_SETTING_KEYS.token)
  )?.trim();
  if (!storedMasterToken) return null;
  const expectedSig = createHmac("sha256", storedMasterToken).update(payloadB64).digest("base64url");
  if (!safeTokenEquals(sig, expectedSig)) return null;
  return input.repo.getAccountById(accountId);
}

export async function regenerateVirtualEmbyToken(
  repo: Pick<WorkflowRepository, "setAccountSetting">,
  accountId: string,
): Promise<string> {
  const generated = randomBytes(24).toString("hex");
  await repo.setAccountSetting(accountId, VIRTUAL_EMBY_SETTING_KEYS.token, generated);
  return generated;
}

/** Deterministic 32-hex Emby UserId derived from an account's internal id. */
export function embyUserIdForAccount(accountId: string): string {
  return createHash("sha256").update(`mediary-scout:emby-user:${accountId}`).digest("hex").slice(0, 32);
}

// ── Deterministic Emby Item & MediaSource IDs ────────────────────────────────

export const EMBY_LIBRARY_IDS = {
  movies: "lib_movies",
  tv: "lib_tv",
  anime: "lib_anime",
} as const;

export type EmbyItemRef =
  | { kind: "library"; library: "movies" | "tv" | "anime" }
  | { kind: "movie"; tmdbId: number }
  | { kind: "series"; mediaType: "tv" | "anime"; tmdbId: number }
  | { kind: "season"; mediaType: "tv" | "anime"; tmdbId: number; seasonNumber: number }
  | { kind: "episode"; mediaType: "tv" | "anime"; tmdbId: number; seasonNumber: number; episodeNumber: number };

export function buildEmbyItemId(ref: EmbyItemRef): string {
  switch (ref.kind) {
    case "library":
      return EMBY_LIBRARY_IDS[ref.library];
    case "movie":
      return `mov_${ref.tmdbId}`;
    case "series":
      return `${ref.mediaType === "anime" ? "an" : "tv"}_${ref.tmdbId}`;
    case "season":
      return `sea_${ref.mediaType === "anime" ? "an" : "tv"}_${ref.tmdbId}_${ref.seasonNumber}`;
    case "episode":
      return `ep_${ref.mediaType === "anime" ? "an" : "tv"}_${ref.tmdbId}_${ref.seasonNumber}_${ref.episodeNumber}`;
  }
}

export function parseEmbyItemId(id: string): EmbyItemRef | null {
  const trimmed = id.trim();
  if (trimmed === EMBY_LIBRARY_IDS.movies) return { kind: "library", library: "movies" };
  if (trimmed === EMBY_LIBRARY_IDS.tv) return { kind: "library", library: "tv" };
  if (trimmed === EMBY_LIBRARY_IDS.anime) return { kind: "library", library: "anime" };

  const mov = /^mov_(\d+)$/.exec(trimmed);
  if (mov) return { kind: "movie", tmdbId: Number(mov[1]) };

  const series = /^(tv|an)_(\d+)$/.exec(trimmed);
  if (series) {
    return { kind: "series", mediaType: series[1] === "an" ? "anime" : "tv", tmdbId: Number(series[2]) };
  }

  const season = /^sea_(tv|an)_(\d+)_(\d+)$/.exec(trimmed);
  if (season) {
    return {
      kind: "season",
      mediaType: season[1] === "an" ? "anime" : "tv",
      tmdbId: Number(season[2]),
      seasonNumber: Number(season[3]),
    };
  }

  const ep = /^ep_(tv|an)_(\d+)_(\d+)_(\d+)$/.exec(trimmed);
  if (ep) {
    return {
      kind: "episode",
      mediaType: ep[1] === "an" ? "anime" : "tv",
      tmdbId: Number(ep[2]),
      seasonNumber: Number(ep[3]),
      episodeNumber: Number(ep[4]),
    };
  }
  return null;
}

export function encodeEmbyMediaSourceId(storageId: string, fileId: string): string {
  return `ms_${Buffer.from(JSON.stringify([storageId, fileId]), "utf8").toString("base64url")}`;
}

export function decodeEmbyMediaSourceId(mediaSourceId: string): { storageId: string; fileId: string } | null {
  if (!mediaSourceId.startsWith("ms_")) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(mediaSourceId.slice(3), "base64url").toString("utf8"));
    if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === "string" && typeof parsed[1] === "string") {
      return { storageId: parsed[0], fileId: parsed[1] };
    }
  } catch {
    // ignore malformed media source id
  }
  return null;
}

// ── Request / Response Contract ──────────────────────────────────────────────

export interface VirtualEmbyRequest {
  method: string;
  /** Path segments under `/emby/...` (e.g. ["System", "Info", "Public"]). */
  pathSegments: string[];
  query: URLSearchParams;
  headers: Headers;
  /** Parsed JSON/form body for POST requests, if any. */
  body?: unknown;
  /** Base origin (e.g. "http://localhost:3000") used for LocalAddress in System/Info. */
  origin?: string;
  /** Optional copy keys (`${storageId}::${fileId}`) already found missing during a proxy retry. */
  excludeCopyKeys?: ReadonlySet<string>;
}

export interface VirtualEmbyDownloadResolverInput {
  storage: ConnectedStorage;
  fileId: string;
  userAgent?: string;
}

export interface VirtualEmbyLoginThrottle {
  check(headers: Headers, username: string): { allowed: true } | { allowed: false; retryAfterSec: number };
  recordFailure(headers: Headers, username: string): void;
  recordSuccess(headers: Headers, username: string): void;
}

export interface VirtualEmbyContext {
  repository: WorkflowRepository;
  resolveDownloadLink: (input: VirtualEmbyDownloadResolverInput) => Promise<DriveDownloadLink>;
  tmdbImageBaseUrl?: string;
  now?: () => string;
  loginThrottle?: VirtualEmbyLoginThrottle;
}

export type VirtualEmbyResult =
  | { kind: "json"; status: number; body: unknown; headers?: Record<string, string> }
  | { kind: "text"; status: number; body: string; headers?: Record<string, string> }
  | { kind: "empty"; status: number; headers?: Record<string, string> }
  | { kind: "redirect"; status: 302; location: string; headers?: Record<string, string> }
  | {
      kind: "proxy";
      link: DriveDownloadLink;
      storage: ConnectedStorage;
      fileId: string;
      trackedSeasonId: string;
      episodeCode: string;
    };

// ── Internal Catalog Model ───────────────────────────────────────────────────

interface PlayableCopy {
  storage: ConnectedStorage;
  trackedSeasonId: string;
  episodeCode: string;
  fileId: string;
  sizeBytes: number | null;
  quality: string | null;
  recordedAt: string;
}

interface CatalogEpisode {
  id: string;
  tmdbId: number;
  mediaType: "tv" | "anime";
  seriesId: string;
  seriesName: string;
  seasonId: string;
  seasonNumber: number;
  episodeNumber: number;
  episodeCode: string;
  name: string;
  airDate: string | null;
  posterPath: string | null;
  backdropPath: string | null;
  copies: PlayableCopy[];
  recordedAt: string;
  progress: PlaybackProgress | null;
}

interface CatalogSeason {
  id: string;
  tmdbId: number;
  mediaType: "tv" | "anime";
  seriesId: string;
  seriesName: string;
  seasonNumber: number;
  name: string;
  posterPath: string | null;
  backdropPath: string | null;
  episodes: CatalogEpisode[];
  recordedAt: string;
}

interface CatalogSeries {
  id: string;
  tmdbId: number;
  mediaType: "tv" | "anime";
  title: MediaTitle;
  seasons: CatalogSeason[];
  recordedAt: string;
}

interface CatalogMovie {
  id: string;
  tmdbId: number;
  title: MediaTitle;
  copies: PlayableCopy[];
  recordedAt: string;
  progress: PlaybackProgress | null;
}

interface AccountCatalog {
  movies: CatalogMovie[];
  tvSeries: CatalogSeries[];
  animeSeries: CatalogSeries[];
  movieById: Map<string, CatalogMovie>;
  seriesById: Map<string, CatalogSeries>;
  seasonById: Map<string, CatalogSeason>;
  episodeById: Map<string, CatalogEpisode>;
  storagesById: Map<string, ConnectedStorage>;
}

// ── Auth Helpers ─────────────────────────────────────────────────────────────

export function extractEmbyToken(headers: Headers, query: URLSearchParams): string | null {
  const direct =
    headers.get("x-emby-token") ??
    headers.get("x-mediabrowser-token") ??
    query.get("api_key") ??
    query.get("ApiKey") ??
    query.get("X-Emby-Token") ??
    query.get("token");
  if (direct && direct.trim()) {
    return direct.trim();
  }
  const authHeader = headers.get("x-emby-authorization") ?? headers.get("authorization") ?? "";
  const match = /\bToken\s*=\s*"([^"]+)"/i.exec(authHeader) ?? /\bToken\s*=\s*([^\s,]+)/i.exec(authHeader);
  if (match?.[1]?.trim()) {
    return match[1].trim();
  }
  return null;
}

function safeTokenEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length || bufA.length === 0) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

async function authenticateByToken(repo: WorkflowRepository, token: string): Promise<Account | null> {
  if (token.startsWith(SCOPED_PLAYBACK_TOKEN_PREFIX)) {
    return null;
  }
  if (repo.findAccountBySetting) {
    const candidate = await repo.findAccountBySetting(VIRTUAL_EMBY_SETTING_KEYS.token, token);
    if (!candidate) return null;
    const stored = (await repo.getAccountSetting(candidate.id, VIRTUAL_EMBY_SETTING_KEYS.token))?.trim();
    return stored && safeTokenEquals(token, stored) ? candidate : null;
  }
  const accounts = await repo.listAccounts();
  for (const account of accounts) {
    const stored = (await repo.getAccountSetting(account.id, VIRTUAL_EMBY_SETTING_KEYS.token))?.trim();
    if (stored && safeTokenEquals(token, stored)) {
      return account;
    }
  }
  return null;
}

function normalizeEmbySegments(segments: string[]): string[] {
  let start = 0;
  while (
    start < segments.length &&
    (segments[start]!.toLowerCase() === "emby" || segments[start]!.toLowerCase() === "jellyfin")
  ) {
    start += 1;
  }
  return segments.slice(start).filter((s) => s.length > 0);
}

function parseClientHeader(headers: Headers): { client: string; device: string; deviceId: string } {
  const raw = headers.get("x-emby-authorization") ?? headers.get("authorization") ?? "";
  const grab = (key: string, fallback: string) =>
    new RegExp(`\\b${key}\\s*=\\s*"([^"]+)"`, "i").exec(raw)?.[1] ?? fallback;
  return {
    client: grab("Client", headers.get("user-agent")?.slice(0, 48) || "Emby Client"),
    device: grab("Device", "Media Player"),
    deviceId: grab("DeviceId", "mediary-client"),
  };
}

// ── Catalog Builder ──────────────────────────────────────────────────────────

async function loadAccountCatalog(repo: WorkflowRepository, accountId: string): Promise<AccountCatalog> {
  const [trackedStates, storages, driveOrderRaw, progressRows] = await Promise.all([
    repo.listTrackedSeasonStates({ accountId, connectedStorageId: null }),
    repo.listConnectedStorages(accountId),
    repo.getAccountSetting(accountId, DRIVE_ORDER_SETTING_KEY),
    repo.listPlaybackProgress ? repo.listPlaybackProgress(accountId) : Promise.resolve([]),
  ]);

  let driveOrder: string[] = [];
  if (driveOrderRaw) {
    try {
      const parsed: unknown = JSON.parse(driveOrderRaw);
      if (Array.isArray(parsed)) {
        driveOrder = parsed.filter((v): v is string => typeof v === "string");
      }
    } catch {
      driveOrder = [];
    }
  }

  const orderedStorages = sortDrivesByOrder(storages, driveOrder);
  const driveRank = new Map<string, number>();
  orderedStorages.forEach((s, idx) => driveRank.set(s.id, idx));
  const storagesById = new Map<string, ConnectedStorage>(orderedStorages.map((s) => [s.id, s]));

  const seasonIds = [...new Set(trackedStates.map((s) => s.season.id))];
  const allCopies: EpisodeCopy[] =
    seasonIds.length > 0 && repo.listEpisodeCopiesForSeasons
      ? await repo.listEpisodeCopiesForSeasons(seasonIds)
      : seasonIds.length > 0 && repo.listEpisodeCopies
        ? (await Promise.all(seasonIds.map((id) => repo.listEpisodeCopies!(id)))).flat()
        : [];

  // Index copies by `${trackedSeasonId}::${episodeCode}`
  const copiesBySeasonEp = new Map<string, EpisodeCopy[]>();
  for (const c of allCopies) {
    const key = `${c.trackedSeasonId}::${c.episodeCode}`;
    const list = copiesBySeasonEp.get(key) ?? [];
    list.push(c);
    copiesBySeasonEp.set(key, list);
  }

  const progressMap = new Map<string, PlaybackProgress>();
  for (const p of progressRows) {
    progressMap.set(`${p.mediaType}::${p.tmdbId}::${p.seasonNumber}::${p.episodeNumber}`, p);
  }

  const sortCopies = (copies: PlayableCopy[]): PlayableCopy[] => {
    const hasCustomOrder = driveOrder.length > 0;
    return [...copies].sort((a, b) => {
      // 1. Active drives before frozen drives
      const activeA = a.storage.status === "active" ? 0 : 1;
      const activeB = b.storage.status === "active" ? 0 : 1;
      if (activeA !== activeB) return activeA - activeB;
      // 2. If user configured drive_order, honor it; otherwise prefer direct-302 drives over proxy drives
      if (hasCustomOrder) {
        const rankA = driveRank.get(a.storage.id) ?? 9999;
        const rankB = driveRank.get(b.storage.id) ?? 9999;
        if (rankA !== rankB) return rankA - rankB;
      } else {
        const redirA = REDIRECT_PRIORITY_PROVIDERS.has(a.storage.provider) ? 0 : 1;
        const redirB = REDIRECT_PRIORITY_PROVIDERS.has(b.storage.provider) ? 0 : 1;
        if (redirA !== redirB) return redirA - redirB;
        const rankA = driveRank.get(a.storage.id) ?? 9999;
        const rankB = driveRank.get(b.storage.id) ?? 9999;
        if (rankA !== rankB) return rankA - rankB;
      }
      // 3. Larger file size first (higher bitrate/quality)
      const sizeA = a.sizeBytes ?? 0;
      const sizeB = b.sizeBytes ?? 0;
      if (sizeA !== sizeB) return sizeB - sizeA;
      return b.recordedAt.localeCompare(a.recordedAt);
    });
  };

  const resolvePlayableCopies = (
    seasonStates: TrackedSeasonState[],
    episodeCode: string,
  ): PlayableCopy[] => {
    const seen = new Set<string>();
    const tombstoned = new Set<string>();
    const out: PlayableCopy[] = [];
    const distinctSeasonIds = [...new Set(seasonStates.map((st) => st.season.id))];

    // 1. Explicit episode_copies rows across ALL tracked-season rows in the group
    for (const seasonIdKey of distinctSeasonIds) {
      for (const c of copiesBySeasonEp.get(`${seasonIdKey}::${episodeCode}`) ?? []) {
        if (c.fileStatus === "missing_on_drive") {
          tombstoned.add(`${seasonIdKey}::${c.storageId}`);
          tombstoned.add(`*::${c.storageId}`);
          continue;
        }
        const storage = storagesById.get(c.storageId);
        if (!storage) continue;
        for (const fileId of c.fileIds) {
          if (!fileId) continue;
          const dedupKey = `${storage.id}::${fileId}`;
          if (seen.has(dedupKey)) continue;
          seen.add(dedupKey);
          out.push({
            storage,
            trackedSeasonId: seasonIdKey,
            episodeCode,
            fileId,
            sizeBytes: c.sizeBytes,
            quality: c.quality,
            recordedAt: c.recordedAt,
          });
        }
      }
    }

    // 2. Fallback to episode_states.verifiedFileIds for pre-C8 legacy rows
    for (const st of seasonStates) {
      if (!st.connectedStorageId) continue;
      if (
        tombstoned.has(`${st.season.id}::${st.connectedStorageId}`) ||
        tombstoned.has(`*::${st.connectedStorageId}`)
      ) {
        continue;
      }
      const storage = storagesById.get(st.connectedStorageId);
      if (!storage) continue;
      const ep = st.episodes.find((e) => e.episodeCode === episodeCode);
      if (!ep?.obtained) continue;
      for (const fileId of ep.verifiedFileIds) {
        if (!fileId) continue;
        const dedupKey = `${storage.id}::${fileId}`;
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);
        out.push({
          storage,
          trackedSeasonId: st.season.id,
          episodeCode,
          fileId,
          sizeBytes: null,
          quality: st.season.qualityPreference || null,
          recordedAt: storage.createdAt,
        });
      }
    }

    return sortCopies(out);
  };

  // Group trackedStates by (mediaType, tmdbId)
  const grouped = new Map<string, TrackedSeasonState[]>();
  for (const st of trackedStates) {
    const key = `${st.title.type}::${st.title.tmdbId}`;
    const list = grouped.get(key) ?? [];
    list.push(st);
    grouped.set(key, list);
  }

  const movies: CatalogMovie[] = [];
  const tvSeries: CatalogSeries[] = [];
  const animeSeries: CatalogSeries[] = [];
  const movieById = new Map<string, CatalogMovie>();
  const seriesById = new Map<string, CatalogSeries>();
  const seasonById = new Map<string, CatalogSeason>();
  const episodeById = new Map<string, CatalogEpisode>();

  for (const states of grouped.values()) {
    const title = states[0]!.title;
    if (title.type === "movie") {
      // Movie anchor uses episodeCode "S01E01" (or whatever obtained episode exists on movie anchor).
      const candidateCodes = new Set<string>(["S01E01"]);
      for (const st of states) {
        for (const ep of st.episodes) {
          if (ep.obtained) candidateCodes.add(ep.episodeCode);
        }
      }
      const allMovieCopies: PlayableCopy[] = [];
      for (const code of candidateCodes) {
        allMovieCopies.push(...resolvePlayableCopies(states, code));
      }
      // Deduplicate across codes by (storageId, fileId)
      const deduped: PlayableCopy[] = [];
      const seen = new Set<string>();
      for (const copy of sortCopies(allMovieCopies)) {
        const key = `${copy.storage.id}::${copy.fileId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(copy);
      }
      if (deduped.length === 0) continue;
      const id = buildEmbyItemId({ kind: "movie", tmdbId: title.tmdbId });
      const recordedAt = deduped.reduce((max, c) => (c.recordedAt > max ? c.recordedAt : max), "");
      const movie: CatalogMovie = {
        id,
        tmdbId: title.tmdbId,
        title,
        copies: deduped,
        recordedAt,
        progress: progressMap.get(`movie::${title.tmdbId}::1::1`) ?? null,
      };
      movies.push(movie);
      movieById.set(id, movie);
      continue;
    }

    // TV or Anime
    const mediaType: "tv" | "anime" = title.type === "anime" ? "anime" : "tv";
    const seriesId = buildEmbyItemId({ kind: "series", mediaType, tmdbId: title.tmdbId });
    const bySeasonNumber = new Map<number, TrackedSeasonState[]>();
    for (const st of states) {
      const list = bySeasonNumber.get(st.season.seasonNumber) ?? [];
      list.push(st);
      bySeasonNumber.set(st.season.seasonNumber, list);
    }

    const seasons: CatalogSeason[] = [];
    for (const [seasonNumber, seasonStates] of [...bySeasonNumber.entries()].sort((a, b) => a[0] - b[0])) {
      const seasonId = buildEmbyItemId({
        kind: "season",
        mediaType,
        tmdbId: title.tmdbId,
        seasonNumber,
      });

      // Collect all distinct episode codes from episode_states AND episode_copies
      const episodeMetaByCode = new Map<string, { title: string; airDate: string | null }>();
      for (const st of seasonStates) {
        for (const ep of st.episodes) {
          if (ep.obtained && !episodeMetaByCode.has(ep.episodeCode)) {
            episodeMetaByCode.set(ep.episodeCode, { title: ep.title, airDate: ep.airDate });
          }
        }
      }
      const seasonIdSet = new Set(seasonStates.map((st) => st.season.id));
      for (const [key, copies] of copiesBySeasonEp) {
        const sep = key.indexOf("::");
        if (sep < 0 || !seasonIdSet.has(key.slice(0, sep))) continue;
        const code = key.slice(sep + 2);
        if (!episodeMetaByCode.has(code) && copies.some((c) => c.fileStatus !== "missing_on_drive" && c.fileIds.length > 0)) {
          episodeMetaByCode.set(code, { title: code, airDate: null });
        }
      }

      const episodes: CatalogEpisode[] = [];
      for (const code of [...episodeMetaByCode.keys()].sort(compareEpisodeCodes)) {
        const copies = resolvePlayableCopies(seasonStates, code);
        if (copies.length === 0) continue;
        let epNum = 1;
        try {
          epNum = episodePartsFromCode(code).episodeNumber;
        } catch {
          continue;
        }
        const meta = episodeMetaByCode.get(code);
        const epId = buildEmbyItemId({
          kind: "episode",
          mediaType,
          tmdbId: title.tmdbId,
          seasonNumber,
          episodeNumber: epNum,
        });
        const epRecordedAt = copies.reduce((max, c) => (c.recordedAt > max ? c.recordedAt : max), "");
        const epName =
          meta?.title && meta.title !== code && !/^Episode \d+$/.test(meta.title)
            ? meta.title
            : `第 ${epNum} 集`;
        const episode: CatalogEpisode = {
          id: epId,
          tmdbId: title.tmdbId,
          mediaType,
          seriesId,
          seriesName: title.title,
          seasonId,
          seasonNumber,
          episodeNumber: epNum,
          episodeCode: code,
          name: epName,
          airDate: meta?.airDate ?? null,
          posterPath: title.posterPath ?? null,
          backdropPath: title.backdropPath ?? null,
          copies,
          recordedAt: epRecordedAt,
          progress: progressMap.get(`${mediaType}::${title.tmdbId}::${seasonNumber}::${epNum}`) ?? null,
        };
        episodes.push(episode);
        episodeById.set(epId, episode);
      }

      if (episodes.length === 0) continue;
      const seasonRecordedAt = episodes.reduce((max, e) => (e.recordedAt > max ? e.recordedAt : max), "");
      const season: CatalogSeason = {
        id: seasonId,
        tmdbId: title.tmdbId,
        mediaType,
        seriesId,
        seriesName: title.title,
        seasonNumber,
        name: `第 ${seasonNumber} 季`,
        posterPath: title.posterPath ?? null,
        backdropPath: title.backdropPath ?? null,
        episodes,
        recordedAt: seasonRecordedAt,
      };
      seasons.push(season);
      seasonById.set(seasonId, season);
    }

    if (seasons.length === 0) continue;
    const seriesRecordedAt = seasons.reduce((max, s) => (s.recordedAt > max ? s.recordedAt : max), "");
    const series: CatalogSeries = {
      id: seriesId,
      tmdbId: title.tmdbId,
      mediaType,
      title,
      seasons,
      recordedAt: seriesRecordedAt,
    };
    seriesById.set(seriesId, series);
    if (mediaType === "anime") {
      animeSeries.push(series);
    } else {
      tvSeries.push(series);
    }
  }

  return {
    movies,
    tvSeries,
    animeSeries,
    movieById,
    seriesById,
    seasonById,
    episodeById,
    storagesById,
  };
}

/** Count actually playable movies, series, and episodes using the exact same inventory
 *  and tombstoning rules as the Virtual Emby catalog (for Settings UI accuracy). */
export async function loadVirtualEmbyPlayableCounts(
  repo: WorkflowRepository,
  accountId: string,
): Promise<{ movies: number; series: number; episodes: number }> {
  const catalog = await loadAccountCatalog(repo, accountId);
  return {
    movies: catalog.movies.length,
    series: catalog.tvSeries.length + catalog.animeSeries.length,
    episodes: catalog.episodeById.size,
  };
}

/** Targeted playable-copy loader for stream/download requests — avoids scanning the entire
 *  account's episode_copies and playback_progress tables on every HTTP Range request. */
async function loadPlayableCopiesForItem(
  repo: WorkflowRepository,
  accountId: string,
  itemId: string,
): Promise<PlayableCopy[]> {
  const ref = parseEmbyItemId(itemId);
  if (!ref || (ref.kind !== "movie" && ref.kind !== "episode")) {
    return [];
  }
  const targetType: MediaType = ref.kind === "movie" ? "movie" : ref.mediaType;
  const [allStates, storages, driveOrderRaw] = await Promise.all([
    repo.listTrackedSeasonStates({ accountId, connectedStorageId: null }),
    repo.listConnectedStorages(accountId),
    repo.getAccountSetting(accountId, DRIVE_ORDER_SETTING_KEY),
  ]);
  const matchingStates = allStates.filter((st) => {
    if (st.title.tmdbId !== ref.tmdbId || st.title.type !== targetType) return false;
    if (ref.kind === "episode" && st.season.seasonNumber !== ref.seasonNumber) return false;
    return true;
  });
  if (matchingStates.length === 0) return [];

  let driveOrder: string[] = [];
  if (driveOrderRaw) {
    try {
      const parsed: unknown = JSON.parse(driveOrderRaw);
      if (Array.isArray(parsed)) driveOrder = parsed.filter((v): v is string => typeof v === "string");
    } catch {
      driveOrder = [];
    }
  }
  const orderedStorages = sortDrivesByOrder(storages, driveOrder);
  const driveRank = new Map<string, number>();
  orderedStorages.forEach((s, idx) => driveRank.set(s.id, idx));
  const storagesById = new Map<string, ConnectedStorage>(orderedStorages.map((s) => [s.id, s]));

  const distinctSeasonIds = [...new Set(matchingStates.map((st) => st.season.id))];
  const rawCopies: EpisodeCopy[] =
    distinctSeasonIds.length > 0 && repo.listEpisodeCopiesForSeasons
      ? await repo.listEpisodeCopiesForSeasons(distinctSeasonIds)
      : distinctSeasonIds.length > 0 && repo.listEpisodeCopies
        ? (await Promise.all(distinctSeasonIds.map((id) => repo.listEpisodeCopies!(id)))).flat()
        : [];

  const targetCodes = new Set<string>();
  if (ref.kind === "movie") {
    targetCodes.add("S01E01");
    for (const st of matchingStates) {
      for (const ep of st.episodes) {
        if (ep.obtained) targetCodes.add(ep.episodeCode);
      }
    }
    for (const c of rawCopies) {
      if (c.fileStatus !== "missing_on_drive" && c.fileIds.length > 0) targetCodes.add(c.episodeCode);
    }
  } else {
    for (const st of matchingStates) {
      for (const ep of st.episodes) {
        if (!ep.obtained) continue;
        try {
          if (episodePartsFromCode(ep.episodeCode).episodeNumber === ref.episodeNumber) {
            targetCodes.add(ep.episodeCode);
          }
        } catch {
          // ignore unparseable episode codes
        }
      }
    }
    for (const c of rawCopies) {
      try {
        if (episodePartsFromCode(c.episodeCode).episodeNumber === ref.episodeNumber) {
          targetCodes.add(c.episodeCode);
        }
      } catch {
        // ignore unparseable episode codes
      }
    }
  }

  const seen = new Set<string>();
  const tombstoned = new Set<string>();
  const out: PlayableCopy[] = [];
  for (const c of rawCopies) {
    if (!targetCodes.has(c.episodeCode)) continue;
    if (c.fileStatus === "missing_on_drive") {
      tombstoned.add(`${c.trackedSeasonId}::${c.episodeCode}::${c.storageId}`);
      tombstoned.add(`*::${c.episodeCode}::${c.storageId}`);
      continue;
    }
    const storage = storagesById.get(c.storageId);
    if (!storage) continue;
    for (const fileId of c.fileIds) {
      if (!fileId) continue;
      const dedupKey = `${storage.id}::${fileId}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      out.push({
        storage,
        trackedSeasonId: c.trackedSeasonId,
        episodeCode: c.episodeCode,
        fileId,
        sizeBytes: c.sizeBytes,
        quality: c.quality,
        recordedAt: c.recordedAt,
      });
    }
  }
  for (const st of matchingStates) {
    if (!st.connectedStorageId) continue;
    const storage = storagesById.get(st.connectedStorageId);
    if (!storage) continue;
    for (const ep of st.episodes) {
      if (!ep.obtained || !targetCodes.has(ep.episodeCode)) continue;
      if (
        tombstoned.has(`${st.season.id}::${ep.episodeCode}::${st.connectedStorageId}`) ||
        tombstoned.has(`*::${ep.episodeCode}::${st.connectedStorageId}`)
      ) {
        continue;
      }
      for (const fileId of ep.verifiedFileIds) {
        if (!fileId) continue;
        const dedupKey = `${storage.id}::${fileId}`;
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);
        out.push({
          storage,
          trackedSeasonId: st.season.id,
          episodeCode: ep.episodeCode,
          fileId,
          sizeBytes: null,
          quality: st.season.qualityPreference || null,
          recordedAt: storage.createdAt,
        });
      }
    }
  }
  const hasCustomOrder = driveOrder.length > 0;
  return out.sort((a, b) => {
    const activeA = a.storage.status === "active" ? 0 : 1;
    const activeB = b.storage.status === "active" ? 0 : 1;
    if (activeA !== activeB) return activeA - activeB;
    if (hasCustomOrder) {
      const rankA = driveRank.get(a.storage.id) ?? 9999;
      const rankB = driveRank.get(b.storage.id) ?? 9999;
      if (rankA !== rankB) return rankA - rankB;
    } else {
      const redirA = REDIRECT_PRIORITY_PROVIDERS.has(a.storage.provider) ? 0 : 1;
      const redirB = REDIRECT_PRIORITY_PROVIDERS.has(b.storage.provider) ? 0 : 1;
      if (redirA !== redirB) return redirA - redirB;
      const rankA = driveRank.get(a.storage.id) ?? 9999;
      const rankB = driveRank.get(b.storage.id) ?? 9999;
      if (rankA !== rankB) return rankA - rankB;
    }
    const sizeA = a.sizeBytes ?? 0;
    const sizeB = b.sizeBytes ?? 0;
    if (sizeA !== sizeB) return sizeB - sizeA;
    return b.recordedAt.localeCompare(a.recordedAt);
  });
}

// ── Emby DTO Builders ────────────────────────────────────────────────────────

function shortBrandLabel(storage: ConnectedStorage): string {
  if (storage.label?.trim()) return storage.label.trim();
  if (isRegisteredStorageProvider(storage.provider)) {
    return getStorageBrand(storage.provider).label;
  }
  return storage.provider;
}

function buildMediaSourceDto(
  itemId: string,
  copy: PlayableCopy,
  accountId: string,
  masterToken: string,
  durationTicks: number,
  nowMs?: number,
): Record<string, unknown> {
  const msId = encodeEmbyMediaSourceId(copy.storage.id, copy.fileId);
  const labelParts = [`[${shortBrandLabel(copy.storage)}]`];
  if (copy.quality) labelParts.push(copy.quality);
  if (copy.sizeBytes !== null && copy.sizeBytes > 0) labelParts.push(formatByteSize(copy.sizeBytes));
  const deliveryHint = REDIRECT_PRIORITY_PROVIDERS.has(copy.storage.provider) ? "直链" : "代理";
  labelParts.push(deliveryHint);
  const name = labelParts.join(" · ");
  // Issue a short-lived, item-scoped playback token so stream URLs in DTOs or player history
  // cannot be reused to access other items or browse the account's full library.
  const playbackToken = createVirtualEmbyPlaybackToken({
    accountId,
    itemId,
    masterToken,
    ...(nowMs !== undefined ? { nowMs } : {}),
  });
  const streamPath = `/emby/Videos/${itemId}/stream?Static=true&MediaSourceId=${encodeURIComponent(msId)}&api_key=${encodeURIComponent(playbackToken)}`;

  return {
    Protocol: "Http",
    Id: msId,
    Path: streamPath,
    Type: "Default",
    Size: copy.sizeBytes ?? undefined,
    Name: name,
    IsRemote: false,
    RunTimeTicks: durationTicks > 0 ? durationTicks : undefined,
    SupportsTranscoding: false,
    SupportsDirectStream: true,
    SupportsDirectPlay: true,
    IsInfiniteStream: false,
    RequiresOpening: false,
    RequiresClosing: false,
    SupportsProbing: true,
    DirectStreamUrl: streamPath,
    // Leave MediaStreams empty rather than fabricating H.264/AAC codec metadata;
    // native players probe actual tracks via Range requests when SupportsProbing=true.
    MediaStreams: [],
    Formats: [],
    RequiredHttpHeaders: {},
    ReadAtNativeFramerate: false,
  };
}

function buildUserDataDto(progress: PlaybackProgress | null, unplayedItemCount?: number): Record<string, unknown> {
  const positionTicks = progress?.positionTicks ?? 0;
  const durationTicks = progress?.durationTicks ?? 0;
  const played = progress?.played ?? false;
  const playedPercentage =
    durationTicks > 0 && positionTicks > 0
      ? Math.min(100, Math.round((positionTicks / durationTicks) * 1000) / 10)
      : undefined;
  return {
    PlaybackPositionTicks: positionTicks,
    PlayCount: progress?.playCount ?? 0,
    IsFavorite: false,
    Played: played,
    ...(playedPercentage !== undefined ? { PlayedPercentage: playedPercentage } : {}),
    ...(progress?.lastPlayedAt ? { LastPlayedDate: progress.lastPlayedAt } : {}),
    ...(unplayedItemCount !== undefined ? { UnplayedItemCount: unplayedItemCount } : {}),
  };
}

function imageTagsFor(posterPath: string | null | undefined, backdropPath: string | null | undefined): {
  ImageTags: Record<string, string>;
  BackdropImageTags: string[];
} {
  const ImageTags: Record<string, string> = {};
  if (posterPath) {
    ImageTags["Primary"] = createHash("md5").update(posterPath).digest("hex").slice(0, 12);
  }
  const BackdropImageTags = backdropPath
    ? [createHash("md5").update(backdropPath).digest("hex").slice(0, 12)]
    : [];
  return { ImageTags, BackdropImageTags };
}

function buildLibraryDto(
  library: "movies" | "tv" | "anime",
  serverId: string,
  childCount: number,
): Record<string, unknown> {
  const meta =
    library === "movies"
      ? { id: EMBY_LIBRARY_IDS.movies, name: "电影", collectionType: "movies" }
      : library === "tv"
        ? { id: EMBY_LIBRARY_IDS.tv, name: "剧集", collectionType: "tvshows" }
        : { id: EMBY_LIBRARY_IDS.anime, name: "动漫", collectionType: "tvshows" };
  return {
    Name: meta.name,
    ServerId: serverId,
    Id: meta.id,
    IsFolder: true,
    Type: "CollectionFolder",
    CollectionType: meta.collectionType,
    ChildCount: childCount,
    ImageTags: {},
    BackdropImageTags: [],
    UserData: { PlaybackPositionTicks: 0, PlayCount: 0, IsFavorite: false, Played: false },
  };
}

interface DtoContext {
  serverId: string;
  accountId: string;
  token: string;
  nowMs: number;
}

function buildMovieDto(movie: CatalogMovie, dtoCtx: DtoContext): Record<string, unknown> {
  const durationTicks = movie.progress?.durationTicks ?? 0;
  const images = imageTagsFor(movie.title.posterPath, movie.title.backdropPath);
  return {
    Name: movie.title.title,
    OriginalTitle: movie.title.originalTitle || movie.title.title,
    SortName: movie.title.title,
    ServerId: dtoCtx.serverId,
    Id: movie.id,
    ParentId: EMBY_LIBRARY_IDS.movies,
    Type: "Movie",
    MediaType: "Video",
    IsFolder: false,
    ProductionYear: movie.title.year || undefined,
    PremiereDate: movie.title.releaseDate ? `${movie.title.releaseDate.slice(0, 10)}T00:00:00.000Z` : undefined,
    DateCreated: movie.recordedAt || undefined,
    Overview: movie.title.overview || undefined,
    ProviderIds: { Tmdb: String(movie.tmdbId) },
    RunTimeTicks: durationTicks > 0 ? durationTicks : undefined,
    CanDownload: true,
    ...images,
    MediaSources: movie.copies.map((c) =>
      buildMediaSourceDto(movie.id, c, dtoCtx.accountId, dtoCtx.token, durationTicks, dtoCtx.nowMs),
    ),
    UserData: buildUserDataDto(movie.progress),
  };
}

function buildSeriesDto(series: CatalogSeries, serverId: string): Record<string, unknown> {
  const images = imageTagsFor(series.title.posterPath, series.title.backdropPath);
  const allEpisodes = series.seasons.flatMap((s) => s.episodes);
  const unplayedCount = allEpisodes.filter((e) => !e.progress?.played).length;
  return {
    Name: series.title.title,
    OriginalTitle: series.title.originalTitle || series.title.title,
    SortName: series.title.title,
    ServerId: serverId,
    Id: series.id,
    ParentId: series.mediaType === "anime" ? EMBY_LIBRARY_IDS.anime : EMBY_LIBRARY_IDS.tv,
    Type: "Series",
    IsFolder: true,
    ProductionYear: series.title.year || undefined,
    DateCreated: series.recordedAt || undefined,
    Overview: series.title.overview || undefined,
    ProviderIds: { Tmdb: String(series.tmdbId) },
    ChildCount: series.seasons.length,
    RecursiveItemCount: allEpisodes.length,
    ...images,
    UserData: {
      PlaybackPositionTicks: 0,
      PlayCount: 0,
      IsFavorite: false,
      Played: allEpisodes.length > 0 && unplayedCount === 0,
      UnplayedItemCount: unplayedCount,
    },
  };
}

function buildSeasonDto(season: CatalogSeason, serverId: string): Record<string, unknown> {
  const images = imageTagsFor(season.posterPath, season.backdropPath);
  const unplayedCount = season.episodes.filter((e) => !e.progress?.played).length;
  return {
    Name: season.name,
    ServerId: serverId,
    Id: season.id,
    SeriesId: season.seriesId,
    SeriesName: season.seriesName,
    ParentId: season.seriesId,
    IndexNumber: season.seasonNumber,
    Type: "Season",
    IsFolder: true,
    ChildCount: season.episodes.length,
    DateCreated: season.recordedAt || undefined,
    ...images,
    UserData: {
      PlaybackPositionTicks: 0,
      PlayCount: 0,
      IsFavorite: false,
      Played: season.episodes.length > 0 && unplayedCount === 0,
      UnplayedItemCount: unplayedCount,
    },
  };
}

function buildEpisodeDto(episode: CatalogEpisode, dtoCtx: DtoContext): Record<string, unknown> {
  const durationTicks = episode.progress?.durationTicks ?? 0;
  const images = imageTagsFor(episode.posterPath, episode.backdropPath);
  return {
    Name: episode.name,
    ServerId: dtoCtx.serverId,
    Id: episode.id,
    SeriesId: episode.seriesId,
    SeriesName: episode.seriesName,
    SeasonId: episode.seasonId,
    SeasonName: `第 ${episode.seasonNumber} 季`,
    ParentId: episode.seasonId,
    ParentIndexNumber: episode.seasonNumber,
    IndexNumber: episode.episodeNumber,
    Type: "Episode",
    MediaType: "Video",
    IsFolder: false,
    PremiereDate: episode.airDate ? `${episode.airDate.slice(0, 10)}T00:00:00.000Z` : undefined,
    DateCreated: episode.recordedAt || undefined,
    RunTimeTicks: durationTicks > 0 ? durationTicks : undefined,
    CanDownload: true,
    ...images,
    MediaSources: episode.copies.map((c) =>
      buildMediaSourceDto(episode.id, c, dtoCtx.accountId, dtoCtx.token, durationTicks, dtoCtx.nowMs),
    ),
    UserData: buildUserDataDto(episode.progress),
  };
}

function buildUserDto(account: Account, serverId: string): Record<string, unknown> {
  const userId = embyUserIdForAccount(account.id);
  return {
    Name: account.username,
    ServerId: serverId,
    Id: userId,
    HasPassword: true,
    HasConfiguredPassword: true,
    HasConfiguredEasyPassword: false,
    EnableAutoLogin: false,
    Policy: {
      IsAdministrator: account.isOwner,
      IsHidden: false,
      IsDisabled: false,
      EnableUserPreferenceAccess: true,
      EnableRemoteControlOfOtherUsers: false,
      EnableSharedDeviceControl: false,
      EnableRemoteAccess: true,
      EnableLiveTvManagement: false,
      EnableLiveTvAccess: false,
      EnableMediaPlayback: true,
      EnableAudioPlaybackTranscoding: false,
      EnableVideoPlaybackTranscoding: false,
      EnablePlaybackRemuxing: false,
      EnableContentDeletion: false,
      EnableContentDownloading: true,
      EnableAllFolders: true,
      EnableAllChannels: true,
      EnableAllDevices: true,
    },
    Configuration: {
      PlayDefaultAudioTrack: true,
      DisplayMissingEpisodes: false,
      SubtitleMode: "Default",
      HidePlayedInLatest: false,
      RememberAudioSelections: true,
      RememberSubtitleSelections: true,
      EnableNextEpisodeAutoPlay: true,
    },
  };
}

// ── Main Virtual Emby HTTP Dispatcher ────────────────────────────────────────

export async function handleVirtualEmbyRequest(
  req: VirtualEmbyRequest,
  ctx: VirtualEmbyContext,
): Promise<VirtualEmbyResult> {
  const method = req.method.toUpperCase();
  if (method === "OPTIONS") {
    return { kind: "empty", status: 204 };
  }

  if (!(await isVirtualEmbyEnabled(ctx.repository))) {
    return {
      kind: "json",
      status: 404,
      body: { error: "Virtual Emby server is disabled. Enable it in Settings." },
    };
  }

  const segments = normalizeEmbySegments(req.pathSegments);
  const lower = segments.map((s) => s.toLowerCase());
  const serverId = await ensureVirtualEmbyServerId(ctx.repository);
  const nowIso = (ctx.now ?? (() => new Date().toISOString()))();
  const nowMs = Date.parse(nowIso) || Date.now();
  const origin = req.origin ?? "http://localhost:3000";

  // ── 1. Public unauthenticated endpoints ──────────────────────────────────

  if (lower[0] === "system" && lower[1] === "ping") {
    return { kind: "text", status: 200, body: "Emby Server" };
  }

  if (method === "GET" && lower[0] === "system" && lower[1] === "info" && lower[2] === "public") {
    return {
      kind: "json",
      status: 200,
      body: {
        LocalAddress: `${origin}/emby`,
        ServerName: VIRTUAL_EMBY_SERVER_NAME,
        Version: VIRTUAL_EMBY_VERSION,
        ProductName: "Emby Server",
        OperatingSystem: "Linux",
        Id: serverId,
        StartupWizardCompleted: true,
      },
    };
  }

  if (method === "GET" && lower[0] === "users" && lower[1] === "public") {
    // Never leak usernames publicly; clients present the login form directly.
    return { kind: "json", status: 200, body: [] };
  }

  if (method === "POST" && lower[0] === "users" && lower[1] === "authenticatebyname") {
    return handleAuthenticateByName(req, ctx.repository, serverId, ctx.loginThrottle);
  }

  // Image redirects (Emby clients frequently fetch posters without sending auth headers)
  if (
    (method === "GET" || method === "HEAD") &&
    lower[0] === "items" &&
    segments[1] &&
    lower[2] === "images" &&
    segments[3]
  ) {
    return handleItemImageRequest(
      segments[1],
      segments[3],
      ctx.repository,
      ctx.tmdbImageBaseUrl ?? DEFAULT_TMDB_IMAGE_BASE,
    );
  }

  // ── 2. Authenticate all remaining endpoints via Emby token ───────────────

  const isStreamRoute =
    (method === "GET" || method === "HEAD") &&
    Boolean(segments[1]) &&
    ((lower[0] === "videos" &&
      Boolean(lower[2]) &&
      (lower[2] === "stream" ||
        lower[2]!.startsWith("stream.") ||
        lower[2] === "original" ||
        lower[2]!.startsWith("original."))) ||
      (lower[0] === "items" && lower[2] === "download"));

  const token = extractEmbyToken(req.headers, req.query);
  if (!token) {
    return {
      kind: "json",
      status: 401,
      body: { error: "Access token is required" },
      headers: { "WWW-Authenticate": 'MediaBrowser realm="Mediary Scout"' },
    };
  }

  // Short-lived, item-scoped playback tokens (`pt_...`) are ONLY accepted on the matching
  // stream/download route; all other endpoints require the account's master Emby token.
  let account: Account | null = null;
  if (token.startsWith(SCOPED_PLAYBACK_TOKEN_PREFIX)) {
    if (isStreamRoute && segments[1]) {
      account = await verifyVirtualEmbyPlaybackToken({
        repo: ctx.repository,
        token,
        itemId: segments[1],
        nowMs,
      });
    }
  } else {
    account = await authenticateByToken(ctx.repository, token);
  }

  if (!account) {
    return {
      kind: "json",
      status: 401,
      body: { error: "Invalid Emby access token" },
      headers: { "WWW-Authenticate": 'MediaBrowser realm="Mediary Scout"' },
    };
  }

  // Fast path for media stream/download requests: resolve only the requested item's
  // playable copies instead of rebuilding the full account catalog on every Range request.
  if (isStreamRoute && segments[1]) {
    const itemId = segments[1];
    const mediaSourceId = req.query.get("MediaSourceId") ?? req.query.get("mediaSourceId") ?? undefined;
    const userAgent = req.headers.get("user-agent") ?? undefined;
    const copies = await loadPlayableCopiesForItem(ctx.repository, account.id, itemId);
    return handleVideoStream(copies, itemId, mediaSourceId, userAgent, ctx, nowIso, req.excludeCopyKeys);
  }

  // ── 3. Authenticated System / User / Session endpoints ───────────────────

  if (method === "GET" && lower[0] === "system" && lower[1] === "info") {
    return {
      kind: "json",
      status: 200,
      body: {
        LocalAddress: `${origin}/emby`,
        ServerName: VIRTUAL_EMBY_SERVER_NAME,
        Version: VIRTUAL_EMBY_VERSION,
        ProductName: "Emby Server",
        OperatingSystem: "Linux",
        OperatingSystemDisplayName: "Linux",
        Id: serverId,
        HasPendingRestart: false,
        IsShuttingDown: false,
        SupportsLibraryMonitor: false,
        WebSocketPortNumber: 0,
        CanSelfRestart: false,
        CanSelfUpdate: false,
        HasUpdateAvailable: false,
        StartupWizardCompleted: true,
      },
    };
  }

  if (method === "GET" && lower[0] === "system" && lower[1] === "configuration") {
    return {
      kind: "json",
      status: 200,
      body: {
        EnableUPnP: false,
        PublicPort: 8096,
        IsStartupWizardCompleted: true,
      },
    };
  }

  if (method === "GET" && lower[0] === "displaypreferences") {
    return {
      kind: "json",
      status: 200,
      body: {
        Id: segments[1] ?? "usersettings",
        SortBy: "SortName",
        SortOrder: "Ascending",
        Client: "emby",
        CustomPrefs: {},
      },
    };
  }

  if (lower[0] === "sessions") {
    if (method === "GET" && lower.length === 1) {
      return { kind: "json", status: 200, body: [] };
    }
    if (method === "POST" && lower[1] === "capabilities") {
      return { kind: "empty", status: 204 };
    }
    if (method === "POST" && lower[1] === "logout") {
      return { kind: "empty", status: 204 };
    }
    if (method === "POST" && lower[1] === "playing") {
      return handlePlaybackReport(lower[2] ?? "start", req.body, account.id, ctx.repository, nowIso);
    }
  }

  // Legacy playing item endpoints used by some Jellyfin/Emby clients
  if (lower[0] === "users" && lower[2] === "playingitems" && segments[3]) {
    const phase = method === "DELETE" ? "stopped" : lower[4] === "progress" ? "progress" : "start";
    const bodyObj = isRecord(req.body) ? req.body : {};
    const mergedBody = {
      ...bodyObj,
      ItemId: segments[3],
      ...(req.query.get("positionTicks") ? { PositionTicks: Number(req.query.get("positionTicks")) } : {}),
    };
    return handlePlaybackReport(phase, mergedBody, account.id, ctx.repository, nowIso);
  }

  // Mark Played / Unplayed: POST/DELETE /Users/{uid}/PlayedItems/{itemId}
  if (lower[0] === "users" && lower[2] === "playeditems" && segments[3]) {
    if (method === "POST" || method === "DELETE") {
      return handleSetPlayed(segments[3], method === "POST", account.id, ctx.repository, nowIso);
    }
  }

  if (method === "GET" && lower[0] === "users" && lower.length === 2) {
    return { kind: "json", status: 200, body: buildUserDto(account, serverId) };
  }

  // ── 4. Catalog-backed endpoints ──────────────────────────────────────────

  const catalog = await loadAccountCatalog(ctx.repository, account.id);
  const dtoCtx: DtoContext = { serverId, accountId: account.id, token, nowMs };

  // Views / MediaFolders / VirtualFolders
  if (
    method === "GET" &&
    ((lower[0] === "users" && lower[2] === "views") ||
      (lower[0] === "library" && (lower[1] === "mediafolders" || lower[1] === "virtualfolders")))
  ) {
    const views = buildLibraryViews(catalog, serverId);
    if (lower[1] === "virtualfolders") {
      return {
        kind: "json",
        status: 200,
        body: views.map((v) => ({
          Name: v["Name"],
          ItemId: v["Id"],
          CollectionType: v["CollectionType"],
          Locations: [],
        })),
      };
    }
    return {
      kind: "json",
      status: 200,
      body: { Items: views, TotalRecordCount: views.length, StartIndex: 0 },
    };
  }

  // Counts: GET /Items/Counts
  if (method === "GET" && lower[0] === "items" && lower[1] === "counts") {
    const movieCount = catalog.movies.length;
    const seriesCount = catalog.tvSeries.length + catalog.animeSeries.length;
    const episodeCount = catalog.episodeById.size;
    return {
      kind: "json",
      status: 200,
      body: {
        MovieCount: movieCount,
        SeriesCount: seriesCount,
        EpisodeCount: episodeCount,
        ArtistCount: 0,
        ProgramCount: 0,
        TrailerCount: 0,
        SongCount: 0,
        AlbumCount: 0,
        MusicVideoCount: 0,
        BoxSetCount: 0,
        BookCount: 0,
        ItemCount: movieCount + seriesCount + episodeCount,
      },
    };
  }

  // Latest: GET /Users/{uid}/Items/Latest (returns BARE array!)
  if (method === "GET" && lower[0] === "users" && lower[2] === "items" && lower[3] === "latest") {
    const parentId = req.query.get("ParentId") ?? req.query.get("parentId") ?? "";
    const limit = clampLimit(req.query.get("Limit") ?? req.query.get("limit"), 20);
    const items = queryItems(catalog, dtoCtx, {
      ...(parentId ? { parentId } : {}),
      includeItemTypes: parseCsvSet(req.query.get("IncludeItemTypes") ?? req.query.get("includeItemTypes")),
      recursive: false,
      sortBy: "DateCreated",
      sortOrder: "Descending",
    }).slice(0, limit);
    return { kind: "json", status: 200, body: items };
  }

  // Resume: GET /Users/{uid}/Items/Resume
  if (method === "GET" && lower[0] === "users" && lower[2] === "items" && lower[3] === "resume") {
    const startIndex = parseNonNegInt(req.query.get("StartIndex") ?? req.query.get("startIndex"), 0);
    const limit = clampLimit(req.query.get("Limit") ?? req.query.get("limit"), 20);
    const resumable = collectResumableItems(catalog, dtoCtx);
    const paged = resumable.slice(startIndex, startIndex + limit);
    return {
      kind: "json",
      status: 200,
      body: { Items: paged, TotalRecordCount: resumable.length, StartIndex: startIndex },
    };
  }

  // Single item: GET /Users/{uid}/Items/{itemId} OR /Items/{itemId}
  if (
    method === "GET" &&
    ((lower[0] === "users" && lower[2] === "items" && lower.length === 4 && lower[3] !== "latest" && lower[3] !== "resume") ||
      (lower[0] === "items" && lower.length === 2 && lower[1] !== "counts"))
  ) {
    const itemId = lower[0] === "users" ? segments[3]! : segments[1]!;
    const dto = findSingleItemDto(catalog, itemId, dtoCtx);
    if (!dto) {
      return { kind: "json", status: 404, body: { error: `Item not found: ${itemId}` } };
    }
    return { kind: "json", status: 200, body: dto };
  }

  // Similar: GET /Items/{itemId}/Similar
  if (method === "GET" && lower[0] === "items" && lower[2] === "similar") {
    return { kind: "json", status: 200, body: { Items: [], TotalRecordCount: 0 } };
  }

  // PlaybackInfo: GET|POST /Items/{itemId}/PlaybackInfo
  if ((method === "GET" || method === "POST") && lower[0] === "items" && segments[1] && lower[2] === "playbackinfo") {
    return handlePlaybackInfo(catalog, segments[1], dtoCtx);
  }

  // Items query: GET /Users/{uid}/Items OR GET /Items
  if (
    method === "GET" &&
    ((lower[0] === "users" && lower[2] === "items" && lower.length === 3) ||
      (lower[0] === "items" && lower.length === 1))
  ) {
    const parentId = req.query.get("ParentId") ?? req.query.get("parentId") ?? undefined;
    const ids = parseCsvSet(req.query.get("Ids") ?? req.query.get("ids"));
    const includeItemTypes = parseCsvSet(req.query.get("IncludeItemTypes") ?? req.query.get("includeItemTypes"));
    const excludeItemTypes = parseCsvSet(req.query.get("ExcludeItemTypes") ?? req.query.get("excludeItemTypes"));
    const filters = parseCsvSet(req.query.get("Filters") ?? req.query.get("filters"));
    const recursive = (req.query.get("Recursive") ?? req.query.get("recursive") ?? "").toLowerCase() === "true";
    const searchTerm = (req.query.get("SearchTerm") ?? req.query.get("searchTerm") ?? "").trim() || undefined;
    const sortBy = req.query.get("SortBy") ?? req.query.get("sortBy") ?? "SortName";
    const sortOrder = req.query.get("SortOrder") ?? req.query.get("sortOrder") ?? "Ascending";
    const startIndex = parseNonNegInt(req.query.get("StartIndex") ?? req.query.get("startIndex"), 0);
    const limitParam = req.query.get("Limit") ?? req.query.get("limit");
    const limit = limitParam ? clampLimit(limitParam, 200) : undefined;

    const all = queryItems(catalog, dtoCtx, {
      ...(parentId ? { parentId } : {}),
      ...(ids.size > 0 ? { ids } : {}),
      ...(includeItemTypes.size > 0 ? { includeItemTypes } : {}),
      ...(excludeItemTypes.size > 0 ? { excludeItemTypes } : {}),
      ...(filters.size > 0 ? { filters } : {}),
      recursive,
      ...(searchTerm ? { searchTerm } : {}),
      sortBy,
      sortOrder,
    });
    const paged = limit !== undefined ? all.slice(startIndex, startIndex + limit) : all.slice(startIndex);
    return {
      kind: "json",
      status: 200,
      body: { Items: paged, TotalRecordCount: all.length, StartIndex: startIndex },
    };
  }

  // Shows/{seriesId}/Seasons
  if (method === "GET" && lower[0] === "shows" && segments[1] && lower[2] === "seasons") {
    const series = catalog.seriesById.get(segments[1]);
    if (!series) {
      return { kind: "json", status: 404, body: { error: `Series not found: ${segments[1]}` } };
    }
    const items = series.seasons.map((s) => buildSeasonDto(s, serverId));
    return {
      kind: "json",
      status: 200,
      body: { Items: items, TotalRecordCount: items.length, StartIndex: 0 },
    };
  }

  // Shows/{seriesId}/Episodes
  if (method === "GET" && lower[0] === "shows" && segments[1] && lower[2] === "episodes") {
    const series = catalog.seriesById.get(segments[1]);
    if (!series) {
      return { kind: "json", status: 404, body: { error: `Series not found: ${segments[1]}` } };
    }
    const seasonIdFilter = req.query.get("SeasonId") ?? req.query.get("seasonId") ?? "";
    const seasonNumRaw = req.query.get("Season") ?? req.query.get("season");
    const seasonNumFilter = seasonNumRaw !== null ? Number(seasonNumRaw) : null;
    const startIndex = parseNonNegInt(req.query.get("StartIndex") ?? req.query.get("startIndex"), 0);
    const limitParam = req.query.get("Limit") ?? req.query.get("limit");
    const limit = limitParam ? clampLimit(limitParam, 500) : undefined;

    const matchingEpisodes = series.seasons
      .filter((s) => {
        if (seasonIdFilter && s.id !== seasonIdFilter) return false;
        if (seasonNumFilter !== null && Number.isFinite(seasonNumFilter) && s.seasonNumber !== seasonNumFilter) {
          return false;
        }
        return true;
      })
      .flatMap((s) => s.episodes)
      .map((ep) => buildEpisodeDto(ep, dtoCtx));

    const paged =
      limit !== undefined ? matchingEpisodes.slice(startIndex, startIndex + limit) : matchingEpisodes.slice(startIndex);
    return {
      kind: "json",
      status: 200,
      body: { Items: paged, TotalRecordCount: matchingEpisodes.length, StartIndex: startIndex },
    };
  }

  // Shows/NextUp
  if (method === "GET" && lower[0] === "shows" && lower[1] === "nextup") {
    const seriesIdFilter = req.query.get("SeriesId") ?? req.query.get("seriesId") ?? "";
    const startIndex = parseNonNegInt(req.query.get("StartIndex") ?? req.query.get("startIndex"), 0);
    const limit = clampLimit(req.query.get("Limit") ?? req.query.get("limit"), 20);
    const nextUp = collectNextUpEpisodes(catalog, dtoCtx, seriesIdFilter || undefined);
    const paged = nextUp.slice(startIndex, startIndex + limit);
    return {
      kind: "json",
      status: 200,
      body: { Items: paged, TotalRecordCount: nextUp.length, StartIndex: startIndex },
    };
  }

  // Search/Hints
  if (method === "GET" && lower[0] === "search" && lower[1] === "hints") {
    const term = (req.query.get("SearchTerm") ?? req.query.get("searchTerm") ?? "").trim().toLowerCase();
    const limit = clampLimit(req.query.get("Limit") ?? req.query.get("limit"), 30);
    const matches = queryItems(catalog, dtoCtx, {
      recursive: true,
      includeItemTypes: new Set(["movie", "series"]),
      ...(term ? { searchTerm: term } : {}),
      sortBy: "SortName",
      sortOrder: "Ascending",
    }).slice(0, limit);
    const hints = matches.map((m) => ({
      ItemId: m["Id"],
      Id: m["Id"],
      Name: m["Name"],
      Type: m["Type"],
      ProductionYear: m["ProductionYear"],
      PrimaryImageTag: isRecord(m["ImageTags"]) ? m["ImageTags"]["Primary"] : undefined,
      MediaType: m["MediaType"],
    }));
    return {
      kind: "json",
      status: 200,
      body: { SearchHints: hints, TotalRecordCount: hints.length },
    };
  }

  // Genres / Studios / Persons (empty valid collections)
  if (method === "GET" && (lower[0] === "genres" || lower[0] === "studios" || lower[0] === "persons")) {
    return { kind: "json", status: 200, body: { Items: [], TotalRecordCount: 0, StartIndex: 0 } };
  }

  // AdditionalParts: GET /Videos/{itemId}/AdditionalParts
  if (method === "GET" && lower[0] === "videos" && segments[1] && lower[2] === "additionalparts") {
    return { kind: "json", status: 200, body: { Items: [], TotalRecordCount: 0 } };
  }

  return {
    kind: "json",
    status: 404,
    body: { error: `Unsupported Virtual Emby route: ${method} /${segments.join("/")}` },
  };
}

// ── Endpoint Sub-Handlers ────────────────────────────────────────────────────

async function handleAuthenticateByName(
  req: VirtualEmbyRequest,
  repo: WorkflowRepository,
  serverId: string,
  loginThrottle?: VirtualEmbyLoginThrottle,
): Promise<VirtualEmbyResult> {
  const body = isRecord(req.body) ? req.body : {};
  const username = String(body["Username"] ?? body["username"] ?? "").trim();
  const pw = String(body["Pw"] ?? body["pw"] ?? body["Password"] ?? body["password"] ?? "");
  if (!pw) {
    return { kind: "json", status: 401, body: { error: "Password or Emby token is required" } };
  }

  // Normalize throttle identity BEFORE scanning accounts so throttled requests short-circuit
  // immediately without DB work; casing variants ("Owner" vs "owner") share one bucket.
  const throttleIdentity = username.toLowerCase();
  if (loginThrottle) {
    const verdict = loginThrottle.check(req.headers, throttleIdentity);
    if (!verdict.allowed) {
      return {
        kind: "json",
        status: 429,
        body: { error: "Too many login attempts, please try again later" },
        headers: { "Retry-After": String(verdict.retryAfterSec) },
      };
    }
  }

  const accounts = await repo.listAccounts();
  let account: Account | null = null;
  if (username) {
    account = accounts.find((a) => a.username.toLowerCase() === username.toLowerCase()) ?? null;
  } else if (accounts.length === 1 && accounts[0]?.id === DEFAULT_ACCOUNT_ID) {
    account = accounts[0]!;
  }

  if (!account) {
    loginThrottle?.recordFailure(req.headers, throttleIdentity);
    return { kind: "json", status: 401, body: { error: "Invalid username or password" } };
  }

  const storedToken = (await repo.getAccountSetting(account.id, VIRTUAL_EMBY_SETTING_KEYS.token))?.trim() ?? "";
  let authenticated = Boolean(storedToken && safeTokenEquals(pw, storedToken));
  if (!authenticated && account.passwordHash) {
    authenticated = await verifyPassword(pw, account.passwordHash);
  }
  if (!authenticated) {
    loginThrottle?.recordFailure(req.headers, throttleIdentity);
    return { kind: "json", status: 401, body: { error: "Invalid username or password" } };
  }

  loginThrottle?.recordSuccess(req.headers, throttleIdentity);
  const accessToken = await ensureVirtualEmbyToken(repo, account.id);
  const clientInfo = parseClientHeader(req.headers);
  const userDto = buildUserDto(account, serverId);
  return {
    kind: "json",
    status: 200,
    body: {
      User: userDto,
      SessionInfo: {
        Id: randomUUID().replace(/-/g, ""),
        UserId: userDto["Id"],
        UserName: account.username,
        Client: clientInfo.client,
        DeviceName: clientInfo.device,
        DeviceId: clientInfo.deviceId,
        ServerId: serverId,
        SupportsRemoteControl: false,
      },
      AccessToken: accessToken,
      ServerId: serverId,
    },
  };
}

async function handleItemImageRequest(
  itemId: string,
  imageType: string,
  repo: WorkflowRepository,
  tmdbImageBaseUrl: string,
): Promise<VirtualEmbyResult> {
  const ref = parseEmbyItemId(itemId);
  if (!ref || ref.kind === "library") {
    return { kind: "empty", status: 404 };
  }
  const states = await repo.listAllTrackedSeasonStates();
  const targetMediaType: MediaType | null =
    ref.kind === "movie" ? "movie" : ref.mediaType;
  const matched = states.find(
    (s) => s.title.tmdbId === ref.tmdbId && s.title.type === targetMediaType,
  );
  if (!matched) {
    return { kind: "empty", status: 404 };
  }
  const lowerType = imageType.toLowerCase();
  const isBackdrop = lowerType === "backdrop" || lowerType === "banner";
  const imagePath = isBackdrop
    ? matched.title.backdropPath ?? matched.title.posterPath
    : matched.title.posterPath ?? matched.title.backdropPath;
  if (!imagePath) {
    return { kind: "empty", status: 404 };
  }
  const size = isBackdrop ? "w1280" : "w500";
  const base = tmdbImageBaseUrl.replace(/\/+$/, "");
  return {
    kind: "redirect",
    status: 302,
    location: `${base}/${size}${imagePath}`,
    headers: { "Cache-Control": "public, max-age=86400" },
  };
}

function handlePlaybackInfo(
  catalog: AccountCatalog,
  itemId: string,
  dtoCtx: DtoContext,
): VirtualEmbyResult {
  const movie = catalog.movieById.get(itemId);
  const episode = catalog.episodeById.get(itemId);
  const copies = movie?.copies ?? episode?.copies;
  if (!copies || copies.length === 0) {
    return { kind: "json", status: 404, body: { error: `Playable item not found: ${itemId}` } };
  }
  const durationTicks = movie?.progress?.durationTicks ?? episode?.progress?.durationTicks ?? 0;
  return {
    kind: "json",
    status: 200,
    body: {
      MediaSources: copies.map((c) =>
        buildMediaSourceDto(itemId, c, dtoCtx.accountId, dtoCtx.token, durationTicks, dtoCtx.nowMs),
      ),
      PlaySessionId: randomUUID().replace(/-/g, ""),
    },
  };
}

async function handleVideoStream(
  baseCopies: readonly PlayableCopy[],
  itemId: string,
  mediaSourceId: string | undefined,
  userAgent: string | undefined,
  ctx: VirtualEmbyContext,
  nowIso: string,
  excludeCopyKeys?: ReadonlySet<string>,
): Promise<VirtualEmbyResult> {
  const filteredCopies = excludeCopyKeys?.size
    ? baseCopies.filter((c) => !excludeCopyKeys.has(`${c.storage.id}::${c.fileId}`))
    : [...baseCopies];
  if (filteredCopies.length === 0) {
    return { kind: "json", status: 404, body: { error: `Playable item not found: ${itemId}` } };
  }

  // Order candidates: requested MediaSourceId first (if valid), then remaining healthy copies for automatic failover.
  let candidates = [...filteredCopies];
  if (mediaSourceId) {
    const decoded = decodeEmbyMediaSourceId(mediaSourceId);
    if (decoded) {
      const idx = candidates.findIndex(
        (c) => c.storage.id === decoded.storageId && c.fileId === decoded.fileId,
      );
      if (idx > 0) {
        const [picked] = candidates.splice(idx, 1);
        candidates = [picked!, ...candidates];
      }
    }
  }

  let lastError: unknown = null;
  let allMissingOnDrive = true;

  for (const copy of candidates) {
    try {
      const link = await ctx.resolveDownloadLink({
        storage: copy.storage,
        fileId: copy.fileId,
        ...(userAgent ? { userAgent } : {}),
      });
      if (link.supportsRedirect) {
        return {
          kind: "redirect",
          status: 302,
          location: link.url,
          headers: { "Cache-Control": "no-store" },
        };
      }
      return {
        kind: "proxy",
        link,
        storage: copy.storage,
        fileId: copy.fileId,
        trackedSeasonId: copy.trackedSeasonId,
        episodeCode: copy.episodeCode,
      };
    } catch (error) {
      lastError = error;
      if (isDriveFileNotFoundError(error)) {
        // Lazy invalidation: prune ONLY this missing fileId (or tombstone the row if it
        // was the last fileId on this drive; never flips episode_states.obtained so patrol
        // won't re-download user-deleted files), then automatically fail over to sibling copies!
        if (ctx.repository.markEpisodeCopyFileMissing) {
          await ctx.repository.markEpisodeCopyFileMissing({
            trackedSeasonId: copy.trackedSeasonId,
            episodeCode: copy.episodeCode,
            storageId: copy.storage.id,
            fileId: copy.fileId,
            verifiedAt: nowIso,
          });
        } else if (ctx.repository.setEpisodeCopyFileStatus) {
          await ctx.repository.setEpisodeCopyFileStatus({
            trackedSeasonId: copy.trackedSeasonId,
            episodeCode: copy.episodeCode,
            storageId: copy.storage.id,
            fileStatus: "missing_on_drive",
            verifiedAt: nowIso,
          });
        }
        continue;
      }
      allMissingOnDrive = false;
      // Try sibling copy if another drive holds this item; otherwise bubble up error after loop.
    }
  }

  if (allMissingOnDrive) {
    return {
      kind: "json",
      status: 404,
      body: { error: "Media file no longer exists on any connected drive" },
    };
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError ?? "upstream error");
  return {
    kind: "json",
    status: 502,
    body: { error: `Failed to resolve cloud drive stream: ${message}` },
  };
}

async function handlePlaybackReport(
  phase: string,
  rawBody: unknown,
  accountId: string,
  repo: WorkflowRepository,
  nowIso: string,
): Promise<VirtualEmbyResult> {
  if (!repo.upsertPlaybackProgress || !repo.getPlaybackProgress) {
    return { kind: "empty", status: 204 };
  }
  const body = isRecord(rawBody) ? rawBody : {};
  const itemId = String(body["ItemId"] ?? body["itemId"] ?? "").trim();
  const ref = parseEmbyItemId(itemId);
  if (!ref || (ref.kind !== "movie" && ref.kind !== "episode")) {
    return { kind: "empty", status: 204 };
  }
  const mediaType: MediaType = ref.kind === "movie" ? "movie" : ref.mediaType;
  const seasonNumber = ref.kind === "movie" ? 1 : ref.seasonNumber;
  const episodeNumber = ref.kind === "movie" ? 1 : ref.episodeNumber;

  const existing = await repo.getPlaybackProgress({
    accountId,
    tmdbId: ref.tmdbId,
    mediaType,
    seasonNumber,
    episodeNumber,
  });

  const rawPos = Number(body["PositionTicks"] ?? body["positionTicks"]);
  const positionTicks = Number.isFinite(rawPos) && rawPos >= 0 ? Math.trunc(rawPos) : (existing?.positionTicks ?? 0);
  const rawDur = Number(body["RunTimeTicks"] ?? body["runTimeTicks"]);
  const durationTicks =
    Number.isFinite(rawDur) && rawDur > 0 ? Math.trunc(rawDur) : (existing?.durationTicks ?? 0);

  const clientCompleted =
    body["Played"] === true || body["played"] === true || body["PlaybackCompleted"] === true;
  const reachedEnd =
    clientCompleted ||
    (durationTicks > 0 && positionTicks / durationTicks >= COMPLETION_RATIO_THRESHOLD);
  const played = Boolean(existing?.played || reachedEnd);
  const playCount = reachedEnd && !existing?.played
    ? (existing?.playCount ?? 0) + 1
    : (existing?.playCount ?? (played ? 1 : 0));
  const storedPosition =
    phase === "stopped" && reachedEnd ? 0 : positionTicks;

  await repo.upsertPlaybackProgress({
    accountId,
    tmdbId: ref.tmdbId,
    mediaType,
    seasonNumber,
    episodeNumber,
    positionTicks: storedPosition,
    durationTicks,
    played,
    playCount,
    lastPlayedAt: nowIso,
  });
  return { kind: "empty", status: 204 };
}

async function handleSetPlayed(
  itemId: string,
  played: boolean,
  accountId: string,
  repo: WorkflowRepository,
  nowIso: string,
): Promise<VirtualEmbyResult> {
  const ref = parseEmbyItemId(itemId);
  if (!ref || (ref.kind !== "movie" && ref.kind !== "episode")) {
    return { kind: "json", status: 404, body: { error: `Unknown item: ${itemId}` } };
  }
  const mediaType: MediaType = ref.kind === "movie" ? "movie" : ref.mediaType;
  const seasonNumber = ref.kind === "movie" ? 1 : ref.seasonNumber;
  const episodeNumber = ref.kind === "movie" ? 1 : ref.episodeNumber;

  const existing = repo.getPlaybackProgress
    ? await repo.getPlaybackProgress({
        accountId,
        tmdbId: ref.tmdbId,
        mediaType,
        seasonNumber,
        episodeNumber,
      })
    : null;

  const updated: PlaybackProgress = {
    accountId,
    tmdbId: ref.tmdbId,
    mediaType,
    seasonNumber,
    episodeNumber,
    positionTicks: 0,
    durationTicks: existing?.durationTicks ?? 0,
    played,
    playCount: played ? Math.max(1, (existing?.playCount ?? 0) + (existing?.played ? 0 : 1)) : 0,
    lastPlayedAt: nowIso,
  };
  if (repo.upsertPlaybackProgress) {
    await repo.upsertPlaybackProgress(updated);
  }
  return { kind: "json", status: 200, body: buildUserDataDto(updated) };
}

// ── Querying, Filtering, Sorting ─────────────────────────────────────────────

function buildLibraryViews(catalog: AccountCatalog, serverId: string): Record<string, unknown>[] {
  const views: Record<string, unknown>[] = [];
  if (catalog.movies.length > 0) {
    views.push(buildLibraryDto("movies", serverId, catalog.movies.length));
  }
  if (catalog.tvSeries.length > 0) {
    views.push(buildLibraryDto("tv", serverId, catalog.tvSeries.length));
  }
  if (catalog.animeSeries.length > 0) {
    views.push(buildLibraryDto("anime", serverId, catalog.animeSeries.length));
  }
  // Never return an empty Views list (some Emby clients error if Views is empty).
  if (views.length === 0) {
    views.push(buildLibraryDto("movies", serverId, 0));
    views.push(buildLibraryDto("tv", serverId, 0));
  }
  return views;
}

function findSingleItemDto(
  catalog: AccountCatalog,
  itemId: string,
  dtoCtx: DtoContext,
): Record<string, unknown> | null {
  if (itemId === EMBY_LIBRARY_IDS.movies) return buildLibraryDto("movies", dtoCtx.serverId, catalog.movies.length);
  if (itemId === EMBY_LIBRARY_IDS.tv) return buildLibraryDto("tv", dtoCtx.serverId, catalog.tvSeries.length);
  if (itemId === EMBY_LIBRARY_IDS.anime) return buildLibraryDto("anime", dtoCtx.serverId, catalog.animeSeries.length);

  const movie = catalog.movieById.get(itemId);
  if (movie) return buildMovieDto(movie, dtoCtx);

  const series = catalog.seriesById.get(itemId);
  if (series) return buildSeriesDto(series, dtoCtx.serverId);

  const season = catalog.seasonById.get(itemId);
  if (season) return buildSeasonDto(season, dtoCtx.serverId);

  const episode = catalog.episodeById.get(itemId);
  if (episode) return buildEpisodeDto(episode, dtoCtx);

  return null;
}

interface ItemQueryOptions {
  parentId?: string;
  ids?: Set<string>;
  includeItemTypes?: Set<string>;
  excludeItemTypes?: Set<string>;
  filters?: Set<string>;
  recursive: boolean;
  searchTerm?: string;
  sortBy: string;
  sortOrder: string;
}

function queryItems(
  catalog: AccountCatalog,
  dtoCtx: DtoContext,
  opts: ItemQueryOptions,
): Record<string, unknown>[] {
  let dtos: Record<string, unknown>[] = [];

  if (opts.ids && opts.ids.size > 0) {
    for (const id of opts.ids) {
      const dto = findSingleItemDto(catalog, id, dtoCtx);
      if (dto) dtos.push(dto);
    }
  } else if (opts.parentId) {
    const parent = parseEmbyItemId(opts.parentId);
    if (parent?.kind === "library") {
      if (parent.library === "movies") {
        dtos = catalog.movies.map((m) => buildMovieDto(m, dtoCtx));
      } else {
        const list = parent.library === "anime" ? catalog.animeSeries : catalog.tvSeries;
        if (opts.recursive) {
          for (const s of list) {
            dtos.push(buildSeriesDto(s, dtoCtx.serverId));
            for (const sea of s.seasons) {
              dtos.push(buildSeasonDto(sea, dtoCtx.serverId));
              for (const ep of sea.episodes) {
                dtos.push(buildEpisodeDto(ep, dtoCtx));
              }
            }
          }
        } else {
          dtos = list.map((s) => buildSeriesDto(s, dtoCtx.serverId));
        }
      }
    } else if (parent?.kind === "series") {
      const s = catalog.seriesById.get(opts.parentId);
      if (s) {
        if (opts.recursive) {
          for (const sea of s.seasons) {
            dtos.push(buildSeasonDto(sea, dtoCtx.serverId));
            for (const ep of sea.episodes) dtos.push(buildEpisodeDto(ep, dtoCtx));
          }
        } else {
          dtos = s.seasons.map((sea) => buildSeasonDto(sea, dtoCtx.serverId));
        }
      }
    } else if (parent?.kind === "season") {
      const sea = catalog.seasonById.get(opts.parentId);
      if (sea) {
        dtos = sea.episodes.map((ep) => buildEpisodeDto(ep, dtoCtx));
      }
    }
  } else if (opts.recursive || (opts.includeItemTypes && opts.includeItemTypes.size > 0)) {
    for (const m of catalog.movies) dtos.push(buildMovieDto(m, dtoCtx));
    for (const s of [...catalog.tvSeries, ...catalog.animeSeries]) {
      dtos.push(buildSeriesDto(s, dtoCtx.serverId));
      for (const sea of s.seasons) {
        dtos.push(buildSeasonDto(sea, dtoCtx.serverId));
        for (const ep of sea.episodes) dtos.push(buildEpisodeDto(ep, dtoCtx));
      }
    }
  } else {
    // Non-recursive root query returns top-level movies + series
    for (const m of catalog.movies) dtos.push(buildMovieDto(m, dtoCtx));
    for (const s of [...catalog.tvSeries, ...catalog.animeSeries]) dtos.push(buildSeriesDto(s, dtoCtx.serverId));
  }

  // Apply type filters
  if (opts.includeItemTypes && opts.includeItemTypes.size > 0) {
    dtos = dtos.filter((d) => opts.includeItemTypes!.has(String(d["Type"] ?? "").toLowerCase()));
  }
  if (opts.excludeItemTypes && opts.excludeItemTypes.size > 0) {
    dtos = dtos.filter((d) => !opts.excludeItemTypes!.has(String(d["Type"] ?? "").toLowerCase()));
  }

  // Apply play-state filters
  if (opts.filters && opts.filters.size > 0) {
    if (opts.filters.has("isresumable")) {
      dtos = dtos.filter((d) => {
        const ud = isRecord(d["UserData"]) ? d["UserData"] : {};
        return Number(ud["PlaybackPositionTicks"] ?? 0) > 0 && ud["Played"] !== true;
      });
    }
    if (opts.filters.has("isunplayed")) {
      dtos = dtos.filter((d) => {
        const ud = isRecord(d["UserData"]) ? d["UserData"] : {};
        return ud["Played"] !== true;
      });
    }
    if (opts.filters.has("isplayed")) {
      dtos = dtos.filter((d) => {
        const ud = isRecord(d["UserData"]) ? d["UserData"] : {};
        return ud["Played"] === true;
      });
    }
  }

  // Apply SearchTerm
  if (opts.searchTerm) {
    const q = opts.searchTerm.toLowerCase();
    dtos = dtos.filter((d) => {
      const name = String(d["Name"] ?? "").toLowerCase();
      const orig = String(d["OriginalTitle"] ?? "").toLowerCase();
      return name.includes(q) || orig.includes(q);
    });
  }

  // Apply SortBy + SortOrder
  const primarySort = (opts.sortBy.split(",")[0] ?? "SortName").trim().toLowerCase();
  const desc = opts.sortOrder.trim().toLowerCase() === "descending";
  const dir = desc ? -1 : 1;

  dtos.sort((a, b) => {
    if (primarySort === "datecreated") {
      return dir * String(a["DateCreated"] ?? "").localeCompare(String(b["DateCreated"] ?? ""));
    }
    if (primarySort === "premieredate" || primarySort === "productionyear") {
      const ya = Number(a["ProductionYear"] ?? 0);
      const yb = Number(b["ProductionYear"] ?? 0);
      if (ya !== yb) return dir * (ya - yb);
    }
    if (primarySort === "dateplayed") {
      const da = String((isRecord(a["UserData"]) ? a["UserData"]["LastPlayedDate"] : "") ?? "");
      const db = String((isRecord(b["UserData"]) ? b["UserData"]["LastPlayedDate"] : "") ?? "");
      if (da !== db) return dir * da.localeCompare(db);
    }
    if (primarySort === "indexnumber") {
      const ia = Number(a["IndexNumber"] ?? 0);
      const ib = Number(b["IndexNumber"] ?? 0);
      if (ia !== ib) return dir * (ia - ib);
    }
    return dir * String(a["SortName"] ?? a["Name"] ?? "").localeCompare(
      String(b["SortName"] ?? b["Name"] ?? ""),
      "zh-Hans-CN",
    );
  });

  return dtos;
}

function collectResumableItems(
  catalog: AccountCatalog,
  dtoCtx: DtoContext,
): Record<string, unknown>[] {
  const items: Array<{ lastPlayedAt: string; dto: Record<string, unknown> }> = [];
  for (const m of catalog.movies) {
    if (m.progress && m.progress.positionTicks > 0 && !m.progress.played) {
      items.push({ lastPlayedAt: m.progress.lastPlayedAt, dto: buildMovieDto(m, dtoCtx) });
    }
  }
  for (const ep of catalog.episodeById.values()) {
    if (ep.progress && ep.progress.positionTicks > 0 && !ep.progress.played) {
      items.push({ lastPlayedAt: ep.progress.lastPlayedAt, dto: buildEpisodeDto(ep, dtoCtx) });
    }
  }
  items.sort((a, b) => b.lastPlayedAt.localeCompare(a.lastPlayedAt));
  return items.map((i) => i.dto);
}

function collectNextUpEpisodes(
  catalog: AccountCatalog,
  dtoCtx: DtoContext,
  seriesIdFilter?: string,
): Record<string, unknown>[] {
  const results: Array<{ lastPlayedAt: string; dto: Record<string, unknown> }> = [];
  const allSeries = seriesIdFilter
    ? (() => {
        const s = catalog.seriesById.get(seriesIdFilter);
        return s ? [s] : [];
      })()
    : [...catalog.tvSeries, ...catalog.animeSeries];

  for (const series of allSeries) {
    const flat = series.seasons.flatMap((s) => s.episodes);
    let lastInteractedIdx = -1;
    let latestPlayedAt = "";
    flat.forEach((ep, idx) => {
      if (ep.progress && (ep.progress.played || ep.progress.positionTicks > 0)) {
        if (!latestPlayedAt || ep.progress.lastPlayedAt >= latestPlayedAt) {
          latestPlayedAt = ep.progress.lastPlayedAt;
          lastInteractedIdx = idx;
        }
      }
    });
    if (lastInteractedIdx === -1) continue;
    const current = flat[lastInteractedIdx]!;
    if (!current.progress?.played) {
      results.push({ lastPlayedAt: latestPlayedAt, dto: buildEpisodeDto(current, dtoCtx) });
      continue;
    }
    const next = flat.slice(lastInteractedIdx + 1).find((ep) => !ep.progress?.played);
    if (next) {
      results.push({ lastPlayedAt: latestPlayedAt, dto: buildEpisodeDto(next, dtoCtx) });
    }
  }
  results.sort((a, b) => b.lastPlayedAt.localeCompare(a.lastPlayedAt));
  return results.map((r) => r.dto);
}

/** Format Emby ticks as a concise Chinese playback progress label (e.g. "已看 42 分钟"). */
export function formatPlaybackProgressLabel(progress: PlaybackProgress | null | undefined): string | null {
  if (!progress) return null;
  if (progress.played) return "已看完";
  if (progress.positionTicks <= 0) return null;
  const minutes = Math.max(1, Math.floor(progress.positionTicks / EMBY_TICKS_PER_SECOND / 60));
  if (progress.durationTicks > 0) {
    const pct = Math.min(99, Math.max(1, Math.round((progress.positionTicks / progress.durationTicks) * 100)));
    return `已看 ${minutes} 分钟 (${pct}%)`;
  }
  return `已看 ${minutes} 分钟`;
}

// ── Small Pure Utilities ─────────────────────────────────────────────────────

function parseCsvSet(raw: string | null): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  );
}

function parseNonNegInt(raw: string | null, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

function clampLimit(raw: string | null, fallback: number): number {
  const n = parseNonNegInt(raw, fallback);
  return Math.max(1, Math.min(n, 1000));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
