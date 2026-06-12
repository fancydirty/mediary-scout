import type {
  Pan115ActionResult,
  Pan115DirectoryInfo,
  Pan115Item,
  Pan115StorageApi,
} from "./storage-115-executor.js";

const PAN115_WEBAPI_BASE_URL = "https://webapi.115.com";
const PAN115_CDN_WEBAPI_BASE_URL = "https://115cdn.com/webapi";
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
    return {
      ok: false,
      message:
        "PAN115_OFFLINE_TASK_UNIMPLEMENTED: cookie client requires encrypted 115 offline-task payload support",
    };
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
  return stringValue(
    recordValue(response, "msg") ??
      recordValue(response, "message") ??
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
