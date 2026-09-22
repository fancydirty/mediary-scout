import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { runAcquisitionV2Workflow } from "../src/acquisition-v2/workflow-v2.js";
import { stagingLeaksOf } from "../src/acquisition-v2/directory-lifecycle.js";
import { FakeStorageExecutor } from "../src/fakes.js";
import type { ResourceProvider } from "../src/ports.js";
import type { ResourceSnapshot } from "../src/domain.js";
import type { JevJudge, JevJudgeInput } from "../src/jev-judge.js";

const USAGE = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
} as const;

function emptyProvider(): ResourceProvider {
  return {
    search: async ({ keyword }): Promise<ResourceSnapshot> => ({
      id: "snap_empty",
      provider: "pansou",
      keyword,
      candidates: [],
      createdAt: "2026-06-14T00:00:00.000Z",
    }),
  };
}

/** Model that searches once then honestly reports no coverage. */
function searchThenReportModel() {
  let i = 0;
  const tool = (name: string, input: unknown) => ({
    content: [{ type: "tool-call" as const, toolCallId: `c${i}`, toolName: name, input: JSON.stringify(input) }],
    finishReason: { unified: "tool-calls" as const, raw: "tool-calls" as const },
    usage: USAGE,
    warnings: [],
  });
  return new MockLanguageModelV3({
    doGenerate: async () => {
      i += 1;
      if (i === 1) return tool("searchResources", { keyword: "show" });
      if (i === 2) return tool("reportNoCoverage", { reason: "no candidates" });
      return { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" as const }, usage: USAGE, warnings: [] };
    },
  });
}

describe("runAcquisitionV2Workflow — outer orchestration (dirs → sync → agent → reconcile)", () => {
  it("ensures dirs, computes the cross-season need, runs the agent, reconciles", async () => {
    const executor = new FakeStorageExecutor();
    const result = await runAcquisitionV2Workflow({
      provider: emptyProvider(),
      executor,
      model: searchThenReportModel(),
      workflowRunId: "run-1",
      title: { name: "Show", year: 2024, aliases: [], tmdbId: 42 },
      categoryParentId: "tv_root",
      seasons: [{ seasonNumber: 1, latestAiredEpisode: 3 }],
      qualityPreference: "1080p",
    });

    // directory tree was verify-or-created
    expect(result.directories.seasonDirectoryIds[1]).toBeDefined();
    expect(result.directories.stagingDirectoryId).toContain(result.directories.showDirectoryId);
    // the need was computed from empty storage (all three aired episodes missing)
    expect(result.missingBefore).toEqual(["S01E01", "S01E02", "S01E03"]);
    // nothing covered them → still missing after reconcile (honest gap)
    expect(result.stillMissing).toEqual(["S01E01", "S01E02", "S01E03"]);
    expect(result.outcome.transferAttempts).toEqual([]);
  });

  it("no-op when nothing is missing: the agent (model) is never invoked", async () => {
    const executor = new FakeStorageExecutor();
    let modelCalled = false;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        modelCalled = true;
        throw new Error("model should not be called on a no-op run");
      },
    });
    const result = await runAcquisitionV2Workflow({
      provider: emptyProvider(),
      executor,
      model,
      workflowRunId: "run-2",
      title: { name: "Show", year: 2024, aliases: [], tmdbId: 42 },
      categoryParentId: "tv_root",
      seasons: [{ seasonNumber: 1, latestAiredEpisode: 0 }], // nothing aired → nothing missing
      qualityPreference: "1080p",
    });

    expect(modelCalled).toBe(false);
    expect(result.missingBefore).toEqual([]);
    expect(result.outcome.transferAttempts).toEqual([]);
  });

  it("实有 comes from the DB marks (priorObtained), NOT a 115 scan — it narrows the need and drives obtained", async () => {
    const executor = new FakeStorageExecutor();
    const result = await runAcquisitionV2Workflow({
      provider: emptyProvider(),
      executor,
      model: searchThenReportModel(), // finds no new coverage this run
      workflowRunId: "run-3",
      title: { name: "Show", year: 2024, aliases: [], tmdbId: 42 },
      categoryParentId: "tv_root",
      seasons: [{ seasonNumber: 1, latestAiredEpisode: 3 }],
      qualityPreference: "1080p",
      priorObtained: ["S01E01"], // the DB already has E01 (agent marked it before)
    });

    // The need is aired − DB实有 = {E02,E03}; E01 is NOT re-needed (the old code
    // scanned an empty 115 and would have re-needed all three).
    expect(result.missingBefore).toEqual(["S01E02", "S01E03"]);
    // obtained reflects the DB mark; stillMissing is the rest.
    expect(result.obtained).toEqual(["S01E01"]);
    expect(result.stillMissing).toEqual(["S01E02", "S01E03"]);
  });

  it("records a staging_leaked audit event when the staging dir survives the harness cleanup (123 silent-no-op delete)", async () => {
    // 2026-09-20: 123's file/trash answered code:0 and deleted nothing; the
    // executor said {removed:true}; 80 staging dirs / ~1.4 TB piled up unseen.
    // Model that with an executor whose removeDirectory is a silent no-op and
    // assert the leak is visible in the run's audit trail.
    class SilentNoopDeleteExecutor extends FakeStorageExecutor {
      override async removeDirectory(): Promise<{ removed: boolean }> {
        return { removed: true }; // lies, exactly like production did
      }
    }
    const executor = new SilentNoopDeleteExecutor();
    const result = await runAcquisitionV2Workflow({
      provider: emptyProvider(),
      executor,
      model: searchThenReportModel(),
      workflowRunId: "run-leak",
      title: { name: "Show", year: 2024, aliases: [], tmdbId: 42 },
      categoryParentId: "tv_root",
      seasons: [{ seasonNumber: 1, latestAiredEpisode: 3 }],
      qualityPreference: "1080p",
    });

    const leak = result.auditEvents.find((event) => event.type === "staging_leaked");
    expect(leak).toBeDefined();
    expect(leak?.data).toMatchObject({ stagingDirectoryId: result.directories.stagingDirectoryId });
    expect(leak?.message).toContain("staging");
  });

  it("records NO staging_leaked event when the cleanup really removed the staging dir", async () => {
    const executor = new FakeStorageExecutor();
    const result = await runAcquisitionV2Workflow({
      provider: emptyProvider(),
      executor,
      model: searchThenReportModel(),
      workflowRunId: "run-clean",
      title: { name: "Show", year: 2024, aliases: [], tmdbId: 42 },
      categoryParentId: "tv_root",
      seasons: [{ seasonNumber: 1, latestAiredEpisode: 3 }],
      qualityPreference: "1080p",
    });
    expect(result.auditEvents.some((event) => event.type === "staging_leaked")).toBe(false);
    // and the fake really dropped it
    const children = await executor.listChildDirectories(result.directories.showDirectoryId);
    expect(children.some((child) => child.id === result.directories.stagingDirectoryId)).toBe(false);
  });

  it("carries the leak on the thrown error when the body FAILS and the staging dir survives (Copilot #260 r1)", async () => {
    // The throw path is exactly the one the harness guard exists for (斗破苍穹). If
    // the agent dies AND the delete silently no-ops, the leak must still reach the
    // persisted failed run — the success-path audit append never runs here, so the
    // leak rides on the error itself for the failure handler to pick up.
    class SilentNoopDeleteExecutor extends FakeStorageExecutor {
      override async removeDirectory(): Promise<{ removed: boolean }> {
        return { removed: true };
      }
    }
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        throw new Error("agent model unavailable");
      },
    });
    let caught: unknown;
    try {
      await runAcquisitionV2Workflow({
        provider: emptyProvider(),
        executor: new SilentNoopDeleteExecutor(),
        model,
        workflowRunId: "run-leak-throw",
        title: { name: "Show", year: 2024, aliases: [], tmdbId: 42 },
        categoryParentId: "tv_root",
        seasons: [{ seasonNumber: 1, latestAiredEpisode: 3 }],
        qualityPreference: "1080p",
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("agent model unavailable"); // original error, not a wrapper
    const leaks = stagingLeaksOf(caught);
    expect(leaks).toHaveLength(1);
    expect(leaks[0]?.stagingDirectoryId).toContain("staging-run-leak-throw");
    // The failure path has no `directories` to consult: the leak itself names the
    // show dir (the fake nests ids, so staging id starts with its parent's id).
    expect(leaks[0]?.showDirectoryId).toBeTruthy();
    expect(leaks[0]?.stagingDirectoryId.startsWith(leaks[0]!.showDirectoryId)).toBe(true);
  });

  it("carries NO leak on the thrown error when the cleanup really removed staging", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        throw new Error("agent model unavailable");
      },
    });
    let caught: unknown;
    try {
      await runAcquisitionV2Workflow({
        provider: emptyProvider(),
        executor: new FakeStorageExecutor(),
        model,
        workflowRunId: "run-clean-throw",
        title: { name: "Show", year: 2024, aliases: [], tmdbId: 42 },
        categoryParentId: "tv_root",
        seasons: [{ seasonNumber: 1, latestAiredEpisode: 3 }],
        qualityPreference: "1080p",
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(stagingLeaksOf(caught)).toEqual([]);
  });
});

