import { describe, expect, it, vi } from "vitest";
import type { MediaTitle, TrackedSeason, WorkflowRun } from "../src/domain.js";
import type { PersistedWorkflowRunSnapshot, PersistWorkflowRunSnapshotInput } from "../src/repository.js";
import { QuarkAuthError } from "../src/quark-cookie-client.js";
import { attachStagingLeaks } from "../src/acquisition-v2/directory-lifecycle.js";
import { FREE_LLM_PRESET } from "../src/agent-model.js";
import {
  FREE_LLM_MODEL_GONE_LINE,
  FREE_LLM_POOL_FAILURE_LINE,
  handleWorkflowRunFailure,
} from "../src/worker.js";

const title: MediaTitle = {
  id: "tmdb_movie_1",
  tmdbId: 1,
  type: "movie",
  title: "测试电影",
  originalTitle: "Test",
  year: 2020,
  aliases: [],
};

const season: TrackedSeason = {
  id: "tmdb_movie_1_movie",
  mediaTitleId: "tmdb_movie_1",
  seasonNumber: 1,
  status: "completed",
  qualityPreference: "4K",
  storageDirectoryId: "",
  totalEpisodes: 1,
  latestAiredEpisode: 1,
  latestAiredSource: "manual",
};

function snapshot(run: Partial<WorkflowRun> = {}): PersistedWorkflowRunSnapshot {
  const workflowRun: WorkflowRun = {
    id: "r1",
    kind: "movie_init",
    status: "running",
    trackedSeasonId: "tmdb_movie_1_movie",
    startedAt: "2026-06-21T05:00:00.000Z",
    finishedAt: null,
    auditEvents: [],
    ...run,
  };
  return {
    accountId: "acct_default",
    connectedStorageId: "cs_1",
    title,
    season,
    workflowRun,
    episodes: [],
    resourceSnapshots: [],
    decisions: [],
    transferAttempts: [],
    notifications: [],
    obtainedEpisodes: [],
    providerAheadEpisodes: [],
  } as PersistedWorkflowRunSnapshot;
}

const now = () => "2026-06-21T05:30:00.000Z";

