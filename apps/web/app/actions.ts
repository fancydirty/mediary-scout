"use server";

import { revalidatePath } from "next/cache";
import { queueCandidateSeries, queueCandidateTracking, reserveCandidate } from "../lib/workflow-runtime";
import { assertNotDemo } from "../lib/demo-mode";

export interface TestStorageConnectionResult {
  ok: boolean;
  status: "active" | "frozen";
  message: string;
}

/** Settings "测试连接": probe a drive's cookie. A dead cookie freezes the drive
 *  (no acquisition/patrol until re-bound); a healthy one reactivates it. */
export async function testStorageConnectionAction(
  storageId: string,
): Promise<TestStorageConnectionResult> {
  assertNotDemo();
  const { testConnection, getCurrentAccountId } = await import("../lib/workflow-runtime");
  const result = await testConnection(await getCurrentAccountId(), storageId);
  revalidatePath("/settings");
  return result;
}

export interface UnbindStorageActionResult {
  ok: boolean;
  message: string;
}

/** Settings「取消绑定」: hard-remove the drive from the account (frees the physical
 *  drive + drops its cookie), keeping tracking data so re-binding the same drive
 *  restores it. Refused while the drive has an in-flight acquisition. */
export async function unbindStorageAction(storageId: string): Promise<UnbindStorageActionResult> {
  assertNotDemo();
  const { getCurrentAccountId, getWorkflowRepository } = await import("../lib/workflow-runtime");
  const accountId = await getCurrentAccountId();
  const repository = getWorkflowRepository();

  // Ownership: only a drive this account owns can be unbound.
  const drives = await repository.listConnectedStorages(accountId);
  if (!drives.some((drive) => drive.id === storageId)) {
    return { ok: false, message: "未找到该网盘。" };
  }

  // Guard: refuse while an acquisition is queued/running on this drive (else the
  // worker loses its credentials mid-flight).
  const active = await repository.listActiveWorkflowRuns({ accountId, connectedStorageId: storageId });
  if (active.length > 0) {
    return { ok: false, message: "该盘还有获取任务在进行，完成或取消后再取消绑定。" };
  }

  await repository.deleteConnectedStorage(accountId, storageId);
  revalidatePath("/settings");
  revalidatePath("/");
  return { ok: true, message: "已取消绑定（追踪记录已保留，重新绑定同一块盘即可恢复）。" };
}

export interface ConnectQuarkActionResult {
  ok: boolean;
  message: string;
}

