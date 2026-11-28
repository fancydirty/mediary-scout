/**
 * 123网盘 (123pan / yun.123pan.com) HTTP client — the brand-5 analogue of
 * QuarkCookieClient / TianyiClient. Like 夸克/天翼 it is token-auth (Bearer
 * <token>) and can 转存分享; unlike 夸克/天翼 it ALSO has a native offline-
 * download path on the web face (magnet/ed2k/http → resolve → submit → poll),
 * ported from OpenList `drivers/123` OfflineDownload.
 *
 * Uses ONLY the WEB face `yun.123pan.com/b/api/*`. Every request carries a
 * crc32-based signPath signature (the {k,v} pair is injected into the query) plus
 * a fixed header set. There is NO token-refresh endpoint on the web face (all
 * refresh_token flows live on open-api.123pan.com, unrelated to 转存), so a dead
 * token cannot self-heal here: code 401 / 20101 (see PAN123_AUTH_CODES) throws Pan123AuthError and the upstream
 * registry freezes the connection for the user to re-scan. (This is why there is no
 * onCredentialRefresh / login_another / retry logic — nothing to refresh with.)
 *
 * 🔴 THE root cause this brand needs care for: 123's FileId/ShareId/task_id
 * (int64, 18 digits) exceed Number.MAX_SAFE_INTEGER. Plain JSON.parse silently
 * ROUNDS them → a corrupted, non-existent id → a transfer that hangs / lands
 * nothing. The fix: stringify these id fields BEFORE JSON.parse. `parsePan123Json`
 * is the SINGLE json-parse entry point — no response is ever handed to raw JSON.parse.
 */

import { parseFiniteMetric } from "./domain.js";
import { DriveFileNotFoundError, type DriveDownloadLink } from "./ports.js";

const API_BASE = "https://yun.123pan.com/b/api";
const DEFAULT_TIMEOUT_MS = 20_000;
const OFFLINE_RESOLVE_TIMEOUT_MS = 60_000;

/** Standard IEEE CRC32. Buffer in, unsigned 32-bit out. Used by signPath. */
export function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    let c = (crc ^ (buf[i] as number)) & 0xff;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 123 web-face request signature (ported verbatim from the real-run probe /
 * OpenList drivers/123 signPath). Returns {k, v} where the query KEY is the
 * timeSign value itself and the VALUE is `<timestamp>-<random>-<dataSign>`.
 * ⚠️ Date.now()/Math.random() are intentional — this is a real client, not the
 * Workflow sandbox.
 */
export function signPath(path: string): { k: string; v: string } {
  const table = "adefghlmyijnopkqrstubcvwsz";
  const random = String(Math.round(1e7 * Math.random()));
  const nowMs = Date.now();
  const timestamp = String(Math.floor(nowMs / 1000));
  const cst = new Date(nowMs + 8 * 3600 * 1000);
  const p2 = (n: number): string => String(n).padStart(2, "0");
  const nowStr = `${cst.getUTCFullYear()}${p2(cst.getUTCMonth() + 1)}${p2(cst.getUTCDate())}${p2(cst.getUTCHours())}${p2(cst.getUTCMinutes())}`;
  const mapped = Buffer.from([...nowStr].map((ch) => table.charCodeAt(ch.charCodeAt(0) - 48)));
  const timeSign = String(crc32(mapped));
  const data = [timestamp, random, path, "web", "3", timeSign].join("|");
  const dataSign = String(crc32(Buffer.from(data)));
  return { k: timeSign, v: [timestamp, random, dataSign].join("-") };
}

/** id 字段名:123 的这些字段是 18 位 int64,JSON.parse 前必须先转字符串防精度丢失。
 *  ⚠️ 全 client 唯一的解析入口,任何响应都走它。字段清单以真跑通的探针 BIGINT 常量为准,
 *  额外加 `\s*` 容错(JSON 允许冒号前后空白)。`id`/`task_id`/`resource_id` 覆盖离线
 *  resolve/submit/list 响应(OpenList drivers/123);仅匹配 ≥16 位所以不会把 Size/progress 当 id。 */
const BIGINT_ID_FIELDS =
  /"(FileId|fileId|ShareId|shareId|file_id|parent_file_id|task_id|resource_id|id)"\s*:\s*(\d{16,})/g;

/** 唯一 JSON 解析入口:先把大整数 id 字段加引号转字符串,再 parse。见文件头「root cause」。 */
export function parsePan123Json(text: string): unknown {
  try {
    return JSON.parse(text.replace(BIGINT_ID_FIELDS, '"$1":"$2"'));
  } catch {
    return null;
  }
}

/** The inverse of parsePan123Json for REQUEST bodies. 123's file/trash only acts
 *  on a JSON-number FileId (a string id is silently ignored — live-isolated
 *  2026-09-20), yet an 18-digit int64 cannot round-trip through Number(). So the
 *  body is built with a unique placeholder string per id, stringified, and each
 *  placeholder is then replaced by the bare digit literal (unquoted). Ids are
 *  validated as pure digits first: a non-numeric id would otherwise be spliced in
 *  as invalid JSON. */
