import { lixianRsaEncrypt } from "./pan115-lixian-cipher.js";
import type {
  Pan115ActionResult,
  Pan115DirectoryInfo,
  Pan115Item,
  Pan115StorageApi,
} from "./storage-115-executor.js";

export interface Pan115OfflineTask {
  infoHash: string;
  name: string;
  /** 0–100; 0 with status "waiting"/"downloading" is a non-秒传 in-flight task. */
  percentDone: number;
  /** 115 status code (1=waiting, 2=downloading, 5/-1=failed, ...). */
  status: number;
  statusText: string;
  url: string;
}

const PAN115_WEBAPI_BASE_URL = "https://webapi.115.com";
const PAN115_CDN_WEBAPI_BASE_URL = "https://115cdn.com/webapi";
const PAN115_LIXIAN_SSP_URL = "https://lixian.115.com/lixianssp/";
const PAN115_LIXIAN_WEB_URL = "https://lixian.115.com/lixian/";
// 115 requires its android client UA for the lixianssp offline endpoint.
const PAN115_ANDROID_USER_AGENT =
  "Mozilla/5.0 115disk/99.99.99.99 115Browser/99.99.99.99 115wangpan_android/99.99.99.99";
const DEFAULT_LIST_LIMIT = 200;
const DEFAULT_USER_AGENT = "media-track/0.1";

export interface Pan115HttpInit {
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
}

export type Pan115FetchJson = (url: string, init: Pan115HttpInit) => Promise<unknown>;

export interface Pan115CookieClientOptions {
  cookie: string;
  fetchJson?: Pan115FetchJson;
  listLimit?: number;
  userAgent?: string;
}

export class Pan115CookieClient implements Pan115StorageApi {
  private readonly cookie: string;
  private readonly fetchJson: Pan115FetchJson;
  private readonly listLimit: number;
  private readonly userAgent: string;

  constructor(options: Pan115CookieClientOptions) {
    const cookie = normalizeCookie(options.cookie);
    if (!cookie) {
      throw new Error("PAN115_COOKIE is required to create Pan115CookieClient");
    }
    this.cookie = cookie;
    this.fetchJson = options.fetchJson ?? defaultFetchJson;
    this.listLimit = options.listLimit ?? DEFAULT_LIST_LIMIT;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  }

  async createFolder(input: { name: string; parentId: string }): Promise<string> {
    const response = await this.postForm(`${PAN115_WEBAPI_BASE_URL}/files/add`, [
      ["pid", input.parentId],
      ["cname", input.name],
    ]);
    if (!responseState(response)) {
      throw new Error(`PAN115_CREATE_FOLDER_FAILED: ${responseMessage(response)}`);
    }
    const directoryId = stringValue(
      recordValue(response, "cid") ??
        recordValue(recordValue(response, "data"), "cid") ??
        recordValue(response, "file_id"),
    );
    if (!directoryId) {
      throw new Error("PAN115_CREATE_FOLDER_FAILED: response missing cid");
    }
    return directoryId;
  }

  async listItems(input: { directoryId: string }): Promise<Pan115Item[]> {
    const response = await this.getJson(`${PAN115_WEBAPI_BASE_URL}/files`, [
      ["aid", "1"],
      ["cid", input.directoryId],
      ["o", "user_ptime"],
      ["asc", "1"],
      ["offset", "0"],
      ["show_dir", "1"],
      ["limit", String(this.listLimit)],
      ["snap", "0"],
      ["natsort", "0"],
      ["record_open_time", "1"],
      ["format", "json"],
      ["fc_mix", "0"],
    ]);
    if (!responseState(response)) {
      throw new Error(`PAN115_LIST_ITEMS_FAILED: ${responseMessage(response)}`);
    }
    const items = arrayValue(recordValue(response, "data")).filter(isRecord) as Pan115Item[];
    const totalCount = numberValue(recordValue(response, "count"));
    if (totalCount > this.listLimit) {
      throw new Error(
        `PAN115_LIST_TOO_LARGE: cid=${input.directoryId}; count=${totalCount}; limit=${this.listLimit}`,
      );
    }
    return items;
  }

  async getDirectoryInfo(input: { directoryId: string }): Promise<Pan115DirectoryInfo | null> {
    const response = await this.getJson(`${PAN115_WEBAPI_BASE_URL}/category/get`, [
      ["cid", input.directoryId],
    ]);
    if (!responseState(response)) {
      return {
        state: false,
        path: [],
      };
    }
    return {
      state: true,
      path: directoryPathFromResponse(response, input.directoryId),
    };
  }

