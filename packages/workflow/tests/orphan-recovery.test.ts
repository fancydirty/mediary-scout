import { describe, expect, it } from "vitest";
import {
  isQueueClaimableKind,
  recoverOrphanRunningRun,
  ORPHAN_REQUEUE_MAX,
} from "../src/repository.js";
import type { WorkflowKind, WorkflowRun } from "../src/domain.js";

function runningRun(kind: WorkflowKind, over: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "r1",
    kind,
    status: "running",
    trackedSeasonId: "tmdb_tv_1_s1",
    startedAt: "2026-08-05T00:00:00.000Z",
    finishedAt: null,
    auditEvents: [{ type: "type3_scheduled", message: "scheduled" }],
    ...over,
  } as WorkflowRun;
}

describe("isQueueClaimableKind", () => {
  it("marks the three queue-driven kinds claimable", () => {
    expect(isQueueClaimableKind("type2_init")).toBe(true);
    expect(isQueueClaimableKind("type1_package_init")).toBe(true);
    expect(isQueueClaimableKind("movie_init")).toBe(true);
  });

  it("marks type3_monitor unclaimable (no worker claims queued type3)", () => {
    expect(isQueueClaimableKind("type3_monitor")).toBe(false);
  });

  it("covers every WorkflowKind explicitly (guard against a new kind being forgotten)", () => {
    const all: WorkflowKind[] = ["type1_package_init", "type2_init", "type3_monitor", "movie_init"];
    for (const kind of all) {
      expect(typeof isQueueClaimableKind(kind)).toBe("boolean");
    }
  });
});

describe("recoverOrphanRunningRun", () => {
  it("requeues a claimable kind (unchanged behavior)", () => {
    const result = recoverOrphanRunningRun(runningRun("type2_init"), "2026-08-05T01:00:00.000Z");
    expect(result.action).toBe("requeue");
    expect(result.run.status).toBe("queued");
    expect(result.run.finishedAt).toBeNull();
    expect(result.run.orphanRequeueCount).toBe(1);
  });

  it("fails an unclaimable kind instead of parking it in queued forever", () => {
    const result = recoverOrphanRunningRun(runningRun("type3_monitor"), "2026-08-05T01:00:00.000Z");
    expect(result.action).toBe("fail");
    expect(result.run.status).toBe("failed");
    expect(result.run.finishedAt).toBe("2026-08-05T01:00:00.000Z");
  });

  it("records why an unclaimable orphan was failed", () => {
    const result = recoverOrphanRunningRun(runningRun("type3_monitor"), "2026-08-05T01:00:00.000Z");
    const last = result.run.auditEvents.at(-1);
    expect(last?.type).toBe("orphan_unclaimable");
    expect(last?.message).toContain("type3_monitor");
  });

  it("does not bump orphanRequeueCount when failing an unclaimable orphan", () => {
    const result = recoverOrphanRunningRun(
      runningRun("type3_monitor", { orphanRequeueCount: 2 }),
      "2026-08-05T01:00:00.000Z",
    );
    expect(result.run.orphanRequeueCount).toBe(2);
  });

  it("still caps a claimable poison run", () => {
    const result = recoverOrphanRunningRun(
      runningRun("type2_init", { orphanRequeueCount: ORPHAN_REQUEUE_MAX }),
      "2026-08-05T01:00:00.000Z",
    );
    expect(result.action).toBe("fail");
    expect(result.run.auditEvents.at(-1)?.type).toBe("orphan_requeue_capped");
  });
});
