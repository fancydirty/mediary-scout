import type { LanguageModel } from "ai";
import { runKeyedPool } from "./keyed-pool.js";
import type {
  AcquisitionSeasonScope,
  EpisodeState,
  MediaTitle,
  MediaType,
  NotificationEvent,
  NotificationReport,
  TrackedSeason,
  WorkflowStatus,
} from "./domain.js";
import type { ResourceProvider, StorageExecutor } from "./ports.js";
import type { PersistedWorkflowRunSnapshot, QueueClaimOptions, WorkflowRepository } from "./repository.js";
import {
  AUTO_REQUEUE_BACKOFF_MS,
  AUTO_REQUEUE_MAX,
  claimNextQueuedRun,
  failWorkflowRun,
  requeueWorkflowRunForRetry,
} from "./repository.js";
import { isTransientAcquisitionError } from "./acquisition-v2/transient-error.js";
import type { JevJudge } from "./jev-judge.js";
import { stagingFailureAuditEvents } from "./acquisition-v2/directory-lifecycle.js";
import {
  describeAgentRunError,
  isLlmAuthError,
  isLlmModelGoneError,
  isLlmRateLimitError,
  isLlmServerError,
  summarizeErrorForNotification,
} from "./agent-error.js";
import { isFreeLlmPreset } from "./agent-model.js";
import { formatReportPushText } from "./notification-report.js";
import { isMovieUnreleased } from "./domain.js";
import {
  runMovieAcquisitionV2AndPersist,
  runSeriesInitializationV2AndPersist,
  runType2InitializationV2AndPersist,
  runType3MonitoringV2AndPersist,
} from "./runner-v2.js";
import { syncSeasonAgainstMetadata } from "./season-sync.js";
import { isBrandStorageAuthError } from "./storage-auth-error.js";
import { userMessageDrive, type UserMessageScope } from "./user-requests.js";
// Circular with replace-request.ts (it uses this module's claim helpers); both sides
// only call the other's functions at run time, never at module evaluation.
import { queueReplaceRequest } from "./replace-request.js";

async function maybeFreezeOnBrandAuthError(input: {
  connectedStorageId: string | null | undefined;
  error: unknown;
  onAuthErrorFreeze?: (storageId: string, reason: string) => Promise<void>;
}): Promise<void> {
  const { connectedStorageId, error, onAuthErrorFreeze } = input;
  if (!onAuthErrorFreeze || !connectedStorageId || !isBrandStorageAuthError(error)) {
    return;
  }
  const reason = error instanceof Error ? error.message : String(error);
  try {
    await onAuthErrorFreeze(connectedStorageId, reason);
  } catch (freezeError) {
    console.error(
      `[media-track] onAuthErrorFreeze failed for ${connectedStorageId}: ${String(freezeError)}`,
    );
  }
}

/**
 * Pick the 115 landing parent for a title. Anime lands under its own parent
 * (when configured) so the 动漫 library shelf is a physically separate tree,
 * never intermixed with TV shows; everything else uses the default parent.
 */
export function storageParentForTitle(
  title: { type: MediaType },
  storageParentDirectoryId: string | undefined,
  animeStorageParentDirectoryId: string | undefined,
): string | undefined {
  if (title.type === "anime" && animeStorageParentDirectoryId !== undefined) {
    return animeStorageParentDirectoryId;
  }
  return storageParentDirectoryId;
}

/**
 * Merge the per-account worker context (resolved from the run's owner) over the
 * globally-passed deps. Per-account fields (115 storage + landing CIDs) win;
 * everything else falls through to the base. No resolver → base unchanged.
 */
export async function resolveWorkerDeps(
  resolve: ResolveAccountWorkerContext | undefined,
  accountId: string,
  connectedStorageId: string | null,
  base: AccountWorkerContext & {
    storage: StorageExecutor;
    resourceProvider: ResourceProvider;
    model: LanguageModel;
  },
): Promise<{
  storage: StorageExecutor;
  resourceProvider: ResourceProvider;
  model: LanguageModel;
  llmConfig: { baseURL?: string; modelId?: string } | undefined;
  preferredLanguage: string | undefined;
  qualityPreference: "high" | "medium" | undefined;
  storageProvider: string | undefined;
  assrtToken: string | undefined;
  jevJudge: JevJudge | undefined;
  agentMemory: boolean | undefined;
  storageParentDirectoryId: string | undefined;
  animeStorageParentDirectoryId: string | undefined;
  moviesParentDirectoryId: string | undefined;
}> {
  const ctx = resolve ? await resolve(accountId, connectedStorageId) : {};
  return {
    storage: ctx.storage ?? base.storage,
    resourceProvider: ctx.resourceProvider ?? base.resourceProvider,
    model: ctx.model ?? base.model,
    // The failure-copy config must describe the model THIS run actually uses.
    // The resolver's model wins only when it discloses its config; a resolver
    // that overrides the model without llmConfig yields undefined → the worker
    // falls back to the AGNOSTIC copy (never guess a config it cannot see).
    llmConfig: ctx.model !== undefined ? ctx.llmConfig : base.llmConfig,
    preferredLanguage: ctx.preferredLanguage ?? base.preferredLanguage,
    qualityPreference: ctx.qualityPreference ?? base.qualityPreference,
    storageProvider: ctx.storageProvider ?? base.storageProvider,
    assrtToken: ctx.assrtToken ?? base.assrtToken,
    // Jev is per-account opt-in: with a resolver, its answer is authoritative even
    // when it has no judge — an account that never configured (or switched off) the
    // prefilter must not inherit a judge that happens to ride in the base deps.
    jevJudge: resolve ? ctx.jevJudge : base.jevJudge,
    agentMemory: ctx.agentMemory ?? base.agentMemory,
    storageParentDirectoryId:
      ctx.storageParentDirectoryId ?? base.storageParentDirectoryId,
    animeStorageParentDirectoryId:
      ctx.animeStorageParentDirectoryId ?? base.animeStorageParentDirectoryId,
    moviesParentDirectoryId:
      ctx.moviesParentDirectoryId ?? base.moviesParentDirectoryId,
  };
}

/**
 * Refresh a tracked season's aired/total counts from TMDB. Returning null (or
 * throwing) leaves the season on its stored counts — the sweep still runs, it
 * just won't discover episodes aired since tracking began.
 */
export type SeasonMetadataSync = (input: {
  tmdbId: number;
  seasonNumber: number;
}) => Promise<{ latestAiredEpisode: number; totalEpisodes: number } | null>;

/**
 * §7: per-account worker context. After a run is claimed, the worker resolves the
 * RUN's account credentials (115 cookie via storage, landing CIDs) so a multi-user
 * acquisition transfers to the right person's 网盘. Every field is optional — the
 * resolver overrides only what is per-account (storage + CIDs); model/provider/
 * language fall through to the globally-passed values. No resolver → the function
 * uses its input deps unchanged (single-user / tests).
 */
