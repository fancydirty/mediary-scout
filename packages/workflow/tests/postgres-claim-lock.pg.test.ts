import { describe, expect, it } from "vitest";
import pg from "pg";
import { PostgresWorkflowRepository } from "../src/postgres.js";
import { workflowPersistenceFixture } from "./workflow-fixtures.js";

const connectionString = process.env.MEDIA_TRACK_POSTGRES_URL;
const d = connectionString ? describe : describe.skip;

d("PostgresWorkflowRepository queued-run claim locking", () => {
  it("skips a queued run already locked by another claimant instead of waiting and double-claiming it", async () => {
    const id = `claim_lock_${Date.now()}`;
    const seasonId = `season_${id}`;
    const titleId = `title_${id}`;
    const pool = new pg.Pool({ connectionString });
    const blocker = new pg.Client({ connectionString });
    const repository = new PostgresWorkflowRepository(pool);
    const base = workflowPersistenceFixture();
    const snapshot = {
      ...base,
      title: { ...base.title, id: titleId },
      season: { ...base.season, id: seasonId, mediaTitleId: titleId },
      workflowRun: {
        ...base.workflowRun,
        id,
        trackedSeasonId: seasonId,
        status: "queued" as const,
        finishedAt: null,
      },
      episodes: [],
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    };

    try {
      await repository.saveWorkflowRunSnapshot(snapshot);
      await blocker.connect();
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM workflow_runs WHERE id = $1 FOR UPDATE", [id]);

      const result = await Promise.race([
        repository.claimNextQueuedWorkflowRun({ kind: "type2_init", now: "2026-06-11T01:00:00.000Z" }),
        new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 500)),
      ]);

      expect(result).toBeNull();
    } finally {
      await blocker.query("ROLLBACK").catch(() => {});
      await blocker.end().catch(() => {});
      await pool.query("DELETE FROM workflow_runs WHERE id = $1", [id]).catch(() => {});
      await pool.query("DELETE FROM tracked_seasons WHERE id = $1", [seasonId]).catch(() => {});
      await pool.query("DELETE FROM media_titles WHERE id = $1", [titleId]).catch(() => {});
      await pool.end();
    }
  }, 10_000);
});