const NUMERIC_ID_PLACEHOLDER = "\u0000pan123-numeric-id:";

export function numericIdPlaceholder(id: string): string {
  // Digits only AND no leading zero: `007` spliced in bare is not a JSON number
  // (123 would reject/misparse it); a lone `0` (the root folder) stays valid.
  if (!/^(?:0|[1-9]\d*)$/.test(id)) {
    throw new Error(`PAN123_BAD_ID: expected a numeric 123 file id, got ${JSON.stringify(id)}`);
  }
  return `${NUMERIC_ID_PLACEHOLDER}${id}`;
}

export function rawJsonWithNumericIds(body: unknown, ids: string[]): string {
  let raw = JSON.stringify(body);
  for (const id of ids) {
    raw = raw.split(JSON.stringify(numericIdPlaceholder(id))).join(id);
  }
  return raw;
}

/** providerUid = JWT payload 的 `id`(稳定数字用户 id)。非 JWT/空 → null。
 *  keys UNIQUE(provider, provider_uid)。 */
export function parsePan123Uid(token: string): string | null {
  const parts = (token ?? "").trim().split(".");
  if (parts.length < 2 || !parts[1]) {
    return null;
  }
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    );
    const id = payload?.id;
    return id != null && String(id).trim() ? String(id) : null;
  } catch {
    return null;
  }
}

/**
 * The token is dead — distinct from a generic API error so the worker can FREEZE
 * the drive on this specifically. Mirrors TianyiAuthError / QuarkAuthError.
 * v1 does NOT self-heal (no web-face refresh endpoint); the user re-scans.
 */
export class Pan123AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Pan123AuthError";
  }
}

/** Envelope codes that mean "this token is no longer logged in". 401 = token invalid /
 *  expired. 20101 = 未登录: seen in production (2026-09-30) on a 90-day token still inside
 *  its lifetime, i.e. the session was kicked off (the 123 App's device list, or another
 *  login pushing it out). Both need a re-scan, so both freeze the drive. */
const PAN123_AUTH_CODES = new Set([401, 20101]);

export function isPan123AuthError(error: unknown): error is Pan123AuthError {
  return error instanceof Pan123AuthError;
}

/** The credential blob persisted in connected_storages.payload. v1 是纯 token 模型
 *  (web 面无刷新端点),故不含 tokenExp/meta——没有代码写读,YAGNI。 */
export interface Pan123Credential {
  token: string;
}

export type Pan123Fetch = (
  url: string,
  init: {
    method: "GET" | "POST";
    headers: Record<string, string>;
    body?: string;
    timeoutMs?: number;
    redirect?: "follow" | "manual";
  },
) => Promise<{
  status: number;
  text: string;
  location?: string | null;
  contentType?: string | null;
}>;

/** 统一 item:file/list/new 与 share/get 的 InfoList 条目共用此形状。 */
export interface Pan123Item {
  id: string;
  name: string;
  size: number;
  etag: string;
  isFolder: boolean;
}

export type Pan123ResolveRedirect = (
  url: string,
  headers: Record<string, string>,
) => Promise<string>;

export interface Pan123FileInfo {
  fileId: string;
  fileName: string;
  size: number;
  etag: string;
  s3keyFlag: string;
  type: number;
}

export interface Pan123ClientOptions {
  token: string;
  fetchImpl?: Pan123Fetch;
  /** Injectable single-hop redirect resolver for download URLs (tests pass a stub). */
  resolveRedirect?: Pan123ResolveRedirect;
}

export class Pan123Client {
  private readonly token: string;
  private readonly fetchImpl: Pan123Fetch;
  private readonly resolveRedirect: Pan123ResolveRedirect;

  constructor(opts: Pan123ClientOptions) {
    // Defensive coercion at the single choke point: callers cast `credential`
    // from unknown, so a malformed DB blob can deliver a non-string token. Treat
    // it as "" so the failure surfaces as a clean 401 → Pan123AuthError (freeze),
    // never a TypeError inside .trim().
    this.token = typeof opts.token === "string" ? opts.token.trim() : "";
    this.fetchImpl = opts.fetchImpl ?? defaultPan123Fetch;
    this.resolveRedirect =
      opts.resolveRedirect ??
      ((url, headers) => defaultPan123ResolveRedirect(url, headers, this.fetchImpl));
  }

  // ── 传输(signPath 签名 + envelope 判定) ──────────────────────────────────