/** Asked right before a run is claimed or reserved as running. False = start nothing
 *  now (the web process is about to be replaced by an update); queued runs stay
 *  queued. Absent = always allowed. */
export type MayStartRun = () => boolean;

export interface AccountWorkerContext {
  storage?: StorageExecutor;
  resourceProvider?: ResourceProvider;
  model?: LanguageModel;
  /** The config (baseURL/modelId only, never the key) that built `model`.
   *  Informational: the worker consults it only for free-preset-gated
   *  presentation/recovery (isFreeLlmPreset — failure copy, and the HTTP-status
   *  transient layer of the free pool's backoff, Copilot r5 M) — it never
   *  affects execution. Absent → agnostic copy. */
  llmConfig?: { baseURL?: string; modelId?: string };
  preferredLanguage?: string;
  qualityPreference?: "high" | "medium";
  /** The run's drive brand ("pan115" | "quark") — selects brand-specific skill. */
  storageProvider?: string;
  /** assrt token (Settings → 字幕来源). Undefined = 字幕流程不触发。 */
  assrtToken?: string;
  /** Optional Jev candidate prefilter, resolved per account from Settings. */
  jevJudge?: JevJudge;
  /** Agent memory on/off, resolved per account from Settings (absent = on). */
  agentMemory?: boolean;
  storageParentDirectoryId?: string;
  animeStorageParentDirectoryId?: string;
  moviesParentDirectoryId?: string;
}

export type ResolveAccountWorkerContext = (
  accountId: string,
  connectedStorageId?: string | null,
) => Promise<AccountWorkerContext>;

export type QueuedType2WorkerResult =
  | {
      status: "idle";
    }
  | {
      status: "ran";
      workflowRunId: string;
      workflowStatus: WorkflowStatus;
    }
  | {
      status: "failed";
      workflowRunId: string;
      errorMessage: string;
    };

function failureReport(
  claimed: PersistedWorkflowRunSnapshot,
  status: "failed" | "retrying",
  lines: string[],
): NotificationReport {
  return {
    titleName: claimed.title.title,
    // A replace_request covers every tracked season of the work and is only recorded
    // on its lowest one (the lock): naming that season would label an S02 request
    // 「第 1 季」. Title-level, like its success report (buildReplacementReport).
    seasonLabel:
      claimed.title.type !== "movie" && claimed.workflowRun.kind !== "replace_request" && claimed.season.seasonNumber
        ? `第 ${claimed.season.seasonNumber} 季`
        : null,
    status,
    lines,
    newlyObtained: [],
    realMissing: [],
    posterPath: claimed.title.posterPath ?? null,
    tmdbId: claimed.title.tmdbId,
    mediaType: claimed.title.type,
    year: claimed.title.year,
  };
}

/** 免费档（isFreeLlmPreset）下 LLM 调用类失败的首行文案。逐字固定（含全角
 *  标点）—— 改动要走设计复核。只在「当前生效配置 == 出厂免费预设 且错误能
 *  明确识别为 LLM 调用失败（限流/鉴权/5xx）」时替换 agnostic 的「获取失败」
 *  首行；自带模型的用户永远看到 agnostic 文案（不点名任何厂商）。 */
export const FREE_LLM_POOL_FAILURE_LINE =
  "AI 模型调用失败：Kilo 公共免费池暂时不可用（限速或服务波动）。可稍后重试，或在 设置 → AI 模型 换成自己的服务。";

/** 免费档下「模型下架」（model not found 类）的首行文案。模型没了重试也不会
 *  好，所以它不是 transient（不退避重排）、直接终止并指引用户换模型。 */
export const FREE_LLM_MODEL_GONE_LINE =
  "内置免费模型已失效（Kilo 池变动）。请到 设置 → AI 模型 换一个模型或换成自己的服务。";

/**
 * 首行失败标题：免费档 + 可明确识别的 LLM 调用失败 → 点名 Kilo 的可操作文案；
 *  其余一切（自带模型、非 LLM 错误、识别不了的）→ 现有 agnostic 文案。口径
 *  保守：分类器（isLlm*Error）都带非-LLM 上游（网盘品牌/PanSou/Prowlarr）短路，
 *  网盘错/搜索源错绝不冒充「Kilo 挂了」。auth(401/403) 也归入「池不可用」：
 *  免费预设不带 key，从 Kilo 回 401/403 只能是池侧访问策略变了，agnostic 的
 *  「检查 API Key」指引对没配过 key 的免费档用户是误导。
 */
function failureHeadline(input: {
  error: unknown;
  llmConfig: { baseURL?: string; modelId?: string } | undefined;
}): string | null {
  if (!isFreeLlmPreset(input.llmConfig ?? {})) {
    return null;
  }
  if (isLlmModelGoneError(input.error)) {
    return FREE_LLM_MODEL_GONE_LINE;
  }
  if (
    isLlmRateLimitError(input.error) ||
    isLlmAuthError(input.error) ||
    isLlmServerError(input.error)
  ) {
    return FREE_LLM_POOL_FAILURE_LINE;
  }
  return null;
}

/**
 * Single failure path for every interactive queued acquisition (type2/series/
 * movie). A TRANSIENT error (network/TLS/socket — see isTransientAcquisitionError)
 * under the retry cap → back to `queued` with backoff (the worker re-claims it
 * after nextAttemptAt) plus a `retrying` notification. Otherwise → terminal
 * `failed` plus a `failed` notification — no longer the old silent `notifications:[]`.
 */
