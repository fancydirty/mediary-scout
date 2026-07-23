import { describe, expect, it } from "vitest";
import {
  isPrunableFinishedRun,
  ORPHAN_REQUEUE_MAX,
  recoverOrphanRunningRun,
  retriedWorkflowRun,
} from "../src/repository.js";
import type { WorkflowRun } from "../src/domain.js";

const baseRun = (over: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: "run_x",
  kind: "type2_init",
  status: "running",
  trackedSeasonId: "season_1",
  startedAt: "2026-06-11T00:00:00.000Z",
  finishedAt: null,
  auditEvents: [],
  ...over,
});

describe("recoverOrphanRunningRun", () => {
  it("requeues under the cap and increments orphanRequeueCount", () => {
    const { action, run } = recoverOrphanRunningRun(baseRun(), "2026-06-11T01:00:00.000Z");
    expect(action).toBe("requeue");
    expect(run.status).toBe("queued");
    expect(run.orphanRequeueCount).toBe(1);
    expect(run.auditEvents.some((e) => e.type === "orphan_requeued")).toBe(true);
  });

  it("fails at the cap instead of requeuing forever", () => {
    const { action, run } = recoverOrphanRunningRun(
      baseRun({ orphanRequeueCount: ORPHAN_REQUEUE_MAX }),
      "2026-06-11T02:00:00.000Z",
    );
    expect(action).toBe("fail");
    expect(run.status).toBe("failed");
    expect(run.finishedAt).toBe("2026-06-11T02:00:00.000Z");
    expect(run.auditEvents.some((e) => e.type === "orphan_requeue_capped")).toBe(true);
  });
});

describe("retriedWorkflowRun", () => {
  it("resets orphanRequeueCount so manual retry gets a fresh recovery budget", () => {
    const failed = baseRun({
      status: "failed",
      finishedAt: "2026-06-11T02:00:00.000Z",
      orphanRequeueCount: ORPHAN_REQUEUE_MAX,
      autoRequeueCount: 2,
      nextAttemptAt: "2026-06-11T03:00:00.000Z",
    });
    const retried = retriedWorkflowRun(failed, "2026-06-11T04:00:00.000Z");
    expect(retried.status).toBe("queued");
    expect(retried.orphanRequeueCount).toBe(0);
    expect(retried.autoRequeueCount).toBe(0);
    expect(retried.nextAttemptAt).toBeUndefined();
  });
});

describe("isPrunableFinishedRun", () => {
  it("prunes old succeeded runs and keeps active/recent", () => {
    const cutoff = "2026-06-01T00:00:00.000Z";
    expect(
      isPrunableFinishedRun(
        baseRun({ status: "succeeded", finishedAt: "2026-05-01T00:00:00.000Z" }),
        cutoff,
      ),
    ).toBe(true);
    expect(
      isPrunableFinishedRun(
        baseRun({ status: "succeeded", finishedAt: "2026-06-10T00:00:00.000Z" }),
        cutoff,
      ),
    ).toBe(false);
    expect(isPrunableFinishedRun(baseRun({ status: "queued" }), cutoff)).toBe(false);
    expect(isPrunableFinishedRun(baseRun({ status: "running" }), cutoff)).toBe(false);
    expect(isPrunableFinishedRun(baseRun({ status: "reserved" }), cutoff)).toBe(false);
  });
});
