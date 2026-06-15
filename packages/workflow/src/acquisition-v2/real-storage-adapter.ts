import type { TransferAttempt } from "../domain.js";
import type { StorageExecutor } from "../ports.js";
import type { CandidateRegistry } from "./candidate-registry.js";
import type { SimTreeFile, StorageV2, TransferAttemptResult } from "./storage-115-simulator.js";

/**
 * Phase 6 — the real 115 executor as a StorageV2. It maps the V2 sandbox's tool
 * surface onto the fail-loud Storage115Executor: transfers resolve the candidate
 * from the shared registry (the agent only ever passes ids), and the executor's
 * own write-scope / protected-dir / risk-control guards stay in force underneath.
 */
const VIDEO_EXTENSIONS = /\.(mkv|mp4|avi|ts|m2ts|mov|flv|wmv)$/i;
const SUBTITLE_EXTENSIONS = /\.(srt|ass|ssa|sub|idx|vtt|sup|smi)$/i;
const PAN115_SHARE_URL = /^https?:\/\/(115\.com|115cdn\.com|anxia\.com)\/s\//i;

export interface RealStorageV2Options {
  executor: StorageExecutor;
  registry: CandidateRegistry;
  workflowRunId: string;
}

export class RealStorageV2 implements StorageV2 {
  private readonly executor: StorageExecutor;
  private readonly registry: CandidateRegistry;
  private readonly workflowRunId: string;
  private readonly recordedAttempts: TransferAttempt[] = [];

  constructor(options: RealStorageV2Options) {
    this.executor = options.executor;
    this.registry = options.registry;
    this.workflowRunId = options.workflowRunId;
  }

  /** Every transfer attempt this run, for the workflow to persist. */
  attempts(): TransferAttempt[] {
    return [...this.recordedAttempts];
  }

  /** Classify a candidate's link from its recorded payload url: a 115 share (fails
   *  loud) vs a magnet (silent — success only via the landing point) vs unknown.
   *  transferUntilLanded uses this to stay 115-only. */
  candidateLinkKind(candidateId: string): "pan115" | "magnet" | "unknown" {
    const url = String(this.registry.get(candidateId)?.providerPayload?.["url"] ?? "");
    if (PAN115_SHARE_URL.test(url)) return "pan115";
    if (/^magnet:/i.test(url)) return "magnet";
    return "unknown";
  }

  async createDirectory(input: { name: string; parentId: string }): Promise<string> {
    return this.executor.createDirectory(input);
  }

  async transferCandidate(input: {
    candidateId: string;
    intoDirectoryId: string;
  }): Promise<TransferAttemptResult> {
    const candidate = this.registry.get(input.candidateId);
    if (!candidate) {
      throw new Error(
        `REAL_STORAGE_CANDIDATE_NOT_REGISTERED: ${input.candidateId} was never observed in a search this run`,
      );
    }
    const attempt = await this.executor.transfer({
      workflowRunId: this.workflowRunId,
      directoryId: input.intoDirectoryId,
      candidate,
    });
    this.recordedAttempts.push(attempt);
    // Only a real materialization counts as success; no_target_change (115 has no
    // cached copy) is a miss the agent must recover from, surfaced as failed +
    // an empty reread.
    return {
      status: attempt.status === "succeeded" ? "succeeded" : "failed",
      materializedFileIds: attempt.materializedFileIds,
    };
  }

  async listTree(input: { directoryId: string }): Promise<SimTreeFile[]> {
    const tree = await this.executor.listTree({ directoryId: input.directoryId });
    return tree.map((file) => ({
      id: file.providerFileId,
      path: file.path,
      sizeBytes: file.sizeBytes,
      isVideo: VIDEO_EXTENSIONS.test(file.path),
      isSubtitle: SUBTITLE_EXTENSIONS.test(file.path),
    }));
  }

  async listSubdirectories(input: { directoryId: string }): Promise<Array<{ id: string; path: string }>> {
    return this.executor.listSubdirectories({ directoryId: input.directoryId });
  }

  async moveFiles(input: { fileIds: string[]; targetDirectoryId: string }): Promise<{ moved: string[] }> {
    return this.executor.moveFiles(input);
  }

  async deleteFiles(input: { directoryId: string; fileIds: string[] }): Promise<{ deleted: string[] }> {
    return this.executor.deleteFiles(input);
  }

  async removeDirectory(input: { directoryId: string }): Promise<{ removed: string[] }> {
    const result = await this.executor.removeDirectory(input.directoryId);
    return { removed: result.removed ? [input.directoryId] : [] };
  }
}
