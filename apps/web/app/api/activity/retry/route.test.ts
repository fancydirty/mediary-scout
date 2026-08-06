import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("../../../../lib/demo-mode", () => ({ isDemoMode: vi.fn(() => false) }));

const retryFailedWorkflowRun = vi.fn();
const getWorkflowRunSnapshot = vi.fn();

vi.mock("../../../../lib/workflow-runtime", () => ({
  getCurrentAccountId: vi.fn(async () => "acct_default"),
  getWorkflowRepository: vi.fn(() => ({ retryFailedWorkflowRun, getWorkflowRunSnapshot })),
}));

import { isDemoMode } from "../../../../lib/demo-mode";
import { POST } from "./route";

function post(body: unknown) {
  return POST(
    new NextRequest("http://localhost/api/activity/retry", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/activity/retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isDemoMode).mockReturnValue(false);
  });

  it("returns the retried result without a reason (and does not re-read the run)", async () => {
    retryFailedWorkflowRun.mockResolvedValue({ status: "retried" });

    const body = (await (await post({ runId: "r1" })).json()) as Record<string, unknown>;

    expect(body).toEqual({ status: "retried" });
    // Happy path stays a single query — the snapshot read is refusal-path only.
    expect(getWorkflowRunSnapshot).not.toHaveBeenCalled();
  });

  it("reports kind_not_retriable for a patrol run so the UI can explain the real remedy", async () => {
    // type3_monitor has no queue claimer: requeueing it would strand the run in
    // `queued` forever and re-block the season. The user's remedy is to trigger a
    // patrol, NOT to retry — so the UI must not say "可能已在处理".
    retryFailedWorkflowRun.mockResolvedValue({ status: "not_retriable" });
    getWorkflowRunSnapshot.mockResolvedValue({
      workflowRun: { id: "r2", kind: "type3_monitor", status: "failed" },
    });

    const body = (await (await post({ runId: "r2" })).json()) as Record<string, unknown>;

    expect(body).toEqual({ status: "not_retriable", reason: "kind_not_retriable" });
  });

  it("reports not_failed for a RUNNING patrol — refused for status, not kind", async () => {
    // Status is checked before kind: a running patrol was refused because it is
    // not failed, so telling the user "巡检任务不能重试" would explain the wrong
    // thing. Without the status-first ordering this returns kind_not_retriable.
    retryFailedWorkflowRun.mockResolvedValue({ status: "not_retriable" });
    getWorkflowRunSnapshot.mockResolvedValue({
      workflowRun: { id: "r4", kind: "type3_monitor", status: "running" },
    });

    const body = (await (await post({ runId: "r4" })).json()) as Record<string, unknown>;

    expect(body).toEqual({ status: "not_retriable", reason: "not_failed" });
  });

  it("reports not_failed when a claimable run is refused for its status", async () => {
    retryFailedWorkflowRun.mockResolvedValue({ status: "not_retriable" });
    getWorkflowRunSnapshot.mockResolvedValue({
      workflowRun: { id: "r3", kind: "type2_init", status: "running" },
    });

    const body = (await (await post({ runId: "r3" })).json()) as Record<string, unknown>;

    expect(body).toEqual({ status: "not_retriable", reason: "not_failed" });
  });

  it("falls back to not_failed when the run cannot be read back", async () => {
    retryFailedWorkflowRun.mockResolvedValue({ status: "not_retriable" });
    getWorkflowRunSnapshot.mockResolvedValue(null);

    const body = (await (await post({ runId: "missing" })).json()) as Record<string, unknown>;

    expect(body).toEqual({ status: "not_retriable", reason: "not_failed" });
  });

  it("rejects a request without a runId", async () => {
    const res = await post({});

    expect(res.status).toBe(400);
    expect(retryFailedWorkflowRun).not.toHaveBeenCalled();
  });

  it("refuses to mutate anything in demo mode", async () => {
    vi.mocked(isDemoMode).mockReturnValue(true);

    const res = await post({ runId: "r1" });

    expect(res.status).toBe(403);
    expect(retryFailedWorkflowRun).not.toHaveBeenCalled();
  });
});