export async function handleWorkflowRunFailure(input: {
  claimed: PersistedWorkflowRunSnapshot;
  error: unknown;
  repository: Pick<WorkflowRepository, "saveWorkflowRunSnapshot">;
  now: () => string;
  /** Freeze the run's connected drive on brand *AuthError (cookie/token dead). */
  onAuthErrorFreeze?: (storageId: string, reason: string) => Promise<void>;
  /** Trigger stamped on the failure/retry notification. Default "user" (individual push).
   *  A patrol-origin replace run passes "scheduled" so its failure joins the daily digest,
   *  matching the success path (stampReplaceNotification). */
  notificationTrigger?: "user" | "scheduled";
  /** The effective LLM config of the model THIS run used (base or per-account
   *  resolver). Consulted ONLY for free-preset-gated presentation/recovery — the
   *  failure copy (isFreeLlmPreset) and the HTTP-status transient layer (429/5xx
   *  backoff is the free pool's recovery strategy, Copilot r5 M); never affects
   *  execution. Absent → agnostic copy + legacy connection-class transient. */
  llmConfig?: { baseURL?: string; modelId?: string };
}): Promise<{ status: "auto_requeued" | "failed"; workflowRunId: string; errorMessage: string }> {
  const { claimed, error, repository } = input;
  const nowIso = input.now();
  // describeAgentRunError maps an LLM auth/401 failure (the agent dying on its
  // first model call when the BYO LLM key is missing/invalid, issue #49) onto
  // actionable, provider-agnostic guidance; every other error keeps its original
  // message. The raw `error` object is untouched, so transient classification +
  // any logging stay accurate.
  const errorMessage = describeAgentRunError(error);
  const priorCount = claimed.workflowRun.autoRequeueCount ?? 0;
  // HTTP 状态类退避（429/5xx）是免费池专属恢复策略（spec：已配置 DB/env 的
  // 用户行为不变）：仅当「当前生效配置 == 出厂免费预设（isFreeLlmPreset）且
  // 错误能明确识别为 LLM 调用失败（agent-error.ts 的 isLlm* 分类器任一命中，
  // 网盘/PanSou/Prowlarr 等非 LLM 上游被短路）」时，才让 transient 判定追加
  // HTTP 状态类匹配。BYO 与非 LLM 的 429/5xx 维持既有保守连接类分类 ——
  // Kilo 免费池的恢复策略不扩大到别人的失败上（Copilot r5 M）。
  const httpStatusClassified =
    isFreeLlmPreset(input.llmConfig ?? {}) &&
    (isLlmModelGoneError(error) ||
      isLlmRateLimitError(error) ||
      isLlmAuthError(error) ||
      isLlmServerError(error));
  const transient = isTransientAcquisitionError(
    error,
    0,
    httpStatusClassified ? { httpStatusClassified: true } : undefined,
  );
  const willRetry = transient && priorCount < AUTO_REQUEUE_MAX;

  // A staging dir that survived the harness cleanup on this failed body rides on
  // the error (attachStagingLeaks). This handler is the ONLY persist path for a
  // failed/requeued run, so the leak is recorded here or nowhere (Copilot #260 r1).
  const leakEvents = stagingFailureAuditEvents(error);
  const claimedRun =
    leakEvents.length === 0
      ? claimed.workflowRun
      : { ...claimed.workflowRun, auditEvents: [...claimed.workflowRun.auditEvents, ...leakEvents] };

  let report: NotificationReport;
  let workflowRun;
  if (willRetry) {
    workflowRun = requeueWorkflowRunForRetry(claimedRun, errorMessage, nowIso);
    const minutes = Math.round((AUTO_REQUEUE_BACKOFF_MS[priorCount] ?? 0) / 60_000);
    // 把真实报因摘要带进「重试中」通知——以前一律「网络波动」把根因藏了,
    // 用户和我们都得翻日志才知道发生了什么(issue #196)。摘要已脱敏+截断,
    // 不会把 cookie/token 泄进推送渠道;原始错误仍在日志/auditEvents 里。
    report = failureReport(claimed, "retrying", [
      `网络波动 · 第 ${priorCount + 1} 次自动重试,约 ${minutes} 分钟后`,
      `原因:${summarizeErrorForNotification(errorMessage)}`,
    ]);
  } else {
    workflowRun = failWorkflowRun(claimedRun, errorMessage, nowIso);
    // 免费档 + 可明确识别的 LLM 调用失败 → 首行换成点名 Kilo 的指引；其余
    // （含重试耗尽的网络中断）保持 agnostic 现状。
    const headline = failureHeadline({ error, llmConfig: input.llmConfig });
    report = failureReport(claimed, "failed", [
      headline ?? (transient ? `网络中断,已自动重试 ${priorCount} 次仍失败` : "获取失败"),
      // Pushed verbatim by formatReportPushText, so the same redaction as the retry
      // line; the raw message stays in the run row (failWorkflowRun) for forensics.
      summarizeErrorForNotification(errorMessage),
    ]);
  }
  const notification: NotificationEvent = {
    id: `notification_${claimed.workflowRun.id}_${willRetry ? `retry${priorCount + 1}` : "failed"}`,
    workflowRunId: claimed.workflowRun.id,
    kind: claimed.workflowRun.kind,
    title: claimed.title.title,
    body: formatReportPushText(report),
    createdAt: nowIso,
    trigger: input.notificationTrigger ?? "user",
    report,
  };
  // One stdout line per failure (console.log — stdout, beside the worker's other
  // lines). Without it the only trace is the run row, which a user retry/cancel
  // deletes — the 《出入平安》 timeout cause (2026-09-24) had to be dug out of dead
  // Postgres heap tuples. Same redaction as the push line.
  // Emitted BEFORE persistence: if the save below rejects, this line is the only record.
  console.log(
    `[workflow] run ${claimed.workflowRun.id} ${claimed.workflowRun.kind} ${willRetry ? "auto_requeued" : "failed"}` +
      ` (storage ${claimed.connectedStorageId ?? "-"}): ${summarizeErrorForNotification(errorMessage)}`,
  );
  // saveWorkflowRunSnapshot DELETES the season's episode bucket then re-inserts
  // only what we pass. The two branches need OPPOSITE handling:
  //  - auto-requeue: the run is going BACK to queued (still in flight) → preserve
  //    the claimed snapshot's children, else a TV/series run loses its reserved
  //    episode bucket mid-retry (Copilot review #1).
  //  - terminal failure: a failed Type 2 init intentionally clears its initial
  //    episode state so a fresh, never-acquired season doesn't linger as tracked
  //    (see worker.test "clears initial episode state when the agent model dies").
  //    A replace_request is the exception: it runs on a library that already has
  //    files, and a failed replace must leave that library exactly as it was.
  // A staging recovery runs on a library that already has files, and its failure
  // is not the user's problem: write no notification, and do not touch the
  // episode bucket. The claimed copy is from queue time on InMemory, and a user
  // run is allowed to mark episodes while this recovery sits queued.
  const silent = claimed.workflowRun.kind === "staging_recovery";
  const keepEpisodes = willRetry || claimed.workflowRun.kind === "replace_request";
  await repository.saveWorkflowRunSnapshot({
    accountId: claimed.accountId,
    connectedStorageId: claimed.connectedStorageId,
    title: claimed.title,
    season: claimed.season,
    workflowRun,
    episodes: keepEpisodes ? claimed.episodes : [],
    resourceSnapshots: willRetry ? claimed.resourceSnapshots : [],
    decisions: willRetry ? claimed.decisions : [],
    transferAttempts: willRetry ? claimed.transferAttempts : [],
    notifications: silent ? [] : [notification],
    ...(silent ? { keepCurrentEpisodes: true } : {}),
  });
  // Brand auth (dead cookie/token) — freeze the drive so the queue refuses more
  // work until re-bound. LLM Unauthorized is NOT a brand AuthError; only the
  // five *AuthError classes trigger this. Failures in the freeze hook are log-only.
  await maybeFreezeOnBrandAuthError({
    connectedStorageId: claimed.connectedStorageId,
    error,
    ...(input.onAuthErrorFreeze === undefined ? {} : { onAuthErrorFreeze: input.onAuthErrorFreeze }),
  });
  return {
    status: willRetry ? "auto_requeued" : "failed",
    workflowRunId: claimed.workflowRun.id,
    errorMessage,
  };
}

