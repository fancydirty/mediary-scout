import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import {
  FakeResourceProvider,
  FakeStorageExecutor,
  InMemoryWorkflowRepository,
  queueMovieAcquisition,
  runQueuedMovieAcquisition,
  type MediaTitle,
  type QueueClaimOptions,
} from "@media-track/workflow";
import { drainQueueOnce } from "./background-worker";

/**
 * The real chain the in-process worker drives — drain → queued movie runner → claim
 * with the drive filter → repository — for the case from the bug report: the same film
 * queued on 115 and then on 光鸭. Each run's agent waits in its first model call until
 * the test lets it go, so "both going at once" is observable.
 */

const USAGE = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
} as const;

const toolCall = (id: string, name: string, input: unknown) => ({
  content: [{ type: "tool-call" as const, toolCallId: id, toolName: name, input: JSON.stringify(input) }],
  finishReason: { unified: "tool-calls" as const, raw: "tool-calls" as const },
  usage: USAGE,
  warnings: [],
});

/** Searches (after `gate` opens), finds nothing, reports no coverage. */
function gatedNoCoverageModel(gate: Promise<void>, onEnter: () => void) {
  let i = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => {
      i += 1;
      if (i === 1) {
        onEnter();
        await gate;
        return toolCall("c1", "searchResources", { keyword: "护肝人" });
      }
      if (i === 2) return toolCall("c2", "reportNoCoverage", { reason: "no candidates" });
      return {
        content: [{ type: "text" as const, text: "done" }],
        finishReason: { unified: "stop" as const, raw: "stop" as const },
        usage: USAGE,
        warnings: [],
      };
    },
  });
}

const film: MediaTitle = {
  id: "tmdb_movie_1377237",
  tmdbId: 1377237,
  type: "movie",
  title: "护肝人",
  originalTitle: "Liver Man",
  year: 2025,
  aliases: [],
};

const poll = () => new Promise<void>((resolve) => setTimeout(resolve, 2));
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 1000 && !condition(); i += 1) await poll();
  expect(condition()).toBe(true);
}

describe("worker drain → real queued movie runs on two drives", () => {
  it("runs the 115 run and the 光鸭 run at the same time with the setting at 5", async () => {
    const repository = new InMemoryWorkflowRepository();
    const ids = ["run_115", "run_guangya"];
    for (const [index, drive] of ["cs_115", "cs_guangya"].entries()) {
      const queued = await queueMovieAcquisition({
        title: film,
        keyword: "护肝人",
        repository,
        connectedStorageId: drive,
        createWorkflowRunId: () => ids[index]!,
      });
      expect(queued.status).toBe("queued");
    }

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered: string[] = [];
    // Each drive has its own storage, as each connected drive has its own client.
    const storages = new Map([
      ["cs_115", new FakeStorageExecutor()],
      ["cs_guangya", new FakeStorageExecutor()],
    ]);
    const runNext = (claim?: QueueClaimOptions) =>
      runQueuedMovieAcquisition({
        repository,
        resourceProvider: new FakeResourceProvider({ keywordResults: {} }),
        storage: new FakeStorageExecutor(),
        model: gatedNoCoverageModel(gate, () => entered.push("model")),
        moviesParentDirectoryId: "movies_root",
        resolveAccountContext: async (_accountId, drive) => ({ storage: storages.get(drive ?? "")! }),
        ...(claim === undefined ? {} : { claim }),
      });

    const drain = drainQueueOnce({
      runNext,
      runScheduled: async () => undefined,
      concurrency: async () => 5,
      pollMs: 2,
      sleep: poll,
    });

    // Both agents are inside their first model call before either is let go.
    await until(() => entered.length === 2);
    const running = await repository.listActiveWorkflowRuns();
    expect(running.map((snapshot) => snapshot.workflowRun.id).sort()).toEqual(ids);
    expect(running.every((snapshot) => snapshot.workflowRun.status === "running")).toBe(true);

    release();
    expect(await drain).toBe(2);
    expect(await repository.listActiveWorkflowRuns()).toHaveLength(0);
  });

  it("with the setting at 1 the 光鸭 run starts only after the 115 run is done", async () => {
    const repository = new InMemoryWorkflowRepository();
    const ids = ["run_115", "run_guangya"];
    for (const [index, drive] of ["cs_115", "cs_guangya"].entries()) {
      await queueMovieAcquisition({
        title: film,
        keyword: "护肝人",
        repository,
        connectedStorageId: drive,
        createWorkflowRunId: () => ids[index]!,
      });
    }
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered: string[] = [];
    const runNext = (claim?: QueueClaimOptions) =>
      runQueuedMovieAcquisition({
        repository,
        resourceProvider: new FakeResourceProvider({ keywordResults: {} }),
        storage: new FakeStorageExecutor(),
        model: gatedNoCoverageModel(gate, () => entered.push("model")),
        moviesParentDirectoryId: "movies_root",
        ...(claim === undefined ? {} : { claim }),
      });

    const drain = drainQueueOnce({
      runNext,
      runScheduled: async () => undefined,
      concurrency: async () => 1,
      pollMs: 2,
      sleep: poll,
    });

    await until(() => entered.length === 1);
    for (let i = 0; i < 20; i += 1) await poll();
    expect(entered).toHaveLength(1);
    expect((await repository.getWorkflowRunSnapshot("run_guangya"))?.workflowRun.status).toBe("queued");
    release();
    expect(await drain).toBe(2);
  });
});
