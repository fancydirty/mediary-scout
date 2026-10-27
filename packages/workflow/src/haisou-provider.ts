import { createHash } from "node:crypto";
import type { ResourceCandidate, ResourceSnapshot, ResourceType } from "./domain.js";
import type { ResourceProvider } from "./ports.js";
import { normalizeResourceType } from "./pansou-provider.js";
import {
  classifySourceFailure,
  mergeSourceHealth,
  type SourceHealth,
} from "./resource-source-health.js";

/**
 * 海搜 (haisou.cc) 资源源，走它挂在 idatariver 上的**官方付费 API**
 * (`POST https://apiok.us/api/b9d1/search?apikey=…`)。
 *
 * 为什么是这条通道而不是 haisou.cc 自己的 /api/v2/shares/search:
 * - haisou.cc 的站点页脚就把「开放接口」指向这个 idatariver 项目 —— 这是站方
 *   给出的程序化入口，不是绕过它的界面。
 * - 匿名 /api/v2 有每日配额（实测耗尽后连续 15 次全是 429），要靠用户登录态
 *   的 hs_web_session 才解除；那意味着用户得把账号 cookie 交给我们，而站方
 *   页面上写着不要用脚本调用。官方 API 只要一个 apikey，没有这个问题。
 * - 官方接口直接返回 shareUrl（站点接口只给 share_code，要自己按平台拼模板）。
 *
 * 额度：同一 apikey 的日调用量在 100 次以下免费，100–10000 次每次
 * $0.0001（响应里的 credits 字段实测恒为 0，计费不体现在这里）。
 *
 * 用量口径：一个实例每天一次巡检、真正有缺集要搜的作品通常不到十部，
 * 每部按 allowedTypes 发一次请求 —— 离 100 次还有很大余量。它是和 PanSou
 * 并行的补充源（Composite 各成员并行、并集去重），不是替代品：两家索引
 * 覆盖面不同，缺一边就少一批候选。
 */

const ENDPOINT = "https://apiok.us/api/b9d1/search";

export interface HaisouFetchJson {
  (url: string, init: { method: "POST"; headers: Record<string, string>; body: string; timeoutMs?: number }): Promise<unknown>;
}

export interface HaisouResourceProviderOptions {
  apiKey: string;
  /** 只保留这些类型的候选（与 PanSou/Prowlarr 的 allowedTypes 同义）。 */
  allowedTypes?: readonly ResourceType[];
  fetchJson?: HaisouFetchJson;
  endpoint?: string;
  now?: () => string;
}

/** haisou/idata 的 platform 值直接喂给 PanSou 那个分类器（URL 形状也会校验），
 *  两处共用一套判定 —— 复制一份映射表就会出现「PanSou 剔掉的仿冒域名，海搜
 *  这条路放进来」这种漂移。不在分类器覆盖范围内的盘（移动/联通/蓝奏/微云/
 *  城通）返回 null，直接丢弃：留成 unknown 只会让 agent 拿到一批永远转不了
 *  的候选。 */
const ALL_PLATFORMS = ["quark", "uc", "115", "tianyi", "123", "guangya"] as const;

const DEFAULT_TIMEOUT_MS = 15_000;

/** idatariver 的「余额/额度不足」。一旦见到它，当天再问也没用 —— 每个关键词都
 *  白打一次只会浪费时间并把日志刷满。命中后熔断到 UTC 日切（上游的 rpd 按日
 *  重置），期间直接返回 unreachable 而不发请求。 */
const CREDITS_EXHAUSTED_CODE = 1005;

export class HaisouResourceProvider implements ResourceProvider {
  private readonly apiKey: string;
  private readonly allowedTypes: readonly ResourceType[] | undefined;
  private readonly fetchJson: HaisouFetchJson;
  private readonly endpoint: string;
  private readonly now: () => string;
  /** UTC date (YYYY-MM-DD) on which we saw CREDITS_EXHAUSTED_CODE. Same-day
   *  searches short-circuit instead of hammering a source we know will refuse. */
  private exhaustedOn: string | null = null;

