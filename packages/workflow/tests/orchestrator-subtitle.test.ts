import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { runAcquisitionV2 } from "../src/acquisition-v2/orchestrator.js";
import type { ResourceProvider } from "../src/ports.js";
import type { ResourceSnapshot } from "../src/domain.js";
import type { AssrtCandidate, AssrtSubtitleFile } from "../src/subtitle-provider.js";
import { FakeStorageExecutor } from "../src/fakes.js";

const USAGE = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
} as const;

/** A model that stops immediately — the subtitle PRE-WARM side effect we assert
 *  happens BEFORE the loop runs, so the agent behavior itself doesn't matter. */
function stopModel(): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text" as const, text: "done" }],
      finishReason: { unified: "stop" as const, raw: "stop" as const },
      usage: USAGE,
      warnings: [],
    }),
  });
}

function emptyProvider(): ResourceProvider {
  return {
    search: async ({ keyword }): Promise<ResourceSnapshot> => ({
      id: "snap_empty",
      provider: "pansou",
      keyword,
      candidates: [],
      createdAt: "2026-07-01T00:00:00.000Z",
    }),
  };
}

/** An assrt provider that records how many times search() was called, so we can
 *  assert the pre-warm gate: 1 call when all gates pass, 0 when any gate fails. */
function spyingAssrtProvider(): {
  provider: { search(k: string): Promise<AssrtCandidate[]>; detail(id: number): Promise<AssrtSubtitleFile[]> };
  state: { searchCalls: number };
} {
  const state = { searchCalls: 0 };
  const provider = {
    search: async (_k: string): Promise<AssrtCandidate[]> => {
      state.searchCalls += 1;
      return [];
    },
    detail: async (_id: number): Promise<AssrtSubtitleFile[]> => [],
  };
  return { provider, state };
}

/** Run a movie acquisition with the given gate inputs; return how many times
 *  assrt.search was called (the pre-warm indicator). */
async function runWithGates(gates: {
  originCountries: string[];
  storageProvider: string;
  assrtToken?: string;
}): Promise<number> {
  const { provider: assrtProvider, state } = spyingAssrtProvider();
  await runAcquisitionV2({
    provider: emptyProvider(),
    executor: new FakeStorageExecutor({ directories: { staging: [], movie: [] } }),
    model: stopModel(),
    workflowRunId: "run-test",
    target: { kind: "movie", title: "Inception", aliases: [], year: 2010, qualityPreference: "4K" },
    stagingDirectoryId: "staging",
    targetMovieDirectoryId: "movie",
    originCountries: gates.originCountries,
    storageProvider: gates.storageProvider,
    ...(gates.assrtToken === undefined ? {} : { assrtToken: gates.assrtToken }),
    assrtProvider,
  });
  return state.searchCalls;
}

describe("runAcquisitionV2 subtitle pre-warming gates", () => {
  it("pre-warms when assrtToken set + origin non-CN + drive 115", async () => {
    expect(await runWithGates({ originCountries: ["US"], storageProvider: "pan115", assrtToken: "fake-token" })).toBe(1);
  });

  it("does NOT pre-warm when origin includes CN", async () => {
    expect(await runWithGates({ originCountries: ["CN"], storageProvider: "pan115", assrtToken: "fake-token" })).toBe(0);
  });

  it("does NOT pre-warm when assrtToken is undefined", async () => {
    expect(await runWithGates({ originCountries: ["US"], storageProvider: "pan115" })).toBe(0);
  });

  it("does NOT pre-warm when drive is quark (phase 1 = 115-only)", async () => {
    expect(await runWithGates({ originCountries: ["US"], storageProvider: "quark", assrtToken: "fake-token" })).toBe(0);
  });

  it("does NOT pre-warm when origins include CN alongside others (multi-origin)", async () => {
    expect(await runWithGates({ originCountries: ["CN", "US"], storageProvider: "pan115", assrtToken: "fake-token" })).toBe(0);
  });
});