export async function runQueuedType2Workflow(input: {
  repository: WorkflowRepository;
  resourceProvider: ResourceProvider;
  storage: StorageExecutor;
  model: LanguageModel;
  /** Config that built `model` (failure-copy only — see AccountWorkerContext.llmConfig). */
  llmConfig?: { baseURL?: string; modelId?: string };
  preferredLanguage?: string;
  qualityPreference?: "high" | "medium";
  now?: () => string;
  storageParentDirectoryId?: string;
  /** Separate landing parent for anime (see runQueuedSeriesInitialization). */
  animeStorageParentDirectoryId?: string;
  /** §7: resolve the claimed run's per-account 115 creds + landing CIDs. */
  resolveAccountContext?: ResolveAccountWorkerContext;
  onAuthErrorFreeze?: (storageId: string, reason: string) => Promise<void>;
  mayStartRun?: MayStartRun;
  /** The worker's drive filter and claim callback when queued runs go side by side. */
  claim?: QueueClaimOptions;
}): Promise<QueuedType2WorkerResult> {
  const now = input.now ?? (() => new Date().toISOString());
  if (input.mayStartRun && !input.mayStartRun()) {
    return { status: "idle" };
  }
  const claimed = await claimNextQueuedRun(input.repository, "type2_init", now(), input.claim);
  if (!claimed) {
    return { status: "idle" };
  }
  // The config of the model this run ENDED UP using (per-account resolver may
  // override the base) — captured for the failure handler's free-tier copy.
  let resolvedLlmConfig: { baseURL?: string; modelId?: string } | undefined;
  // Inside the try: a throw here (drive gone, settings cleared, a DB blip) must end the
  // claimed run through the failure handler, not leave it "running".
  try {
    const deps = await resolveWorkerDeps(
      input.resolveAccountContext,
      claimed.accountId,
      claimed.connectedStorageId,
      input,
    );
    resolvedLlmConfig = deps.llmConfig;
    const result = await runType2InitializationV2AndPersist({
      title: claimed.title,
      season: claimed.season,
      categoryParentId: requireCategoryParent(
        storageParentForTitle(
          claimed.title,
          deps.storageParentDirectoryId,
          deps.animeStorageParentDirectoryId,
        ),
      ),
      resourceProvider: deps.resourceProvider,
      storage: deps.storage,
      model: deps.model,
      repository: input.repository,
      accountId: claimed.accountId,
      connectedStorageId: claimed.connectedStorageId,
      ...(deps.preferredLanguage === undefined
        ? {}
        : { preferredLanguage: deps.preferredLanguage }),
      ...(deps.qualityPreference === undefined
        ? {}
        : { qualityPreference: deps.qualityPreference }),
      ...(deps.storageProvider === undefined
        ? {}
        : { storageProvider: deps.storageProvider }),
      ...(deps.assrtToken === undefined
        ? {}
        : { assrtToken: deps.assrtToken }),
      ...(deps.jevJudge === undefined
        ? {}
        : { jevJudge: deps.jevJudge }),
      ...(deps.agentMemory === undefined
        ? {}
        : { agentMemory: deps.agentMemory }),
      // finishedAt is stamped post-run inside the persist step (see runner-v2),
      // so it reflects actual completion, not the claim time.
      workflowRun: {
        id: claimed.workflowRun.id,
        startedAt: claimed.workflowRun.startedAt,
        finishedAt: null,
      },
      now,
    });

    return {
      status: "ran",
      workflowRunId: claimed.workflowRun.id,
      workflowStatus: result.status,
    };
  } catch (error) {
    const handled = await handleWorkflowRunFailure({
      claimed,
      error,
      repository: input.repository,
      now,
      ...(resolvedLlmConfig === undefined ? {} : { llmConfig: resolvedLlmConfig }),
      ...(input.onAuthErrorFreeze === undefined
        ? {}
        : { onAuthErrorFreeze: input.onAuthErrorFreeze }),
    });
    return handled.status === "auto_requeued"
      ? { status: "ran", workflowRunId: handled.workflowRunId, workflowStatus: "queued" }
      : { status: "failed", workflowRunId: handled.workflowRunId, errorMessage: handled.errorMessage };
  }
}

export type ScheduledType3Outcome =
  | {
      trackedSeasonId: string;
      status: "skipped_active";
    }
  | {
      /** Untracked after the sweep read it: nothing was written, nothing ran. */
      trackedSeasonId: string;
      status: "skipped_untracked";
    }
  | {
      trackedSeasonId: string;
      status: "ran";
      workflowRunId: string;
      workflowStatus: WorkflowStatus;
    }
  | {
      trackedSeasonId: string;
      status: "failed";
      workflowRunId: string;
      errorMessage: string;
    };

/**
 * Unattended Type 3 sweep: one reservation-guarded monitoring run per active
 * tracked season. One season's failure never blocks the rest, and a failed
 * run preserves the season's episode state (unlike a failed Type 2 init,
 * which clears it).
 */
