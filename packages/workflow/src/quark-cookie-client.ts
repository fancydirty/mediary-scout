/**
 * 阿里云盘族 (Alibaba cloud-drive family) HTTP client — 夸克 and UC share ONE
 * protocol. Originally quark-only; UC joined 2026-10-23 after live probing
 * proved every layer identical (share token → detail → save → poll, the same
 * `{code, message, data}` envelope, and even the same dead-cookie code 31001).
 * The two differ ONLY in host / fixed query / UA / referer — everything below
 * is driven by a `CloudDriveProfile`, never by a brand `if`.
 *
 * Cookie auth at `<baseUrl>`, JSON bodies, response shape
 * `{code, message, data}` where `code===0` is success. No signature params
 * (kps/sign/vcode) are needed — the cookie alone authenticates.
 *
 * 转存 (the 115-秒传 equivalent) is a 4-step chain: share token → share detail →
 * save → poll task. Magnet/offline has NO usable web API on quark, and on UC it
 * is gated behind a runtime-injected `window.encryption` (see the brand
 * evaluation ledger), so it lives in the executor's fail-loud path, not here.
 */

import { fetchWithTimeout } from "./fetch-with-timeout.js";

/** The per-brand half of the family protocol: everything that actually differs. */
export interface CloudDriveProfile {
  /** Brand key — also the StorageProvider id. */
  key: "quark" | "uc";
  /** Human label used in error messages. */
  label: string;
  baseUrl: string;
  /** Fixed query string every pc-web call carries for this brand. The two are
   *  NOT interchangeable: sending quark's `pr=ucpro&fr=pc&uc_param_str=` to UC
   *  returns 403 code=41027 分享不存在 (verified live 2026-10-23). */
  query: string;
  userAgent: string;
  referer: string;
  origin: string;
  /** Uppercase prefix for thrown error codes (QUARK_… / UC_…). */
  errorPrefix: string;
  /** Stable browser-site host a user pastes a share link from (docs/UI only). */
  shareHostPattern: RegExp;
}

/**
 * Anchor a share-host pattern so it can only match at a real host boundary.
 * Without this, an unanchored `pan\.quark\.cn\/s\/…` accepts BOTH
 * `https://evilpan.quark.cn/s/x` (a lookalike registrable domain) and
 * `https://attacker.com/drive.uc.cn/s/x` (a path substring) — either would become
 * a "transferable" candidate that can never land. Leading whitespace is tolerated
 * (pasted links often carry it); anything else must be the URL's very start.
 */
function SHARE_HOST(body: RegExp): RegExp {
  return new RegExp(`^\\s*(?:https?:\\/\\/)?${body.source}`, body.flags);
}

