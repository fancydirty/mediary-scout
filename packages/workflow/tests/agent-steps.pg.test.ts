import { describe, expect, it } from "vitest";
import pg from "pg";
import { PostgresWorkflowRepository } from "../src/index.js";
import type { AgentStep } from "../src/index.js";

const URL = process.env.MEDIA_TRACK_POSTGRES_URL;
const d = URL ? describe : describe.skip;

function step(ordinal: number, toolName: string, apiCalls?: number): AgentStep {
  return {
    ordinal,
    toolName,
    args: { keyword: "莉可丽丝" },
    activity: "搜",
    phase: "search",
    ...(apiCalls === undefined ? {} : { apiCalls }),
    at: "2026-06-22T00:00:00.000Z",
  };
}

d("Postgres agent steps", () => {
  it("appends and lists ordered, idempotent on (run, ordinal)", async () => {
    const pool = new pg.Pool({ connectionString: URL });
    const repo = new PostgresWorkflowRepository(pool);
    const runId = `run_steps_${Date.now()}`;
    try {
      await repo.appendAgentStep(runId, step(1, "transferCandidate", 50));
      await repo.appendAgentStep(runId, step(0, "searchResources", 3));
      // duplicate ordinal must not throw (ON CONFLICT DO NOTHING)
      await repo.appendAgentStep(runId, step(0, "searchResources", 999));
      const steps = await repo.listAgentSteps(runId);
      expect(steps.map((s) => s.ordinal)).toEqual([0, 1]);
      expect(steps[0]!.apiCalls).toBe(3);
      expect(steps[0]!.args.keyword).toBe("莉可丽丝");
      expect(steps[1]!.toolName).toBe("transferCandidate");
    } finally {
      await pool.query("DELETE FROM agent_steps WHERE workflow_run_id = $1", [runId]);
      await pool.end();
    }
  });

  it("clearAgentSteps drops a prior attempt so a retry (same run id) re-traces from 0", async () => {
    const pool = new pg.Pool({ connectionString: URL });
    const repo = new PostgresWorkflowRepository(pool);
    const runId = `run_retry_${Date.now()}`;
    try {
      await repo.appendAgentStep(runId, step(0, "searchResources"));
      await repo.appendAgentStep(runId, step(1, "transferCandidate"));
      await repo.appendAgentStep(runId, step(2, "markObtained"));
      // retry: clear, then re-append from ordinal 0 (would otherwise be DROPPED by ON CONFLICT)
      await repo.clearAgentSteps(runId);
      await repo.appendAgentStep(runId, step(0, "reportNoCoverage"));
      const steps = await repo.listAgentSteps(runId);
      expect(steps.map((s) => s.ordinal)).toEqual([0]);
      expect(steps[0]!.toolName).toBe("reportNoCoverage");
    } finally {
      await pool.query("DELETE FROM agent_steps WHERE workflow_run_id = $1", [runId]);
      await pool.end();
    }
  });
});
