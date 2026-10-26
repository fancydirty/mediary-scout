import { parseGuangYaShareUrl } from "./guangya-client.js";
import { parseQuarkShareUrl, parseUcShareUrl } from "./quark-storage-executor.js";
import { parsePan123ShareUrl } from "./pan123-storage-executor.js";
import { parseTianyiShareUrl } from "./tianyi-storage-executor.js";
import { createHash } from "node:crypto";
import type {
  ResourceCandidate,
  ResourceSnapshot,
  ResourceType,
} from "./domain.js";
import type { ResourceProvider } from "./ports.js";
import {
  classifySourceFailure,
  mergeSourceHealth,
  PanSouProtocolError,
  PanSouRequestError,
  type SourceHealth,
} from "./resource-source-health.js";

export interface PanSouFetchInit {
  method: "POST";
  headers: Record<string, string>;
  body: string;
  /** Per-request abort deadline — a stalled PanSou upstream must degrade to
   *  "fewer candidates this poll", never hang the run (2026-07-06 incident:
   *  4.5 min pre-agent stall; same failure class as the TMDB hang #68).
   *  Optional so existing PanSouFetchJson call sites stay source-compatible;
   *  defaultFetchJson falls back to DEFAULT_REQUEST_TIMEOUT_MS. */
  timeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

/** PanSou searches in progress per server, across every provider in this process.
 *  One PanSou fans each search out to dozens of channels and starts answering 502
 *  at about four simultaneous searches (measured 2026-09-25); parallel patrol runs
 *  share it, so their searches queue here instead of failing as "source down". */
const MAX_IN_FLIGHT_PER_SERVER = 2;
const serverSlots = new Map<string, { inFlight: number; waiters: Array<() => void> }>();

async function withServerSlot<T>(baseURL: string, call: () => Promise<T>): Promise<T> {
  let slot = serverSlots.get(baseURL);
  if (!slot) {
    slot = { inFlight: 0, waiters: [] };
    serverSlots.set(baseURL, slot);
  }
  if (slot.inFlight >= MAX_IN_FLIGHT_PER_SERVER) {
    await new Promise<void>((resolve) => slot!.waiters.push(resolve));
  } else {
    slot.inFlight += 1;
  }
  try {
    return await call();
  } finally {
    // Hand the slot straight to the next waiter (inFlight unchanged), or free it.
    const next = slot.waiters.shift();
    if (next) next();
    else if ((slot.inFlight -= 1) === 0) serverSlots.delete(baseURL);
  }
}

export type PanSouFetchJson = (url: string, init: PanSouFetchInit) => Promise<unknown>;

export interface PanSouResourceProviderOptions {
  baseURL: string;
  fetchJson?: PanSouFetchJson;
  now?: () => string;
  /** How many times to re-query before treating the result set as complete. */
  maxSearchAttempts?: number;
  /** Delay between completeness polls (ms). */
  searchPollMs?: number;
  /** Injectable sleep (tests pass a no-op). */
  wait?: (ms: number) => Promise<void>;
  /** Abort a single search request after this many ms (default 20s). */
  requestTimeoutMs?: number;
  /** Restrict returned candidates to these link types (per-brand: a quark drive
   *  gets ["quark"], a 115 drive ["115","magnet"]). Undefined = no filter. */
  allowedTypes?: ResourceType[];
}

interface PanSouLinkFact {
  title: string;
  source: string;
  type: ResourceType;
  rawType: string;
  url: string;
  password: string;
  datetime: string;
}

export class PanSouResourceProvider implements ResourceProvider {
  private readonly baseURL: string;
  private readonly fetchJson: PanSouFetchJson;
  private readonly now: () => string;
  private readonly maxSearchAttempts: number;
  private readonly searchPollMs: number;
  private readonly wait: (ms: number) => Promise<void>;
  private readonly allowedTypes: Set<ResourceType> | null;
  private readonly requestTimeoutMs: number;