export const QUARK_PROFILE: CloudDriveProfile = {
  key: "quark",
  label: "夸克网盘",
  baseUrl: "https://drive-pc.quark.cn",
  // uc_param_str is intentionally empty.
  query: "pr=ucpro&fr=pc&uc_param_str=",
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124 Safari/537.36",
  referer: "https://pan.quark.cn/",
  origin: "https://pan.quark.cn",
  errorPrefix: "QUARK",
  shareHostPattern: SHARE_HOST(/pan\.quark\.cn\/s\/([0-9a-zA-Z]+)(?:[?#]([^#]*))?/),
};

/** UC profile — captured live 2026-10-23 (drive.uc.cn web client 2.5.20). */
export const UC_PROFILE: CloudDriveProfile = {
  key: "uc",
  label: "UC网盘",
  baseUrl: "https://pc-api.uc.cn",
  query: "pr=UCBrowser&fr=pc&sys=darwin&ve=1.8.6",
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "uc-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 " +
    "Safari/537.36 Channel/pckk_other_ch",
  referer: "https://drive.uc.cn",
  origin: "https://drive.uc.cn",
  errorPrefix: "UC",
  shareHostPattern: SHARE_HOST(/drive\.uc\.cn\/s\/([0-9a-zA-Z]+)(?:[?#]([^#]*))?/),
};

const DEFAULT_LIST_PAGE_SIZE = 50;
const DEFAULT_POLL_ATTEMPTS = 12;
const DEFAULT_POLL_DELAY_MS = 800;
const DEFAULT_HTTP_TIMEOUT_MS = 20_000;

/** Quark's "require login" code — the dead-cookie signal (HTTP 401, code 31001).
 *  UC uses the SAME code (verified live 2026-10-23: `401 {"code":31001,
 *  "message":"require login [guest]"}`), so one constant covers the family. */
const FAMILY_AUTH_CODE = 31001;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface QuarkHttpInit {
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
}

export type QuarkFetchJson = (url: string, init: QuarkHttpInit) => Promise<unknown>;

export interface QuarkCookieClientOptions {
  cookie: string;
  /** Which family member to talk to. Defaults to 夸克 (back-compat: every caller
   *  written before UC existed passes only a cookie). */
  profile?: CloudDriveProfile;
  fetchJson?: QuarkFetchJson;
  userAgent?: string;
  /** Injectable sleep between task-poll attempts (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
  pollAttempts?: number;
  pollDelayMs?: number;
}

/** A directory listing entry (file/sort). `dir:true` = directory. */
export interface QuarkItem {
  fid?: string;
  file_name?: string;
  dir?: boolean;
  size?: number | string;
  file_type?: number;
}

/** A share-detail entry — carries the share_fid_token needed to save it. */
export interface QuarkShareItem extends QuarkItem {
  share_fid_token?: string;
}

/**
 * The cookie is dead (logged in elsewhere / expired). Quark and UC both signal
 * this as HTTP 401 + `{code:31001, message:"require login [guest]"}`. Distinct
 * from a bad-param failure so the worker can FREEZE the drive on this
 * specifically. Mirrors Pan115AuthError.
 */
export class QuarkAuthError extends Error {
  readonly code: number | null;
  constructor(message: string, code: number | null = null) {
    super(message);
    this.name = "QuarkAuthError";
    this.code = code;
  }
}

export function isQuarkAuthError(error: unknown): error is QuarkAuthError {
  return error instanceof QuarkAuthError;
}

/** Family-neutral alias — UC and 夸克 throw the SAME error class, so brand-DSL
 *  code reads better as `isCloudDriveAuthError`. One class, not two: the worker
 *  freezes the drive on it either way, and `storage-auth-error.ts` already
 *  aggregates by brand. */
export const CloudDriveAuthError = QuarkAuthError;
export const isCloudDriveAuthError = isQuarkAuthError;

export class QuarkCookieClient {
  private readonly cookie: string;
  private readonly profile: CloudDriveProfile;
  private readonly fetchJson: QuarkFetchJson;
  private readonly userAgent: string;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly pollAttempts: number;
  private readonly pollDelayMs: number;

  constructor(options: QuarkCookieClientOptions) {
    const cookie = normalizeCookie(options.cookie);
    if (!cookie) {
      throw new Error("QUARK_COOKIE is required to create QuarkCookieClient");
    }
    this.cookie = cookie;
    this.profile = options.profile ?? QUARK_PROFILE;
    this.fetchJson = options.fetchJson ?? defaultFetchJson;
    this.userAgent = options.userAgent ?? this.profile.userAgent;
    this.sleepFn = options.sleep ?? sleep;
    this.pollAttempts = options.pollAttempts ?? DEFAULT_POLL_ATTEMPTS;
    this.pollDelayMs = options.pollDelayMs ?? DEFAULT_POLL_DELAY_MS;
  }

  /** Immediate children of a directory (file/sort, one page; size covers a media leaf). */
  async listItems(input: { directoryId: string; page?: number; size?: number }): Promise<QuarkItem[]> {
    const response = await this.getJson("/1/clouddrive/file/sort", [
      ["pdir_fid", input.directoryId],
      ["_page", String(input.page ?? 1)],
      ["_size", String(input.size ?? DEFAULT_LIST_PAGE_SIZE)],
      ["_fetch_total", "1"],
      ["_sort", "file_type:asc,updated_at:desc"],
    ]);
    const data = unwrap(response, this.errCode("LIST_ITEMS_FAILED"));
    return listFrom(data);
  }

  /** A single file/directory's identity incl. its immediate parent (pdir_fid).
   *  Quark has no one-shot breadcrumb, so the executor walks pdir_fid up to a
   *  write-scope root with these calls. */
  async getFileInfo(fid: string): Promise<{ fid: string; file_name: string; pdir_fid: string; dir: boolean }> {
    const response = await this.getJson("/1/clouddrive/file/info", [["fid", fid]]);
    const data = unwrap(response, this.errCode("FILE_INFO_FAILED"));
    return {
      fid: stringValue(recordValue(data, "fid")),
      file_name: stringValue(recordValue(data, "file_name")),
      pdir_fid: stringValue(recordValue(data, "pdir_fid")),
      dir: recordValue(data, "dir") === true,
    };
  }

  async createFolder(input: { name: string; parentId: string }): Promise<string> {
    const response = await this.postJson("/1/clouddrive/file", {
      pdir_fid: input.parentId,
      file_name: input.name,
      dir_path: "",
      dir_init_lock: false,
    });
    const data = unwrap(response, this.errCode("CREATE_FOLDER_FAILED"));
    const fid = stringValue(recordValue(data, "fid"));
    if (!fid) {
      throw new Error(`${this.errCode("CREATE_FOLDER_FAILED")}: response missing data.fid`);
    }
    return fid;
  }

  /** Step 1 of 转存: exchange a share's pwd_id + passcode for an stoken. */
  async getShareToken(input: { pwd_id: string; passcode: string }): Promise<string> {
    const response = await this.postJson("/1/clouddrive/share/sharepage/token", {
      pwd_id: input.pwd_id,
      passcode: input.passcode,
    });
    const data = unwrap(response, this.errCode("SHARE_TOKEN_FAILED"));
    const stoken = stringValue(recordValue(data, "stoken"));
    if (!stoken) {
      throw new Error(`${this.errCode("SHARE_TOKEN_FAILED")}: response missing data.stoken`);
    }
    return stoken;
  }

  /** Step 2: list the files inside a share (each carries share_fid_token for save). */
  async listShareDetail(input: {
    pwd_id: string;
    stoken: string;
    pdirFid?: string;
    page?: number;
    size?: number;
  }): Promise<QuarkShareItem[]> {
    const response = await this.getJson("/1/clouddrive/share/sharepage/detail", [
      ["pwd_id", input.pwd_id],
      ["stoken", input.stoken],
      ["pdir_fid", input.pdirFid ?? "0"],
      ["force", "0"],
      ["_page", String(input.page ?? 1)],
      ["_size", String(input.size ?? DEFAULT_LIST_PAGE_SIZE)],
      ["_fetch_banner", "0"],
      ["_fetch_share", "0"],
      ["_fetch_total", "1"],
      ["_sort", "file_type:asc,updated_at:desc"],
    ]);
    const data = unwrap(response, this.errCode("SHARE_DETAIL_FAILED"));
    return listFrom(data) as QuarkShareItem[];
  }

  /** Step 3: save selected share files into a destination directory; returns task_id. */
  async saveShare(input: {
    fid_list: string[];
    fid_token_list: string[];
    to_pdir_fid: string;
    pwd_id: string;
    stoken: string;
    pdirFid?: string;
  }): Promise<string> {
    const response = await this.postJson("/1/clouddrive/share/sharepage/save", {
      fid_list: input.fid_list,
      fid_token_list: input.fid_token_list,
      to_pdir_fid: input.to_pdir_fid,
      pwd_id: input.pwd_id,
      stoken: input.stoken,
      pdir_fid: input.pdirFid ?? "0",
      scene: "link",
    });
    const data = unwrap(response, this.errCode("SHARE_SAVE_FAILED"));
    const taskId = stringValue(recordValue(data, "task_id"));
    if (!taskId) {
      throw new Error(`${this.errCode("SHARE_SAVE_FAILED")}: response missing data.task_id`);
    }
    return taskId;
  }

  /** Step 4: poll the async task until status===2 (done). false if it never completes. */
  async pollTask(taskId: string, opts?: { maxAttempts?: number }): Promise<boolean> {
    const maxAttempts = opts?.maxAttempts ?? this.pollAttempts;
    for (let i = 0; i < maxAttempts; i++) {
      const response = await this.getJson("/1/clouddrive/task", [
        ["task_id", taskId],
        ["retry_index", String(i)],
      ]);
      const data = unwrap(response, this.errCode("TASK_FAILED"));
      if (numberValue(recordValue(data, "status")) === 2) {
        return true;
      }
      await this.sleepFn(this.pollDelayMs);
    }
    return false;
  }

  /** Delete files (action_type:2 = move to recycle bin, same as 115's rb/delete).
   *  Async on quark — returns a task_id we poll to completion. */
  async deleteFiles(fids: string[]): Promise<void> {
    const response = await this.postJson("/1/clouddrive/file/delete", {
      action_type: 2,
      filelist: fids,
      exclude_fids: [],
    });
    await this.awaitTaskFrom(response, this.errCode("DELETE_FAILED"));
  }

  /** Move files. Async on quark — returns a task_id we poll to completion so the
   *  move is reflected before the caller re-reads the destination. */
  async moveFiles(input: { fids: string[]; to: string }): Promise<void> {
    const response = await this.postJson("/1/clouddrive/file/move", {
      filelist: input.fids,
      to_pdir_fid: input.to,
      exclude_fids: [],
      action_type: 1,
    });
    await this.awaitTaskFrom(response, this.errCode("MOVE_FAILED"));
  }

  /** Unwrap a task-returning response and poll its task_id to completion (if any). */
  private async awaitTaskFrom(response: unknown, genericPrefix: string): Promise<void> {
    const data = unwrap(response, genericPrefix);
    const taskId = stringValue(recordValue(data, "task_id"));
    if (taskId) {
      await this.pollTask(taskId);
    }
  }

  async renameFile(input: { fid: string; name: string }): Promise<void> {
    const response = await this.postJson("/1/clouddrive/file/rename", {
      fid: input.fid,
      file_name: input.name,
    });
    unwrap(response, this.errCode("RENAME_FAILED"));
  }

  private async getJson(path: string, params: Array<[string, string]>): Promise<unknown> {
    const query = new URLSearchParams(this.profile.query);
    for (const [key, value] of params) {
      query.set(key, value);
    }
    return this.fetchJson(`${this.profile.baseUrl}${path}?${query.toString()}`, {
      method: "GET",
      headers: this.headers(),
    });
  }

  private async postJson(path: string, body: unknown): Promise<unknown> {
    return this.fetchJson(`${this.profile.baseUrl}${path}?${this.profile.query}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
  }

  private errCode(suffix: string): string {
    return `${this.profile.errorPrefix}_${suffix}`;
  }

  private headers(): Record<string, string> {
    return {
      Cookie: this.cookie,
      "User-Agent": this.userAgent,
      Referer: this.profile.referer,
      Origin: this.profile.origin,
      "Content-Type": "application/json",
      Accept: "application/json, text/plain, */*",
    };
  }
}

/** Extract the stable family account id from a cookie (`__uid=` preferred,
 *  `__kps=` fallback — both carry the same opaque per-account token). Verified
 *  live that UC uses the identical cookie key names, so one parser serves the
 *  whole family. Keys the instance-wide UNIQUE(provider, provider_uid). */
export function parseCloudDriveUid(cookie: string): string | null {
  const uid = /(?:^|;|\s)__uid=([^;]+)/.exec(cookie);
  if (uid?.[1]) {
    return uid[1].trim();
  }
  const kps = /(?:^|;|\s)__kps=([^;]+)/.exec(cookie);
  return kps?.[1] ? kps[1].trim() : null;
}

/** Back-compat alias — 夸克 callers predate the family rename. */
export const parseQuarkUid = parseCloudDriveUid;

async function defaultFetchJson(url: string, init: QuarkHttpInit): Promise<unknown> {
  const requestInit: RequestInit = { method: init.method, headers: init.headers };
  if (init.body !== undefined) {
    requestInit.body = init.body;
  }
  const response = await fetchWithTimeout(url, requestInit, DEFAULT_HTTP_TIMEOUT_MS);
  // Quark returns its {code:31001} auth body WITH HTTP 401, so parse the JSON
  // regardless of status — the code (not the HTTP status) is the real signal.
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`QUARK_HTTP_FAILED: ${response.status}`);
  }
}

/**
 * Assert `code===0` and return `data`. On the auth code (31001) throw
 * QuarkAuthError so the drive can be frozen; on any other non-zero code throw a
 * generic Error carrying the server message (fail-loud — never a silent success).
 */
function unwrap(response: unknown, genericPrefix: string): unknown {
  const code = numberValue(recordValue(response, "code"));
  if (code === 0) {
    return recordValue(response, "data");
  }
  const message = responseMessage(response);
  if (isAuthFailure(code, message)) {
    // One class for the whole family (see CloudDriveAuthError). The prefix's brand
    // half carries into the message, so logs read UC_AUTH_FAILED on a UC drive.
    throw new QuarkAuthError(`${familyOf(genericPrefix)}_AUTH_FAILED: ${message}`, code);
  }
  throw new Error(`${genericPrefix}: code=${code} ${message}`);
}

/** "QUARK_SHARE_SAVE_FAILED" → "QUARK" (the brand half of an error code). */
function familyOf(errorCode: string): string {
  return errorCode.split("_")[0] ?? errorCode;
}

function isAuthFailure(code: number, message: string): boolean {
  if (code === FAMILY_AUTH_CODE) {
    return true;
  }
  return /require login|未登录|登录|登陆|relogin/i.test(message);
}

function responseMessage(response: unknown): string {
  return stringValue(recordValue(response, "message") ?? recordValue(response, "msg"));
}

function listFrom(data: unknown): QuarkItem[] {
  return arrayValue(recordValue(data, "list")).filter(isRecord) as QuarkItem[];
}

function normalizeCookie(cookie: string | undefined): string {
  const trimmed = cookie?.trim() ?? "";
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
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
    return Number.isFinite(parsed) ? parsed : NaN;
  }
  return NaN;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
