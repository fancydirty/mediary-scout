import type { LanguageModel } from "ai";
import type { ResourceProvider, StorageExecutor } from "../ports.js";
import type { AcquisitionAgentResult } from "./agent-loop.js";
import { CandidateRegistry } from "./candidate-registry.js";
import { RealResourceProviderV2 } from "./real-provider-adapter.js";
import { RealStorageV2 } from "./real-storage-adapter.js";
import { TaskSandbox } from "./sandbox.js";
import {
  needForMovie,
  needForTvTarget,
  runMovieTaskAgent,
  runTvAnimeTaskAgent,
  type MovieTarget,
  type TvAnimeTarget,
} from "./task-agents.js";

/**
 * Phase 6 — the composition root. Given the real provider + executor, a model,
 * a target, and the already-resolved scoped handles, it wires the registry +
 * both real adapters + the task sandbox (with the coverage need) and runs the
 * matching strong task agent's loop. This is the inner orchestration; the outer
 * workflow still owns resolving the handles (show/staging/season dirs) from the
 * media DB and persisting the trace.
 */
export type AcquisitionV2Target =
  | ({ kind: "tv" } & TvAnimeTarget)
  | ({ kind: "movie" } & MovieTarget);

export interface RunAcquisitionV2Request {
  provider: ResourceProvider;
  executor: StorageExecutor;
  model: LanguageModel;
  workflowRunId: string;
  target: AcquisitionV2Target;
  /** The scoped staging dir (under the show dir / storage parent — NEVER inside the Season dir). */
  stagingDirectoryId: string;
  /** The scoped Season N dir (TV) or movie dir (movie) this task may write into. */
  targetDirectoryId: string;
  searchBudget?: number;
  maxSteps?: number;
  preferredLanguage?: string;
}

export async function runAcquisitionV2(request: RunAcquisitionV2Request): Promise<AcquisitionAgentResult> {
  const registry = new CandidateRegistry();
  const provider = new RealResourceProviderV2({
    provider: request.provider,
    registry,
    workflowRunId: request.workflowRunId,
  });
  const storage = new RealStorageV2({
    executor: request.executor,
    registry,
    workflowRunId: request.workflowRunId,
  });
  const need = request.target.kind === "tv" ? needForTvTarget(request.target) : needForMovie();
  const sandbox = new TaskSandbox({
    provider,
    storage,
    stagingDirectoryId: request.stagingDirectoryId,
    targetSeasonDirectoryId: request.targetDirectoryId,
    need,
    ...(request.searchBudget === undefined ? {} : { searchBudget: request.searchBudget }),
  });

  const common = {
    sandbox,
    model: request.model,
    ...(request.maxSteps === undefined ? {} : { maxSteps: request.maxSteps }),
    ...(request.preferredLanguage === undefined ? {} : { preferredLanguage: request.preferredLanguage }),
  };

  if (request.target.kind === "tv") {
    const { kind: _kind, ...target } = request.target;
    return runTvAnimeTaskAgent({ ...common, target });
  }
  const { kind: _kind, ...target } = request.target;
  return runMovieTaskAgent({ ...common, target });
}
