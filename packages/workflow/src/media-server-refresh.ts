import type { MediaType, NotificationEvent } from "./domain.js";
import { fetchWithTimeout } from "./fetch-with-timeout.js";

/**
 * Post-landing media server library refresh (issue #373).
 *
 * When cloud drive files land via FUSE / WebDAV / CloudDrive2 / OpenList / rclone,
 * media servers (Emby, Jellyfin, Plex, fnOS/custom scripts) do not receive kernel
 * inotify events. After a workflow run actually lands new or replaced files, we
 * coalesce one library scan call per configured media server (with optional settle
 * delay so FUSE directory caches see the newly moved files).
 *
 * Never throws into the acquisition pipeline: refresh errors are collected/logged.
 */

export const MEDIA_SERVER_SETTING_KEYS = {
  embyUrl: "media_server_emby_url",
  embyApiKey: "media_server_emby_api_key",
  jellyfinUrl: "media_server_jellyfin_url",
  jellyfinApiKey: "media_server_jellyfin_api_key",
  plexUrl: "media_server_plex_url",
  plexToken: "media_server_plex_token",
  webhookUrl: "media_server_webhook_url",
  delaySeconds: "media_server_refresh_delay_sec",
} as const;

export const DEFAULT_MEDIA_SERVER_DELAY_SECONDS = 5;
export const MAX_MEDIA_SERVER_DELAY_SECONDS = 120;

export type MediaServerChannelKey = "emby" | "jellyfin" | "plex" | "webhook";

export const MEDIA_SERVER_CHANNEL_KEYS: readonly MediaServerChannelKey[] = [
  "emby",
  "jellyfin",
  "plex",
  "webhook",
];

export interface LandedMediaItem {
  titleName: string;
  seasonLabel?: string | null;
  mediaType?: MediaType;
  tmdbId?: number;
  year?: number;
  newlyObtained?: string[];
  landingDir?: string;
  driveLabels?: string[];
}

export interface MediaServerFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type MediaServerFetch = (
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string; redirect?: "error" | "follow" | "manual" },
) => Promise<MediaServerFetchResponse>;

const DEFAULT_TIMEOUT_MS = 15_000;

const defaultMediaServerFetch: MediaServerFetch = async (url, init) => {
  // Never follow a redirect with an API key/token attached: a misconfigured or
  // compromised reverse proxy could bounce the credentialed request elsewhere.
  const res = await fetchWithTimeout(url, { ...init, redirect: "error" }, DEFAULT_TIMEOUT_MS);
  return {
    ok: res.ok,
    status: res.status,
    text: () => res.text(),
  };
};

export function validateMediaServerUrl(
  raw: string,
  opts?: { allowQuery?: boolean },
): { ok: true; url: string } | { ok: false; message: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, message: "服务地址不能为空" };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, message: "服务地址格式不正确，需以 http:// 或 https:// 开头" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, message: "服务地址仅支持 http:// 或 https://" };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, message: "请勿在 URL 中内嵌账号密码，凭证请填在密钥栏" };
  }
  if (parsed.hash || (!opts?.allowQuery && parsed.search)) {
    return { ok: false, message: "服务地址请勿包含 ? 参数或 # 片段，只需填到端口或反代路径" };
  }
  // Normalize trailing slashes on pathname while preserving reverse-proxy subpaths like /emby
  const cleanPath = parsed.pathname.replace(/\/+$/, "");
  const normalized = `${parsed.origin}${cleanPath}${opts?.allowQuery ? parsed.search : ""}`;
  return { ok: true, url: normalized };
}

/**
 * Filter a batch of notifications down to the ones that represent genuinely NEW or
 * REPLACED files landing on a drive during this run/sweep.
 *
 * "Files landed" is taken from the report itself, never from a status label alone:
 *  - `acquired` (a film just landed) and `replaced` (a film was swapped) always landed;
 *  - episode reports (`complete` / `airing` / `partial`) count ONLY when they name
 *    newly obtained episodes — a routine patrol of an already-complete season also
 *    reports `complete`, and must not trigger a library scan.
 * Synthetic digests and routine `already_current` checks never trigger anything.
 */
