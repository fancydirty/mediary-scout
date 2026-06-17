"use server";

import { revalidatePath } from "next/cache";
import { queueCandidateSeries, queueCandidateTracking, reserveCandidate } from "../lib/workflow-runtime";

export interface RequestTrackingActionResult {
  status: "requested" | "already_tracked" | "active_workflow" | "reserved" | "unsupported";
  message: string;
}

export async function requestTrackingAction(input?: {
  candidateId?: string;
  currentState?: "can_request" | "already_tracked" | "active_workflow" | "can_reserve" | "reserved";
}): Promise<RequestTrackingActionResult> {
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
    const request = await reserveCandidate(input.candidateId);
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
    const request = await queueCandidateTracking(input.candidateId);
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
}): Promise<RequestTrackingActionResult> {
  const request = await queueCandidateSeries(input.candidateId);
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
}): Promise<RequestTrackingActionResult> {
  const { queueSeasonTracking } = await import("../lib/title-hub");
  const request = await queueSeasonTracking(input.tmdbId, input.seasonNumber);
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
}): Promise<RequestTrackingActionResult> {
  const { queueRemainingSeasons } = await import("../lib/title-hub");
  const request = await queueRemainingSeasons(input.tmdbId);
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
  try {
    const { getWorkflowRepository } = await import("../lib/workflow-runtime");
    const repository = getWorkflowRepository();
    
    const keys = ["bark", "serverchan", "wecom", "webhook"];
    for (const key of keys) {
      const value = settings[key]?.trim();
      // Only write channels the user actually typed into. An empty field means
      // "leave unchanged" — the saved key stays masked and intact, never wiped.
      if (value) {
        await repository.setSetting(`push_${key}`, value);
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
  if (!(PUSH_CHANNEL_KEYS as readonly string[]).includes(key)) {
    return { success: false, message: "未知的推送渠道" };
  }
  try {
    const { getWorkflowRepository } = await import("../lib/workflow-runtime");
    await getWorkflowRepository().setSetting(`push_${key}`, "");
    return { success: true };
  } catch (error) {
    return { success: false, message: `清除失败：${String(error)}` };
  }
}

export async function saveDailySweepTimeAction(time: string): Promise<PushSettingsActionResult> {
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
  try {
    const { getWorkflowRepository, PREFERRED_LANGUAGE_SETTING_KEY } = await import(
      "../lib/workflow-runtime"
    );
    const repository = getWorkflowRepository();
    await repository.setSetting(PREFERRED_LANGUAGE_SETTING_KEY, language.trim());
    return { success: true };
  } catch (error) {
    return { success: false, message: `保存失败：${String(error)}` };
  }
}

export async function saveQualityPreferenceAction(
  quality: string,
): Promise<PushSettingsActionResult> {
  try {
    const { getWorkflowRepository, QUALITY_PREFERENCE_SETTING_KEY } = await import(
      "../lib/workflow-runtime"
    );
    const repository = getWorkflowRepository();
    await repository.setSetting(QUALITY_PREFERENCE_SETTING_KEY, quality.trim());
    return { success: true };
  } catch (error) {
    return { success: false, message: `保存失败：${String(error)}` };
  }
}

export async function testPushNotificationAction(
  settings: Record<string, string>,
): Promise<PushSettingsActionResult> {
  try {
    const { sendPushNotifications } = await import("@media-track/workflow");
    const { getWorkflowRepository } = await import("../lib/workflow-runtime");
    
    const repository = getWorkflowRepository();
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
