import { fetchWithTimeout } from "./fetch-with-timeout.js";

/**
 * 光鸭云盘 (GuangYaPan) HTTP client — the brand-3 analogue of Pan115CookieClient
 * and QuarkCookieClient. Unlike those two (cookie auth), 光鸭 uses OAuth Bearer
 * tokens (access_token + refresh_token) issued by `account.guangyapan.com`.
 *
 * Two hosts:
 *  - account.guangyapan.com — auth (validate user, refresh token). Bearer only.
 *  - api.guangyapan.com     — files + offline. Bearer + `Did:<deviceId>` + `Dt:4`.
 *
 * SUCCESS SIGNAL: `msg === ""` OR `msg.toLowerCase() === "success"`. The `code`
 * field is null on every response and MUST NOT be used as the signal.
 *
 * On a 401 the access_token is stale; we refresh once (POST /v1/auth/token with
 * the refresh_token) and retry the call. A fresh access/refresh pair is surfaced
 * via `onTokensRefreshed` so the executor can persist it. The executor that uses
 * this client (StorageExecutor) is a later task — this file is the API layer only.
 */

export const GUANGYA_CLIENT_ID = "aMe-8VSlkrbQXpUR";

const AUTH_HOST = "https://account.guangyapan.com";
const API_HOST = "https://api.guangyapan.com";

const DEFAULT_LIST_PAGE_SIZE = 100;
const DEFAULT_HTTP_TIMEOUT_MS = 20_000;

/** A directory listing entry from get_file_list. */
export interface GuangYaItem {
  fileId: string;
  parentId: string;
  fileName: string;
  fileSize: number;
  resType: number;
}

/** One subfile inside a bt/磁力 resource (fileIndex is null when the API omits it). */
export interface GuangYaSubfile {
  fileName: string;
  fileIndex: number | null;
  fileSize: number;
}

/** resolve_res result, parsed into the typed shape the executor relies on. */
export interface GuangYaResolvedRes {
  resType: number;
  url?: string;
  btResInfo?: {
    infoHash: string;
    fileName: string;
    subfiles: GuangYaSubfile[];
  };
}

/** One offline-task status row from list_task. */
export interface GuangYaTaskStatus {
  taskId: string;
  status: number;
  progress: number;
  fileId: string;
}

/** The token pair (+ the device id they were bound to) handed to the persist hook. */
export interface GuangYaTokens {
  accessToken: string;
  refreshToken: string;
  deviceId: string;
}

export type GuangYaFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface GuangYaClientOptions {
  accessToken: string;
  refreshToken: string;
  /** Stable per-install device id sent as the `Did` header. Auto-generated (32 hex) if empty. */
  deviceId?: string;
  /** Called after a successful refresh so the caller can persist the new tokens. */
  onTokensRefreshed?: (tokens: GuangYaTokens) => void | Promise<void>;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: GuangYaFetch;
}

/**
 * The token pair is dead / refresh failed — distinct from a generic API error so
 * the worker can FREEZE the drive on this specifically. Mirrors QuarkAuthError /
 * Pan115AuthError.
 */
export class GuangYaAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuangYaAuthError";
  }
}

export function isGuangYaAuthError(error: unknown): error is GuangYaAuthError {
  return error instanceof GuangYaAuthError;
}

/**
 * Decode the `sub` (user id) from a 光鸭 access_token (a JWT). Returns the sub
 * string, or null when the token is malformed / missing a sub. Keys the
 * instance-wide UNIQUE(provider, provider_uid).
 */
export function parseGuangYaUid(accessToken: string): string | null {
  const segments = accessToken.split(".");
  const payloadSegment = segments[1];
  if (!payloadSegment) {
    return null;
  }
  try {
    const payloadJson = Buffer.from(payloadSegment, "base64url").toString("utf8");
    const payload = JSON.parse(payloadJson) as unknown;
    const sub = recordValue(payload, "sub");
    return typeof sub === "string" && sub.length > 0 ? sub : null;
  } catch {
    return null;
  }
}

/**
 * Parse a 光鸭 share link. The shareId is the WHOLE path segment after /s/
 * (`1947864096514232347_amtV6IXLP9l33m6z` — splitting on "_" is rejected with 112
 * 参数错误, real probe 2026-09-24). The 提取码 rides in `?pwd=` / `?code=`.
 * Returns null for anything that is not a 光鸭 share URL.
 */
export function parseGuangYaShareUrl(url: string): { shareId: string; code: string } | null {
  const noFragment = url.split("#")[0] ?? url;
  // The id must be the WHOLE segment: it ends at the url end, "?" or a single
  // trailing "/" — never "/s/abc/other" or "/s/abc.evil".
  const m = /^https?:\/\/(?:www\.)?guangyapan\.com\/s\/([0-9A-Za-z_-]+)\/?(?:\?|$)/.exec(noFragment);
  if (!m?.[1]) {
    return null;
  }
  const params = new URLSearchParams(noFragment.split("?")[1] ?? "");
  return { shareId: m[1], code: params.get("pwd") ?? params.get("code") ?? params.get("password") ?? "" };
}