  /** 组装签名请求 + envelope 判定。返回响应顶层对象(含 code/data)。
   *  code===0 成功;code 401/20101 → Pan123AuthError(死 token,不重试/不刷新);其它非 0 → 普通 Error。 */
  private async signed(
    path: string,
    init: {
      method: "GET" | "POST";
      query?: Record<string, string>;
      body?: unknown;
      /** Pre-serialised JSON body (bigint-safe numeric ids spliced in). Wins over `body`. */
      rawBody?: string;
      timeoutMs?: number;
    },
  ): Promise<Record<string, unknown>> {
    const u = new URL(API_BASE + path);
    for (const [k, v] of Object.entries(init.query ?? {})) {
      if (v != null) {
        u.searchParams.set(k, v);
      }
    }
    const s = signPath(u.pathname);
    u.searchParams.set(s.k, s.v);
    let res: { status: number; text: string };
    try {
      res = await this.fetchImpl(u.toString(), {
        method: init.method,
        headers: {
          authorization: `Bearer ${this.token}`,
          platform: "web",
          "app-version": "3",
          "content-type": "application/json;charset=UTF-8",
          origin: "https://yun.123pan.com",
          referer: "https://yun.123pan.com/",
          "user-agent": "Mozilla/5.0",
        },
        ...(init.timeoutMs !== undefined ? { timeoutMs: init.timeoutMs } : {}),
        ...(init.rawBody !== undefined
          ? { body: init.rawBody }
          : init.body !== undefined
            ? { body: JSON.stringify(init.body) }
            : {}),
      });
    } catch (error) {
      // A bare "The operation was aborted due to timeout" reads like the LLM timed out
      // (《出入平安》 2026-09-24: 123's API hung for hours and the user suspected the
      // model). Name the brand + host + path; keep the original message (the transient
      // classifier matches on it) and the cause. The URL's query (signature) and the
      // token header are never included.
      const name = error instanceof Error ? error.name : "Error";
      // undici quotes an invalid header VALUE in its message ('"Bearer <token>" is an
      // invalid header value'), and this message is persisted and pushed — so the
      // token is removed before it can travel. The cause keeps the raw error in-process.
      let message = error instanceof Error ? error.message : String(error);
      // Masked wherever it appears as a whole token-shaped run (bounded by characters
      // that cannot be part of a JWT/base64url token), so any length is covered and a
      // short token never shreds ordinary words ("t" inside "timeout" is not a match).
      if (this.token) {
        const escaped = this.token.replace(/[.*+?^\${}()|[\]\\]/g, "\\$&");
        // "=" can only TRAIL a base64 value (padding), never lead one — so it is a
        // boundary on the left (token=<t> must still be masked) but not on the right.
        message = message.replace(new RegExp(`(?<![A-Za-z0-9._~+/-])${escaped}(?![A-Za-z0-9._~+/=-])`, "g"), "***");
      }
      throw new Error(`PAN123_REQUEST_FAILED(${u.host} ${u.pathname}): ${name} ${message}`, { cause: error });
    }
    const parsed = parsePan123Json(res.text);
    // Fail LOUD on a non-JSON body (WAF/gateway/challenge HTML, transient 5xx) —
    // never null→{}→code=0=空成功, or an upstream outage / GFW block masquerades as
    // an empty directory / 「分享已失效」 (the TMDB-outage-as-empty 病, 天翼血泪).
    // ⚠️ Not gated on HTTP status: challenge pages ship HTTP 200 + HTML.
    if (parsed === null || typeof parsed !== "object") {
      throw new Error(`PAN123_HTTP_FAILED: status=${res.status} non-JSON body`);
    }
    const data = parsed as Record<string, unknown>;
    // 123 每个 web 响应都带 code;缺 code = 非正常响应(不是 code:0 空成功)→ fail loud。
    if (data["code"] === undefined) {
      throw new Error(`PAN123_HTTP_FAILED: status=${res.status} missing code`);
    }
    const code = numOf(data["code"]);
    if (PAN123_AUTH_CODES.has(code)) {
      throw new Pan123AuthError(`PAN123_AUTH_FAILED: ${strOf(data["message"])}`);
    }
    if (code !== 0) {
      throw new Error(`PAN123_FAILED(${path}): code=${code} ${strOf(data["message"])}`);
    }
    return data;
  }

  // ── 目录读 ───────────────────────────────────────────────────────────────

  /** file/list/new:分页游标 `next`(起始 "0"),读 data.InfoList + data.Next。
   *  Next 为 -1/""/0 之一即停止(照探针分页停止条件)。
   *  `opts.maxPages` 封顶翻页数(默认不限=全量翻页,现行为):probe 这类 cheap read
   *  只需第一页验活,存量大账号不必付至多 100 个串行签名往返。 */
  async listFiles(parentFileId: string, opts?: { maxPages?: number }): Promise<Pan123Item[]> {
    const out: Pan123Item[] = [];
    let next = "0";
    // Safety cap: a misbehaving cursor must not spin forever (100 pages × 100 = 10k items).
    for (let guard = 0; guard < 100; guard++) {
      const resp = await this.signed("/file/list/new", {
        method: "GET",
        query: {
          driveId: "0",
          limit: "100",
          next,
          orderBy: "file_id",
          orderDirection: "desc",
          parentFileId,
          trashed: "false",
          Page: "1",
        },
      });
      const d = (resp["data"] ?? {}) as Record<string, unknown>;
      const infoList = Array.isArray(d["InfoList"]) ? (d["InfoList"] as unknown[]) : [];
      for (const it of infoList) {
        out.push(mapPan123Item(it));
      }
      const nextCursor = d["Next"];
      if (isStopCursor(nextCursor)) {
        break;
      }
      if (guard + 1 >= (opts?.maxPages ?? Infinity)) {
        break; // cheap-read cap reached — caller only needed the first page(s)
      }
      next = String(nextCursor);
    }
    return out;
  }

