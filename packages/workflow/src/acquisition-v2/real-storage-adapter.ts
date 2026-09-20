import type { TransferAttempt } from "../domain.js";
import { parsePan123ShareUrl } from "../pan123-storage-executor.js";
import type { StorageExecutor } from "../ports.js";
import { parseQuarkShareUrl } from "../quark-storage-executor.js";
import { isBrandStorageAuthError } from "../storage-auth-error.js";
import { parseTianyiShareUrl } from "../tianyi-storage-executor.js";
import type { CandidateRegistry } from "./candidate-registry.js";
import { deadLinkKey, deadLinkReason, UNRESOLVED_MAGNET_DEAD_LINK_TTL_MS, type DeadLinkStore } from "./dead-links.js";
import type { SimTreeFile, StorageV2, SubtitleLandingResult, TransferAttemptResult } from "./storage-115-simulator.js";

/**
 * Phase 6 — the real 115 executor as a StorageV2. It maps the V2 sandbox's tool
 * surface onto the fail-loud Storage115Executor: transfers resolve the candidate
 * from the shared registry (the agent only ever passes ids), and the executor's
 * own write-scope / protected-dir / risk-control guards stay in force underneath.
 */
const VIDEO_EXTENSIONS = /\.(mkv|mp4|avi|ts|m2ts|mov|flv|wmv)$/i;
const SUBTITLE_EXTENSIONS = /\.(srt|ass|ssa|sub|idx|vtt|sup|smi)$/i;
const PAN115_SHARE_URL = /^https?:\/\/(115\.com|115cdn\.com|anxia\.com)\/s\//i;

/** Consecutive per-file landing failures after which the rest of a package is
 *  skipped on the per-file fallback path. Each failed landing costs real drive
 *  API calls (offline task + materialization polls + cleanup) and a dead assrt
 *  package fails file after file the same way; a success resets the counter so
 *  mixed flakiness still lands. A brand with a batch method owns this policy
 *  itself (115 stops SUBMITTING after 3 rejections and polls once per round). */
const MAX_CONSECUTIVE_SUBTITLE_FAILURES = 3;

export interface RealStorageV2Options {
  executor: StorageExecutor;
  registry: CandidateRegistry;
  workflowRunId: string;
  /** When set, a transfer PROVEN dead (115 fail-loud / magnet-no-秒传) records the
   *  link so future PanSou searches filter it out before the agent sees it (#15). */
  deadLinkStore?: DeadLinkStore;
}

export class RealStorageV2 implements StorageV2 {
  private readonly executor: StorageExecutor;
  private readonly registry: CandidateRegistry;
  private readonly workflowRunId: string;
  private readonly deadLinkStore: DeadLinkStore | undefined;
  private readonly recordedAttempts: TransferAttempt[] = [];

  constructor(options: RealStorageV2Options) {
    this.executor = options.executor;
    this.registry = options.registry;
    this.workflowRunId = options.workflowRunId;
    this.deadLinkStore = options.deadLinkStore;
  }

  /** Every transfer attempt this run, for the workflow to persist. */
  attempts(): TransferAttempt[] {
    return [...this.recordedAttempts];
  }

  /** Classify a candidate's link from its recorded payload url: a fail-loud
   *  转存分享 (115/夸克/天翼/123 — a dead share errors back immediately) vs a
   *  magnet (silent — success only via the landing point) vs unknown.
   *  transferUntilLanded iterates ONLY "share" candidates (its loop is sound only
   *  when death is loud). Brand share shapes are delegated to each brand's OWN
   *  parser — the same one its executor transfers with — so this classifier can
   *  never drift from what actually transfers (no second domain list). */
  candidateLinkKind(candidateId: string): "share" | "magnet" | "unknown" {
    const url = String(this.registry.get(candidateId)?.providerPayload?.["url"] ?? "");
    if (
      PAN115_SHARE_URL.test(url) ||
      parseQuarkShareUrl(url) !== null ||
      parseTianyiShareUrl(url) !== null ||
      parsePan123ShareUrl(url) !== null
    ) {
      return "share";
    }
    if (/^magnet:/i.test(url)) return "magnet";
    return "unknown";
  }

