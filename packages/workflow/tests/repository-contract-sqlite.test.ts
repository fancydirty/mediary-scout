import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { createSqliteWorkflowRepository, SqliteWorkflowRepository } from "../src/sqlite.js";
import { runRepositoryContract } from "./repository-contract.js";
import { workflowPersistenceFixture } from "./workflow-fixtures.js";

function makeSqliteRepo(): SqliteWorkflowRepository {
  const dir = mkdtempSync(join(tmpdir(), "ms-sqlite-"));
  return createSqliteWorkflowRepository({ path: join(dir, "test.db") });
}

runRepositoryContract("SQLite", {
  make: makeSqliteRepo,
  teardown: (repo) => {
    (repo as SqliteWorkflowRepository).close();
  },
});

// SQLite-specific: the shared contract can't assert nextAttemptAt gating because the
// InMemory oracle intentionally does NOT gate (pure FIFO), while Postgres AND SQLite do
// (via claimableQueuedRuns). This locks the PRODUCTION engine's gate directly — and, more
// SQLite-specifically, proves nextAttemptAt survives the JSON *text* payload round-trip so
// the gate can actually see it.
describe("SQLite claim honors nextAttemptAt backoff gate", () => {
  const base = workflowPersistenceFixture();
  const gatedRun = (nextAttemptAt: string) => ({
    ...base,
    workflowRun: {
      ...base.workflowRun,
      id: "run_gated",
      status: "queued" as const,
      finishedAt: null,
      autoRequeueCount: 1,
      nextAttemptAt,
      startedAt: "2026-07-05T00:00:00.000Z",
    },
    // child rows are validated to belong to workflowRun.id; drop them since we
    // re-id the run and this test only exercises claim gating.
    transferAttempts: [],
    notifications: [],
  });

  it("skips a queued run until now reaches its nextAttemptAt, then claims it", async () => {
    const repo = makeSqliteRepo();
    try {
      await repo.saveWorkflowRunSnapshot(gatedRun("2026-07-05T06:00:00.000Z"));
      // Before the backoff deadline: not yet claimable.
      expect(await repo.claimNextQueuedWorkflowRun({ kind: base.workflowRun.kind, now: "2026-07-05T05:59:59.000Z" })).toBeNull();
      // At/after the deadline: claimed (proves nextAttemptAt round-tripped through the text payload).
      const claimed = await repo.claimNextQueuedWorkflowRun({ kind: base.workflowRun.kind, now: "2026-07-05T06:00:00.000Z" });
      expect(claimed?.workflowRun.id).toBe("run_gated");
      expect(claimed?.workflowRun.status).toBe("running");
    } finally {
      repo.close();
    }
  });
});