  /** 列分享目录(share/get,登录态空码穿透)。分页游标 `next`(起始 "0"),读 data.InfoList
   *  + data.Next,停止哨兵同 listFiles。合并所有页——分享顶层 >100 文件时不静默截断
   *  (no-silent-caps,转存完整性)。 */
  async listShareDir(input: { shareKey: string; sharePwd: string; parentFileId?: string }): Promise<Pan123Item[]> {
    const out: Pan123Item[] = [];
    let next = "0";
    for (let guard = 0; guard < 100; guard++) {
      const resp = await this.signed("/share/get", {
        method: "GET",
        query: {
          ShareKey: input.shareKey,
          SharePwd: input.sharePwd,
          parentFileId: input.parentFileId ?? "0",
          Page: "1",
          limit: "100",
          next,
          orderBy: "file_name",
          orderDirection: "asc",
          event: "homeListFile",
        },
      });
      const d = (resp["data"] ?? {}) as Record<string, unknown>;
      const infoList = Array.isArray(d["InfoList"]) ? (d["InfoList"] as unknown[]) : [];
      for (const it of infoList) {
        out.push(mapPan123Item(it));
      }
      const nextCursor = d["Next"];
      if (isStopCursor(nextCursor)) {
        break;
      }
      next = String(nextCursor);
    }
    return out;
  }

  // ── 转存链(share/get → file/copy/async) ─────────────────────────────────

  /** 转存:先 listShareDir 拿顶层 items(空 → ok:false,不抛);再 file/copy/async。
   *  ⚠️ file_list 每项必须四件套 file_id+file_name+etag+size(缺 size→code:5050),
   *  外加 parent_file_id+drive_id+type。无异步 task 轮询,由 executor 重列目录验证。 */
  async saveShare(input: {
    shareKey: string;
    sharePwd: string;
    targetParentId: string;
  }): Promise<{ ok: boolean; message: string }> {
    const items = await this.listShareDir({ shareKey: input.shareKey, sharePwd: input.sharePwd });
    if (items.length === 0) {
      return { ok: false, message: "分享为空 / 已失效(share empty / dead)" };
    }
    await this.signed("/file/copy/async", {
      method: "POST",
      body: {
        share_key: input.shareKey,
        share_pwd: input.sharePwd,
        current_level: 1,
        event: "transfer",
        file_list: items.map((i) => ({
          file_id: i.id,
          file_name: i.name,
          etag: i.etag,
          size: i.size,
          parent_file_id: input.targetParentId,
          drive_id: 0,
          type: i.isFolder ? 1 : 0,
        })),
      },
    });
    return { ok: true, message: "" };
  }

  // ── 目录写 ───────────────────────────────────────────────────────────────

  async createFolder(input: { name: string; parentId: string }): Promise<string> {
    const resp = await this.signed("/file/upload_request", {
      method: "POST",
      body: { driveId: 0, etag: "", fileName: input.name, parentFileId: input.parentId, size: 0, type: 1 },
    });
    const d = (resp["data"] ?? {}) as Record<string, unknown>;
    const info = (d["Info"] ?? {}) as Record<string, unknown>;
    const id = strId(info["FileId"]) || strId(d["FileId"]);
    if (!id) {
      throw new Error("PAN123_CREATE_FOLDER_FAILED: response missing FileId");
    }
    return id;
  }

  async trash(entries: { id: string; name?: string; isFolder: boolean }[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }
    // ⚠️ FileId MUST be a JSON NUMBER here. LIVE-ISOLATED 2026-09-20 (production
    // container, real drive, every field combination): `"FileId":"57162650"` →
    // code:0 / InfoList:[] / nothing deleted; `"FileId":57162650` → code:0 /
    // InfoList:[{FileId}] / gone. The endpoint neither errors nor flags the string
    // form — it just ignores the entry. Our bigint-safe habit of shipping ids as
    // strings therefore made EVERY 123 delete a silent no-op (80 leaked staging
    // dirs / ~1.4 TB). The id is spliced into the body as a raw digit literal so
    // an 18-digit int64 survives without Number() rounding (the same bigint rule
    // as parsePan123Json, in the other direction).
    const resp = await this.signed("/file/trash", {
      method: "POST",
      rawBody: rawJsonWithNumericIds(
        {
          driveId: 0,
          event: "intoRecycle",
          operation: true,
          fileTrashInfoList: entries.map((e) => ({
            FileId: numericIdPlaceholder(e.id),
            ...(e.name ? { FileName: e.name } : {}),
            Type: e.isFolder ? 1 : 0,
          })),
        },
        entries.map((e) => e.id),
      ),
    });
    // The ONLY success signal the endpoint gives is echoing each acted-on id in
    // data.InfoList. A code:0 with a missing echo is exactly the silent-no-op
    // shape above — fail loud so a leak can never again hide behind {removed:true}.
    const data = (resp["data"] ?? {}) as Record<string, unknown>;
    const echoed = new Set(
      (Array.isArray(data["InfoList"]) ? (data["InfoList"] as unknown[]) : []).map((it) =>
        strId((it as Record<string, unknown>)["FileId"]),
      ),
    );
    const missing = entries.map((e) => e.id).filter((id) => !echoed.has(id));
    if (missing.length > 0) {
      throw new Error(
        `PAN123_TRASH_NOOP: file/trash answered code:0 but did not act on ${missing.join(",")} (InfoList echo missing)`,
      );
    }
  }