describe("handleWorkflowRunFailure", () => {
  it("auto-requeues a transient error under the cap (queued + retrying notification)", async () => {
    const save = vi.fn(async (_input: PersistWorkflowRunSnapshotInput) => {});
    const out = await handleWorkflowRunFailure({
      claimed: snapshot(),
      error: new Error("Cannot connect to API: socket disconnected"),
      repository: { saveWorkflowRunSnapshot: save },
      now,
    });
    expect(out.status).toBe("auto_requeued");
    const saved = save.mock.calls[0]![0];
    expect(saved.workflowRun.status).toBe("queued");
    expect(saved.workflowRun.autoRequeueCount).toBe(1);
    expect(saved.workflowRun.nextAttemptAt).toBeDefined();
    expect(saved.notifications[0]?.report?.status).toBe("retrying");
  });

  it("surfaces the real cause in the retry notification (no longer hidden behind 网络波动, issue #196)", async () => {
    const save = vi.fn(async (_input: PersistWorkflowRunSnapshotInput) => {});
    await handleWorkflowRunFailure({
      claimed: snapshot(),
      error: new Error("fetch failed: 夸克访问频繁,请稍后再试"),
      repository: { saveWorkflowRunSnapshot: save },
      now,
    });
    const report = save.mock.calls[0]![0].notifications[0]?.report;
    expect(report?.status).toBe("retrying");
    // 既保留「网络波动·重试」那句,又多一句「原因:…」把真错亮出来。
    expect(report?.lines.some((l) => l.includes("网络波动"))).toBe(true);
    expect(report?.lines.some((l) => l.includes("原因:") && l.includes("夸克访问频繁"))).toBe(true);
  });

  it("redacts secrets from the retry-cause line (never leak a cookie/token into a push)", async () => {
    const save = vi.fn(async (_input: PersistWorkflowRunSnapshotInput) => {});
    await handleWorkflowRunFailure({
      claimed: snapshot(),
      error: new Error("fetch failed https://u:sup3rSecretPw@drive.quark.cn/x timeout"),
      repository: { saveWorkflowRunSnapshot: save },
      now,
    });
    const body = save.mock.calls[0]![0].notifications[0]?.body ?? "";
    expect(body).not.toContain("sup3rSecretPw");
    expect(body).toContain("原因:");
  });

  it("terminally fails a transient error AT the cap (failed + failed notification)", async () => {
    const save = vi.fn(async (_input: PersistWorkflowRunSnapshotInput) => {});
    const out = await handleWorkflowRunFailure({
      claimed: snapshot({ autoRequeueCount: 3 }),
      error: new Error("socket hang up"),
      repository: { saveWorkflowRunSnapshot: save },
      now,
    });
    expect(out.status).toBe("failed");
    const saved = save.mock.calls[0]![0];
    expect(saved.workflowRun.status).toBe("failed");
    expect(saved.notifications[0]?.report?.status).toBe("failed");
  });

  it("preserves the claimed snapshot's episode bucket across auto-requeue (does NOT wipe it)", async () => {
    const save = vi.fn(async (_input: PersistWorkflowRunSnapshotInput) => {});
    const episodes = [
      {
        trackedSeasonId: "tmdb_movie_1_movie",
        episodeCode: "S01E01",
        airDate: null,
        airStatus: "aired" as const,
        obtained: false,
      },
    ];
    const claimed = { ...snapshot(), episodes } as PersistedWorkflowRunSnapshot;
    await handleWorkflowRunFailure({
      claimed,
      error: new Error("read ECONNRESET"),
      repository: { saveWorkflowRunSnapshot: save },
      now,
    });
    const saved = save.mock.calls[0]![0];
    // Bug (Copilot): saving with episodes:[] deletes the season's reserved bucket
    // (replaceWorkflowRunSnapshot wipes by season then re-inserts) — losing tracked
    // state on a run that is going BACK to queued. Must round-trip claimed.episodes.
    expect(saved.episodes).toHaveLength(1);
    expect(saved.episodes[0]?.episodeCode).toBe("S01E01");
  });

  it("maps an LLM 401 'Unauthorized' failure to actionable guidance in the user-facing message (#49)", async () => {
    const save = vi.fn(async (_input: PersistWorkflowRunSnapshotInput) => {});
    const out = await handleWorkflowRunFailure({
      claimed: snapshot(),
      error: new Error("Unauthorized"),
      repository: { saveWorkflowRunSnapshot: save },
      now,
    });
    expect(out.status).toBe("failed");
    expect(out.errorMessage).toContain("AI 模型鉴权失败");
    expect(out.errorMessage).not.toBe("Unauthorized");
    const saved = save.mock.calls[0]![0];
    const body = saved.notifications[0]?.body ?? "";
    expect(body).toContain("设置 → AI 模型");
    expect(body).not.toContain("Unauthorized");
  });

  it("leaves a non-LLM failure message unchanged (no false positive)", async () => {
    const save = vi.fn(async (_input: PersistWorkflowRunSnapshotInput) => {});
    const out = await handleWorkflowRunFailure({
      claimed: snapshot(),
      error: new Error("QUARK_TRANSFER_FAILED: dead share"),
      repository: { saveWorkflowRunSnapshot: save },
      now,
    });
    expect(out.errorMessage).toBe("QUARK_TRANSFER_FAILED: dead share");
  });

  it("terminally fails a NON-transient error immediately (count=0)", async () => {
    const save = vi.fn(async (_input: PersistWorkflowRunSnapshotInput) => {});
    const out = await handleWorkflowRunFailure({
      claimed: snapshot(),
      error: new Error("agent gave up: no coverage"),
      repository: { saveWorkflowRunSnapshot: save },
      now,
    });
    expect(out.status).toBe("failed");
    const saved = save.mock.calls[0]![0];
    expect(saved.workflowRun.status).toBe("failed");
    expect(saved.notifications[0]?.report?.status).toBe("failed");
  });

  it("persists staging_leaked audit events carried on the error into the FAILED run (Copilot #260 r1)", async () => {
    // A leak detected by withStagingCleanup on the throw path rides on the error;
    // the failure handler is the only code that persists that run, so it must
    // append the event — otherwise a failed run can leave 1.4 TB behind unseen.
    const save = vi.fn(async (_input: PersistWorkflowRunSnapshotInput) => {});
    const error = attachStagingLeaks(new Error("agent gave up: no coverage"), [
      {
        stagingDirectoryId: "stg-77",
        showDirectoryId: "show-7",
        error: new Error("PAN123_TRASH_NOOP: did not act on stg-77"),
      },
    ]);
    await handleWorkflowRunFailure({
      claimed: snapshot(),
      error,
      repository: { saveWorkflowRunSnapshot: save },
      now,
    });
    const saved = save.mock.calls[0]![0];
    expect(saved.workflowRun.status).toBe("failed");
    const leak = saved.workflowRun.auditEvents.find((event) => event.type === "staging_leaked");
    expect(leak).toBeDefined();
    // Same shape as the success path (Copilot #260 r2): the show dir rides along so
    // a hand cleanup knows WHERE the leaked staging dir lives.
    expect(leak?.data).toMatchObject({
      stagingDirectoryId: "stg-77",
      showDirectoryId: "show-7",
      cleanupError: expect.stringContaining("PAN123_TRASH_NOOP"),
    });
    // the failure itself is still recorded
    expect(saved.workflowRun.auditEvents.some((event) => event.type === "workflow_failed")).toBe(true);
  });

  it("persists staging_leaked audit events on the REQUEUED run too (transient failure + surviving staging)", async () => {
    const save = vi.fn(async (_input: PersistWorkflowRunSnapshotInput) => {});
    const error = attachStagingLeaks(new Error("read ECONNRESET"), [
      { stagingDirectoryId: "stg-78", showDirectoryId: "show-8" },
    ]);
    const out = await handleWorkflowRunFailure({
      claimed: snapshot(),
      error,
      repository: { saveWorkflowRunSnapshot: save },
      now,
    });
    expect(out.status).toBe("auto_requeued");
    const saved = save.mock.calls[0]![0];
    expect(saved.workflowRun.auditEvents.some((event) => event.type === "staging_leaked")).toBe(true);
  });

  it("attaching leaks does NOT change the error's identity: a brand auth error still freezes the drive", async () => {
    const save = vi.fn(async (_input: PersistWorkflowRunSnapshotInput) => {});
    const onAuthErrorFreeze = vi.fn(async (_storageId: string, _reason: string) => {});
    const error = attachStagingLeaks(new QuarkAuthError("QUARK_AUTH_FAILED: require login"), [
      { stagingDirectoryId: "stg-79", showDirectoryId: "show-9" },
    ]);
    await handleWorkflowRunFailure({
      claimed: snapshot(),
      error,
      repository: { saveWorkflowRunSnapshot: save },
      now,
      onAuthErrorFreeze,
    });
    expect(onAuthErrorFreeze).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![0].workflowRun.auditEvents.some((event) => event.type === "staging_leaked")).toBe(true);
  });

  it("freezes the connected drive once on brand QuarkAuthError", async () => {
    const save = vi.fn(async (_input: PersistWorkflowRunSnapshotInput) => {});
    const onAuthErrorFreeze = vi.fn(async (_storageId: string, _reason: string) => {});
    await handleWorkflowRunFailure({
      claimed: snapshot(),
      error: new QuarkAuthError("QUARK_AUTH_FAILED: require login"),
      repository: { saveWorkflowRunSnapshot: save },
      now,
      onAuthErrorFreeze,
    });
    expect(onAuthErrorFreeze).toHaveBeenCalledTimes(1);
    expect(onAuthErrorFreeze).toHaveBeenCalledWith("cs_1", "QUARK_AUTH_FAILED: require login");
  });

  it("does not freeze on a plain Error (even if message looks auth-like)", async () => {
    const save = vi.fn(async (_input: PersistWorkflowRunSnapshotInput) => {});
    const onAuthErrorFreeze = vi.fn(async () => {});
    await handleWorkflowRunFailure({
      claimed: snapshot(),
      error: new Error("Unauthorized"),
      repository: { saveWorkflowRunSnapshot: save },
      now,
      onAuthErrorFreeze,
    });
    expect(onAuthErrorFreeze).not.toHaveBeenCalled();
  });

  it("does not freeze / does not throw when connectedStorageId is null", async () => {
    const save = vi.fn(async (_input: PersistWorkflowRunSnapshotInput) => {});
    const onAuthErrorFreeze = vi.fn(async () => {});
    const claimed = { ...snapshot(), connectedStorageId: null };
    await expect(
      handleWorkflowRunFailure({
        claimed,
        error: new QuarkAuthError("QUARK_AUTH_FAILED: require login"),
        repository: { saveWorkflowRunSnapshot: save },
        now,
        onAuthErrorFreeze,
      }),
    ).resolves.toMatchObject({ status: "failed" });
    expect(onAuthErrorFreeze).not.toHaveBeenCalled();
  });
});

