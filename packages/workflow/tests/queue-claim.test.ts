import { describe, expect, it, vi } from "vitest";
import {
  claimNextQueuedRun,
  InMemoryWorkflowRepository,
  isRunOrItsSeasonRecord,
  runQueuedMovieAcquisition,
  runQueuedReplaceRequest,
  runQueuedSeriesInitialization,
  runQueuedStagingRecovery,
  runQueuedType2Workflow,
  type QueueClaimOptions,
  type WorkflowKind,
} from "../src/index.js";
import { workflowPersistenceFixture } from "./workflow-fixtures.js";

const NOW = "2026-10-04T15:00:00.000Z";

/** A queued run of `kind` on its own season, so several coexist. */
function queued(id: string, kind: WorkflowKind, connectedStorageId: string | null, startedAt: string) {
  const base = workflowPersistenceFixture();
  const seasonId = `season_${id}`;
  return {
    ...base,
    connectedStorageId,
    season: { ...base.season, id: seasonId },
    workflowRun: { ...base.workflowRun, id, kind, trackedSeasonId: seasonId, status: "queued" as const, startedAt, finishedAt: null },
    episodes: [],
    resourceSnapshots: [],
    decisions: [],
    transferAttempts: [],
    notifications: [],
  };
}

describe("claimNextQueuedRun", () => {
  it("claims past a busy drive and reports the claimed run's drive before anything runs", async () => {
    const repository = new InMemoryWorkflowRepository();
    await repository.saveWorkflowRunSnapshot(queued("on-115", "movie_init", "cs_115", "2026-10-04T14:12:16.000Z"));
    await repository.saveWorkflowRunSnapshot(queued("on-guangya", "movie_init", "cs_guangya", "2026-10-04T14:16:04.000Z"));
    const onClaimed = vi.fn();

    const claimed = await claimNextQueuedRun(repository, "movie_init", NOW, {
      excludeConnectedStorageIds: ["cs_115"],
      onClaimed,
    });

    expect(claimed?.workflowRun.id).toBe("on-guangya");
    expect(onClaimed).toHaveBeenCalledTimes(1);
    expect(onClaimed).toHaveBeenCalledWith({ workflowRunId: "on-guangya", connectedStorageId: "cs_guangya" });
  });

  it("reports nothing when no run is claimable", async () => {
    const repository = new InMemoryWorkflowRepository();
    await repository.saveWorkflowRunSnapshot(queued("on-115", "movie_init", "cs_115", "2026-10-04T14:12:16.000Z"));
    const onClaimed = vi.fn();

    expect(await claimNextQueuedRun(repository, "movie_init", NOW, { excludeConnectedStorageIds: ["cs_115"], onClaimed })).toBeNull();
    expect(onClaimed).not.toHaveBeenCalled();
  });

  it("without options claims the oldest run, as before", async () => {
    const repository = new InMemoryWorkflowRepository();
    await repository.saveWorkflowRunSnapshot(queued("newer", "movie_init", "cs_a", "2026-10-04T14:16:04.000Z"));
    await repository.saveWorkflowRunSnapshot(queued("older", "movie_init", "cs_b", "2026-10-04T14:12:16.000Z"));

    expect((await claimNextQueuedRun(repository, "movie_init", NOW, undefined))?.workflowRun.id).toBe("older");
  });
});

describe("queued runners pass the worker's claim options through", () => {
  // Every runner claims through claimNextQueuedRun, so the worker's drive filter and
  // its claim callback reach the repository whatever kind the next queued run is.
  const unused = {} as never;
  const claim: QueueClaimOptions = { excludeConnectedStorageIds: ["cs_busy"], excludeUnbound: true };
  const runners: Array<[WorkflowKind, (repository: InMemoryWorkflowRepository) => Promise<{ status: string }>]> = [
    ["type2_init", (repository) => runQueuedType2Workflow({ repository, resourceProvider: unused, storage: unused, model: unused, now: () => NOW, claim })],
    [
      "type1_package_init",
      (repository) =>
        runQueuedSeriesInitialization({
          repository,
          resourceProvider: unused,
          storage: unused,
          model: unused,
          storageParentDirectoryId: "tv",
          now: () => NOW,
          claim,
        }),
    ],
    [
      "movie_init",
      (repository) =>
        runQueuedMovieAcquisition({
          repository,
          resourceProvider: unused,
          storage: unused,
          model: unused,
          moviesParentDirectoryId: "movies",
          now: () => NOW,
          claim,
        }),
    ],
    [
      "replace_request",
      (repository) =>
        runQueuedReplaceRequest({
          repository,
          resourceProvider: unused,
          storage: unused,
          model: unused,
          storageParentDirectoryId: "tv",
          moviesParentDirectoryId: "movies",
          now: () => NOW,
          claim,
        }),
    ],
    [
      "staging_recovery",
      (repository) => runQueuedStagingRecovery({ repository, resourceProvider: unused, storage: unused, model: unused, now: () => NOW, claim }),
    ],
  ];

  it.each(runners)("%s", async (kind, run) => {
    const repository = new InMemoryWorkflowRepository();
    // Only queued run of the kind is on the busy drive: filtered out, so the runner is idle.
    await repository.saveWorkflowRunSnapshot(queued("on-busy", kind, "cs_busy", "2026-10-04T14:12:16.000Z"));
    const spy = vi.spyOn(repository, "claimNextQueuedWorkflowRun");

    expect(await run(repository)).toEqual({ status: "idle" });
    expect(spy).toHaveBeenCalledWith({ kind, now: NOW, excludeConnectedStorageIds: ["cs_busy"], excludeUnbound: true });
    expect((await repository.getWorkflowRunSnapshot("on-busy"))?.workflowRun.status).toBe("queued");
  });
});

describe("isRunOrItsSeasonRecord", () => {
  it("matches the run and its per-season records only", () => {
    expect(isRunOrItsSeasonRecord("run_1", "run_1")).toBe(true);
    expect(isRunOrItsSeasonRecord("run_1_s1", "run_1")).toBe(true);
    expect(isRunOrItsSeasonRecord("run_1_s12", "run_1")).toBe(true);
    expect(isRunOrItsSeasonRecord("run_12", "run_1")).toBe(false);
    expect(isRunOrItsSeasonRecord("run_1_sx", "run_1")).toBe(false);
    expect(isRunOrItsSeasonRecord("run_1_s", "run_1")).toBe(false);
    expect(isRunOrItsSeasonRecord("other_run_1_s1", "run_1")).toBe(false);
  });
});
