import type { WorkflowStatus } from "./domain.js";
import type { AgentNodes, ResourceProvider, StorageExecutor } from "./ports.js";
import type { PersistedWorkflowRunSnapshot, WorkflowRepository } from "./repository.js";
import {
  runSeriesInitializationAndPersist,
  runType2InitializationAndPersist,
  runType3MonitoringAndPersist,
} from "./runner.js";
import type { AcquisitionSeasonScope } from "./workflow.js";

export type QueuedType2WorkerResult =
  | {
      status: "idle";
    }
  | {
    status: "ran";
    workflowRunId: string;
    workflowStatus: WorkflowStatus;
  }
  | {
      status: "failed";
      workflowRunId: string;
      errorMessage: string;
    };

export async function runQueuedType2Workflow(input: {
  repository: WorkflowRepository;
  resourceProvider: ResourceProvider;
  storage: StorageExecutor;
  agents: AgentNodes;
  now?: () => string;
  storageParentDirectoryId?: string;
}): Promise<QueuedType2WorkerResult> {
  const now = input.now ?? (() => new Date().toISOString());
  const claimed = await input.repository.claimNextQueuedWorkflowRun({
    kind: "type2_init",
    now: now(),
  });
  if (!claimed) {
    return { status: "idle" };
  }

  const keyword = keywordFromQueuedRun(claimed);
  try {
    const result = await runType2InitializationAndPersist({
      title: claimed.title,
      season: claimed.season,
      keyword,
      resourceProvider: input.resourceProvider,
      storage: input.storage,
      agents: input.agents,
      repository: input.repository,
      ...(input.storageParentDirectoryId === undefined
        ? {}
        : { storageParentDirectoryId: input.storageParentDirectoryId }),
      workflowRun: {
        id: claimed.workflowRun.id,
        startedAt: claimed.workflowRun.startedAt,
        finishedAt: now(),
      },
    });

    return {
      status: "ran",
      workflowRunId: claimed.workflowRun.id,
      workflowStatus: result.status,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Workflow failed";
    await input.repository.saveWorkflowRunSnapshot({
      title: claimed.title,
      season: claimed.season,
      workflowRun: {
        ...claimed.workflowRun,
        status: "failed",
        finishedAt: now(),
        auditEvents: [
          ...claimed.workflowRun.auditEvents,
          {
            type: "workflow_failed",
            message: errorMessage,
          },
        ],
      },
      episodes: [],
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });

    return {
      status: "failed",
      workflowRunId: claimed.workflowRun.id,
      errorMessage,
    };
  }
}

export type ScheduledType3Outcome =
  | {
      trackedSeasonId: string;
      status: "skipped_active";
    }
  | {
      trackedSeasonId: string;
      status: "ran";
      workflowRunId: string;
      workflowStatus: WorkflowStatus;
    }
  | {
      trackedSeasonId: string;
      status: "failed";
      workflowRunId: string;
      errorMessage: string;
    };

/**
 * Unattended Type 3 sweep: one reservation-guarded monitoring run per active
 * tracked season. One season's failure never blocks the rest, and a failed
 * run preserves the season's episode state (unlike a failed Type 2 init,
 * which clears it).
 */
export async function runScheduledType3Monitoring(input: {
  repository: WorkflowRepository;
  resourceProvider: ResourceProvider;
  storage: StorageExecutor;
  agents: AgentNodes;
  storageParentDirectoryId: string;
  now?: () => string;
  createWorkflowRunId?: () => string;
  staleActiveRunTimeoutMs?: number;
}): Promise<ScheduledType3Outcome[]> {
  const now = input.now ?? (() => new Date().toISOString());
  const outcomes: ScheduledType3Outcome[] = [];
  const trackedStates = await input.repository.listTrackedSeasonStates();

  for (const state of trackedStates) {
    if (state.season.status !== "active" || state.episodes.length === 0) {
      continue;
    }
    const workflowRunId = input.createWorkflowRunId?.() ?? crypto.randomUUID();
    const startedAt = now();
    const staleActiveRunStartedBefore = staleStartedBefore(startedAt, input.staleActiveRunTimeoutMs);

    const reservation = await input.repository.reserveWorkflowRun({
      title: state.title,
      season: state.season,
      workflowRun: {
        id: workflowRunId,
        kind: "type3_monitor",
        status: "running",
        trackedSeasonId: state.season.id,
        startedAt,
        finishedAt: null,
        auditEvents: [
          {
            type: "type3_scheduled",
            message: "Scheduled Type 3 monitoring reserved",
          },
        ],
      },
      episodes: state.episodes,
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
      ...(staleActiveRunStartedBefore === null
        ? {}
        : { staleActiveRunStartedBefore, staleFinishedAt: startedAt }),
    });
    if (reservation.status !== "reserved") {
      outcomes.push({ trackedSeasonId: state.season.id, status: "skipped_active" });
      continue;
    }

    try {
      const result = await runType3MonitoringAndPersist({
        title: state.title,
        season: state.season,
        episodes: state.episodes,
        keyword: `${state.title.title} ${state.season.qualityPreference}`.trim(),
        resourceProvider: input.resourceProvider,
        storage: input.storage,
        agents: input.agents,
        repository: input.repository,
        workflowRun: { id: workflowRunId, startedAt, finishedAt: now() },
        storageParentDirectoryId: input.storageParentDirectoryId,
      });
      outcomes.push({
        trackedSeasonId: state.season.id,
        status: "ran",
        workflowRunId,
        workflowStatus: result.status,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Workflow failed";
      await input.repository.saveWorkflowRunSnapshot({
        title: state.title,
        season: state.season,
        workflowRun: {
          id: workflowRunId,
          kind: "type3_monitor",
          status: "failed",
          trackedSeasonId: state.season.id,
          startedAt,
          finishedAt: now(),
          auditEvents: [
            { type: "type3_scheduled", message: "Scheduled Type 3 monitoring reserved" },
            { type: "workflow_failed", message: errorMessage },
          ],
        },
        episodes: state.episodes,
        resourceSnapshots: [],
        decisions: [],
        transferAttempts: [],
        notifications: [],
      });
      outcomes.push({
        trackedSeasonId: state.season.id,
        status: "failed",
        workflowRunId,
        errorMessage,
      });
    }
  }

  return outcomes;
}

function staleStartedBefore(nowIso: string, timeoutMs: number | undefined): string | null {
  if (timeoutMs === undefined) {
    return null;
  }
  if (timeoutMs <= 0) {
    throw new Error("staleActiveRunTimeoutMs must be positive");
  }
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(nowMs)) {
    throw new Error(`Invalid now timestamp: ${nowIso}`);
  }
  return new Date(nowMs - timeoutMs).toISOString();
}

function keywordFromQueuedRun(snapshot: PersistedWorkflowRunSnapshot): string {
  const queuedEvent = snapshot.workflowRun.auditEvents.find(
    (event) => event.type === "tracking_request_queued" && typeof event.data?.["keyword"] === "string",
  );
  if (typeof queuedEvent?.data?.["keyword"] === "string") {
    return queuedEvent.data["keyword"];
  }
  return `${snapshot.title.title} ${snapshot.season.qualityPreference}`.trim();
}

export async function runQueuedSeriesInitialization(input: {
  repository: WorkflowRepository;
  resourceProvider: ResourceProvider;
  storage: StorageExecutor;
  agents: AgentNodes;
  storageParentDirectoryId: string;
  now?: () => string;
}): Promise<QueuedType2WorkerResult> {
  const now = input.now ?? (() => new Date().toISOString());
  const claimed = await input.repository.claimNextQueuedWorkflowRun({
    kind: "type1_package_init",
    now: now(),
  });
  if (!claimed) {
    return { status: "idle" };
  }

  const queuedEvent = claimed.workflowRun.auditEvents.find((event) => event.type === "series_init_queued");
  const seasons = (queuedEvent?.data?.["seasons"] ?? []) as AcquisitionSeasonScope[];
  const keyword =
    typeof queuedEvent?.data?.["keyword"] === "string"
      ? queuedEvent.data["keyword"]
      : `${claimed.title.title} ${claimed.season.qualityPreference}`.trim();

  try {
    if (seasons.length === 0) {
      throw new Error("Queued series initialization run is missing its season metadata");
    }
    const result = await runSeriesInitializationAndPersist({
      title: claimed.title,
      seasons,
      keyword,
      storageParentDirectoryId: input.storageParentDirectoryId,
      resourceProvider: input.resourceProvider,
      storage: input.storage,
      agents: input.agents,
      repository: input.repository,
      workflowRun: {
        id: claimed.workflowRun.id,
        startedAt: claimed.workflowRun.startedAt,
        finishedAt: now(),
      },
    });
    // Finalize the claimed lock run itself; it doubles as season 1's summary
    // record (same tracked season and episode state as the persisted _s1 run).
    const firstSeason = result.seasons[0];
    await input.repository.saveWorkflowRunSnapshot({
      title: claimed.title,
      season: firstSeason?.season ?? claimed.season,
      workflowRun: {
        ...claimed.workflowRun,
        status: result.status,
        finishedAt: now(),
        auditEvents: [...claimed.workflowRun.auditEvents, ...result.auditEvents],
      },
      episodes: firstSeason?.episodes ?? [],
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });
    return {
      status: "ran",
      workflowRunId: claimed.workflowRun.id,
      workflowStatus: result.status,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Workflow failed";
    await input.repository.saveWorkflowRunSnapshot({
      title: claimed.title,
      season: claimed.season,
      workflowRun: {
        ...claimed.workflowRun,
        status: "failed",
        finishedAt: now(),
        auditEvents: [
          ...claimed.workflowRun.auditEvents,
          { type: "workflow_failed", message: errorMessage },
        ],
      },
      episodes: [],
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });
    return { status: "failed", workflowRunId: claimed.workflowRun.id, errorMessage };
  }
}
