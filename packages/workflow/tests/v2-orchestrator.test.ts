import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { runAcquisitionV2 } from "../src/acquisition-v2/orchestrator.js";
import type { ResourceProvider } from "../src/ports.js";
import type { ResourceSnapshot } from "../src/domain.js";
import { FakeStorageExecutor } from "../src/fakes.js";

const USAGE = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
} as const;

function emptySnapshot(keyword: string): ResourceSnapshot {
  return { id: "snap_empty", provider: "pansou", keyword, candidates: [], createdAt: "2026-06-14T00:00:00.000Z" };
}

/** A model that immediately reports no-coverage after one search, then stops. */
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
      // Keyword must reference the title (the new title-guard); "Show" is the target.
      if (i === 1) return tool("searchResources", { keyword: "Show" });
      if (i === 2) return tool("reportNoCoverage", { reason: "no candidates" });
      return { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" as const }, usage: USAGE, warnings: [] };
    },
  });
}

describe("runAcquisitionV2 — composition root wiring real adapters + sandbox + task agent", () => {
  it("seeds a TV task with the missing-episode need and drives the loop", async () => {
    const searched: string[] = [];
    const provider: ResourceProvider = {
      search: async ({ keyword }) => {
        searched.push(keyword);
        return emptySnapshot(keyword);
      },
    };
    const executor = new FakeStorageExecutor({ directories: { staging: [], season: [] } });

    const result = await runAcquisitionV2({
      provider,
      executor,
      model: searchThenReportModel(),
      workflowRunId: "run-1",
      target: { kind: "tv", title: "Show", aliases: [], seasons: [1], missingEpisodes: ["S01E01", "S01E02"], qualityPreference: "1080p" },
      stagingDirectoryId: "staging",
      targetSeasonDirectoryIds: { 1: "season" },
    });

    // The need came from the missing episodes; nothing landed → honestly unmet.
    expect(result.coverage.missing).toEqual(["S01E01", "S01E02"]);
    expect(searched).toEqual(["Show"]); // the real provider was driven through the adapter
    // The persistable trace is assembled from the adapters: one (empty) snapshot
    // observed, no transfers, so no decisions.
    expect(result.outcome.resourceSnapshots.map((s) => s.id)).toEqual(["snap_empty"]);
    expect(result.outcome.transferAttempts).toEqual([]);
    expect(result.outcome.decisions).toEqual([]);
  });

  it("seeds a movie task with the MOVIE need", async () => {
    const provider: ResourceProvider = { search: async ({ keyword }) => emptySnapshot(keyword) };
    const executor = new FakeStorageExecutor({ directories: { staging: [], movie: [] } });

    const result = await runAcquisitionV2({
      provider,
      executor,
      model: searchThenReportModel(),
      workflowRunId: "run-2",
      target: { kind: "movie", title: "Some Film", aliases: [], year: 2025, qualityPreference: "1080p" },
      stagingDirectoryId: "staging",
      targetMovieDirectoryId: "movie",
    });

    expect(result.coverage.missing).toEqual(["MOVIE"]);
  });
});
