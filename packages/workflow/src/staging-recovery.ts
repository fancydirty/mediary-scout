import type { LanguageModel } from "ai";
import type { WorkflowRun } from "./domain.js";
import type { ResourceProvider, StorageExecutor } from "./ports.js";
import type { WorkflowRepository } from "./repository.js";
import { runStagingRecoveryV2AndPersist } from "./runner-v2.js";
import {
  handleWorkflowRunFailure,
  resolveWorkerDeps,
  type AccountWorkerContext,
  type MayStartRun,
  type QueuedType2WorkerResult,
  type ResolveAccountWorkerContext,
} from "./worker.js";

export interface StagingRecoveryTarget {
  stagingDirectoryId: string;
  showDirectoryId: string;
  seasonNumbers: number[];
}

/** What the janitor stored on the queued run. Null when the payload is unusable. */
export function stagingRecoveryTarget(run: Pick<WorkflowRun, "auditEvents">): StagingRecoveryTarget | null {
  for (let index = run.auditEvents.length - 1; index >= 0; index -= 1) {
    const event = run.auditEvents[index];
    if (event?.type !== "staging_recovery_queued") continue;
    const data = event.data ?? {};
    const stagingDirectoryId = data["stagingDirectoryId"];
    const showDirectoryId = data["showDirectoryId"];
    const seasonNumbers = data["seasonNumbers"];
    if (typeof stagingDirectoryId !== "string" || stagingDirectoryId.length === 0) return null;
    if (typeof showDirectoryId !== "string" || showDirectoryId.length === 0) return null;
    if (!Array.isArray(seasonNumbers) || seasonNumbers.some((season) => typeof season !== "number")) return null;
    return { stagingDirectoryId, showDirectoryId, seasonNumbers };
  }
  return null;
}

/**
 * Claim one queued staging_recovery and run it through the normal TV path with
 * the leftover dir as staging. No notification, no push (the caller must not push).
 */
export async function runQueuedStagingRecovery(
  input: AccountWorkerContext & {
    repository: WorkflowRepository;
    resourceProvider: ResourceProvider;
    storage: StorageExecutor;
    model: LanguageModel;
    now?: () => string;
    resolveAccountContext?: ResolveAccountWorkerContext;
    onAuthErrorFreeze?: (storageId: string, reason: string) => Promise<void>;
    mayStartRun?: MayStartRun;
  },
): Promise<QueuedType2WorkerResult> {
  const now = input.now ?? (() => new Date().toISOString());
  if (input.mayStartRun && !input.mayStartRun()) return { status: "idle" };
  const claimed = await input.repository.claimNextQueuedWorkflowRun({ kind: "staging_recovery", now: now() });
  if (!claimed) return { status: "idle" };
  try {
    // Claim already flipped the run to running. A throw here must take the
    // same silent failure path, or the run stays running and blocks the dir.
    const deps = await resolveWorkerDeps(input.resolveAccountContext, claimed.accountId, claimed.connectedStorageId, input);
    const target = stagingRecoveryTarget(claimed.workflowRun);
    if (!target) {
      throw new Error("STAGING_RECOVERY_PAYLOAD: queued run is missing its staging dir");
    }
    const states = (
      await input.repository.listTrackedSeasonStates({
        accountId: claimed.accountId,
        connectedStorageId: claimed.connectedStorageId,
      })
    )
      .filter((state) => state.title.id === claimed.title.id && target.seasonNumbers.includes(state.season.seasonNumber))
      .sort((a, b) => a.season.seasonNumber - b.season.seasonNumber);
    if (states.length === 0) {
      throw new Error("STAGING_RECOVERY_NOT_TRACKED: no season of this title is still tracked");
    }
    const result = await runStagingRecoveryV2AndPersist({
      title: claimed.title,
      seasons: states.map((state) => ({ season: state.season, episodes: state.episodes })),
      lockSeasonNumber: claimed.season.seasonNumber,
      lockAuditEvents: claimed.workflowRun.auditEvents,
      stagingRecovery: {
        showDirectoryId: target.showDirectoryId,
        stagingDirectoryId: target.stagingDirectoryId,
        // Where the janitor found the show: the derived-scope brands must reach it from there.
        categoryDirectoryIds: [deps.storageParentDirectoryId, deps.animeStorageParentDirectoryId].filter(
          (id): id is string => typeof id === "string" && id.length > 0,
        ),
      },
      categoryParentId: "unused",
      resourceProvider: deps.resourceProvider,
      storage: deps.storage,
      model: deps.model,
      repository: input.repository,
      accountId: claimed.accountId,
      connectedStorageId: claimed.connectedStorageId,
      ...(deps.preferredLanguage === undefined ? {} : { preferredLanguage: deps.preferredLanguage }),
      ...(deps.qualityPreference === undefined ? {} : { qualityPreference: deps.qualityPreference }),
      ...(deps.storageProvider === undefined ? {} : { storageProvider: deps.storageProvider }),
      // Subtitles and memory reflection stay off: nothing is searched or transferred,
      // and this run is not one the next acquisition should learn from.
      agentMemory: false,
      workflowRun: {
        id: claimed.workflowRun.id,
        startedAt: claimed.workflowRun.startedAt,
        finishedAt: null,
      },
      now,
    });
    return { status: "ran", workflowRunId: claimed.workflowRun.id, workflowStatus: result.status };
  } catch (error) {
    const handled = await handleWorkflowRunFailure({
      claimed,
      error,
      repository: input.repository,
      now,
      ...(input.onAuthErrorFreeze === undefined ? {} : { onAuthErrorFreeze: input.onAuthErrorFreeze }),
    });
    return handled.status === "auto_requeued"
      ? { status: "ran", workflowRunId: handled.workflowRunId, workflowStatus: "queued" }
      : { status: "failed", workflowRunId: handled.workflowRunId, errorMessage: handled.errorMessage };
  }
}