describe("handleWorkflowRunFailure — 免费档失败文案（isFreeLlmPreset 档位分叉）", () => {
  // 免费池 429 是 transient：重试期间走既有「网络波动·第 N 次自动重试」通知
  // （无需新文案），这里只验「重试耗尽后」的终态首行点名 Kilo。
  it("free preset + 429 with retries EXHAUSTED → 首行换成 Kilo 免费池文案", async () => {
    const save = vi.fn(async (_input: PersistWorkflowRunSnapshotInput) => {});
    const out = await handleWorkflowRunFailure({
      claimed: snapshot({ autoRequeueCount: 3 }),
      error: new Error("Failed after 3 attempts. Last error: Too Many Requests"),
      repository: { saveWorkflowRunSnapshot: save },
      now,
      llmConfig: { ...FREE_LLM_PRESET },
    });
    expect(out.status).toBe("failed");
    const report = save.mock.calls[0]![0].notifications[0]?.report;
    expect(report?.status).toBe("failed");
    expect(report?.lines[0]).toBe(FREE_LLM_POOL_FAILURE_LINE);
    // 免费池文案替换的是首行；重试耗尽的「网络中断」措辞不再出现（429 不是网络中断）。
    expect(report?.lines.join("\n")).not.toContain("网络中断");
  });

  it("free preset + 429 UNDER the cap still auto-requeues with the plain retrying lines", async () => {
    const save = vi.fn(async (_input: PersistWorkflowRunSnapshotInput) => {});
    const out = await handleWorkflowRunFailure({
      claimed: snapshot(),
      // isLlmRateLimitError 命中形态（AI SDK APICallError 的数值 statusCode）：
      // 免费档 × LLM 类错误才解锁 HTTP 状态退避（Copilot r5 M）。
      error: Object.assign(new Error("Request failed with status code 429"), { statusCode: 429 }),
      repository: { saveWorkflowRunSnapshot: save },
      now,
      llmConfig: { ...FREE_LLM_PRESET },
    });
    expect(out.status).toBe("auto_requeued");
    const report = save.mock.calls[0]![0].notifications[0]?.report;
    expect(report?.status).toBe("retrying");
    expect(report?.lines.join("\n")).toContain("网络波动");
    expect(report?.lines.join("\n")).not.toContain("Kilo");
  });

  it("free preset + model not found → 「内置免费模型已失效」文案，且不 transient（不重排）", async () => {
    const save = vi.fn(async (_input: PersistWorkflowRunSnapshotInput) => {});
    const out = await handleWorkflowRunFailure({
      claimed: snapshot(),
      error: new Error("Model not found: nvidia/nemotron-3-ultra-550b-a55b:free"),
      repository: { saveWorkflowRunSnapshot: save },
      now,
      llmConfig: { ...FREE_LLM_PRESET },
    });
    // 模型下架重试也不会好：404/model-not-found 不是 transient，直接终止。
    expect(out.status).toBe("failed");
    expect(save.mock.calls[0]![0].workflowRun.status).toBe("failed");
    expect(save.mock.calls[0]![0].workflowRun.autoRequeueCount).toBeUndefined();
    const report = save.mock.calls[0]![0].notifications[0]?.report;
    expect(report?.lines[0]).toBe(FREE_LLM_MODEL_GONE_LINE);
  });

  it("free preset + LLM 5xx (service fluctuation) → Kilo 免费池文案", async () => {
    const save = vi.fn(async (_input: PersistWorkflowRunSnapshotInput) => {});
    // 5xx 是 transient：耗尽重试后到达终态。
    await handleWorkflowRunFailure({
      claimed: snapshot({ autoRequeueCount: 3 }),
      error: Object.assign(new Error("service unavailable"), { statusCode: 503 }),
      repository: { saveWorkflowRunSnapshot: save },
      now,
      llmConfig: { ...FREE_LLM_PRESET },
    });
    const report = save.mock.calls[0]![0].notifications[0]?.report;
    expect(report?.lines[0]).toBe(FREE_LLM_POOL_FAILURE_LINE);
  });

  it("BYO model (自带服务) keeps the AGNOSTIC copy even on an LLM 429 — 不点名厂商", async () => {
    const save = vi.fn(async (_input: PersistWorkflowRunSnapshotInput) => {});
    await handleWorkflowRunFailure({
      claimed: snapshot({ autoRequeueCount: 3 }),
      error: new Error("Failed after 3 attempts. Last error: Too Many Requests"),
      repository: { saveWorkflowRunSnapshot: save },
      now,
      llmConfig: { baseURL: "https://api.deepseek.com/v1", modelId: "deepseek-chat" },
    });
    const report = save.mock.calls[0]![0].notifications[0]?.report;
    expect(report?.lines[0]).not.toContain("Kilo");
    // Copilot r5 M：BYO 的 LLM 429 不再进退避（HTTP 状态判定是免费池专属），
    // count=3 也不会出现「已自动重试」措辞 —— agnostic 的「获取失败」。
    expect(report?.lines[0]).toBe("获取失败");
  });

  // ---- Copilot r5 M：HTTP 状态退避收窄为「免费预设 × LLM 类错误」专属 ----
  //
  // 免费池 429/5xx 的退避重排是免费档专属恢复策略（spec：已配置 DB/env 的
  // 用户行为不变）。BYO 与非 LLM（网盘/搜索源）的 429/5xx 维持既有保守连接
  // 类分类 —— 不重排，直接终止失败。
  it("BYO model + the SAME numeric LLM 429 → NOT requeued (legacy behavior, spec 承诺不变)", async () => {
    const save = vi.fn(async (_input: PersistWorkflowRunSnapshotInput) => {});
    const out = await handleWorkflowRunFailure({
      claimed: snapshot(),
      error: Object.assign(new Error("Request failed with status code 429"), { statusCode: 429 }),
      repository: { saveWorkflowRunSnapshot: save },
      now,
      llmConfig: { baseURL: "https://api.deepseek.com/v1", modelId: "deepseek-chat" },
    });
    expect(out.status).toBe("failed");
    const saved = save.mock.calls[0]![0];
    expect(saved.workflowRun.status).toBe("failed");
    expect(saved.workflowRun.autoRequeueCount).toBeUndefined();
  });

  it("free preset + a NON-LLM 5xx (brand error carrying statusCode 503) → NOT requeued", async () => {
    const save = vi.fn(async (_input: PersistWorkflowRunSnapshotInput) => {});
    const out = await handleWorkflowRunFailure({
      claimed: snapshot(),
      // PAN115 品牌错误（isLlm* 分类器被品牌 marker 短路）+ 数值 statusCode 503：
      // 若 HTTP 状态判定不门控，这个网盘 5xx 会被免费池的恢复策略吃进退避。
      error: Object.assign(new Error("PAN115_LIST_FAILED: 服务器繁忙,请稍后再试"), { statusCode: 503 }),
      repository: { saveWorkflowRunSnapshot: save },
      now,
      llmConfig: { ...FREE_LLM_PRESET },
    });
    expect(out.status).toBe("failed");
    const saved = save.mock.calls[0]![0];
    expect(saved.workflowRun.status).toBe("failed");
    expect(saved.workflowRun.autoRequeueCount).toBeUndefined();
    // 网盘错不冒充 Kilo 挂了：agnostic 文案。
    expect(saved.notifications[0]?.report?.lines[0]).toBe("获取失败");
  });

  // ---- Copilot r6 M：门控识别 message-only 状态形态（形态对齐被门控能力） ----
  //
  // isLlm* 分类器刻意不认裸 429 子串、5xx 只认数值 statusCode/标准短语，但
  // transient 开关打开后匹配的是「文本 429 / 独立 5xx token」那套形态 —— 门控
  // 比被门控的能力窄，message-only 的免费池 LLM 错（axios 风格 "Request failed
  // with status code 429"、网关 "HTTP 520 from gateway"）过不了门：真 LLM 错
  // 直接终止，不进 1/5/15 退避。isLlmHttpStatusError（状态特征 × 非 LLM 排除）
  // 补齐这个缺口；网盘/搜索源的 5xx 仍被排除挡在门外。
  it("free preset + message-only 'Request failed with status code 429' → requeued（门控看见 transient 会命中的形态）", async () => {
    const save = vi.fn(async (_input: PersistWorkflowRunSnapshotInput) => {});
    const out = await handleWorkflowRunFailure({
      claimed: snapshot(),
      // 没有 statusCode/responseStatus 数值字段 —— 状态只活在 message 里。
      error: new Error("Request failed with status code 429"),
      repository: { saveWorkflowRunSnapshot: save },
      now,
      llmConfig: { ...FREE_LLM_PRESET },
    });
    expect(out.status).toBe("auto_requeued");
    expect(save.mock.calls[0]![0].workflowRun.autoRequeueCount).toBe(1);
    expect(save.mock.calls[0]![0].workflowRun.nextAttemptAt).toBeDefined();
  });

  it("free preset + message-only 'HTTP 520 from gateway' → requeued（Cloudflare 式 5xx token）", async () => {
    const save = vi.fn(async (_input: PersistWorkflowRunSnapshotInput) => {});
    const out = await handleWorkflowRunFailure({
      claimed: snapshot(),
      error: new Error("HTTP 520 from gateway"),
      repository: { saveWorkflowRunSnapshot: save },
      now,
      llmConfig: { ...FREE_LLM_PRESET },
    });
    expect(out.status).toBe("auto_requeued");
    expect(save.mock.calls[0]![0].workflowRun.autoRequeueCount).toBe(1);
  });

  it("free preset + PAN115 brand error with a bare 5xx token in TEXT → NOT requeued（非 LLM 排除保留，回归）", async () => {
    const save = vi.fn(async (_input: PersistWorkflowRunSnapshotInput) => {});
    const out = await handleWorkflowRunFailure({
      claimed: snapshot(),
      // message-only 形态 + 品牌 marker：扩门控不能把网盘 5xx 吃进免费池退避。
      error: new Error("PAN115_LIST_FAILED: HTTP 503 服务器繁忙"),
      repository: { saveWorkflowRunSnapshot: save },
      now,
      llmConfig: { ...FREE_LLM_PRESET },
    });
    expect(out.status).toBe("failed");
    const saved = save.mock.calls[0]![0];
    expect(saved.workflowRun.status).toBe("failed");
    expect(saved.workflowRun.autoRequeueCount).toBeUndefined();
  });

  it("BYO model + message-only 'Request failed with status code 429' → NOT requeued（回归，spec 承诺不变）", async () => {
    const save = vi.fn(async (_input: PersistWorkflowRunSnapshotInput) => {});
    const out = await handleWorkflowRunFailure({
      claimed: snapshot(),
      error: new Error("Request failed with status code 429"),
      repository: { saveWorkflowRunSnapshot: save },
      now,
      llmConfig: { baseURL: "https://api.deepseek.com/v1", modelId: "deepseek-chat" },
    });
    expect(out.status).toBe("failed");
    const saved = save.mock.calls[0]![0];
    expect(saved.workflowRun.status).toBe("failed");
    expect(saved.workflowRun.autoRequeueCount).toBeUndefined();
  });

  it("connection-class (fetch failed) stays requeued for ANY tier (regression, 旧行为不变)", async () => {
    for (const llmConfig of [
      undefined,
      { ...FREE_LLM_PRESET },
      { baseURL: "https://api.deepseek.com/v1", modelId: "deepseek-chat" },
    ]) {
      const save = vi.fn(async (_input: PersistWorkflowRunSnapshotInput) => {});
      const out = await handleWorkflowRunFailure({
        claimed: snapshot(),
        error: new Error("fetch failed"),
        repository: { saveWorkflowRunSnapshot: save },
        now,
        ...(llmConfig === undefined ? {} : { llmConfig }),
      });
      expect(out.status, JSON.stringify(llmConfig ?? "absent")).toBe("auto_requeued");
    }
  });

  it("free preset + a NON-LLM error keeps the AGNOSTIC copy (网盘错不冒充 Kilo 挂了)", async () => {
    const save = vi.fn(async (_input: PersistWorkflowRunSnapshotInput) => {});
    await handleWorkflowRunFailure({
      claimed: snapshot(),
      error: new Error("QUARK_TRANSFER_FAILED: dead share"),
      repository: { saveWorkflowRunSnapshot: save },
      now,
      llmConfig: { ...FREE_LLM_PRESET },
    });
    const report = save.mock.calls[0]![0].notifications[0]?.report;
    expect(report?.lines[0]).toBe("获取失败");
    expect(report?.lines.join("\n")).not.toContain("Kilo");
  });

  it("absent llmConfig → agnostic copy (worker cannot see the config → never guess free tier)", async () => {
    const save = vi.fn(async (_input: PersistWorkflowRunSnapshotInput) => {});
    await handleWorkflowRunFailure({
      claimed: snapshot({ autoRequeueCount: 3 }),
      error: new Error("Failed after 3 attempts. Last error: Too Many Requests"),
      repository: { saveWorkflowRunSnapshot: save },
      now,
    });
    const report = save.mock.calls[0]![0].notifications[0]?.report;
    // 看不到配置 → 不猜免费档：HTTP 状态退避不生效，不重试，agnostic 文案。
    expect(report?.lines[0]).toBe("获取失败");
    expect(report?.lines.join("\n")).not.toContain("Kilo");
  });

  it("the two free-tier copy lines are the approved verbatim texts (含全角标点)", () => {
    expect(FREE_LLM_POOL_FAILURE_LINE).toBe(
      "AI 模型调用失败：Kilo 公共免费池暂时不可用（限速或服务波动）。可稍后重试，或在 设置 → AI 模型 换成自己的服务。",
    );
    expect(FREE_LLM_MODEL_GONE_LINE).toBe(
      "内置免费模型已失效（Kilo 池变动）。请到 设置 → AI 模型 换一个模型或换成自己的服务。",
    );
  });
});