export function extractLandedMediaEvents(notifications: readonly NotificationEvent[]): LandedMediaItem[] {
  const out: LandedMediaItem[] = [];
  // Persisted reports are rehydrated JSON: a legacy/hand-edited row can lack
  // `newlyObtained`. This module must never throw inside the acquisition pipeline.
  const seen = new Set<string>();
  for (const n of notifications) {
    if (n.kind === "already_current" || n.kind === "daily_digest") continue;
    const r = n.report;
    if (!r) continue;
    const newlyObtained = Array.isArray(r.newlyObtained) ? r.newlyObtained : [];
    const landed =
      r.status === "acquired" ||
      r.status === "replaced" ||
      ((r.status === "complete" || r.status === "airing" || r.status === "partial") &&
        newlyObtained.length > 0);
    if (!landed) continue;
    // Identity key: TMDB id (when known) separates a film from a same-named series
    // and from remakes; the display fields are the fallback for report-less rows.
    const key = [
      r.tmdbId !== undefined ? `tmdb:${r.tmdbId}` : r.titleName,
      r.year ?? "",
      r.mediaType ?? "",
      r.seasonLabel ?? "",
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      titleName: r.titleName,
      ...(r.seasonLabel !== undefined ? { seasonLabel: r.seasonLabel } : {}),
      ...(r.mediaType !== undefined ? { mediaType: r.mediaType } : {}),
      ...(r.tmdbId !== undefined ? { tmdbId: r.tmdbId } : {}),
      ...(r.year !== undefined ? { year: r.year } : {}),
      ...(newlyObtained.length > 0 ? { newlyObtained } : {}),
      ...(r.landingDir ? { landingDir: r.landingDir } : {}),
      ...(r.driveLabels && r.driveLabels.length > 0 ? { driveLabels: r.driveLabels } : {}),
    });
  }
  return out;
}

/** Emby & Jellyfin share the exact `POST /Library/Refresh` endpoint with `X-Emby-Token`. */
export async function refreshEmbyOrJellyfin(input: {
  kind: "emby" | "jellyfin";
  baseUrl: string;
  apiKey: string;
  fetchImpl?: MediaServerFetch;
}): Promise<void> {
  const valid = validateMediaServerUrl(input.baseUrl);
  if (!valid.ok) throw new Error(valid.message);
  const fetchImpl = input.fetchImpl ?? defaultMediaServerFetch;
  const label = input.kind === "emby" ? "Emby" : "Jellyfin";
  const res = await fetchImpl(`${valid.url}/Library/Refresh`, {
    method: "POST",
    headers: { "X-Emby-Token": input.apiKey.trim() },
  });
  if (!res.ok) {
    throw new Error(`${label} 返回 HTTP ${res.status}`);
  }
}

function parsePlexSectionKeys(body: string): string[] {
  const trimmed = body.trim();
  if (!trimmed) return [];
  // Prefer JSON (`Accept: application/json`)
  try {
    const parsed = JSON.parse(trimmed) as {
      MediaContainer?: { Directory?: Array<{ key?: string | number }> };
    };
    const dirs = parsed?.MediaContainer?.Directory;
    if (Array.isArray(dirs)) {
      return dirs
        .map((d) => String(d?.key ?? "").trim())
        .filter((k) => /^[A-Za-z0-9_-]+$/.test(k));
    }
  } catch {
    // Fall through to lightweight XML attribute scan if a proxy stripped Accept
  }
  const keys: string[] = [];
  const regex = /<Directory\b[^>]*?\bkey="([A-Za-z0-9_-]+)"/g;
  for (let m = regex.exec(trimmed); m !== null; m = regex.exec(trimmed)) {
    if (m[1]) keys.push(m[1]);
  }
  return [...new Set(keys)];
}

/** Plex: list all library sections via `X-Plex-Token` header and trigger incremental refresh on each. */
export async function refreshPlexLibrary(input: {
  baseUrl: string;
  token: string;
  fetchImpl?: MediaServerFetch;
}): Promise<{ refreshedSections: number }> {
  const valid = validateMediaServerUrl(input.baseUrl);
  if (!valid.ok) throw new Error(valid.message);
  const fetchImpl = input.fetchImpl ?? defaultMediaServerFetch;
  const headers = {
    "X-Plex-Token": input.token.trim(),
    Accept: "application/json",
  };
  const listRes = await fetchImpl(`${valid.url}/library/sections`, {
    method: "GET",
    headers,
  });
  if (!listRes.ok) {
    throw new Error(`Plex 获取媒体库列表返回 HTTP ${listRes.status}`);
  }
  const keys = parsePlexSectionKeys(await listRes.text());
  if (keys.length === 0) {
    // A wrong path / login page behind a reverse proxy answers 200 with no sections.
    // Reporting success there made the Settings "test" pass while nothing was scanned.
    throw new Error("Plex 未返回任何媒体库（检查地址是否指向 Plex 服务器）");
  }
  const failedKeys: string[] = [];
  for (const key of keys) {
    const scanRes = await fetchImpl(`${valid.url}/library/sections/${encodeURIComponent(key)}/refresh`, {
      method: "GET",
      headers,
    });
    if (!scanRes.ok) {
      // Sections are independent scans: one broken/locked library must not stop the rest.
      failedKeys.push(`${key} (HTTP ${scanRes.status})`);
    }
  }
  if (failedKeys.length > 0) {
    throw new Error(`Plex 刷新分库失败：${failedKeys.join("、")}`);
  }
  return { refreshedSections: keys.length };
}