  constructor(options: PanSouResourceProviderOptions) {
    this.baseURL = options.baseURL.replace(/\/+$/, "");
    this.fetchJson = options.fetchJson ?? defaultFetchJson;
    this.now = options.now ?? (() => new Date().toISOString());
    this.maxSearchAttempts = options.maxSearchAttempts ?? 4;
    this.searchPollMs = options.searchPollMs ?? 2500;
    this.wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.allowedTypes = options.allowedTypes ? new Set(options.allowedTypes) : null;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  private async fetchFacts(keyword: string): Promise<PanSouLinkFact[]> {
    const response = await this.fetchJson(`${this.baseURL}/api/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "clawd-media-track/1.0",
      },
      body: JSON.stringify({ kw: keyword, res: "all" }),
      timeoutMs: this.requestTimeoutMs,
    });
    // 两种「不是成功响应」必须区分,否则用户拿到错误的处置建议(Copilot 评审):
    //  1. 响应带 code 字段 → 它**是** PanSou,只是报了错(限流/参数错)。
    //     那是源侧的临时故障,不是「地址填错了」,不归 PanSouProtocolError。
    //  2. 完全不是 PanSou 的形状(静态文件服务器 / 反代错误页 / 换了协议)
    //     → 地址指错了地方,这才是 PanSouProtocolError。
    if (isPanSouErrorResponse(response)) {
      throw new PanSouRequestError(`PanSou 返回错误: ${JSON.stringify(response).slice(0, 200)}`);
    }
    if (!isPanSouSuccessResponse(response)) {
      throw new PanSouProtocolError(`not a PanSou payload from ${this.baseURL}`);
    }
    const facts = collectLinkFacts(response.data.results ?? []);
    // Per-brand filter: a quark drive only sees quark links; a 115 drive only
    // sees 115/magnet. Keeps a candidate set that its executor can actually transfer.
    return this.allowedTypes ? facts.filter((fact) => this.allowedTypes!.has(fact.type)) : facts;
  }

  async search(input: { keyword: string; workflowRunId?: string }): Promise<ResourceSnapshot> {
    // The slot covers the whole poll loop, not each request: between polls PanSou
    // is still fanning the search out to its channels, which is the load that 502s.
    return withServerSlot(this.baseURL, () => this.pollSearch(input));
  }

  private async pollSearch(input: { keyword: string; workflowRunId?: string }): Promise<ResourceSnapshot> {
    // PanSou is async/streaming: the first call returns quick cached results and
    // async-plugin results land on LATER calls (5 → 35 115-links, 0 → 419
    // magnets). Poll until the link count stops growing so the agent always
    // judges the COMPLETE evidence — never a partial slice (no 抢跑). Speed comes
    // from the agent issuing FEWER searches, not from cutting this short.
    let facts: PanSouLinkFact[] = [];
    let failure: unknown = null;
    for (let attempt = 0; attempt < this.maxSearchAttempts; attempt += 1) {
      let next: PanSouLinkFact[];
      try {
        next = await this.fetchFacts(input.keyword);
      } catch (error) {
        // 只有「一条证据都没拿到」才算源不可用。中途失败但先前已有结果时,
        // 保留旧行为(保住已拿到的最完整集合)——那不是源挂了,是轮询被打断。
        failure = error;
        break;
      }
      if (next.length > facts.length) {
        facts = next;
      } else if (attempt > 0) {
        break; // stabilized: no new links since the previous poll
      }
      if (attempt < this.maxSearchAttempts - 1) {
        await this.wait(this.searchPollMs);
      }
    }
    const health: SourceHealth =
      failure !== null && facts.length === 0
        ? { status: classifySourceFailure(failure), source: "pansou" }
        : { status: "healthy", source: "pansou" };
    const snapshotId = createSnapshotId(input.keyword, facts, input.workflowRunId);
    const candidates: ResourceCandidate[] = facts.map((fact, index) => ({
      id: `${snapshotId}_candidate_${index + 1}`,
      snapshotId,
      index,
      title: fact.title,
      type: fact.type,
      source: fact.source,
      providerPayload: {
        url: fact.url,
        password: fact.password,
        datetime: fact.datetime,
        rawType: fact.rawType,
      },
    }));

    return {
      id: snapshotId,
      provider: "pansou",
      keyword: input.keyword,
      candidates,
      createdAt: this.now(),
      sourceHealth: mergeSourceHealth([health]),
    };
  }
}

export function createPanSouResourceProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): PanSouResourceProvider {
  const baseURL = env.PANSOU_BASE_URL;
  if (!baseURL) {
    throw new Error("PANSOU_BASE_URL is required to create PanSouResourceProvider");
  }
  return new PanSouResourceProvider({ baseURL });
}

async function defaultFetchJson(url: string, init: PanSouFetchInit): Promise<unknown> {
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: AbortSignal.timeout(init.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`PanSou search failed with HTTP ${response.status}`);
  }
  return response.json();
}

/** 响应带 code 字段 = 它按 PanSou 协议应答了,只是没成功(限流/参数错/服务端错)。
 *  与「根本不是 PanSou」的关键区别:后者没有 code 字段。 */
function isPanSouErrorResponse(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return typeof value["code"] === "number" && value["code"] !== 0;
}

/** PanSou `SearchResponse` data (fish2018/pansou model/response.go). `Results` is
 *  tagged `json:"results,omitempty"`, so a search with ZERO hits serialises as
 *  `{"code":0,"message":"success","data":{"total":0}}` — no `results` key at all
 *  (verified live 2026-09-19 on the self-hosted container and so.252035.xyz).
 *
 *  Rule, in order:
 *   1. a PRESENT `results` must be an array — a numeric `total` never excuses a
 *      malformed one (an object would blow up `for...of` and be misread as
 *      「源挂了」; a string would iterate silently and look like a healthy miss);
 *      `null` counts as absent (encoding/json writes null for a nil slice on a
 *      build without omitempty);
 *   2. with `results` absent, a numeric `total` is the zero-hit signature;
 *   3. anything else is not PanSou.
 *
 *  Exported so the settings-page save probe applies the SAME rule: the two
 *  drifting apart is exactly how a probe could persist an address the provider
 *  then cannot consume (Copilot, #259). */
export function isPanSouSearchData(
  data: unknown,
): data is { results?: unknown[] | null; total?: number } {
  if (!isRecord(data)) return false;
  const results = data["results"];
  if (results !== undefined && results !== null) {
    return Array.isArray(results);
  }
  return typeof data["total"] === "number";
}

function isPanSouSuccessResponse(value: unknown): value is {
  code: 0;
  data: {
    results?: unknown[] | null;
    total?: number;
  };
} {
  if (!isRecord(value) || value["code"] !== 0) {
    return false;
  }
  // Treating the zero-hit shape as "not a PanSou payload" turned every honest
  // miss into a false 「搜索源连不上」 alert (2026-09-07 → 09-19, daily patrol).
  return isPanSouSearchData(value["data"]);
}

function collectLinkFacts(results: unknown[]): PanSouLinkFact[] {
  const facts: PanSouLinkFact[] = [];
  const seenUrls = new Set<string>();

  for (const result of results) {
    if (!isRecord(result)) {
      continue;
    }
    const title = stringValue(result["title"]);
    const source = stringValue(result["channel"]);
    const links = Array.isArray(result["links"]) ? result["links"] : [];
    for (const link of links) {
      if (!isRecord(link)) {
        continue;
      }
      const rawType = stringValue(link["type"]);
      const url = stringValue(link["url"]);
      const type = normalizeResourceType(rawType, url);
      if (!type || !url || seenUrls.has(url)) {
        continue;
      }
      seenUrls.add(url);
      facts.push({
        title,
        source,
        type,
        rawType,
        url,
        password: stringValue(link["password"]),
        datetime: stringValue(link["datetime"]),
      });
    }
  }

  return facts;
}

/** Classify one upstream link by its URL SHAPE.
 *
 *  The declared `rawType` is deliberately ignored. Every branch here validates the
 *  URL through the same parser its executor transfers with, so `rawType` would add
 *  no information — but it used to be able to SUBTRACT: a link tagged `"115"` whose
 *  url was a quark share hit the 115 branch, failed the shape check, and returned
 *  null before the quark parser ever ran. Checking shapes in order is both simpler
 *  and strictly more forgiving of a mislabelled upstream. (Verified against 7,843
 *  real production candidates: the two agree on every share link we serve.)
 *
 *  `_rawType` is kept in the signature so both providers call it the same way. */
export function normalizeResourceType(_rawType: string, url: string): ResourceType | null {
  // Magnets first, regardless of any declared brand: a magnet is transferable by
  // whichever drive has 秒传, and every executor routes on candidate.type ===
  // "magnet". Checking brands first would drop every 115-sourced torrent.
  if (url.startsWith("magnet:")) {
    return "magnet";
  }
  // 115 shares live on 115.com/s/<code> or 115cdn.com/s/<code> — the exact
  // prefixes storage-115-executor will transfer.
  if (/^https?:\/\/(?:www\.)?115(?:cdn)?\.com\/s\/[A-Za-z0-9]+/.test(url)) {
    return "115";
  }
  // Each of these is the SAME parser the executor transfers with, so a lookalike
  // host (evilpan.quark.cn, evil.example.com/pan.quark.cn/s/x) can never become a
  // candidate that then fails as unparseable at transfer time.
  if (parseQuarkShareUrl(url) !== null) {
    return "quark";
  }
  if (parseUcShareUrl(url) !== null) {
    return "uc";
  }
  // 123 share shapes: multi-mirror domains 123pan/123684/123865/123912 · com/cn,
  // path /s/<key>.
  if (parsePan123ShareUrl(url) !== null) {
    return "123";
  }
  // 天翼: cloud.189.cn/t/<code> and cloud.189.cn/web/share?…code=<code>.
  if (parseTianyiShareUrl(url) !== null) {
    return "tianyi";
  }
  if (parseGuangYaShareUrl(url) !== null) {
    return "guangya";
  }
  return null;
}

function createSnapshotId(keyword: string, facts: PanSouLinkFact[], workflowRunId?: string): string {
  // The keyword is part of the top-level material (not only embedded per-fact),
  // so an EMPTY result set still yields a keyword-specific id. Otherwise every
  // empty search hashes the same `[]` → one shared id that collides across
  // keywords AND across runs (resource_snapshots.id is a global primary key).
  const material = JSON.stringify({
    workflowRunId: workflowRunId ?? null,
    keyword,
    facts: facts.map((fact) => ({
      title: fact.title,
      type: fact.type,
      rawType: fact.rawType,
      url: fact.url,
      password: fact.password,
      datetime: fact.datetime,
      source: fact.source,
    })),
  });
  const hash = createHash("sha1").update(material).digest("hex").slice(0, 12);
  // Run-scope the id so a re-acquisition with identical results gets its OWN
  // snapshot row instead of colliding with the first run's on the global PK.
  return workflowRunId ? `pansou_${workflowRunId}_${hash}` : `pansou_${hash}`;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
