"use server";

import { revalidatePath } from "next/cache";
import { queueCandidateSeries, queueCandidateTracking } from "../lib/workflow-runtime";

export interface RequestTrackingActionResult {
  status: "requested" | "already_tracked" | "active_workflow" | "unsupported";
  message: string;
}

export async function requestTrackingAction(input?: {
  candidateId?: string;
  currentState?: "can_request" | "already_tracked" | "active_workflow";
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