  async receiveShare(input: {
    shareCode: string;
    receiveCode: string;
    directoryId: string;
  }): Promise<Pan115ActionResult> {
    const response = await this.postForm(
      `${PAN115_CDN_WEBAPI_BASE_URL}/share/receive`,
      [
        ["share_code", input.shareCode],
        ["receive_code", input.receiveCode],
        ["cid", input.directoryId],
      ],
      {
        Referer: buildShareReferer(input.shareCode, input.receiveCode),
        Origin: "https://115.com",
      },
    );
    return actionResultFromResponse(response);
  }

  async addOfflineTask(input: { url: string; directoryId: string }): Promise<Pan115ActionResult> {
    // 115's selling point: magnet (and http/ed2k) links land via cloud download
    // just like a 115 share receive — immediate for healthy resources. The
    // lixianssp endpoint takes an RSA-encrypted JSON body; auth is the cookie.
    const payload = JSON.stringify({
      url: input.url,
      wp_path_id: input.directoryId,
      ac: "add_task_url",
      app_ver: "99.99.99.99",
    });
    const encrypted = lixianRsaEncrypt(new TextEncoder().encode(payload));
    const response = await this.postForm(
      PAN115_LIXIAN_SSP_URL,
      [["data", encrypted]],
      { "User-Agent": PAN115_ANDROID_USER_AGENT },
    );
    // errcode 10008 ("任务已存在") is 115 REFUSING a duplicate: this infohash was
    // already submitted on a prior transfer. It is NOT a junk/dead resource — it
    // may well be in our cloud already from that earlier task. Flag it as
    // alreadyTransferred so the caller does NOT cancel it (canceling would kill
    // the prior good task) and instead just moves to the next candidate.
    if (isOfflineTaskAlreadyExists(response)) {
      return {
        ok: true,
        alreadyTransferred: true,
        message: responseMessage(response) || "任务已存在",
      };
    }
    return actionResultFromResponse(response);
  }

  async removeOfflineTask(input: { infoHashes: string[] }): Promise<Pan115ActionResult> {
    // Cancel queued cloud-download tasks (`ac=task_del`) by info_hash. Same
    // RSA-encrypted lixianssp channel as addOfflineTask. Used to drop a magnet
    // that did NOT 秒传: 115 had no cached copy and queued a real download we
    // don't want — removing it frees the offline quota and avoids junk tasks.
    const payload: Record<string, string> = { ac: "task_del", app_ver: "99.99.99.99" };
    input.infoHashes.forEach((hash, index) => {
      payload[`hash[${index}]`] = hash;
    });
    const encrypted = lixianRsaEncrypt(new TextEncoder().encode(JSON.stringify(payload)));
    const response = await this.postForm(
      PAN115_LIXIAN_SSP_URL,
      [["data", encrypted]],
      { "User-Agent": PAN115_ANDROID_USER_AGENT },
    );
    return actionResultFromResponse(response);
  }

  /** List the account's cloud-download (offline) tasks. Plain cookie-authed web
   *  GET — no sign, plaintext JSON. Used to find junk/stuck tasks to cancel. */
  async listOfflineTasks(input?: { page?: number }): Promise<Pan115OfflineTask[]> {
    const response = await this.getJson(PAN115_LIXIAN_WEB_URL, [
      ["ac", "task_lists"],
      ["page", String(input?.page ?? 1)],
    ]);
    return arrayValue(recordValue(response, "tasks"))
      .filter(isRecord)
      .map((task) => ({
        infoHash: stringValue(recordValue(task, "info_hash")),
        name: stringValue(recordValue(task, "name")),
        percentDone: numberValue(recordValue(task, "percentDone")),
        status: numberValue(recordValue(task, "status")),
        statusText: stringValue(recordValue(task, "status_text")),
        url: stringValue(recordValue(task, "url")),
      }));
  }

  async moveItems(input: { fileIds: string[]; targetDirectoryId: string }): Promise<Pan115ActionResult> {
    const fields: Array<[string, string]> = [["pid", input.targetDirectoryId]];
    input.fileIds.forEach((fileId, index) => fields.push([`fid[${index}]`, fileId]));
    const response = await this.postForm(`${PAN115_WEBAPI_BASE_URL}/files/move`, fields);
    return actionResultFromResponse(response);
  }

  async deleteItems(input: { fileIds: string[] }): Promise<Pan115ActionResult> {
    const fields = input.fileIds.map((fileId, index) => [`fid[${index}]`, fileId] as [string, string]);
    const response = await this.postForm(`${PAN115_WEBAPI_BASE_URL}/rb/delete`, fields);
    return actionResultFromResponse(response);
  }