/** Settings "添加网盘 → 夸克": bind a pasted 夸克 cookie as a new drive. */
export async function connectQuarkAction(cookie: string): Promise<ConnectQuarkActionResult> {
  assertNotDemo();
  try {
    const { connectQuarkCookie } = await import("../lib/workflow-runtime");
    const { providerUid } = await connectQuarkCookie(cookie);
    revalidatePath("/settings");
    return { ok: true, message: `夸克网盘已连接（账号 ${providerUid.slice(0, 10)}…）。` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export interface RequestTrackingActionResult {
  status: "requested" | "already_tracked" | "active_workflow" | "reserved" | "unsupported";
  message: string;
}

export async function requestTrackingAction(input?: {
  candidateId?: string;
  currentState?: "can_request" | "already_tracked" | "active_workflow" | "can_reserve" | "reserved";
  /** Tree model: the active workspace drive — acquisition lands HERE, not the primary. */
  storageId?: string;
}): Promise<RequestTrackingActionResult> {
  assertNotDemo();
  if (input?.currentState === "already_tracked") {
    return {
      status: "already_tracked",
      message: "已追踪，后台会继续按缺集状态检查。",
    };
  }

  if (input?.currentState === "active_workflow") {
    return {
      status: "active_workflow",
      message: "获取任务已在运行中，不会重复创建。",
    };
  }

  if (input?.currentState === "reserved") {
    return {
      status: "reserved",
      message: "已预定，上映后会自动获取并通知你。",
    };
  }

  // 预定 an unreleased film — track it without running the agent now.
  if (input?.currentState === "can_reserve" && input?.candidateId) {
    const request = await reserveCandidate(input.candidateId, input.storageId);
    if (request.status === "unsupported") {
      return { status: "unsupported", message: request.message };
    }
    if (request.status === "already_running") {
      return { status: "active_workflow", message: "获取任务已在运行中，不会重复创建。" };
    }
    if (request.status === "already_tracked") {
      return { status: "already_tracked", message: "已追踪，后台会继续按缺集状态检查。" };
    }
    revalidatePath("/");
    return { status: "reserved", message: "已预定，上映后会自动获取并通知你。" };
  }

  if (input?.candidateId) {
    const request = await queueCandidateTracking(input.candidateId, input.storageId);
    if (request.status === "already_tracked") {
      return {
        status: "already_tracked",
        message: "已追踪，后台会继续按缺集状态检查。",
      };
    }
    if (request.status === "already_running") {
      return {
        status: "active_workflow",
        message: "获取任务已在运行中，不会重复创建。",
      };
    }
    if (request.status === "unsupported") {
      return {
        status: "unsupported",
        message: request.message,
      };
    }

    revalidatePath("/");
    return {
      status: "requested",
      message: "已加入后台队列，完成后会通知你。",
    };
  }

  return {
    status: "requested",
    message: "已收到获取请求。",
  };
}

export async function requestSeriesAction(input: {
  candidateId: string;
  // Tree model: the active workspace drive — REQUIRED (value may be undefined =
  // primary) so a non-primary acquisition can't silently mis-route. See note on
  // requestSeasonAction.
  storageId: string | undefined;
}): Promise<RequestTrackingActionResult> {
  assertNotDemo();
  const request = await queueCandidateSeries(input.candidateId, input.storageId);
  if (request.status === "already_tracked") {
    return { status: "already_tracked", message: "全剧已追踪，后台会继续按缺集状态检查。" };
  }
  if (request.status === "already_running") {
    return { status: "active_workflow", message: "全剧获取任务已在运行中。" };
  }
  if (request.status === "unsupported") {
    return { status: "unsupported", message: request.message };
  }
  revalidatePath("/");
  return { status: "requested", message: "全剧获取已加入后台队列。" };
}

export interface ForeignWorkImportActionResult {
  status: "imported" | "failed";
  message: string;
}

export async function importForeignWorkAction(input: {
  providerFileIds: string[];
  movieTitle: string;
  year: number;
}): Promise<ForeignWorkImportActionResult> {
  assertNotDemo();
  const movieTitle = input.movieTitle.trim();
  const year = Number(input.year);
  if (!movieTitle || !Number.isInteger(year) || year < 1880 || year > 2100) {
    return { status: "failed", message: "请填写有效的电影名称与年份。" };
  }
  if (input.providerFileIds.length === 0) {
    return { status: "failed", message: "没有可入库的文件。" };
  }
  try {
    const { importForeignWorkFiles } = await import("../lib/workflow-runtime");
    await importForeignWorkFiles({
      providerFileIds: input.providerFileIds,
      movieTitle,
      year,
    });
    revalidatePath("/notifications");
    return {
      status: "imported",
      message: `已入库到 ${movieTitle} (${year})。`,
    };
  } catch (error) {
    return { status: "failed", message: `入库失败：${String(error)}` };
  }
}

export async function requestSeasonAction(input: {
  tmdbId: number;
  seasonNumber: number;
  // Tree model: the active workspace drive — acquisition lands HERE, not the
  // primary. REQUIRED (value may be undefined = primary) so every call site must
  // consciously thread the workspace; an omitted storageId silently mis-routes a
  // non-primary (e.g. quark) acquisition to the primary drive and the run never
  // shows on the workspace the user is looking at.
  storageId: string | undefined;
}): Promise<RequestTrackingActionResult> {
  assertNotDemo();
  const { queueSeasonTracking } = await import("../lib/title-hub");
  const request = await queueSeasonTracking(input.tmdbId, input.seasonNumber, input.storageId);
  if (request.status === "already_tracked") {
    return { status: "already_tracked", message: "本季已追踪。" };
  }
  if (request.status === "already_running") {
    return { status: "active_workflow", message: "本季获取任务已在运行中。" };
  }
  if (request.status === "unsupported") {
    return { status: "unsupported", message: request.message };
  }
  revalidatePath(`/show/${input.tmdbId}`);
  revalidatePath("/");
  return { status: "requested", message: `第 ${input.seasonNumber} 季已加入后台队列。` };
}

export async function requestRemainingAction(input: {
  tmdbId: number;
  // Tree model: the active workspace drive — REQUIRED (value may be undefined =
  // primary) so a non-primary acquisition can't silently mis-route. See note on
  // requestSeasonAction.
  storageId: string | undefined;
}): Promise<RequestTrackingActionResult> {
  assertNotDemo();
  const { queueRemainingSeasons } = await import("../lib/title-hub");
  const request = await queueRemainingSeasons(input.tmdbId, input.storageId);
  if (request.status === "already_tracked") {
    return { status: "already_tracked", message: "所有季都已在追踪。" };
  }
  if (request.status === "already_running") {
    return { status: "active_workflow", message: "获取任务已在运行中。" };
  }
  if (request.status === "unsupported") {
    return { status: "unsupported", message: request.message };
  }
  revalidatePath(`/show/${input.tmdbId}`);
  revalidatePath("/");
  return { status: "requested", message: "剩余季已加入后台队列。" };
}

export interface PushSettingsActionResult {
  success: boolean;
  message?: string;
  sentTo?: string[];
}

export async function savePushSettingsAction(
  settings: Record<string, string>,
): Promise<PushSettingsActionResult> {
  assertNotDemo();
  try {
    const { getWorkflowRepository, getCurrentAccountId } = await import("../lib/workflow-runtime");
    const repository = getWorkflowRepository();
    const accountId = await getCurrentAccountId();

    const keys = ["bark", "serverchan", "wecom", "webhook"];
    for (const key of keys) {
      const value = settings[key]?.trim();
      // Only write channels the user actually typed into. An empty field means
      // "leave unchanged" — the saved key stays masked and intact, never wiped.
      // Per-account (the worker reads each notification's account push config via
      // the scoped facade: account → global → env).
      if (value) {
        await repository.setAccountSetting(accountId, `push_${key}`, value);
      }
    }
    
    return { success: true };
  } catch (error) {
    return { success: false, message: `保存失败：${String(error)}` };
  }
}

const PUSH_CHANNEL_KEYS = ["bark", "serverchan", "wecom", "webhook"] as const;

/**
 * Wipe a saved push channel. Empty-on-save means "leave unchanged" (so a masked
 * key is never clobbered), which left no way to REMOVE a channel — this is that
 * affordance. Storing "" makes the channel read back as unconfigured.
 */
export async function clearPushChannelAction(key: string): Promise<PushSettingsActionResult> {
  assertNotDemo();
  if (!(PUSH_CHANNEL_KEYS as readonly string[]).includes(key)) {
    return { success: false, message: "未知的推送渠道" };
  }
  try {
    const { getWorkflowRepository, getCurrentAccountId } = await import("../lib/workflow-runtime");
    await getWorkflowRepository().setAccountSetting(await getCurrentAccountId(), `push_${key}`, "");
    return { success: true };
  } catch (error) {
    return { success: false, message: `清除失败：${String(error)}` };
  }
}

export async function saveDailySweepTimeAction(time: string): Promise<PushSettingsActionResult> {
  assertNotDemo();
  if (!/^\d{2}:\d{2}$/.test(time)) {
    return { success: false, message: "时间格式应为 HH:MM" };
  }
  const [hours, minutes] = time.split(":").map(Number);
  if (hours! > 23 || minutes! > 59) {
    return { success: false, message: "时间超出范围" };
  }
  try {
    const { getWorkflowRepository, DAILY_SWEEP_TIME_SETTING_KEY } = await import("../lib/workflow-runtime");
    await getWorkflowRepository().setSetting(DAILY_SWEEP_TIME_SETTING_KEY, time);
    return { success: true };
  } catch (error) {
    return { success: false, message: `保存失败：${String(error)}` };
  }
}

export async function savePreferredLanguageAction(
  language: string,
): Promise<PushSettingsActionResult> {
  assertNotDemo();
  try {
    const { getWorkflowRepository, getCurrentAccountId, PREFERRED_LANGUAGE_SETTING_KEY } = await import(
      "../lib/workflow-runtime"
    );
    const repository = getWorkflowRepository();
    await repository.setAccountSetting(await getCurrentAccountId(), PREFERRED_LANGUAGE_SETTING_KEY, language.trim());
    return { success: true };
  } catch (error) {
    return { success: false, message: `保存失败：${String(error)}` };
  }
}

export async function saveQualityPreferenceAction(
  quality: string,
): Promise<PushSettingsActionResult> {
  assertNotDemo();
  try {
    const { getWorkflowRepository, getCurrentAccountId, QUALITY_PREFERENCE_SETTING_KEY } = await import(
      "../lib/workflow-runtime"
    );
    const repository = getWorkflowRepository();
    await repository.setAccountSetting(await getCurrentAccountId(), QUALITY_PREFERENCE_SETTING_KEY, quality.trim());
    return { success: true };
  } catch (error) {
    return { success: false, message: `保存失败：${String(error)}` };
  }
}

export async function saveLlmConfigAction(input: {
  baseURL: string;
  modelId: string;
  apiKey: string;
}): Promise<PushSettingsActionResult> {
  assertNotDemo();
  try {
    const { normalizeLlmBaseUrl, sanitizeLlmApiKey } = await import("@media-track/workflow");
    const {
      getWorkflowRepository,
      getCurrentAccountId,
      LLM_BASE_URL_SETTING_KEY,
      LLM_MODEL_ID_SETTING_KEY,
      LLM_API_KEY_SETTING_KEY,
    } = await import("../lib/workflow-runtime");
    const repository = getWorkflowRepository();
    const accountId = await getCurrentAccountId();
    // Normalize base URL (the provider appends /chat/completions itself) and
    // strip all whitespace/invisible chars from the key — paste contamination
    // would otherwise silently store a wrong value (大误会).
    await repository.setAccountSetting(accountId, LLM_BASE_URL_SETTING_KEY, normalizeLlmBaseUrl(input.baseURL));
    await repository.setAccountSetting(accountId, LLM_MODEL_ID_SETTING_KEY, input.modelId.trim());
    // Only overwrite the key when the user actually typed a new one — a blank
    // submit keeps the stored key (the form never echoes it back).
    const apiKey = sanitizeLlmApiKey(input.apiKey);
    if (apiKey) {
      await repository.setAccountSetting(accountId, LLM_API_KEY_SETTING_KEY, apiKey);
    }
    return { success: true };
  } catch (error) {
    return { success: false, message: `保存失败：${String(error)}` };
  }
}

export async function testLlmConnectionAction(): Promise<{ ok: boolean; message: string }> {
  try {
    assertNotDemo();
    const { getCurrentAccountId, getAccountScopedSettings, resolveAgentModelConfig } = await import(
      "../lib/workflow-runtime"
    );
    const accountId = await getCurrentAccountId();
    // Resolve EXACTLY as the worker does (account-scoped → env → defaults).
    const cfg = await resolveAgentModelConfig(getAccountScopedSettings(accountId));
    if (!cfg.apiKey) {
      return { ok: false, message: "未配置 API Key —— 请先填写并保存。" };
    }
    const { createAgentModel } = await import("@media-track/workflow");
    const { generateText } = await import("ai");
    const model = createAgentModel(cfg);
    // A tiny real call — proves the key/base_url/model actually work, killing the
    // "stored a wrong value silently" 大误会. Not reached unless apiKey is set.
    await generateText({ model, prompt: "ping" });
    return { ok: true, message: `连接正常 · ${cfg.modelId ?? "mimo-v2.5-pro"}` };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `连接失败：${msg.slice(0, 200)}` };
  }
}

export async function saveTmdbApiKeyAction(apiKey: string): Promise<PushSettingsActionResult> {
  assertNotDemo();
  try {
    const { getWorkflowRepository, getCurrentAccountId, TMDB_API_KEY_SETTING_KEY } = await import("../lib/workflow-runtime");
    const repository = getWorkflowRepository();
    // Blank submit keeps the stored key (the form never echoes it back).
    const trimmed = apiKey.trim();
    if (trimmed) {
      await repository.setAccountSetting(await getCurrentAccountId(), TMDB_API_KEY_SETTING_KEY, trimmed);
    }
    return { success: true };
  } catch (error) {
    return { success: false, message: `保存失败：${String(error)}` };
  }
}

export async function clearTmdbApiKeyAction(): Promise<PushSettingsActionResult> {
  assertNotDemo();
  try {
    const { getWorkflowRepository, getCurrentAccountId, TMDB_API_KEY_SETTING_KEY } = await import("../lib/workflow-runtime");
    await getWorkflowRepository().setAccountSetting(await getCurrentAccountId(), TMDB_API_KEY_SETTING_KEY, "");
    return { success: true };
  } catch (error) {
    return { success: false, message: `清除失败：${String(error)}` };
  }
}

export async function savePanSouBaseUrlAction(baseURL: string): Promise<PushSettingsActionResult> {
  assertNotDemo();
  try {
    const { getWorkflowRepository, getCurrentAccountId, PANSOU_BASE_URL_SETTING_KEY } = await import("../lib/workflow-runtime");
    // Empty = clear the override → falls back to env / public default.
    await getWorkflowRepository().setAccountSetting(await getCurrentAccountId(), PANSOU_BASE_URL_SETTING_KEY, baseURL.trim());
    return { success: true };
  } catch (error) {
    return { success: false, message: `保存失败：${String(error)}` };
  }
}

export async function saveProwlarrConfigAction(input: {
  baseURL: string;
  apiKey: string;
}): Promise<PushSettingsActionResult> {
  assertNotDemo();
  try {
    const { getWorkflowRepository, getCurrentAccountId, PROWLARR_BASE_URL_SETTING_KEY, PROWLARR_API_KEY_SETTING_KEY } = await import(
      "../lib/workflow-runtime"
    );
    const repository = getWorkflowRepository();
    const accountId = await getCurrentAccountId();
    await repository.setAccountSetting(accountId, PROWLARR_BASE_URL_SETTING_KEY, input.baseURL.trim());
    const apiKey = input.apiKey.trim();
    if (apiKey) {
      await repository.setAccountSetting(accountId, PROWLARR_API_KEY_SETTING_KEY, apiKey);
    }
    return { success: true };
  } catch (error) {
    return { success: false, message: `保存失败：${String(error)}` };
  }
}

export async function clearProwlarrConfigAction(): Promise<PushSettingsActionResult> {
  assertNotDemo();
  try {
    const { getWorkflowRepository, getCurrentAccountId, PROWLARR_BASE_URL_SETTING_KEY, PROWLARR_API_KEY_SETTING_KEY } = await import(
      "../lib/workflow-runtime"
    );
    const repository = getWorkflowRepository();
    const accountId = await getCurrentAccountId();
    await repository.setAccountSetting(accountId, PROWLARR_BASE_URL_SETTING_KEY, "");
    await repository.setAccountSetting(accountId, PROWLARR_API_KEY_SETTING_KEY, "");
    return { success: true };
  } catch (error) {
    return { success: false, message: `清除失败：${String(error)}` };
  }
}

export async function testPushNotificationAction(
  settings: Record<string, string>,
): Promise<PushSettingsActionResult> {
  assertNotDemo();
  try {
    const { sendPushNotifications } = await import("@media-track/workflow");
    const { getAccountScopedSettings, getCurrentAccountId } = await import("../lib/workflow-runtime");

    // Per-account: read THIS account's saved push config (account → global), and
    // send through the same scoped source so the test matches real delivery.
    const repository = getAccountScopedSettings(await getCurrentAccountId());
    const configFromDb: Record<string, string> = {};
    for (const key of ["bark", "serverchan", "wecom", "webhook"]) {
      const dbValue = await repository.getSetting(`push_${key}`);
      const formValue = settings[key]?.trim();
      configFromDb[key] = formValue || dbValue || "";
    }

    const sentTo = await sendPushNotifications({
      repository,
      notification: {
        id: "test_" + Date.now(),
        workflowRunId: "test",
        kind: "test",
        title: "📢 Media Track 测试通知",
        body: "如果你收到这条消息，说明推送渠道配置成功！",
        createdAt: new Date().toISOString(),
      },
      overrideConfig: configFromDb,
    });
    
    return { success: true, sentTo };
  } catch (error) {
    return { success: false, message: `测试失败：${String(error)}` };
  }
}