export async function runScheduledType3Monitoring(input: {
  repository: WorkflowRepository;
  resourceProvider: ResourceProvider;
  storage: StorageExecutor;
  model: LanguageModel;
  preferredLanguage?: string;
  qualityPreference?: "high" | "medium";
  storageParentDirectoryId: string;
  /** Separate landing parent for anime, so anime patrol verify-or-creates under
   *  its own tree (see runQueuedSeriesInitialization). */
  animeStorageParentDirectoryId?: string;
  /** Movies category parent. When set, the sweep also patrols tracked-but-
   *  unobtained films, dispatching the MOVIE agent (by title.type) — 已上映无源
   *  films get retried until covered. Unset → movies are left alone. */
  moviesParentDirectoryId?: string;
  now?: () => string;
  createWorkflowRunId?: () => string;
  staleActiveRunTimeoutMs?: number;
  syncSeasonMetadata?: SeasonMetadataSync;
  /** §7: resolve each patrolled season's per-account 115 creds + landing CIDs.
   *  The sweep is cross-account; each show runs under its owner's credentials. */
  resolveAccountContext?: ResolveAccountWorkerContext;
  onAuthErrorFreeze?: (storageId: string, reason: string) => Promise<void>;
  /** How many shows the sweep works on at once (default 1 = one after another).
   *  Never two on the same drive — see runKeyedPool. */
  maxConcurrentRuns?: number;
  /** The drive an account's unbound shows land on (its default drive). Used only
   *  to keep those shows off the same drive as its bound ones when running in
   *  parallel; null when the account has no drive. */
  resolveDriveId?: (accountId: string) => Promise<string | null>;
  /** Checked before each show's run is reserved; a false stops the rest of the sweep
   *  from starting (those shows are reported skipped_active). */
  mayStartRun?: MayStartRun;
}): Promise<ScheduledType3Outcome[]> {
  const now = input.now ?? (() => new Date().toISOString());
  // Cross-account: patrol EVERY user's tracked shows, each under its owner's creds.
  const trackedStates = await input.repository.listAllTrackedSeasonStates();

  // Works with a user message or an unfinished replacement run as ONE replace_request
  // (it covers every season and includes the gaps), so this sweep skips their seasons.
  // Queued, not run here: the queue worker claims it right after the sweep.
  const workKey = (w: UserMessageScope) => JSON.stringify([w.accountId, w.drive, w.titleKey]);
  const requestWorks = [
    ...(await input.repository.listWorksWithPendingMessages({ urgentOnly: false })),
    ...(await input.repository.listWorksWithPendingReplacements()),
  ];
  const requestKeys = new Set(requestWorks.map(workKey));

  // The drive a show runs on: its bound drive, else its account's default drive (null:
  // no drive at all → the process-wide fallback executor). One lookup per account.
  const defaultDrives = new Map<string, Promise<string | null>>();
  const defaultDriveOf = (accountId: string) => {
    let drive = defaultDrives.get(accountId);
    if (!drive) {
      drive = input.resolveDriveId ? input.resolveDriveId(accountId) : Promise.resolve(null);
      defaultDrives.set(accountId, drive);
    }
    return drive;
  };
  // A frozen drive's login is dead: every call on it fails until the drive is re-bound.
  // Its shows and requests wait untouched (no run, no call to the drive) and are
  // patrolled again once the drive is active.
  const frozenDrives = new Set<string>();
  for (const accountId of new Set([...trackedStates, ...requestWorks].map((item) => item.accountId))) {
    for (const storage of await input.repository.listConnectedStorages(accountId)) {
      if (storage.status === "frozen") frozenDrives.add(storage.id);
    }
  }
  const skippedOnFrozen = new Map<string, number>();
  const onFrozenDrive = async (accountId: string, connectedStorageId: string | null) => {
    const drive = connectedStorageId ?? (await defaultDriveOf(accountId));
    if (drive === null || !frozenDrives.has(drive)) return false;
    skippedOnFrozen.set(drive, (skippedOnFrozen.get(drive) ?? 0) + 1);
    return true;
  };

  for (const key of requestKeys) {
    const [accountId, drive, titleKey] = JSON.parse(key) as [string, string, string];
    // Still in requestKeys, so the ordinary patrol leaves the work alone too.
    if (await onFrozenDrive(accountId, drive === "" ? null : drive)) continue;
    try {
      await queueReplaceRequest({ repository: input.repository, work: { accountId, drive, titleKey }, now, origin: "patrol" });
    } catch (error) {
      // One work's queueing failure must not abort the whole sweep; the next sweep retries it.
      console.error(`[user-message] patrol could not queue a replace request for ${titleKey}: ${String(error)}`);
    }
  }
  // Also skip a title whose replace run or leftover recovery is already active.
  // Patrols run outside the queue drain, so either would move files in the same
  // directories at the same time. This filter is only the cheap path; a run queued
  // after it is caught by the patrol reservation (blockIfTitleHasActiveKinds).
  // The janitor will not queue a recovery while any run of the title is active,
  // so the exclusion holds both ways.
  const busyKeys = new Set((await input.repository.listWorksWithProcessingMessages()).map(workKey));
  for (const accountId of new Set(trackedStates.map((s) => s.accountId))) {
    for (const run of await input.repository.listActiveWorkflowRuns({ accountId, connectedStorageId: null })) {
      if (run.workflowRun.kind !== "replace_request" && run.workflowRun.kind !== "staging_recovery") continue;
      busyKeys.add(workKey({ accountId, drive: userMessageDrive(run.connectedStorageId), titleKey: run.title.id }));
    }
  }
  const patrolStates: typeof trackedStates = [];
  for (const s of trackedStates) {
    const key = workKey({ accountId: s.accountId, drive: userMessageDrive(s.connectedStorageId), titleKey: s.title.id });
    if (requestKeys.has(key) || busyKeys.has(key)) continue;
    if (await onFrozenDrive(s.accountId, s.connectedStorageId)) continue;
    patrolStates.push(s);
  }
  for (const [drive, count] of skippedOnFrozen) {
    console.log(`[patrol] drive ${drive} is frozen (login expired): skipped ${count} item(s) until it is re-bound`);
  }

  // One drive at a time, several drives side by side (see runKeyedPool). The key
  // is the drive the run will actually land on: a state with no bound drive runs
  // on its account's default drive, so it must share that drive's key, not get
  // one of its own.
  const concurrency = input.maxConcurrentRuns ?? 1;
  const driveKeys =
    concurrency > 1
      ? await Promise.all(
          patrolStates.map(async (state) => {
            const drive = state.connectedStorageId ?? (await defaultDriveOf(state.accountId));
            // No drive at all → the process-wide fallback executor (env cookie / fake),
            // which every such account shares: one key for all of them.
            return drive ?? "no-connected-drive";
          }),
        )
      : [];
  const keyByState = new Map(patrolStates.map((state, index) => [state, driveKeys[index] ?? ""]));
  // A throw from one state's setup (drive client, DB reservation) is an infra
  // failure: it aborts the sweep as the serial loop did, so the caller can release
  // today's claimed slots and retry. Failures inside a run are outcomes, not throws.
  const perState = await runKeyedPool(
    patrolStates,
    { concurrency, keyOf: (state) => keyByState.get(state)! },
    (state) => patrolTrackedState({ input, state, now }),
  );
  return perState.filter((outcome): outcome is ScheduledType3Outcome => outcome !== null);
}

type ScheduledType3Input = Parameters<typeof runScheduledType3Monitoring>[0];