  async moveFiles(input: { fileIds: string[]; targetParentId: string }): Promise<void> {
    if (input.fileIds.length === 0) {
      return;
    }
    await this.signed("/file/mod_pid", {
      method: "POST",
      body: {
        fileIdList: input.fileIds.map((id) => ({ FileId: id })),
        parentFileId: input.targetParentId,
        event: "fileMove",
      },
    });
  }

  async renameFile(input: { fileId: string; name: string }): Promise<void> {
    await this.signed("/file/rename", {
      method: "POST",
      body: { FileId: input.fileId, fileName: input.name, driveId: 0, duplicate: 0, event: "fileRename" },
    });
  }

  // ── 离线下载(magnet/ed2k/http → resolve → submit → list) ─────────────────
  // Ported from OpenList drivers/123 OfflineDownload. Status codes observed there:
  // 0=downloading, 1=failed, 2=succeed (3 may appear as retrying on open-api face).

  /** Resolve a magnet/ed2k/http URL into a resource_id + selectable file ids.
   *  `name` = the file name 123 will land under (the url's decoded path segment;
   *  an http task lands it directly in upload_dir). */
  async resolveOffline(url: string): Promise<{ resourceId: string; fileIds: string[]; resolvedName?: string }> {
    const resp = await this.signed("/v2/offline_download/task/resolve", {
      method: "POST",
      body: { urls: url },
      timeoutMs: OFFLINE_RESOLVE_TIMEOUT_MS,
    });
    const data = (resp["data"] ?? {}) as Record<string, unknown>;
    const list = Array.isArray(data["list"]) ? (data["list"] as unknown[]) : [];
    if (list.length === 0) {
      throw new Error("PAN123_OFFLINE_RESOLVE_FAILED: empty response");
    }
    const first = (list[0] ?? {}) as Record<string, unknown>;
    if (numOf(first["result"]) !== 0) {
      const msg = strOf(first["err_msg"]) || "offline resolve failed";
      const code = strOf(first["err_code"]);
      throw new Error(`PAN123_OFFLINE_RESOLVE_FAILED: ${msg}${code ? ` (err_code=${code})` : ""}`);
    }
    const resourceId = strId(first["id"]);
    if (!resourceId) {
      throw new Error("PAN123_OFFLINE_RESOLVE_FAILED: empty resource id");
    }
    const files = Array.isArray(first["files"]) ? (first["files"] as unknown[]) : [];
    const fileIds: string[] = [];
    for (const f of files) {
      const fid = strId((f as Record<string, unknown>)["id"]);
      if (fid && fid !== "0") {
        fileIds.push(fid);
      }
    }
    if (fileIds.length === 0) {
      throw new Error("PAN123_OFFLINE_RESOLVE_FAILED: empty file list");
    }
    const resolvedName = strOf(first["name"]);
    return { resourceId, fileIds, ...(resolvedName ? { resolvedName } : {}) };
  }

  /** Submit a previously-resolved offline resource into `uploadDirId`. Returns taskId. */
  async submitOffline(input: {
    resourceId: string;
    fileIds: string[];
    uploadDirId: string;
  }): Promise<string> {
    if (input.fileIds.length === 0) {
      throw new Error("PAN123_OFFLINE_SUBMIT_FAILED: empty select_file_id");
    }
    // API wants numeric ids; keep as string in JS but JSON will emit quoted strings
    // which 123 accepts (OpenList sends int64; our bigint-safe path keeps strings).
    const resourceIdNum = Number(input.resourceId);
    const selectFileIds = input.fileIds.map((id) => {
      const n = Number(id);
      return Number.isSafeInteger(n) ? n : id;
    });
    const uploadDir = Number.isSafeInteger(Number(input.uploadDirId))
      ? Number(input.uploadDirId)
      : input.uploadDirId;
    const resp = await this.signed("/v2/offline_download/task/submit", {
      method: "POST",
      body: {
        resource_list: [
          {
            resource_id: Number.isSafeInteger(resourceIdNum) ? resourceIdNum : input.resourceId,
            select_file_id: selectFileIds,
          },
        ],
        upload_dir: uploadDir,
      },
    });
    const data = (resp["data"] ?? {}) as Record<string, unknown>;
    const taskList = Array.isArray(data["task_list"]) ? (data["task_list"] as unknown[]) : [];
    if (taskList.length === 0) {
      throw new Error("PAN123_OFFLINE_SUBMIT_FAILED: empty task list");
    }
    const first = (taskList[0] ?? {}) as Record<string, unknown>;
    if (numOf(first["result"]) !== 0) {
      const msg = strOf(first["err_msg"]) || "provider rejected submit";
      const code = strOf(first["err_code"]);
      throw new Error(`PAN123_OFFLINE_SUBMIT_FAILED: ${msg}${code ? ` (err_code=${code})` : ""}`);
    }
    const taskId = strId(first["task_id"]);
    if (!taskId) {
      throw new Error("PAN123_OFFLINE_SUBMIT_FAILED: empty task id");
    }
    return taskId;
  }