export async function triggerMediaServerWebhook(input: {
  webhookUrl: string;
  items: readonly LandedMediaItem[];
  test?: boolean;
  fetchImpl?: MediaServerFetch;
}): Promise<void> {
  const valid = validateMediaServerUrl(input.webhookUrl, { allowQuery: true });
  if (!valid.ok) throw new Error(valid.message);
  const fetchImpl = input.fetchImpl ?? defaultMediaServerFetch;
  const res = await fetchImpl(valid.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      event: "library.landed",
      test: Boolean(input.test),
      triggeredAt: new Date().toISOString(),
      items: input.items,
    }),
  });
  if (!res.ok) {
    throw new Error(`入库 Webhook 返回 HTTP ${res.status}`);
  }
}

export interface ResolvedMediaServerConfig {
  emby: { url: string; apiKey: string } | null;
  jellyfin: { url: string; apiKey: string } | null;
  plex: { url: string; token: string } | null;
  webhookUrl: string | null;
  delaySeconds: number;
}

export function parseMediaServerDelaySeconds(raw: string | null | undefined): number {
  if (raw === null || raw === undefined || raw.trim() === "") {
    return DEFAULT_MEDIA_SERVER_DELAY_SECONDS;
  }
  const num = Number(raw.trim());
  if (!Number.isFinite(num) || num < 0) return DEFAULT_MEDIA_SERVER_DELAY_SECONDS;
  return Math.min(MAX_MEDIA_SERVER_DELAY_SECONDS, Math.round(num));
}

export async function readMediaServerConfig(
  repository: { getSetting(key: string): Promise<string | null> },
  overrides?: Partial<{
    embyUrl: string;
    embyApiKey: string;
    jellyfinUrl: string;
    jellyfinApiKey: string;
    plexUrl: string;
    plexToken: string;
    webhookUrl: string;
    delaySeconds: number;
  }>,
  env: Record<string, string | undefined> = process.env,
): Promise<ResolvedMediaServerConfig> {
  const pick = async (overrideVal: string | undefined, settingKey: string, envKey: string): Promise<string> => {
    // `""` is an EXPLICIT clear (the settings form sends every field it shows),
    // distinct from `undefined` = not provided → fall back to DB/env.
    if (overrideVal !== undefined) return overrideVal.trim();
    const dbVal = (await repository.getSetting(settingKey))?.trim();
    if (dbVal) return dbVal;
    return (env[envKey] ?? "").trim();
  };

  const [embyUrl, embyApiKey, jellyfinUrl, jellyfinApiKey, plexUrl, plexToken, webhookUrl, delayRaw] =
    await Promise.all([
      pick(overrides?.embyUrl, MEDIA_SERVER_SETTING_KEYS.embyUrl, "MEDIA_TRACK_EMBY_URL"),
      pick(overrides?.embyApiKey, MEDIA_SERVER_SETTING_KEYS.embyApiKey, "MEDIA_TRACK_EMBY_API_KEY"),
      pick(overrides?.jellyfinUrl, MEDIA_SERVER_SETTING_KEYS.jellyfinUrl, "MEDIA_TRACK_JELLYFIN_URL"),
      pick(overrides?.jellyfinApiKey, MEDIA_SERVER_SETTING_KEYS.jellyfinApiKey, "MEDIA_TRACK_JELLYFIN_API_KEY"),
      pick(overrides?.plexUrl, MEDIA_SERVER_SETTING_KEYS.plexUrl, "MEDIA_TRACK_PLEX_URL"),
      pick(overrides?.plexToken, MEDIA_SERVER_SETTING_KEYS.plexToken, "MEDIA_TRACK_PLEX_TOKEN"),
      pick(overrides?.webhookUrl, MEDIA_SERVER_SETTING_KEYS.webhookUrl, "MEDIA_TRACK_MEDIA_WEBHOOK_URL"),
      repository.getSetting(MEDIA_SERVER_SETTING_KEYS.delaySeconds),
    ]);

  const delaySeconds =
    overrides?.delaySeconds !== undefined
      ? parseMediaServerDelaySeconds(String(overrides.delaySeconds))
      : parseMediaServerDelaySeconds(delayRaw ?? env["MEDIA_TRACK_MEDIA_REFRESH_DELAY_SEC"]);

  return {
    emby: embyUrl && embyApiKey ? { url: embyUrl, apiKey: embyApiKey } : null,
    jellyfin: jellyfinUrl && jellyfinApiKey ? { url: jellyfinUrl, apiKey: jellyfinApiKey } : null,
    plex: plexUrl && plexToken ? { url: plexUrl, token: plexToken } : null,
    webhookUrl: webhookUrl || null,
    delaySeconds,
  };
}