describe("runAcquisitionV2Workflow forwards jevJudge to the orchestrator", () => {
  it("the judge is invoked for the pre-warm search when supplied", async () => {
    const seen: JevJudgeInput[] = [];
    const jevJudge: JevJudge = { judgeCandidates: async (input) => { seen.push(input); return { scores: {}, model: "m" }; } };
    // One real candidate so the prefilter has something to judge (empty snapshots skip the judge).
    const provider: ResourceProvider = {
      search: async ({ keyword }) => ({
        id: `snap_${keyword}`, provider: "pansou", keyword, createdAt: "2026-09-19T00:00:00.000Z",
        candidates: [{ id: "c1", snapshotId: `snap_${keyword}`, index: 0, title: "Show S01", type: "115", source: "pansou", providerPayload: {} }],
      }),
    };
    await runAcquisitionV2Workflow({
      provider,
      executor: new FakeStorageExecutor(),
      model: searchThenReportModel(),
      workflowRunId: "run-jev",
      title: { name: "Show", year: 2024, aliases: ["The Show"], tmdbId: 42 },
      categoryParentId: "tv_root",
      seasons: [{ seasonNumber: 1, latestAiredEpisode: 3 }],
      qualityPreference: "1080p",
      jevJudge,
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]!.target).toEqual({ kind: "tv", title: "Show", aliases: ["The Show"], year: 2024 });
  });
});