  /** Look up one offline task by id (pages status_arr 0/1/2/3). Null if not found. */
  async getOfflineTask(taskId: string): Promise<Pan123OfflineTask | null> {
    if (!taskId) {
      return null;
    }
    let page = 1;
    const pageSize = 100;
    for (let guard = 0; guard < 50; guard++) {
      const resp = await this.signed("/offline_download/task/list", {
        method: "POST",
        body: {
          current_page: page,
          page_size: pageSize,
          status_arr: [0, 1, 2, 3],
        },
      });
      const data = (resp["data"] ?? {}) as Record<string, unknown>;
      const list = Array.isArray(data["list"]) ? (data["list"] as unknown[]) : [];
      for (const raw of list) {
        const t = mapOfflineTask(raw);
        if (t.taskId === taskId) {
          return t;
        }
      }
      const total = numOf(data["total"]);
      if (list.length === 0 || page * pageSize >= total) {
        break;
      }
      page += 1;
    }
    return null;
  }

  /** Rows for a SET of task ids (the subtitle batch polls all its tasks with one
   *  round of paging). Same endpoint/paging as getOfflineTask; stops as soon as
   *  every wanted id has been seen, and never reads more than `maxPages` pages
   *  (default 3 = 300 newest tasks — ours are the newest; a huge account queue
   *  must not turn one poll into 50 requests). Missing ids are simply absent.
   *  task/list is newest-first (live 2026-09-22: tasks submitted seconds earlier
   *  head page 1), so maxPages 3 covers a batch; the executor claims from the
   *  directory anyway, so a task missing from these pages is not a lost landing. */
  async listOfflineTasks(taskIds: string[], opts?: { maxPages?: number }): Promise<Pan123OfflineTask[]> {
    const wanted = new Set(taskIds.filter((id) => id.length > 0));
    if (wanted.size === 0) {
      return [];
    }
    const maxPages = opts?.maxPages ?? 3;
    const pageSize = 100;
    const found: Pan123OfflineTask[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const resp = await this.signed("/offline_download/task/list", {
        method: "POST",
        body: { current_page: page, page_size: pageSize, status_arr: [0, 1, 2, 3] },
      });
      const data = (resp["data"] ?? {}) as Record<string, unknown>;
      const list = Array.isArray(data["list"]) ? (data["list"] as unknown[]) : [];
      for (const raw of list) {
        const t = mapOfflineTask(raw);
        if (wanted.has(t.taskId)) {
          found.push(t);
          wanted.delete(t.taskId);
        }
      }
      const total = numOf(data["total"]);
      if (wanted.size === 0 || list.length === 0 || page * pageSize >= total) {
        break;
      }
    }
    return found;
  }

  /** Best-effort delete of finished/failed offline tasks (free quota). */
  async deleteOfflineTasks(taskIds: string[]): Promise<void> {
    if (taskIds.length === 0) {
      return;
    }
    const ids = taskIds.map((id) => {
      const n = Number(id);
      return Number.isSafeInteger(n) ? n : id;
    });
    await this.signed("/offline_download/task/delete", {
      method: "POST",
      body: { task_ids: ids },
    });
  }

  /** Query total and used storage capacity (`GET /b/api/user/info`). */
  async getSpace(): Promise<{ totalBytes: number; usedBytes: number } | null> {
    const resp = await this.signed("/user/info", { method: "GET" });
    const rawData = resp["data"];
    const data = typeof rawData === "object" && rawData !== null ? (rawData as Record<string, unknown>) : {};
    const totalBytes = parseFiniteMetric(data["SpacePermanent"]);
    const usedBytes = parseFiniteMetric(data["SpaceUsed"]);
    if (!Number.isFinite(totalBytes) || !Number.isFinite(usedBytes) || totalBytes <= 0) {
      return null;
    }
    return { totalBytes, usedBytes };
  }

  /** Fetch file metadata (`POST /b/api/file/info`) with bigint-safe numeric FileId.
   *  Returns null when the file does not exist or is in the recycle bin (`Trashed === 1`). */
  async getFileInfo(fileId: string): Promise<Pan123FileInfo | null> {
    let resp: Record<string, unknown>;
    try {
      resp = await this.signed("/file/info", {
        method: "POST",
        rawBody: rawJsonWithNumericIds(
          { fileIdList: [{ FileId: numericIdPlaceholder(fileId) }] },
          [fileId],
        ),
      });
    } catch (error) {
      if (isPan123AuthError(error)) {
        throw error;
      }
      if (isPan123NotFoundError(error)) {
        return null;
      }
      throw error;
    }
    const data = resp["data"];
    if (!isPlainRecord(data)) {
      throw new Error("PAN123_FILE_INFO_FAILED: unexpected data object");
    }
    const rawList = data["infoList"] ?? data["InfoList"];
    if (!Array.isArray(rawList)) {
      throw new Error("PAN123_FILE_INFO_FAILED: response missing infoList array");
    }
    if (rawList.length === 0) {
      return null;
    }
    const first = rawList[0];
    if (!isPlainRecord(first)) {
      throw new Error("PAN123_FILE_INFO_FAILED: malformed infoList entry");
    }
    const returnedId = strId(first["FileId"] ?? first["fileId"]);
    if (!returnedId || returnedId !== String(fileId)) {
      throw new Error(
        `PAN123_FILE_INFO_FAILED: response FileId mismatch (expected ${fileId}, got ${returnedId || "empty"})`,
      );
    }
    const trashed = numOf(first["Trashed"] ?? first["trashed"]);
    if (trashed === 1) {
      return null;
    }
    return {
      fileId: returnedId,
      fileName: strOf(first["FileName"] ?? first["fileName"]),
      size: numOf(first["Size"] ?? first["size"]),
      etag: strOf(first["Etag"] ?? first["etag"]),
      s3keyFlag: strOf(first["S3KeyFlag"] ?? first["s3keyFlag"]),
      type: numOf(first["Type"] ?? first["type"]),
    };
  }