  constructor(options: HaisouResourceProviderOptions) {
    this.apiKey = options.apiKey;
    this.allowedTypes = options.allowedTypes;
    this.fetchJson = options.fetchJson ?? defaultFetchJson;
    this.endpoint = options.endpoint ?? ENDPOINT;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /** idatariver 只认 query string 里的 `apikey`（body/header 都返回 code:1001），
   *  拼在 URL 上而不是放 header。 */
  private url(): string {
    const u = new URL(this.endpoint);
    u.searchParams.set("apikey", this.apiKey);
    return u.toString();
  }

  async search(input: { keyword: string; workflowRunId?: string }): Promise<ResourceSnapshot> {
    const keyword = input.keyword.trim();
    const snapshotId = scopedId("haisou", keyword, input.workflowRunId);

    if (!this.apiKey) {
      // 没配 key 和「源挂了」是两回事：这是配置缺失，别让 agent 去重搜。
      return emptySnapshot(snapshotId, keyword, this.now(), {
        status: "unreachable",
        source: "haisou",
      });
    }
    if (!keyword) {
      return emptySnapshot(snapshotId, keyword, this.now());
    }
    // Circuit breaker: the upstream answers code 1005 for the rest of the UTC day
    // once the free 100 requests are spent (or credits run out). Asking again costs
    // a round-trip and returns nothing, so stop after the first refusal.
    if (this.exhaustedOn === utcDay(this.now())) {
      return emptySnapshot(snapshotId, keyword, this.now(), {
        status: "unreachable",
        source: "haisou",
      });
    }

    // Map what this drive can actually transfer onto haisou's platform ids.
    // `magnet` is a link kind, not a 光鸭 platform, so it contributes nothing here.
    const platformFilter = (() => {
      if (!this.allowedTypes) return {};
      const wanted = this.allowedTypes.filter((t) =>
        (ALL_PLATFORMS as readonly string[]).includes(t),
      );
      return wanted.length > 0 ? { platforms: wanted } : {};
    })();

    let raw: unknown;
    try {
      raw = await this.fetchJson(this.url(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: keyword,
          // 必须显式传 `platforms`，否则上游按热度把结果挤成几乎全是夸克：
          // 实测 24 个关键词不传时 quark 95.0% / tianyi 1.5% / **115 1.4%**，
          // 而同一批关键词按平台分别查，115 有 101 条、UC 474 条、光鸭 201 条。
          // 也就是说「海搜没有 115」是假象，是默认排序饿死了小平台。
          //
          // 成本不变：每块盘的 allowedTypes 本来就只有 1–2 个平台，所以还是
          // 一次请求。只有在没有 allowedTypes（不限品牌）时才退化成不传。
          ...platformFilter,
          page: 1,
          pageSize: 100,
        }),
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
    } catch (error) {
      return emptySnapshot(snapshotId, keyword, this.now(), {
        status: classifySourceFailure(error),
        source: "haisou",
      });
    }

    const envelope = asRecord(raw);
    // Check `code === 0` directly, NOT through numberValue: that helper defaults a
    // missing/non-numeric code to 0, which would make a malformed upstream body
    // look like a healthy empty result. That matters more than usual here — the
    // save-time probe in saveHaisouConfigAction accepts a snapshot whose health is
    // healthy, so a silently-passing malformed response would persist a bad key.
    if (envelope["code"] !== 0) {
      // idatariver 用 code 表达失败（1001 key 缺失 / 1005 余额不足 …）。
      // 这些不是「今天没有这个资源」，必须如实上报成源不可用。
      if (envelope["code"] === CREDITS_EXHAUSTED_CODE) {
        this.exhaustedOn = utcDay(this.now());
      }
      return emptySnapshot(snapshotId, keyword, this.now(), {
        status: "unreachable",
        source: "haisou",
      });
    }

    const items = asArray(asRecord(envelope["result"])["items"]);
    const candidates: ResourceCandidate[] = [];
    let index = 0;
    for (const item of items) {
      const row = asRecord(item);
      const platform = stringValue(row["platform"]).toLowerCase();
      if (!ALL_PLATFORMS.includes(platform as (typeof ALL_PLATFORMS)[number])) continue;
      const url = stringValue(row["shareUrl"]);
      if (!url) continue;
      // Trust the URL shape over the declared platform, exactly like PanSou does.
      const type = normalizeResourceType(platform, url);
      if (!type) continue;
      if (this.allowedTypes && !this.allowedTypes.includes(type)) continue;
      candidates.push({
        id: `${snapshotId}:${index}`,
        snapshotId,
        index,
        title: stripHighlight(stringValue(row["title"]) || stringValue(row["highlightedTitle"])),
        type,
        source: "haisou",
        providerPayload: {
          url,
          password: stringValue(row["sharePwd"]),
          // 站方给的是人读文本（"2026/10/25（1天前）"），没有 ISO 时间戳；
          // 留空而不是编一个，让下游知道「这个源没有时间信息」。
          datetime: "",
          rawType: platform,
          fileCount: numberValue(row["fileCount"]),
          sizeBytes: numberValue(row["sizeBytes"]),
        },
      });
      index += 1;
    }

    return {
      id: snapshotId,
      provider: "haisou",
      keyword,
      candidates,
      createdAt: this.now(),
    };
  }
}

/** The upstream's rpd window resets on a UTC day boundary. */
function utcDay(iso: string): string {
  const at = Date.parse(iso);
  return new Date(Number.isFinite(at) ? at : Date.now()).toISOString().slice(0, 10);
}

/** 标题里带 `<span class="highlight">` 高亮，去掉标签但保留文字。 */
function stripHighlight(text: string): string {
  return text.replace(/<[^>]*>/g, "").trim();
}

function emptySnapshot(
  id: string,
  keyword: string,
  createdAt: string,
  health?: SourceHealth,
): ResourceSnapshot {
  const snapshot: ResourceSnapshot = { id, provider: "haisou", keyword, candidates: [], createdAt };
  if (health) {
    snapshot.sourceHealth = mergeSourceHealth([health]);
  }
  return snapshot;
}

/** 与 PanSou 同款的 run 级 id：同一个关键词在不同 run 里必须得到不同快照 id，
 *  否则第二次获取会撞 resource_snapshots 的主键。 */
function scopedId(provider: string, keyword: string, workflowRunId?: string): string {
  const hash = createHash("sha256").update(`${provider}:${keyword}`).digest("hex").slice(0, 16);
  return workflowRunId ? `${workflowRunId}:${hash}` : `${provider}-${hash}`;
}

async function defaultFetchJson(
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string; timeoutMs?: number },
): Promise<unknown> {
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: AbortSignal.timeout(init.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`haisou upstream HTTP ${response.status}`);
  }
  return response.json();
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