  /** Record a link as dead when the attempt PROVES it (conservative — see
   *  deadLinkReason). No store, unkeyable url, or non-death outcome → no-op. */
  private async maybeRecordDeadLink(url: unknown, attempt: TransferAttempt): Promise<void> {
    if (!this.deadLinkStore) {
      return;
    }
    const identity = deadLinkKey(String(url ?? ""));
    if (!identity) {
      return;
    }
    const reason = deadLinkReason(attempt, identity.kind);
    if (reason === null) {
      return;
    }
    // A 115 share that fails loud is gone for good (permanent). A magnet is keyed
    // by infohash, whose deadness is time-variable (115 may cache it later, a clean
    // magnet for the same hash may appear) — so it is SOFT (TTL), never permanent.
    // An unresolvable magnet (115 showed the infohash as the name → no metadata, a
    // fake/dead torrent) gets a much longer soft TTL so we don't re-transfer junk.
    const permanent = identity.kind === "pan115";
    const ttlMs = !permanent && /name == infohash/.test(reason) ? UNRESOLVED_MAGNET_DEAD_LINK_TTL_MS : undefined;
    await this.deadLinkStore.recordDeadLink({
      key: identity.key,
      kind: identity.kind,
      reason,
      permanent,
      ...(ttlMs === undefined ? {} : { ttlMs }),
    });
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
    await this.maybeRecordDeadLink(candidate.providerPayload?.["url"], attempt);
    // Only a real materialization counts as success; no_target_change (115 has no
    // cached copy) is a miss the agent must recover from, surfaced as failed +
    // an empty reread. Layer-1: surface providerMessage so the agent sees WHY.
    // The noTargetChange flag rides along so brand-agnostic callers can tell a
    // silent-late async copy (123 — possible FALSE miss) from a loud dead link.
    return {
      status: attempt.status === "succeeded" ? "succeeded" : "failed",
      materializedFileIds: attempt.materializedFileIds,
      ...(attempt.status === "no_target_change" ? { noTargetChange: true as const } : {}),
      ...(attempt.providerMessage ? { providerMessage: attempt.providerMessage } : {}),
    };
  }