  /**
   * Resolve a direct CDN download URL for a 123Pan file id.
   * Live-verified 2026-11-28: `file/info` → `file/download_info` → base64-unwrap `?params=`
   * → single manual-redirect GET yields a clean CDN URL playable via bare HTTP 302 (no cookies,
   * any player User-Agent).
   */
  async getDownloadUrl(input: { fileId: string }): Promise<DriveDownloadLink> {
    const info = await this.getFileInfo(input.fileId);
    if (!info) {
      throw new DriveFileNotFoundError("pan123", input.fileId);
    }
    let resp: Record<string, unknown>;
    try {
      resp = await this.signed("/file/download_info", {
        method: "POST",
        rawBody: rawJsonWithNumericIds(
          {
            driveId: 0,
            etag: info.etag,
            fileId: numericIdPlaceholder(info.fileId),
            fileName: info.fileName,
            s3keyFlag: info.s3keyFlag,
            size: info.size,
            type: info.type,
          },
          [info.fileId],
        ),
      });
    } catch (error) {
      if (isPan123AuthError(error)) {
        throw error;
      }
      if (isPan123NotFoundError(error)) {
        throw new DriveFileNotFoundError(
          "pan123",
          input.fileId,
          error instanceof Error ? error.message : String(error),
        );
      }
      throw error;
    }
    const data = (resp["data"] ?? {}) as Record<string, unknown>;
    const rawUrl = strOf(data["DownloadUrl"] ?? data["downloadUrl"]);
    if (!rawUrl) {
      throw new Error("PAN123_DOWNLOAD_FAILED: response missing DownloadUrl");
    }
    const unwrappedUrl = assertSafePan123HttpUrl(
      unwrapPan123DownloadParams(rawUrl),
      "PAN123_DOWNLOAD_FAILED",
    );
    const finalUrl = assertSafePan123HttpUrl(
      await this.resolveRedirect(unwrappedUrl, {
        Referer: "https://yun.123pan.com/",
        "User-Agent": "Mozilla/5.0",
      }),
      "PAN123_DOWNLOAD_FAILED",
    );
    return {
      url: finalUrl,
      headers: {},
      supportsRedirect: true,
      ...(info.fileName ? { fileName: info.fileName } : {}),
      ...(info.size > 0 ? { fileSize: info.size } : {}),
      ttlMs: 15 * 60 * 1000,
    };
  }
}

/** Offline-task row from /offline_download/task/list.
 *  status: 0=downloading, 1=failed, 2=succeed (OpenList mapping). */
export interface Pan123OfflineTask {
  taskId: string;
  name: string;
  status: number;
  progress: number;
  size: number;
}

// ── module helpers ──────────────────────────────────────────────────────────

/** InfoList 条目(file/list/new 与 share/get 共用)→ 统一 Pan123Item。
 *  id 已被 parsePan123Json 转 string(大整数);小 id 走 strId 的 number→string 兜底。 */
function mapPan123Item(raw: unknown): Pan123Item {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    id: strId(r["FileId"]),
    name: String(r["FileName"] ?? ""),
    size: numOf(r["Size"]),
    etag: String(r["Etag"] ?? ""),
    isFolder: numOf(r["Type"]) === 1,
  };
}

function mapOfflineTask(raw: unknown): Pan123OfflineTask {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    taskId: strId(r["task_id"]),
    name: String(r["name"] ?? ""),
    status: numOf(r["status"]),
    progress: numOf(r["progress"]),
    size: numOf(r["size"]),
  };
}

/** 分页停止哨兵:Next 为 null/undefined/""/"-1"/"0"(或对应数字)即到底。 */
function isStopCursor(v: unknown): boolean {
  if (v == null) {
    return true;
  }
  const s = String(v).trim();
  return s === "" || s === "-1" || s === "0";
}

/** id 已被 parsePan123Json 转成 string;这里兜底 number→string(小 id 不触发 replace)。 */
function strId(v: unknown): string {
  if (typeof v === "string") {
    return v;
  }
  if (typeof v === "number" && Number.isFinite(v)) {
    return String(v);
  }
  return "";
}