/** One tracked state's patrol; null when there is nothing to do for it. */
async function patrolTrackedState(args: {
  input: ScheduledType3Input;
  state: Awaited<ReturnType<WorkflowRepository["listAllTrackedSeasonStates"]>>[number];
  now: () => string;
}): Promise<ScheduledType3Outcome | null> {
  const { input, state, now } = args;
  {
    const deps = await resolveWorkerDeps(
      input.resolveAccountContext,
      state.accountId,
      state.connectedStorageId,
      input,
    );
    // Patrol dispatches by title.type: a film needs the MOVIE agent, not the
    // TV/anime agent (different semantics). (未上映/reserved films aren't tracked
    // yet; the air-time gate lands with that product state.)
    if (state.title.type === "movie") {
      return (await patrolMovie({ input, deps, state, now })) ?? null;
    }

    if (state.season.status !== "active" || state.episodes.length === 0) {
      return null;
    }

    // sync_all equivalent: refresh aired/total from TMDB so episodes that aired
    // after tracking began surface as real gaps this sweep can acquire.
    let season = state.season;
    let episodes = state.episodes;
    if (input.syncSeasonMetadata) {
      try {
        const meta = await input.syncSeasonMetadata({
          tmdbId: state.title.tmdbId,
          seasonNumber: state.season.seasonNumber,
        });
        if (meta) {
          const synced = syncSeasonAgainstMetadata({
            season,
            episodes,
            latestAiredEpisode: meta.latestAiredEpisode,
            totalEpisodes: meta.totalEpisodes,
          });
          season = synced.season;
          episodes = synced.episodes;
        }
      } catch (error) {
        console.warn(
          `[patrol] metadata sync failed tmdbId=${state.title.tmdbId} season=${state.season.seasonNumber}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const workflowRunId = input.createWorkflowRunId?.() ?? crypto.randomUUID();
    const startedAt = now();
    const staleActiveRunStartedBefore = staleStartedBefore(
      startedAt,
      input.staleActiveRunTimeoutMs,
    );

    if (input.mayStartRun && !input.mayStartRun()) {
      return { trackedSeasonId: season.id, status: "skipped_active" };
    }
    const reservation = await input.repository.reserveWorkflowRun({
      accountId: state.accountId,
      connectedStorageId: state.connectedStorageId,
      title: state.title,
      season,
      workflowRun: {
        id: workflowRunId,
        kind: "type3_monitor",
        status: "running",
        trackedSeasonId: season.id,
        startedAt,
        finishedAt: null,
        auditEvents: [
          {
            type: "type3_scheduled",
            message: "Scheduled Type 3 monitoring reserved",
          },
        ],
      },
      episodes,
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
      // Patrols run outside the queue drain. A replace, or a leftover recovery the
      // drain can claim mid-patrol, moves files in the same directories. The
      // janitor will not queue a recovery while this patrol is active, so the
      // exclusion holds both ways.
      blockIfTitleHasActiveKinds: ["replace_request", "staging_recovery"],
      // The state was read when the sweep started (then the drive's deps, a TMDB sync):
      // a season untracked since must not be tracked again by this reservation.
      requireTrackedSeason: true,
      ...(staleActiveRunStartedBefore === null
        ? {}
        : { staleActiveRunStartedBefore, staleFinishedAt: startedAt }),
    });
    if (reservation.status === "not_tracked") {
      return { trackedSeasonId: season.id, status: "skipped_untracked" };
    }
    if (reservation.status !== "reserved") {
      return { trackedSeasonId: season.id, status: "skipped_active" };
    }

    try {
      const result = await runType3MonitoringV2AndPersist({
        title: state.title,
        season,
        episodes,
        categoryParentId: requireCategoryParent(
          storageParentForTitle(
            state.title,
            deps.storageParentDirectoryId,
            deps.animeStorageParentDirectoryId,
          ),
        ),
        resourceProvider: deps.resourceProvider,
        storage: deps.storage,
        model: deps.model,
        repository: input.repository,
        accountId: state.accountId,
        connectedStorageId: state.connectedStorageId,
        ...(deps.preferredLanguage === undefined
          ? {}
          : { preferredLanguage: deps.preferredLanguage }),
        ...(deps.qualityPreference === undefined
          ? {}
          : { qualityPreference: deps.qualityPreference }),
        ...(deps.storageProvider === undefined
          ? {}
          : { storageProvider: deps.storageProvider }),
        ...(deps.assrtToken === undefined
          ? {}
          : { assrtToken: deps.assrtToken }),
        ...(deps.jevJudge === undefined
          ? {}
          : { jevJudge: deps.jevJudge }),
        ...(deps.agentMemory === undefined
          ? {}
          : { agentMemory: deps.agentMemory }),
        workflowRun: { id: workflowRunId, startedAt, finishedAt: null },
        now,
      });
      return {
        trackedSeasonId: state.season.id,
        status: "ran",
        workflowRunId,
        workflowStatus: result.status,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Workflow failed";
      await input.repository.saveWorkflowRunSnapshot({
        accountId: state.accountId,
        connectedStorageId: state.connectedStorageId,
        title: state.title,
        season: state.season,
        workflowRun: {
          id: workflowRunId,
          kind: "type3_monitor",
          status: "failed",
          trackedSeasonId: state.season.id,
          startedAt,
          finishedAt: now(),
          auditEvents: [
            {
              type: "type3_scheduled",
              message: "Scheduled Type 3 monitoring reserved",
            },
            ...stagingFailureAuditEvents(error),
            { type: "workflow_failed", message: errorMessage },
          ],
        },
        episodes: state.episodes,
        resourceSnapshots: [],
        decisions: [],
        transferAttempts: [],
        notifications: [],
      });
      await maybeFreezeOnBrandAuthError({
        connectedStorageId: state.connectedStorageId,
        error,
        ...(input.onAuthErrorFreeze === undefined
          ? {}
          : { onAuthErrorFreeze: input.onAuthErrorFreeze }),
      });
      return {
        trackedSeasonId: state.season.id,
        status: "failed",
        workflowRunId,
        errorMessage,
      };
    }
  }
}

/**
 * Patrol one tracked film: a 已上映无源 movie (anchor episode not obtained) is
 * retried by the MOVIE agent. Returns null when nothing to do (already obtained,
 * or no movies parent configured). A reservation guards against a concurrent run.
 */
async function patrolMovie(args: {
  input: {
    repository: WorkflowRepository;
    createWorkflowRunId?: () => string;
    staleActiveRunTimeoutMs?: number;
    onAuthErrorFreeze?: (storageId: string, reason: string) => Promise<void>;
    mayStartRun?: MayStartRun;
  };
  deps: {
    resourceProvider: ResourceProvider;
    storage: StorageExecutor;
    model: LanguageModel;
    preferredLanguage: string | undefined;
    qualityPreference: "high" | "medium" | undefined;
    storageProvider: string | undefined;
    assrtToken: string | undefined;
    jevJudge: JevJudge | undefined;
    agentMemory: boolean | undefined;
    moviesParentDirectoryId: string | undefined;
  };
  state: {
    accountId: string;
    connectedStorageId: string | null;
    title: MediaTitle;
    season: TrackedSeason;
    episodes: EpisodeState[];
  };
  now: () => string;
}): Promise<ScheduledType3Outcome | null> {
  const { input, deps, state, now } = args;
  const moviesParent = deps.moviesParentDirectoryId;
  if (moviesParent === undefined) {
    return null;
  }
  const obtained = state.episodes.some((episode) => episode.obtained);
  if (obtained) {
    return null;
  }
  // Air-time gate: a reserved (未上映) film whose release date is still in the
  // future stays reserved — the agent must NOT run before release. Once the date
  // arrives this gate opens and the patrol collects it (点预定 → 上映后自然收).
  if (isMovieUnreleased(state.title.releaseDate, now())) {
    return null;
  }

  const workflowRunId = input.createWorkflowRunId?.() ?? crypto.randomUUID();
  const startedAt = now();
  const staleActiveRunStartedBefore = staleStartedBefore(
    startedAt,
    input.staleActiveRunTimeoutMs,
  );
  if (input.mayStartRun && !input.mayStartRun()) {
    return { trackedSeasonId: state.season.id, status: "skipped_active" };
  }
  const reservation = await input.repository.reserveWorkflowRun({
    accountId: state.accountId,
    connectedStorageId: state.connectedStorageId,
    title: state.title,
    season: state.season,
    workflowRun: {
      id: workflowRunId,
      kind: "movie_init",
      status: "running",
      trackedSeasonId: state.season.id,
      startedAt,
      finishedAt: null,
      auditEvents: [
        {
          type: "movie_patrol_scheduled",
          message: "Scheduled movie patrol reserved",
        },
      ],
    },
    episodes: state.episodes,
    resourceSnapshots: [],
    decisions: [],
    transferAttempts: [],
    notifications: [],
    // Same as the TV patrol: a replace or a leftover recovery queued after the filter.
    blockIfTitleHasActiveKinds: ["replace_request", "staging_recovery"],
    // …and an untrack after the sweep read the film.
    requireTrackedSeason: true,
    ...(staleActiveRunStartedBefore === null
      ? {}
      : { staleActiveRunStartedBefore, staleFinishedAt: startedAt }),
  });
  if (reservation.status === "not_tracked") {
    return { trackedSeasonId: state.season.id, status: "skipped_untracked" };
  }
  if (reservation.status !== "reserved") {
    return { trackedSeasonId: state.season.id, status: "skipped_active" };
  }

  try {
    const result = await runMovieAcquisitionV2AndPersist({
      title: state.title,
      categoryParentId: moviesParent,
      resourceProvider: deps.resourceProvider,
      storage: deps.storage,
      model: deps.model,
      repository: input.repository,
      accountId: state.accountId,
      connectedStorageId: state.connectedStorageId,
      ...(deps.preferredLanguage === undefined
        ? {}
        : { preferredLanguage: deps.preferredLanguage }),
      ...(deps.qualityPreference === undefined
        ? {}
        : { qualityPreference: deps.qualityPreference }),
      ...(deps.storageProvider === undefined
        ? {}
        : { storageProvider: deps.storageProvider }),
      ...(deps.assrtToken === undefined
        ? {}
        : { assrtToken: deps.assrtToken }),
      ...(deps.jevJudge === undefined
        ? {}
        : { jevJudge: deps.jevJudge }),
      ...(deps.agentMemory === undefined
        ? {}
        : { agentMemory: deps.agentMemory }),
      // Reported in the sweep's daily digest, like the shows, not pushed on its own.
      notice: { trigger: "scheduled", routineIfNothingReplaced: false },
      workflowRun: { id: workflowRunId, startedAt, finishedAt: null },
      now,
    });
    return {
      trackedSeasonId: state.season.id,
      status: "ran",
      workflowRunId,
      workflowStatus: result.status,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Workflow failed";
    await input.repository.saveWorkflowRunSnapshot({
      accountId: state.accountId,
      connectedStorageId: state.connectedStorageId,
      title: state.title,
      season: state.season,
      workflowRun: {
        id: workflowRunId,
        kind: "movie_init",
        status: "failed",
        trackedSeasonId: state.season.id,
        startedAt,
        finishedAt: now(),
        auditEvents: [
          {
            type: "movie_patrol_scheduled",
            message: "Scheduled movie patrol reserved",
          },
          ...stagingFailureAuditEvents(error),
          { type: "workflow_failed", message: errorMessage },
        ],
      },
      episodes: state.episodes,
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });
    await maybeFreezeOnBrandAuthError({
      connectedStorageId: state.connectedStorageId,
      error,
      ...(input.onAuthErrorFreeze === undefined
        ? {}
        : { onAuthErrorFreeze: input.onAuthErrorFreeze }),
    });
    return {
      trackedSeasonId: state.season.id,
      status: "failed",
      workflowRunId,
      errorMessage,
    };
  }
}

function staleStartedBefore(
  nowIso: string,
  timeoutMs: number | undefined,
): string | null {
  if (timeoutMs === undefined) {
    return null;
  }
  if (timeoutMs <= 0) {
    throw new Error("staleActiveRunTimeoutMs must be positive");
  }
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(nowMs)) {
    throw new Error(`Invalid now timestamp: ${nowIso}`);
  }
  return new Date(nowMs - timeoutMs).toISOString();
}

/**
 * The V2 directory lifecycle must verify-or-create the library category parent
 * (Movies/TV/Anime); a missing parent is a misconfiguration, not a silent
 * account-root fallback (fail loud — see acquisition-hard-details).
 */
export function requireCategoryParent(parent: string | undefined): string {
  if (parent === undefined || parent === "") {
    throw new Error(
      "MEDIA_TRACK_CATEGORY_PARENT_REQUIRED: a library category parent (Movies/TV/Anime) is required for directory verify-or-create",
    );
  }
  return parent;
}

export async function runQueuedMovieAcquisition(input: {
  repository: WorkflowRepository;
  resourceProvider: ResourceProvider;
  storage: StorageExecutor;
  model: LanguageModel;
  /** Config that built `model` (failure-copy only — see AccountWorkerContext.llmConfig). */
  llmConfig?: { baseURL?: string; modelId?: string };
  preferredLanguage?: string;
  qualityPreference?: "high" | "medium";
  moviesParentDirectoryId: string;
  now?: () => string;
  /** §7: resolve the claimed run's per-account 115 creds + landing CIDs. */
  resolveAccountContext?: ResolveAccountWorkerContext;
  onAuthErrorFreeze?: (storageId: string, reason: string) => Promise<void>;
  mayStartRun?: MayStartRun;
  /** The worker's drive filter and claim callback when queued runs go side by side. */
  claim?: QueueClaimOptions;
}): Promise<QueuedType2WorkerResult> {
  const now = input.now ?? (() => new Date().toISOString());
  if (input.mayStartRun && !input.mayStartRun()) {
    return { status: "idle" };
  }
  const claimed = await claimNextQueuedRun(input.repository, "movie_init", now(), input.claim);
  if (!claimed) {
    return { status: "idle" };
  }
  // As in runQueuedType2Workflow: the config of the model this run ended up using.
  let resolvedLlmConfig: { baseURL?: string; modelId?: string } | undefined;
  // Inside the try: a throw here (drive gone, settings cleared, a DB blip) must end the
  // claimed run through the failure handler, not leave it "running".
  try {
    const deps = await resolveWorkerDeps(
      input.resolveAccountContext,
      claimed.accountId,
      claimed.connectedStorageId,
      input,
    );
    resolvedLlmConfig = deps.llmConfig;
    const result = await runMovieAcquisitionV2AndPersist({
      title: claimed.title,
      categoryParentId:
        deps.moviesParentDirectoryId ?? input.moviesParentDirectoryId,
      resourceProvider: deps.resourceProvider,
      storage: deps.storage,
      model: deps.model,
      repository: input.repository,
      accountId: claimed.accountId,
      connectedStorageId: claimed.connectedStorageId,
      ...(deps.preferredLanguage === undefined
        ? {}
        : { preferredLanguage: deps.preferredLanguage }),
      ...(deps.qualityPreference === undefined
        ? {}
        : { qualityPreference: deps.qualityPreference }),
      ...(deps.storageProvider === undefined
        ? {}
        : { storageProvider: deps.storageProvider }),
      ...(deps.assrtToken === undefined
        ? {}
        : { assrtToken: deps.assrtToken }),
      ...(deps.jevJudge === undefined
        ? {}
        : { jevJudge: deps.jevJudge }),
      ...(deps.agentMemory === undefined
        ? {}
        : { agentMemory: deps.agentMemory }),
      workflowRun: {
        id: claimed.workflowRun.id,
        startedAt: claimed.workflowRun.startedAt,
        finishedAt: null,
      },
      now,
    });
    return {
      status: "ran",
      workflowRunId: claimed.workflowRun.id,
      workflowStatus: result.status,
    };
  } catch (error) {
    const handled = await handleWorkflowRunFailure({
      claimed,
      error,
      repository: input.repository,
      now,
      ...(resolvedLlmConfig === undefined ? {} : { llmConfig: resolvedLlmConfig }),
      ...(input.onAuthErrorFreeze === undefined
        ? {}
        : { onAuthErrorFreeze: input.onAuthErrorFreeze }),
    });
    return handled.status === "auto_requeued"
      ? { status: "ran", workflowRunId: handled.workflowRunId, workflowStatus: "queued" }
      : { status: "failed", workflowRunId: handled.workflowRunId, errorMessage: handled.errorMessage };
  }
}

export async function runQueuedSeriesInitialization(input: {
  repository: WorkflowRepository;
  resourceProvider: ResourceProvider;
  storage: StorageExecutor;
  model: LanguageModel;
  /** Config that built `model` (failure-copy only — see AccountWorkerContext.llmConfig). */
  llmConfig?: { baseURL?: string; modelId?: string };
  preferredLanguage?: string;
  qualityPreference?: "high" | "medium";
  storageParentDirectoryId: string;
  /** Separate landing parent for anime, so the 动漫 shelf is physically its own
   *  tree on 115 and never mixed into the TV shows directory. */
  animeStorageParentDirectoryId?: string;
  now?: () => string;
  /** §7: resolve the claimed run's per-account 115 creds + landing CIDs. */
  resolveAccountContext?: ResolveAccountWorkerContext;
  onAuthErrorFreeze?: (storageId: string, reason: string) => Promise<void>;
  mayStartRun?: MayStartRun;
  /** The worker's drive filter and claim callback when queued runs go side by side. */
  claim?: QueueClaimOptions;
}): Promise<QueuedType2WorkerResult> {
  const now = input.now ?? (() => new Date().toISOString());
  if (input.mayStartRun && !input.mayStartRun()) {
    return { status: "idle" };
  }
  const claimed = await claimNextQueuedRun(input.repository, "type1_package_init", now(), input.claim);
  if (!claimed) {
    return { status: "idle" };
  }
  const queuedEvent = claimed.workflowRun.auditEvents.find(
    (event) => event.type === "series_init_queued",
  );
  const seasons = (queuedEvent?.data?.["seasons"] ??
    []) as AcquisitionSeasonScope[];

  // As in runQueuedType2Workflow: the config of the model this run ended up using.
  let resolvedLlmConfig: { baseURL?: string; modelId?: string } | undefined;
  // Inside the try, as in the other queued runners.
  try {
    const deps = await resolveWorkerDeps(
      input.resolveAccountContext,
      claimed.accountId,
      claimed.connectedStorageId,
      input,
    );
    resolvedLlmConfig = deps.llmConfig;
    if (seasons.length === 0) {
      throw new Error(
        "Queued series initialization run is missing its season metadata",
      );
    }
    const result = await runSeriesInitializationV2AndPersist({
      title: claimed.title,
      seasons,
      categoryParentId: requireCategoryParent(
        storageParentForTitle(
          claimed.title,
          deps.storageParentDirectoryId,
          deps.animeStorageParentDirectoryId,
        ),
      ),
      seasonQualityRecord: claimed.season.qualityPreference,
      resourceProvider: deps.resourceProvider,
      storage: deps.storage,
      model: deps.model,
      repository: input.repository,
      accountId: claimed.accountId,
      connectedStorageId: claimed.connectedStorageId,
      ...(deps.preferredLanguage === undefined
        ? {}
        : { preferredLanguage: deps.preferredLanguage }),
      ...(deps.qualityPreference === undefined
        ? {}
        : { qualityPreference: deps.qualityPreference }),
      ...(deps.storageProvider === undefined
        ? {}
        : { storageProvider: deps.storageProvider }),
      ...(deps.assrtToken === undefined
        ? {}
        : { assrtToken: deps.assrtToken }),
      ...(deps.jevJudge === undefined
        ? {}
        : { jevJudge: deps.jevJudge }),
      ...(deps.agentMemory === undefined
        ? {}
        : { agentMemory: deps.agentMemory }),
      workflowRun: {
        id: claimed.workflowRun.id,
        startedAt: claimed.workflowRun.startedAt,
        finishedAt: null,
      },
      now,
    });
    // Finalize the claimed lock run itself; it doubles as season 1's summary
    // record (same tracked season and episode state as the persisted _s1 run).
    const firstSeason = result.seasons[0];
    await input.repository.saveWorkflowRunSnapshot({
      accountId: claimed.accountId,
      connectedStorageId: claimed.connectedStorageId,
      title: claimed.title,
      season: firstSeason?.season ?? claimed.season,
      workflowRun: {
        ...claimed.workflowRun,
        status: result.status,
        finishedAt: now(),
        auditEvents: [
          ...claimed.workflowRun.auditEvents,
          ...result.auditEvents,
        ],
      },
      episodes: firstSeason?.episodes ?? [],
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });
    return {
      status: "ran",
      workflowRunId: claimed.workflowRun.id,
      workflowStatus: result.status,
    };
  } catch (error) {
    const handled = await handleWorkflowRunFailure({
      claimed,
      error,
      repository: input.repository,
      now,
      ...(resolvedLlmConfig === undefined ? {} : { llmConfig: resolvedLlmConfig }),
      ...(input.onAuthErrorFreeze === undefined
        ? {}
        : { onAuthErrorFreeze: input.onAuthErrorFreeze }),
    });
    return handled.status === "auto_requeued"
      ? { status: "ran", workflowRunId: handled.workflowRunId, workflowStatus: "queued" }
      : { status: "failed", workflowRunId: handled.workflowRunId, errorMessage: handled.errorMessage };
  }
}