function scrubSecrets(message: string, secrets: readonly string[]): string {
  let out = message;
  for (const s of secrets) {
    const clean = s.trim();
    if (clean.length < 4) continue;
    out = out.split(clean).join("***");
    // A secret embedded in a webhook URL query reaches errors percent-encoded.
    const encoded = encodeURIComponent(clean);
    if (encoded !== clean) {
      out = out.split(encoded).join("***");
    }
  }
  return out;
}

export interface MediaServerRefreshSummary {
  refreshed: string[];
  failures: Array<{ server: string; error: string }>;
}

export async function refreshConfiguredMediaServers(input: {
  repository: { getSetting(key: string): Promise<string | null> };
  items: readonly LandedMediaItem[];
  test?: boolean;
  delayMs?: number;
  overrides?: Parameters<typeof readMediaServerConfig>[1];
  fetchImpl?: MediaServerFetch;
}): Promise<MediaServerRefreshSummary> {
  if (!input.test && input.items.length === 0) {
    return { refreshed: [], failures: [] };
  }
  const cfg = await readMediaServerConfig(input.repository, input.overrides);
  const hasAny = Boolean(cfg.emby || cfg.jellyfin || cfg.plex || cfg.webhookUrl);
  if (!hasAny) {
    return { refreshed: [], failures: [] };
  }

  const effectiveDelayMs = input.delayMs ?? (input.test ? 0 : cfg.delaySeconds * 1000);
  if (effectiveDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, effectiveDelayMs));
  }

  const secrets = [
    cfg.emby?.apiKey ?? "",
    cfg.jellyfin?.apiKey ?? "",
    cfg.plex?.token ?? "",
    cfg.webhookUrl ?? "",
  ].filter(Boolean);
  const refreshed: string[] = [];
  const failures: Array<{ server: string; error: string }> = [];

  const runTarget = async (
    label: string,
    fn: () => Promise<void>,
  ): Promise<{ ok: true; label: string } | { ok: false; label: string; error: string }> => {
    try {
      await fn();
      return { ok: true, label };
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      return { ok: false, label, error: scrubSecrets(raw, secrets).slice(0, 200) };
    }
  };

  const shared = input.fetchImpl ? { fetchImpl: input.fetchImpl } : {};

  // Independent HTTP targets: run them concurrently so one dead server does not
  // stack its 15 s timeout in front of the others (refresh runs inline after a run).
  // `runTarget` isolates each failure, and the pushes stay in a fixed label order.
  const results = await Promise.all([
    cfg.emby
      ? runTarget("Emby", () =>
          refreshEmbyOrJellyfin({ kind: "emby", baseUrl: cfg.emby!.url, apiKey: cfg.emby!.apiKey, ...shared }),
        )
      : null,
    cfg.jellyfin
      ? runTarget("Jellyfin", () =>
          refreshEmbyOrJellyfin({ kind: "jellyfin", baseUrl: cfg.jellyfin!.url, apiKey: cfg.jellyfin!.apiKey, ...shared }),
        )
      : null,
    cfg.plex
      ? runTarget("Plex", async () => {
          await refreshPlexLibrary({ baseUrl: cfg.plex!.url, token: cfg.plex!.token, ...shared });
        })
      : null,
    cfg.webhookUrl
      ? runTarget("入库 Webhook", () =>
          triggerMediaServerWebhook({
            webhookUrl: cfg.webhookUrl!,
            items: input.items,
            test: Boolean(input.test),
            ...shared,
          }),
        )
      : null,
  ]);
  for (const result of results) {
    if (!result) continue;
    if (result.ok) refreshed.push(result.label);
    else failures.push({ server: result.label, error: result.error });
  }

  return { refreshed, failures };
}