function numOf(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) {
    return v;
  }
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function strOf(v: unknown): string {
  return v == null ? "" : String(v);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertSafePan123HttpUrl(rawUrl: string, errorPrefix: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`${errorPrefix}: invalid download URL`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${errorPrefix}: disallowed download URL scheme ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${errorPrefix}: download URL must not contain embedded credentials`);
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host === "::1" ||
    host === "::" ||
    host.startsWith("fe80:") ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    /^0\./.test(host) ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)
  ) {
    throw new Error(`${errorPrefix}: disallowed private/internal download host ${host}`);
  }
  return parsed.toString();
}

function isPan123NotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  // Only classify explicit 123Pan API envelope errors — NEVER match DNS ENOTFOUND or transport failures.
  if (!error.message.startsWith("PAN123_FAILED(")) return false;
  return /文件不存在|已删除|\bcode=(?:5113|5050|404)\b/i.test(error.message);
}

/** 123Pan's DownloadUrl sometimes wraps the real dispatch URL inside a base64 `params` query arg.
 *  Reads the raw query substring so unescaped `+` in standard base64 is NOT turned into spaces. */
export function unwrapPan123DownloadParams(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    const rawSearch = u.search.startsWith("?") ? u.search.slice(1) : "";
    let rawParams: string | null = null;
    for (const part of rawSearch.split("&")) {
      const eq = part.indexOf("=");
      if (eq < 0) continue;
      if (part.slice(0, eq) === "params") {
        rawParams = decodeURIComponent(part.slice(eq + 1));
        break;
      }
    }
    if (rawParams) {
      const normalizedB64 = rawParams.replace(/ /g, "+");
      const decoded = Buffer.from(normalizedB64, "base64").toString("utf8").trim();
      if (/^https?:\/\//i.test(decoded)) {
        return decoded;
      }
    }
  } catch {
    // Fall through to rawUrl.
  }
  return rawUrl;
}

async function defaultPan123ResolveRedirect(
  url: string,
  headers: Record<string, string>,
  fetchImpl: Pan123Fetch = defaultPan123Fetch,
): Promise<string> {
  const safeUrl = assertSafePan123HttpUrl(url, "PAN123_DOWNLOAD_FAILED");
  const res = await fetchImpl(safeUrl, {
    method: "GET",
    headers: { ...headers, Range: "bytes=0-0" },
    redirect: "manual",
    timeoutMs: DEFAULT_TIMEOUT_MS,
  });
  if (res.status >= 300 && res.status < 400) {
    const location = res.location?.trim();
    if (!location) {
      throw new Error(`PAN123_DOWNLOAD_FAILED: redirect status ${res.status} missing Location header`);
    }
    return assertSafePan123HttpUrl(new URL(location, safeUrl).toString(), "PAN123_DOWNLOAD_FAILED");
  }
  const contentType = (res.contentType ?? "").toLowerCase();
  if (res.status >= 200 && res.status < 300) {
    if (contentType.includes("application/json") || res.text.trimStart().startsWith("{")) {
      const parsed = parsePan123Json(res.text) as Record<string, unknown> | null;
      const nested = isPlainRecord(parsed?.["data"]) ? parsed["data"] : {};
      const redirectUrl = strOf(nested["redirect_url"] ?? parsed?.["redirect_url"]).trim();
      if (redirectUrl) {
        return assertSafePan123HttpUrl(new URL(redirectUrl, safeUrl).toString(), "PAN123_DOWNLOAD_FAILED");
      }
      throw new Error("PAN123_DOWNLOAD_FAILED: dispatch JSON response missing redirect_url");
    }
    return safeUrl;
  }
  throw new Error(`PAN123_DOWNLOAD_FAILED: dispatch resolution returned HTTP ${res.status}`);
}

async function defaultPan123Fetch(
  url: string,
  init: {
    method: "GET" | "POST";
    headers: Record<string, string>;
    body?: string;
    timeoutMs?: number;
    redirect?: "follow" | "manual";
  },
): Promise<{
  status: number;
  text: string;
  location?: string | null;
  contentType?: string | null;
}> {
  // HARD project rule "新外部HTTP一律带超时": a bare fetch with no AbortController
  // hung the whole app in the PanSou incident.
  const requestInit: RequestInit = {
    method: init.method,
    headers: init.headers,
    signal: AbortSignal.timeout(init.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  };
  if (init.body !== undefined) {
    requestInit.body = init.body;
  }
  if (init.redirect !== undefined) {
    requestInit.redirect = init.redirect;
  }
  const res = await fetch(url, requestInit);
  const location = res.headers.get("location");
  const contentType = res.headers.get("content-type");
  if (init.redirect === "manual" && res.status >= 300 && res.status < 400) {
    await res.body?.cancel().catch(() => undefined);
    return { status: res.status, text: "", location, contentType };
  }
  if (
    init.redirect === "manual" &&
    contentType &&
    !contentType.toLowerCase().includes("json") &&
    !contentType.toLowerCase().includes("text")
  ) {
    await res.body?.cancel().catch(() => undefined);
    return { status: res.status, text: "", location, contentType };
  }
  return { status: res.status, text: await res.text(), location, contentType };
}