export class GuangYaClient {
  private accessToken: string;
  private refreshToken: string;
  private readonly deviceId: string;
  private readonly onTokensRefreshed: ((tokens: GuangYaTokens) => void | Promise<void>) | undefined;
  private readonly fetchImpl: GuangYaFetch;

  constructor(options: GuangYaClientOptions) {
    // Trim tokens defensively (mirrors TianyiClient): the credential extraction now
    // hands over the raw stored blob, so the client is the single place that
    // sanitizes — a stray-whitespace token (e.g. from a refresh response) never
    // reaches the `Bearer` header.
    this.accessToken = options.accessToken.trim();
    this.refreshToken = options.refreshToken.trim();
    this.deviceId = options.deviceId?.trim() || generateGuangYaDeviceId();
    this.onTokensRefreshed = options.onTokensRefreshed;
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetchWithTimeout(url, init, DEFAULT_HTTP_TIMEOUT_MS));
  }

  /** GET account/v1/user/me (Bearer); refresh+retry once on 401. Returns `sub`. */
  async validateToken(): Promise<string> {
    const sub = await this.getMeSub(false);
    if (!sub) {
      throw new GuangYaAuthError("GUANGYA_VALIDATE_FAILED: response missing sub");
    }
    return sub;
  }

  private async getMeSub(retried: boolean): Promise<string> {
    const response = await this.fetchImpl(`${AUTH_HOST}/v1/user/me`, {
      method: "GET",
      headers: this.authHeaders(),
    });
    if (response.status === 401) {
      if (retried) {
        throw new GuangYaAuthError("GUANGYA_VALIDATE_FAILED: 401 after refresh");
      }
      await this.refreshTokens();
      return this.getMeSub(true);
    }
    const body = (await response.json()) as unknown;
    const sub = recordValue(body, "sub");
    return typeof sub === "string" ? sub : "";
  }

  /** Paginate get_file_list into a flat GuangYaItem[]. */
  async listFiles(parentId: string, page = 0, pageSize = DEFAULT_LIST_PAGE_SIZE): Promise<GuangYaItem[]> {
    const items: GuangYaItem[] = [];
    let currentPage = page;
    for (;;) {
      const data = await this.postAPI("/userres/v1/file/get_file_list", {
        parentId,
        page: currentPage,
        pageSize,
        orderBy: 3,
        sortType: 1,
        fileTypes: [],
      });
      const list = arrayValue(recordValue(data, "list")).filter(isRecord);
      for (const raw of list) {
        items.push(toItem(raw));
      }
      if (list.length < pageSize) {
        break;
      }
      currentPage += 1;
    }
    return items;
  }

  /** Create a directory under `parentId`; returns the new fileId. */
  async createDir(parentId: string, dirName: string): Promise<string> {
    const data = await this.postAPI("/nd.bizuserres.s/v1/file/create_dir", { parentId, dirName });
    const fileId = stringValue(recordValue(data, "fileId"));
    if (!fileId) {
      throw new Error("GUANGYA_CREATE_DIR_FAILED: response missing data.fileId");
    }
    return fileId;
  }

  async renameFile(fileId: string, newName: string): Promise<void> {
    await this.postAPI("/nd.bizuserres.s/v1/file/rename", { fileId, newName });
  }

  async deleteFiles(fileIds: string[]): Promise<void> {
    await this.postAPI("/nd.bizuserres.s/v1/file/delete_file", { fileIds });
  }

  async moveFiles(fileIds: string[], parentId: string): Promise<void> {
    await this.postAPI("/nd.bizuserres.s/v1/file/move_file", { fileIds, parentId });
  }

  /** Resolve a share/magnet URL to its resType + (for bt) subfile listing. */
  async resolveRes(url: string): Promise<GuangYaResolvedRes> {
    const data = await this.postAPI("/cloudcollection/v1/resolve_res", { url });
    return toResolvedRes(data);
  }

  /** Create an offline-download task; returns the taskId. */
  async createTask(input: {
    url: string;
    parentId: string;
    newName: string;
    fileIndexes?: number[];
  }): Promise<string> {
    const body: Record<string, unknown> = {
      url: input.url,
      parentId: input.parentId,
      newName: input.newName,
    };
    if (input.fileIndexes !== undefined) {
      body.fileIndexes = input.fileIndexes;
    }
    const data = await this.postAPI("/cloudcollection/v1/create_task", body);
    const taskId = stringValue(recordValue(data, "taskId"));
    if (!taskId) {
      throw new Error("GUANGYA_CREATE_TASK_FAILED: response missing data.taskId");
    }
    return taskId;
  }

  // ── 分享链转存 ──────────────────────────────────────────────────────────────
  // Protocol from github.com/BugGeeker/guangyaclient-go (2026-09-20) + the official
  // web bundle, verified against the real drive 2026-09-24 (docs/claude-memory/
  // guangya-share-transfer-api.md). All calls ride postAPI (Bearer + Did + Dt:4,
  // 401 → refresh once) — the share endpoints accept the logged-in headers.

  /** Exchange (shareId, 提取码) for a share accessToken. A dead share comes back as
   *  a business code (201 分享已失效 / 200 分享链接错误 / 112 参数错误) with HTTP 200,
   *  which postAPI already turns into a loud GUANGYA_API_FAILED carrying the msg. */
  async getShareAccessToken(shareId: string, code: string): Promise<string> {
    const envelope: { top?: unknown } = {};
    const data = await this.postAPI("/userres/v1/get_share_access_token", { shareId, code }, false, envelope);
    // Real responses carry data.accessToken (probe 2026-09-24); guangyaclient-go also
    // models a top-level access_token, so accept either rather than call a live share dead.
    const token = stringValue(recordValue(data, "accessToken")) || stringValue(recordValue(envelope.top, "access_token"));
    if (!token) {
      throw new Error("GUANGYA_SHARE_TOKEN_FAILED: response missing data.accessToken");
    }
    return token;
  }

  /** List one directory of a share (parentId "" = share root). Cursor mode, exactly
   *  the web client's body; `cursor` MUST be a number (a string is rejected with a
   *  bind error). A response with no `list` is an empty page — seen on half of the
   *  real shares probed, where summary and token succeed but nothing is listable. */
  async listShareFiles(
    accessToken: string,
    parentId: string,
    options: { pageSize?: number; maxPages?: number } = {},
  ): Promise<GuangYaItem[]> {
    const pageSize = options.pageSize ?? DEFAULT_LIST_PAGE_SIZE;
    // Pagination is by RESPONSE cursor echoed back (real-drive walk 2026-09-24: cursor
    // 1→2→end enumerates; `page` repeats page 0). The cap is a runaway guard, and
    // hitting it FAILS LOUD — restoring a silently partial root would be a lie.
    const maxPages = options.maxPages ?? 50;
    const items: GuangYaItem[] = [];
    let cursor: number | undefined;
    for (let page = 0; page < maxPages; page += 1) {
      const body: Record<string, unknown> = { pageSize, accessToken, orderBy: 0, sortType: 0, parentId };
      if (cursor !== undefined) body.cursor = cursor;
      const data = await this.postAPI("/userres/v1/get_share_page_files_list", body);
      const list = arrayValue(recordValue(data, "list")).filter(isRecord);
      for (const raw of list) items.push(toItem(raw));
      const next = numberValue(recordValue(data, "cursor"));
      // The CURSOR drives pagination. Stop only on a definite end: an empty page, no /
      // repeated cursor, or an explicit hasMore:false. `total` is NOT trusted as a stop
      // — the real probes could not tell a directory total from a page count, and
      // stopping on a page count would restore a partial root. (Real walk 2026-09-24:
      // cursor 1 → 2 → {cursor:2} empty.)
      if (list.length === 0 || next <= 0 || next === cursor || recordValue(data, "hasMore") === false) return items;
      cursor = next;
    }
    throw new Error(`GUANGYA_SHARE_TOO_LARGE: 分享目录超过 ${maxPages} 页仍未列完,拒绝只转存一部分`);
  }

  /** Save share files into our `parentId`; returns the restore taskId. Folder ids are
   *  restored whole (a folder share landed its 92GB file in ~4s on the real drive). */
  async restoreShare(input: { accessToken: string; fileIds: string[]; parentId: string }): Promise<string> {
    const data = await this.postAPI("/userres/v1/restore_share", {
      accessToken: input.accessToken,
      fileIds: input.fileIds,
      parentId: input.parentId,
    });
    const taskId = stringValue(recordValue(data, "taskId"));
    if (!taskId) {
      throw new Error("GUANGYA_RESTORE_SHARE_FAILED: response missing data.taskId");
    }
    return taskId;
  }

  /** Status of a file task (restore/copy/move/delete): 1 = running, 2 = done. */
  async getTaskStatus(taskId: string): Promise<{ status: number }> {
    const data = await this.postAPI("/userres/v1/get_task_status", { taskId });
    return { status: numberValue(recordValue(data, "status")) };
  }

  /** Poll the status/progress of offline tasks. */
  async listTask(taskIds: string[]): Promise<GuangYaTaskStatus[]> {
    const data = await this.postAPI("/cloudcollection/v1/list_task", { taskIds });
    return arrayValue(recordValue(data, "list")).filter(isRecord).map(toTaskStatus);
  }

  /**
   * POST to the api host with Bearer + Did + Dt:4. On 401 (once) refresh and
   * retry. Success = `msg===""||msg==="success"`; otherwise throw (GuangYaAuthError
   * on 401, plain Error otherwise) carrying the server msg.
   */
  private async postAPI(path: string, body: unknown, retried = false, envelope?: { top?: unknown }): Promise<unknown> {
    const response = await this.fetchImpl(`${API_HOST}${path}`, {
      method: "POST",
      headers: this.apiHeaders(),
      body: JSON.stringify(body),
    });
    if (response.status === 401) {
      if (retried) {
        throw new GuangYaAuthError(`GUANGYA_AUTH_FAILED: 401 after refresh (${path})`);
      }
      await this.refreshTokens();
      return this.postAPI(path, body, true, envelope);
    }
    const json = (await response.json().catch(() => ({}))) as unknown;
    if (envelope) envelope.top = json;
    const msg = stringValue(recordValue(json, "msg"));
    if (response.ok && (msg === "" || msg.toLowerCase() === "success")) {
      return recordValue(json, "data");
    }
    throw new Error(`GUANGYA_API_FAILED: ${path} status=${response.status} msg=${msg}`);
  }

  /**
   * Exchange the refresh_token for a fresh access (and possibly refresh) token.
   * Updates in-memory tokens and notifies onTokensRefreshed. Throws
   * GuangYaAuthError on failure (refresh token dead).
   */
  private async refreshTokens(): Promise<void> {
    const response = await this.fetchImpl(`${AUTH_HOST}/v1/auth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: GUANGYA_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: this.refreshToken,
      }),
    });
    const json = (await response.json()) as unknown;
    const accessToken = stringValue(recordValue(json, "access_token"));
    if (!response.ok || !accessToken) {
      const error = stringValue(recordValue(json, "error"));
      const description = stringValue(recordValue(json, "error_description"));
      throw new GuangYaAuthError(
        `GUANGYA_REFRESH_FAILED: ${error || response.status} ${description}`.trim(),
      );
    }
    this.accessToken = accessToken.trim();
    const refreshToken = stringValue(recordValue(json, "refresh_token"));
    if (refreshToken) {
      this.refreshToken = refreshToken.trim();
    }
    if (this.onTokensRefreshed) {
      await this.onTokensRefreshed({
        accessToken: this.accessToken,
        refreshToken: this.refreshToken,
        deviceId: this.deviceId,
      });
    }
  }

  private authHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.accessToken}`,
    };
  }

  private apiHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.accessToken}`,
      Did: this.deviceId,
      Dt: "4",
    };
  }
}

/**
 * Generate a stable 光鸭 device id (32 hex chars) for the `Did` header. Call this
 * ONCE at connect time and persist the result so every worker run reuses the same
 * id — a fresh id each run looks like many devices to 光鸭's risk control. The
 * client's internal default (when no deviceId is supplied) calls this same helper.
 */
export function generateGuangYaDeviceId(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, "");
}

function toItem(raw: Record<string, unknown>): GuangYaItem {
  return {
    fileId: stringValue(raw.fileId),
    parentId: stringValue(raw.parentId),
    fileName: stringValue(raw.fileName),
    fileSize: numberValue(raw.fileSize),
    resType: numberValue(raw.resType),
  };
}

function toResolvedRes(data: unknown): GuangYaResolvedRes {
  const resolved: GuangYaResolvedRes = { resType: numberValue(recordValue(data, "resType")) };
  const url = recordValue(data, "url");
  if (typeof url === "string" && url.length > 0) {
    resolved.url = url;
  }
  const btRaw = recordValue(data, "btResInfo");
  if (isRecord(btRaw)) {
    resolved.btResInfo = {
      infoHash: stringValue(recordValue(btRaw, "infoHash")),
      fileName: stringValue(recordValue(btRaw, "fileName")),
      subfiles: arrayValue(recordValue(btRaw, "subfiles")).filter(isRecord).map(toSubfile),
    };
  }
  return resolved;
}

function toSubfile(raw: Record<string, unknown>): GuangYaSubfile {
  const idx = raw.fileIndex;
  return {
    fileName: stringValue(raw.fileName),
    fileIndex: typeof idx === "number" && Number.isFinite(idx) ? idx : null,
    fileSize: numberValue(raw.fileSize),
  };
}

function toTaskStatus(raw: Record<string, unknown>): GuangYaTaskStatus {
  return {
    taskId: stringValue(raw.taskId),
    status: numberValue(raw.status),
    progress: numberValue(raw.progress),
    fileId: stringValue(raw.fileId),
  };
}

function recordValue(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return "";
}

function numberValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