  /** Whole-package subtitle landing. Batch-capable executor (115) → one call;
   *  otherwise (光鸭) loop the per-file method under the consecutive-failure
   *  abort. Either way the attempts stay OUT of attempts(): their synthetic
   *  `subtitle:<filename>` candidateIds belong to no snapshot, and persisting them
   *  would abort the run's snapshot save after the video already landed. */
  async transferSubtitleUrls(input: {
    files: Array<{ url: string; filename: string }>;
    intoDirectoryId: string;
  }): Promise<SubtitleLandingResult[]> {
    // Unlike transferCandidate, the subtitle path has no iterate-on-failure consumer
    // (nothing burns "the next candidate" on a miss), so `noTargetChange` is
    // deliberately NOT propagated here — status collapsed to succeeded/failed is all
    // the agent needs to decide keep-going vs. give-up on a soft goal.
    const toResult = (filename: string, attempt: TransferAttempt): SubtitleLandingResult => ({
      filename,
      status: attempt.status === "succeeded" ? "succeeded" : "failed",
      materializedFileIds: attempt.materializedFileIds,
      ...(attempt.providerMessage ? { providerMessage: attempt.providerMessage } : {}),
    });
    if (this.executor.transferSubtitleUrls) {
      let attempts: TransferAttempt[];
      try {
        attempts = await this.executor.transferSubtitleUrls({
          files: input.files,
          directoryId: input.intoDirectoryId,
          workflowRunId: this.workflowRunId,
        });
      } catch (error) {
        // A batch-level throw (write-scope violation, a before-snapshot listTree the
        // guard refused, …) kills the whole package at once. Subtitles are a SOFT
        // goal — the sandbox promises the agent {status:"failed"}, never an {error}
        // — so map it to the same per-file soft failure the fallback loop produces
        // for a thrown per-file error. EXCEPT a dead cookie/token: that is not a
        // landing miss, and softening it would hide the one error the worker freezes
        // the drive on (the video path's transfer() lets it out the same way).
        if (isBrandStorageAuthError(error)) {
          throw error;
        }
        return input.files.map((file) => ({
          filename: file.filename,
          status: "failed" as const,
          materializedFileIds: [],
          providerMessage: error instanceof Error ? error.message : String(error),
        }));
      }
      // The port contract is one attempt per input file, in input order. A brand that
      // drops a file instead of marking it failed would otherwise surface as a bare
      // TypeError that asEvidence turns into an inscrutable {error} for the agent —
      // fail loud by name instead. (Order cannot be cross-checked via candidateId: the
      // 115 executor rewrites it for path-y filenames.) NOT caught by the wrapper
      // above: a contract violation stays loud.
      if (attempts.length !== input.files.length) {
        throw new Error(
          `REAL_STORAGE_SUBTITLE_BATCH_ARITY: executor returned ${attempts.length} attempts for ${input.files.length} files — ` +
            `transferSubtitleUrls must return one attempt per input file, in input order`,
        );
      }
      return input.files.map((file, index) => toResult(file.filename, attempts[index]!));
    }
    if (!this.executor.transferSubtitleUrl) {
      throw new Error("REAL_STORAGE_NO_SUBTITLE_SUPPORT: this storage brand has no transferSubtitleUrl");
    }
    const results: SubtitleLandingResult[] = [];
    let consecutiveFailures = 0;
    let lastError: string | undefined;
    let abortMessage: string | null = null;
    for (let i = 0; i < input.files.length; i += 1) {
      const file = input.files[i]!;
      if (abortMessage !== null) {
        results.push({ filename: file.filename, status: "failed", materializedFileIds: [], providerMessage: abortMessage });
        continue;
      }
      let result: SubtitleLandingResult;
      try {
        result = toResult(
          file.filename,
          await this.executor.transferSubtitleUrl({
            url: file.url,
            filename: file.filename,
            directoryId: input.intoDirectoryId,
            workflowRunId: this.workflowRunId,
          }),
        );
      } catch (error) {
        if (isBrandStorageAuthError(error)) {
          throw error; // dead credential ≠ a landing miss (see the batch catch)
        }
        result = {
          filename: file.filename,
          status: "failed",
          materializedFileIds: [],
          providerMessage: error instanceof Error ? error.message : String(error),
        };
      }
      results.push(result);
      if (result.status === "succeeded") {
        consecutiveFailures = 0;
        continue;
      }
      consecutiveFailures += 1;
      if (result.providerMessage) {
        lastError = result.providerMessage;
      }
      if (consecutiveFailures >= MAX_CONSECUTIVE_SUBTITLE_FAILURES) {
        // Only when files actually remain: when the third consecutive failure is the
        // LAST file nothing was skipped, so the file's own message stands (no
        // "剩余 0 个未尝试" lie riding out to the agent as this package's error).
        const remaining = input.files.length - i - 1;
        if (remaining > 0) {
          abortMessage =
            `已连续 ${MAX_CONSECUTIVE_SUBTITLE_FAILURES} 个字幕文件落盘失败,提前中止(剩余 ${remaining} 个未尝试)。` +
            `字幕是软目标——不要重试,带着已落的继续,或直接只交付视频。${lastError ? ` 最后错误: ${lastError}` : ""}`;
        }
      }
    }
    return results;
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

  async renameFile(input: { directoryId: string; fileId: string; newName: string }): Promise<void> {
    return this.executor.renameFile(input);
  }

  async deleteFiles(input: { directoryId: string; fileIds: string[] }): Promise<{ deleted: string[] }> {
    return this.executor.deleteFiles(input);
  }

  async removeDirectory(input: { directoryId: string }): Promise<{ removed: string[] }> {
    const result = await this.executor.removeDirectory(input.directoryId);
    return { removed: result.removed ? [input.directoryId] : [] };
  }
}