  async renameFile(input: { fileId: string; newName: string }): Promise<Pan115ActionResult> {
    const response = await this.postForm(`${PAN115_WEBAPI_BASE_URL}/files/batch_rename`, [
      [`files_new_name[${input.fileId}]`, input.newName],
    ]);
    return actionResultFromResponse(response);
  }

  private async getJson(url: string, params: Array<[string, string]>): Promise<unknown> {
    const query = new URLSearchParams(params);
    return this.fetchJson(`${url}?${query.toString()}`, {
      method: "GET",
      headers: this.headers(),
    });
  }

  private async postForm(
    url: string,
    fields: Array<[string, string]>,
    headers: Record<string, string> = {},
  ): Promise<unknown> {
    const body = new URLSearchParams(fields).toString();
    return this.fetchJson(url, {
      method: "POST",
      headers: {
        ...this.headers(),
        ...headers,
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      },
      body,
    });
  }

  private headers(): Record<string, string> {
    return {
      Cookie: this.cookie,
      "User-Agent": this.userAgent,
      Accept: "application/json, text/plain, */*",
    };
  }
}

export function createPan115CookieClientFromEnv(
  env: Record<string, string | undefined> = process.env,
): Pan115CookieClient {
  const cookie = normalizeCookie(env["PAN115_COOKIE"]);
  if (!cookie) {
    throw new Error("PAN115_COOKIE is required to create Pan115CookieClient");
  }
  return new Pan115CookieClient({ cookie });
}

async function defaultFetchJson(url: string, init: Pan115HttpInit): Promise<unknown> {
  const requestInit: RequestInit = {
    method: init.method,
    headers: init.headers,
  };
  if (init.body !== undefined) {
    requestInit.body = init.body;
  }
  const response = await fetch(url, requestInit);
  if (!response.ok) {
    throw new Error(`PAN115_HTTP_FAILED: ${response.status}`);
  }
  return response.json();
}

function actionResultFromResponse(response: unknown): Pan115ActionResult {
  return {
    ok: responseState(response),
    message: responseMessage(response),
  };
}

/** lixianssp returns errcode 10008 / error_msg "任务已存在" when the infohash is
 *  already queued. 115 recognized the resource, so we count it as accepted. */
function isOfflineTaskAlreadyExists(response: unknown): boolean {
  if (!isRecord(response)) {
    return false;
  }
  const errcode = response["errcode"] ?? response["errno"] ?? response["code"];
  if (errcode === 10008 || errcode === "10008") {
    return true;
  }
  return responseMessage(response).includes("已存在");
}

function responseState(response: unknown): boolean {
  if (!isRecord(response)) {
    return false;
  }
  const state = response["state"];
  if (typeof state === "boolean") {
    return state;
  }
  if (typeof state === "number") {
    return state === 1;
  }
  if (typeof state === "string") {
    return state === "1" || state.toLowerCase() === "true";
  }
  return false;
}

function responseMessage(response: unknown): string {
  // Prefer the human-readable fields. lixianssp failures carry the real reason
  // in `error_msg` ("任务已存在") while `errtype` is only a coarse class ("war").
  return stringValue(
    recordValue(response, "msg") ??
      recordValue(response, "message") ??
      recordValue(response, "error_msg") ??
      recordValue(response, "error") ??
      recordValue(response, "errtype"),
  );
}

function directoryPathFromResponse(
  response: unknown,
  requestedDirectoryId: string,
): Pan115DirectoryInfo["path"] {
  const pathItems = arrayValue(
    recordValue(response, "paths") ?? recordValue(recordValue(response, "data"), "paths"),
  ).filter(isRecord);
  const path = pathItems
    .map((item) => ({
      cid: stringValue(recordValue(item, "cid") ?? recordValue(item, "file_id")),
      name: stringValue(recordValue(item, "name") ?? recordValue(item, "file_name")),
    }))
    .filter((item) => item.cid || item.name);

  // category/get returns `paths` as ancestors only and does not always echo
  // the queried directory's own id back, so fall back to the requested cid.
  // Safety checks (e.g. the flatten season-leaf rule) rely on the leaf being
  // present as the last path element.
  const current = {
    cid:
      stringValue(recordValue(response, "cid") ?? recordValue(response, "file_id")) ||
      requestedDirectoryId,
    name: stringValue(recordValue(response, "name") ?? recordValue(response, "file_name")),
  };
  if (current.cid && !path.some((item) => item.cid === current.cid)) {
    path.push(current);
  }
  return path;
}

function buildShareReferer(shareCode: string, receiveCode: string): string {
  return `https://115cdn.com/s/${shareCode}?password=${receiveCode}&`;
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
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