describe("handleWorkflowRunFailure — model content-filter before any transfer", () => {
  it("terminal failure naming the model, not a retry and not no-coverage (《出入平安》)", async () => {
    const { AgentContentFilterError } = await import("../src/agent-error.js");
    const save = vi.fn(async (_input: PersistWorkflowRunSnapshotInput) => {});
    const out = await handleWorkflowRunFailure({
      claimed: snapshot(),
      error: new AgentContentFilterError(),
      repository: { saveWorkflowRunSnapshot: save },
      now,
    });
    expect(out.status).toBe("failed");
    const saved = save.mock.calls[0]![0];
    expect(saved.workflowRun.status).toBe("failed");
    const report = saved.notifications[0]?.report;
    expect(report?.status).toBe("failed");
    expect(report?.lines.join("\n")).toContain("内容审查");
    expect(report?.lines.join("\n")).toContain("不是没有资源");
  });
});

describe("handleWorkflowRunFailure — stdout trail", () => {
  it("logs one secret-safe line per failure (the 出入平安 cause was only recoverable from dead heap tuples)", async () => {
    const save = vi.fn(async (_input: PersistWorkflowRunSnapshotInput) => {});
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await handleWorkflowRunFailure({
        claimed: snapshot(),
        error: new Error("PAN123_REQUEST_FAILED(yun.123pan.com /file/list): TimeoutError token=abcdefghijklmnop"),
        repository: { saveWorkflowRunSnapshot: save },
        now,
      });
      const lines = spy.mock.calls.map((c) => String(c[0]));
      const line = lines.find((l) => l.startsWith("[workflow] run r1"));
      expect(line).toBeDefined();
      expect(line).toContain("movie_init");
      expect(line).toContain("auto_requeued");
      expect(line).toContain("yun.123pan.com");
      expect(line).not.toContain("abcdefghijklmnop");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("handleWorkflowRunFailure — log survives a failing save", () => {
  it("writes the stdout line even when persistence rejects", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const save = vi.fn(async () => { throw new Error("db down"); });
      await expect(
        handleWorkflowRunFailure({ claimed: snapshot(), error: new Error("boom"), repository: { saveWorkflowRunSnapshot: save }, now }),
      ).rejects.toThrow("db down");
      expect(spy.mock.calls.map((c) => String(c[0])).some((l) => l.startsWith("[workflow] run r1") && l.includes("boom"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("handleWorkflowRunFailure — terminal failure push is redacted", () => {
  it("a non-retried failure never pushes a raw token, but the run row keeps the raw message", async () => {
    const save = vi.fn(async (_input: PersistWorkflowRunSnapshotInput) => {});
    await handleWorkflowRunFailure({
      claimed: snapshot(),
      error: new Error("PAN123_FAILED(/x): code=5 bad cookie=UID_abcdefghijkl"),
      repository: { saveWorkflowRunSnapshot: save },
      now,
    });
    const saved = save.mock.calls[0]![0];
    expect(saved.workflowRun.status).toBe("failed");
    const push = [saved.notifications[0]!.body, ...(saved.notifications[0]!.report?.lines ?? [])].join("\n");
    expect(push).not.toContain("UID_abcdefghijkl");
    expect(push).toContain("PAN123_FAILED");
  });
});

describe("summarizeErrorForNotification — bare secret names", () => {
  it("redacts token=/cookie= with no name prefix, and keeps a short harmless value", async () => {
    const { summarizeErrorForNotification } = await import("../src/agent-error.js");
    expect(summarizeErrorForNotification("x token=abcdefghijkl y")).toBe("x token=*** y");
    expect(summarizeErrorForNotification("cookie: UID=12345678_abc")).not.toContain("12345678_abc");
    expect(summarizeErrorForNotification("key=ab")).toBe("key=ab");
  });
});
