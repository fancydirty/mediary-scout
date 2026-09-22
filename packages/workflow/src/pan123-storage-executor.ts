/**
 * 123网盘 (123pan / yun.123pan.com) StorageExecutor — the brand-5 analogue of
 * TianyiStorageExecutor / QuarkStorageExecutor / GuangYaStorageExecutor, over
 * Pan123Client. Implements the 12 StorageExecutor port methods.
 *
 * Transfer paths (dual, like 115):
 *  - 123 分享链 → client.saveShare (listShareDir → file/copy/async) + settle-poll
 *  - magnet/ed2k/http 离线 → resolveOffline → submitOffline → poll getOfflineTask
 *    (OpenList drivers/123 OfflineDownload; status 0=run 1=fail 2=ok)
 *
 * Other brand notes:
 *  - Deletion via client.trash; move via client.moveFiles({fileIds, targetParentId}).
 *  - Write-scope is DERIVED-SCOPE (no parent-walk API): createDirectory /
 *    listSubdirectories register nested ids under already-in-scope parents.
 *    assertWithinWriteScope is SYNCHRONOUS.
 *  - Personal-cloud root id is `"0"` (always protected).
 */
import type { PackageTreeFile, ResourceCandidate, TransferAttempt, TransferStatus, VerifiedFile } from "./domain.js";
import { episodeCodeFromFileName } from "./episode-code.js";
import { isPan123AuthError } from "./pan123-client.js";
import type { Pan123Client, Pan123Item, Pan123OfflineTask } from "./pan123-client.js";
import type { StorageExecutor, UnparsedVideoFile } from "./ports.js";

const MAX_RECURSIVE_COLLECT_DEPTH = 6;
const DEFAULT_MIN_VIDEO_SIZE_BYTES = 10 * 1024 * 1024;
/** /file/copy/async is server-side async — the copy is still queuing when saveShare
 *  returns. Poll the target dir this many times (aligned with the real-run probe:
 *  8 × 2500ms) before concluding nothing landed. */
const DEFAULT_TRANSFER_SETTLE_POLL_ATTEMPTS = 8;
const DEFAULT_TRANSFER_SETTLE_POLL_INTERVAL_MS = 2500;
const OFFLINE_TASK_DELETE_MAX_ATTEMPTS = 3;
const OFFLINE_TASK_DELETE_RETRY_DELAY_MS = 250;
/** Consecutive subtitle files that failed to get a task — resolve dead (after its one
 *  retry) or submit refused — after which the rest of the package is not attempted:
 *  a dead assrt mirror rejects every url the same way, and an exhausted offline
 *  quota refuses every submit the same way. */
const SUBTITLE_MAX_CONSECUTIVE_FAILED_FILES = 3;
/** Consecutive non-auth task/list errors after which the subtitle poll stops early
 *  (not an error: the claim from the directory still decides every file). */
const SUBTITLE_MAX_CONSECUTIVE_POLL_ERRORS = 3;
/** A subtitle lands 6–12 s after its OWN submit (真机 2026-09-22). When the poll is
 *  abandoned early, the claim listing waits until this long after the last submit,
 *  so the tail is not reported "not landed" (and then cancelled by the cleanup). */
const SUBTITLE_LANDING_GRACE_MS = 15_000;
/** 个人云根目录 id — a plain non-empty id (unlike 光鸭's "" root). */
const PAN123_ROOT_FOLDER_ID = "0";

const DEFAULT_VIDEO_EXTENSIONS = [
  ".mp4",
  ".mkv",
  ".avi",
  ".mov",
  ".wmv",
  ".flv",
  ".webm",
  ".m4v",
  ".mpg",
  ".mpeg",
  ".ts",
  ".m2ts",
];

export interface Pan123StorageExecutorOptions {
  client: Pan123Client;
  /** Directory ids inside which writes/deletes are allowed (the drive's scope
   *  roots: rootDir + Movies/TV/Anime). Empty = allow all (dev only). */
  writeScopeDirectoryIds?: string[];
  /** Directories that may never be removed or recursively listed (account root
   *  "0" is always included). */
  protectedDirectoryIds?: string[];
  minVideoSizeBytes?: number;
  videoExtensions?: string[];
  /** Bounded settle-poll for the async copy (default 8, aligned with the probe). */
  transferSettlePollAttempts?: number;
  /** Interval between settle-poll reads in ms (default 2500, aligned with the probe). */
  transferSettlePollIntervalMs?: number;
  /** Offline-task poll caps (magnet path). Default 60 × 3s ≈ 3min, mirrors 光鸭. */
  offlineTaskPollMaxPolls?: number;
  offlineTaskPollIntervalMs?: number;
  /** Subtitle-landing poll caps (transferSubtitleUrls), SEPARATE from the video
   *  offline caps above — a ~100KB subtitle lands in seconds or effectively never
   *  (真机 2026-09-21: http task 0→2 in ~7s). Default 16 × 3s ≈ 48s, same budget
   *  as 115/光鸭. */
  subtitleTaskPollMaxPolls?: number;
  subtitleTaskPollIntervalMs?: number;
  /** How long after a subtitle batch starts a file may still START (default
   *  210 000 ms); a file whose turn comes later is not attempted. The check gates the
   *  start only: a file that began inside the window may finish resolving after it
   *  (its resolve + one retry); subtitleLinkLifetimeMs re-checks right before the submit.
   *  assrt download links expire ~5 min after detail() and 123 fetches the url at
   *  SUBMIT time, not at resolve time (真机 2026-09-22: a link was HTTP 200 at 4 min
   *  and 402 at 6 min; a url resolved and then submitted 300 s later failed within
   *  6 s). */
  subtitleSubmitWindowMs?: number;
  /** Re-checked right before each subtitle SUBMIT (default 240 000 ms = the longest
   *  time after detail() a link was observed alive, 真机 2026-09-22): a file that
   *  started inside subtitleSubmitWindowMs but whose resolve (worst case two 60 s
   *  timeouts + the retry delay) ended later is not submitted — 123 would fetch a dead
   *  link at submit time. */
  subtitleLinkLifetimeMs?: number;
  /** Delay before the ONE retry of a failed (non-auth) subtitle resolve (default
   *  2000 ms): some err_code=3 are transient assrt 503s (assrt answers a burst of
   *  requests from one source with 503, 真机 2026-09-22). */
  subtitleResolveRetryDelayMs?: number;
  /** Sleep primitive — injected so tests can advance the poll without real waiting. */
  sleep?: (ms: number) => Promise<void>;
  /** Clock for the subtitle deadlines (submit window, link lifetime, landing grace) —
   *  injected so tests can advance time (default performance.now: monotonic). */
  now?: () => number;
}

interface VideoFact {
  file: VerifiedFile;
  sourceDirectoryId: string;
  sizeBytes: number;
}

type Pan123OfflineResource = Awaited<ReturnType<Pan123Client["resolveOffline"]>>;

/** One offline task a subtitle batch created. `state` is what task/list last said:
 *  "failed" = status 1, "done" = status 2 (still verified against the directory),
 *  "waiting" = 0/3 or never seen. */
interface SubtitleTask {
  index: number;
  taskId: string;
  landingName: string;
  filename: string;
  state: "waiting" | "done" | "failed";
}

/** Match landed subtitle files to the tasks that produced them, ONE-TO-ONE, from the
 *  new files of ONE listing (the directory is the truth; the task row has no file id).
 *  Tiers run across ALL tasks before the next tier starts, so one task's fallback can
 *  never take another task's exact hit: the resolved landing name, then the assrt
 *  filename, then 123's numbered twin of either (123 never overwrites — a name already
 *  in the directory lands as name(1).ext). Returns task → the claimed directory entry. */
function claimSubtitleLandings(tasks: SubtitleTask[], newFiles: Pan123Item[]): Map<SubtitleTask, Pan123Item> {
  const pool = [...newFiles];
  const claimed = new Map<SubtitleTask, Pan123Item>();
  const tiers: Array<(task: SubtitleTask, name: string) => boolean> = [
    (task, name) => name === task.landingName,
    (task, name) => name === task.filename,
    (task, name) => isNumberedTwin(name, task.landingName),
    (task, name) => isNumberedTwin(name, task.filename),
  ];
  for (const matches of tiers) {
    for (const task of tasks) {
      if (claimed.has(task)) {
        continue;
      }
      const at = pool.findIndex((it) => matches(task, it.name));
      if (at >= 0) {
        claimed.set(task, pool[at]!);
        pool.splice(at, 1);
      }
    }
  }
  return claimed;
}

/** `Show.S01E01(1).ass` is a numbered twin of `Show.S01E01.ass` (and `name(2)` of
 *  `name`): 123's rename when the plain name is taken. */
function isNumberedTwin(candidate: string, original: string): boolean {
  const dot = original.lastIndexOf(".");
  const stem = dot > 0 ? original.slice(0, dot) : original;
  const ext = dot > 0 ? original.slice(dot) : "";
  if (!candidate.startsWith(`${stem}(`) || !candidate.endsWith(`)${ext}`)) {
    return false;
  }
  return /^\d+$/.test(candidate.slice(stem.length + 1, candidate.length - ext.length - 1));
}

export class Pan123StorageExecutor implements StorageExecutor {
  private readonly client: Pan123Client;
  private readonly writeScopeDirectoryIds: Set<string>;
  /** Ids of nested dirs find-or-created (createDirectory) or discovered under an
   *  already-in-scope parent (listSubdirectories, PR#58) during this run. They
   *  become authorized write targets — 123 has no parent-walk API to verify them
   *  otherwise. Consulted by assertWithinWriteScope / isWithinWriteScope. */
  private readonly derivedScopeIds = new Set<string>();
  private readonly protectedDirectoryIds: Set<string>;
  private readonly minVideoSizeBytes: number;
  private readonly videoExtensions: Set<string>;
  private readonly transferSettlePollAttempts: number;
  private readonly transferSettlePollIntervalMs: number;
  private readonly offlineTaskPollMaxPolls: number;
  private readonly offlineTaskPollIntervalMs: number;
  private readonly subtitleTaskPollMaxPolls: number;
  private readonly subtitleTaskPollIntervalMs: number;
  private readonly subtitleSubmitWindowMs: number;
  private readonly subtitleLinkLifetimeMs: number;
  private readonly subtitleResolveRetryDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private nextTransferNumber = 1;

  constructor(options: Pan123StorageExecutorOptions) {
    this.client = options.client;
    this.writeScopeDirectoryIds = new Set(options.writeScopeDirectoryIds ?? []);
    this.protectedDirectoryIds = new Set([
      PAN123_ROOT_FOLDER_ID,
      ...(options.protectedDirectoryIds ?? []),
    ]);
    this.minVideoSizeBytes = options.minVideoSizeBytes ?? DEFAULT_MIN_VIDEO_SIZE_BYTES;
    this.videoExtensions = new Set(
      (options.videoExtensions ?? DEFAULT_VIDEO_EXTENSIONS).map((ext) => ext.toLowerCase()),
    );
    this.transferSettlePollAttempts =
      options.transferSettlePollAttempts ?? DEFAULT_TRANSFER_SETTLE_POLL_ATTEMPTS;
    this.transferSettlePollIntervalMs =
      options.transferSettlePollIntervalMs ?? DEFAULT_TRANSFER_SETTLE_POLL_INTERVAL_MS;
    this.offlineTaskPollMaxPolls = options.offlineTaskPollMaxPolls ?? 60;
    this.offlineTaskPollIntervalMs = options.offlineTaskPollIntervalMs ?? 3000;
    this.subtitleTaskPollMaxPolls = options.subtitleTaskPollMaxPolls ?? 16;
    this.subtitleTaskPollIntervalMs = options.subtitleTaskPollIntervalMs ?? 3000;
    this.subtitleSubmitWindowMs = options.subtitleSubmitWindowMs ?? 210_000;
    this.subtitleLinkLifetimeMs = options.subtitleLinkLifetimeMs ?? 240_000;
    this.subtitleResolveRetryDelayMs = options.subtitleResolveRetryDelayMs ?? 2000;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    // Monotonic: the subtitle deadlines (window, link lifetime, landing grace) are
    // durations, and a wall clock that steps (NTP) would stretch or cut them.
    this.now = options.now ?? (() => performance.now());
  }

  async createDirectory(input: { name: string; parentId: string }): Promise<string> {
    const safeParentId = this.assertWithinWriteScope(input.parentId, "create directory");
    // Find-or-create: seasons of one title initialize at different times and must
    // land under the SAME show directory (123 happily makes duplicate folders).
    const items = await this.client.listFiles(safeParentId);
    for (const item of items) {
      if (isDirectory(item) && nameOf(item) === input.name) {
        const existingId = idOf(item);
        if (existingId) {
          // Authorize this nested dir as a future write target (it lives under an
          // already-in-scope parent). Covers both the find-existing and create branches.
          this.derivedScopeIds.add(existingId);
          return existingId;
        }
      }
    }
    const createdId = await this.client.createFolder({ name: input.name, parentId: safeParentId });
    this.derivedScopeIds.add(createdId);
    return createdId;
  }

  async listVideoFiles(directoryId: string): Promise<VerifiedFile[]> {
    const safe = this.assertSafeRecursiveListTarget(directoryId, "list videos in");
    const videos = await this.collectVideos(safe, safe);
    return videos.map((v) => v.file);
  }

  async listUnparsedVideoFiles(directoryId: string): Promise<UnparsedVideoFile[]> {
    const safe = this.assertSafeRecursiveListTarget(directoryId, "list unparsed videos in");
    return this.collectUnparsedVideos(safe);
  }

  async renameFile(input: { directoryId: string; fileId: string; newName: string }): Promise<void> {
    this.assertWithinWriteScope(input.directoryId, "rename file");
    await this.client.renameFile({ fileId: input.fileId, name: input.newName });
  }

  async transfer(input: {
    workflowRunId: string;
    directoryId: string;
    candidate: ResourceCandidate;
  }): Promise<TransferAttempt> {
    const url = stringValue(input.candidate.providerPayload["url"]);
    // Share https stays on saveShare; only magnet-typed / magnet:/ed2k: go offline.
    // (http offline exists on 123 but we don't route bare https here — that would
    // steal 123 share URLs.)
    const useOffline =
      input.candidate.type === "magnet" || url.startsWith("magnet:") || url.startsWith("ed2k:");

    const safe = this.assertWithinWriteScope(input.directoryId, "transfer"); // 同步(derived-scope)
    const before = new Set((await this.listVideoFiles(safe)).map((f) => f.id));

    let providerMessage = "";
    try {
      if (useOffline) {
        await this.transferOfflineMagnet({ url, targetDirId: safe });
      } else {
        const parsed = parsePan123ShareUrl(url);
        if (!parsed) {
          throw new Error(`PAN123_TRANSFER_FAILED: unparseable 123 share url: ${url.slice(0, 60)}`);
        }
        const accessCode =
          stringValue(input.candidate.providerPayload["password"]) || parsed.sharePwd;
        const result = await this.client.saveShare({
          shareKey: parsed.shareKey,
          sharePwd: accessCode,
          targetParentId: safe,
        });
        if (!result.ok) {
          // ok:false with an EMPTY message must never be reclassified as
          // success/no_target_change — fall back to a loud generic reason.
          providerMessage = result.message || "转存失败(provider 未给原因)"; // dead share / 提取码错 / 空分享
        }
      }
    } catch (error) {
      // Auth failures must surface so the worker freezes the drive — never absorbed.
      if (isPan123AuthError(error)) {
        throw error;
      }
      // Any other failure (dead magnet / dead share / bad params) is a FAILED
      // attempt with a loud message; the agent moves to the next candidate.
      providerMessage = error instanceof Error ? error.message : String(error);
    }

    let materializedFileIds: string[] = [];
    if (providerMessage) {
      // Already failed — no point polling. Still diff once so a PARTIAL landing
      // (some files copied before the block) is reported alongside the failure.
      materializedFileIds = (await this.listVideoFiles(safe))
        .filter((f) => !before.has(f.id))
        .map((f) => f.id);
    } else {
      // Both copy/async and offline task completion can race the directory index:
      // poll until new videos appear. Exhausting the budget while still empty =
      // genuinely nothing landed → no_target_change is correct.
      for (let attempt = 0; attempt < this.transferSettlePollAttempts; attempt++) {
        const after = await this.listVideoFiles(safe);
        materializedFileIds = after.filter((f) => !before.has(f.id)).map((f) => f.id);
        if (materializedFileIds.length > 0) {
          break;
        }
        if (attempt < this.transferSettlePollAttempts - 1) {
          await this.sleep(this.transferSettlePollIntervalMs);
        }
      }
    }
    const status: TransferStatus = providerMessage
      ? "failed"
      : materializedFileIds.length > 0
        ? "succeeded"
        : "no_target_change";

    const emptyHint = useOffline
      ? "离线任务完成但目标目录未出现新视频"
      : "转存完成但目标目录未出现新视频";
    const attempt: TransferAttempt = {
      id: `${input.workflowRunId}_transfer_${this.nextTransferNumber}`,
      workflowRunId: input.workflowRunId,
      candidateId: input.candidate.id,
      status,
      providerMessage: providerMessage || (status === "no_target_change" ? emptyHint : ""),
      materializedFileIds,
    };
    this.nextTransferNumber += 1;
    return attempt;
  }

  /** Subtitle direct-link landing, single file — delegates to the batch (the
   *  capability gate the orchestrator probes is THIS method). */
  async transferSubtitleUrl(input: {
    url: string;
    filename: string;
    directoryId: string;
    workflowRunId: string;
  }): Promise<TransferAttempt> {
    const [attempt] = await this.transferSubtitleUrls({
      files: [{ url: input.url, filename: input.filename }],
      directoryId: input.directoryId,
      workflowRunId: input.workflowRunId,
    });
    return attempt!;
  }

  /** Whole-package subtitle landing via 123's native http offline download, as a
   *  PER-FILE PIPELINE: resolve one url → submit it at once → next file; then ONE
   *  unified poll of every created task; then each landing is claimed by NAME from
   *  ONE directory listing — the directory is the truth, the task row is not.
   *
   *  Why per-file (真机 2026-09-22: a 75-file package landed 0/75 when every url was
   *  resolved first and all were submitted at the end; 3 self-cleaning probes then
   *  showed why):
   *   - assrt download links expire ~5 min after the package detail was fetched
   *     (HTTP 200 at 4 min, 402 at 6 min) and 123 downloads the url at SUBMIT time,
   *     not at resolve time; one resolve takes ~5–6 s (123 fetches assrt server-
   *     side), so 75 resolves (6–7 min) handed the final submit dead links;
   *   - one submit carrying 20 resources returned 20 task ids whose tasks never
   *     existed (silent failure; 5–6 were fine) — only single-resource submits;
   *   - resolve → immediate single submit landed 23/23 in 139 s, each file 6–12 s
   *     after its own submit.
   *  Guards: a file not reached within `subtitleSubmitWindowMs` of the batch start is
   *  not attempted (its link would be dead by submit time), and one whose resolve ended
   *  past `subtitleLinkLifetimeMs` is not submitted; a non-auth resolve
   *  failure is retried once after `subtitleResolveRetryDelayMs` (some err_code=3
   *  are transient assrt 503s); 3 consecutive files that got no task (resolve dead or
   *  submit refused) abort the rest — a dead mirror, an exhausted offline quota. Non-
   *  auth poll / claim-listing errors are tolerated (an abandoned poll still waits
   *  out a landing grace before the claim); a Pan123AuthError always propagates, and
   *  the created tasks are deleted either way. 123 never overwrites: a name already
   *  in the directory lands as name(1).ext, which the claim accepts as a fallback.
   *  Still true from 真机 2026-09-21: ONE url per resolve; resolve reports the
   *  landing `name`; the task row carries NO file id; the file lands directly in
   *  upload_dir (no wrapper); deleting a finished task keeps the file.
   *  Cost: 1 before-listing + per file 1 resolve (+1 retry) + 1 submit + p polls +
   *  1 claim-listing + 1 delete; a listing is ⌈entries/100⌉ requests (listFiles pages
   *  by 100), and both must be COMPLETE — a partial before-snapshot would let a stale
   *  same-named file be claimed, and new files can sit on any page. */
  async transferSubtitleUrls(input: {
    files: Array<{ url: string; filename: string }>;
    directoryId: string;
    workflowRunId: string;
  }): Promise<TransferAttempt[]> {
    // The links' ~5 min clock started even earlier (at detail()) — start ours at once.
    const batchStart = this.now();
    const firstNumber = this.nextTransferNumber;
    this.nextTransferNumber += input.files.length;
    const attempts: TransferAttempt[] = input.files.map((file, index) => ({
      id: `${input.workflowRunId}_subtitle_${firstNumber + index}`,
      workflowRunId: input.workflowRunId,
      candidateId: `subtitle:${file.filename}`,
      status: "failed",
      providerMessage: "",
      materializedFileIds: [],
    }));

    // Boundary (zero API): path-y names pollute the id and the name match; a
    // duplicate name could never be told apart from its twin once both land.
    const packageNames = new Set<string>();
    const pending = new Map<number, { url: string; filename: string }>();
    input.files.forEach((file, index) => {
      const attempt = attempts[index]!;
      if (/[\\/]/.test(file.filename)) {
        attempt.candidateId = `subtitle:invalid_name_${firstNumber + index}`;
        attempt.providerMessage =
          "SUBTITLE_INVALID_FILENAME: filename must be a bare name without path separators (路径分隔符)";
        return;
      }
      if (packageNames.has(file.filename)) {
        attempt.providerMessage = "SUBTITLE_DUPLICATE_FILENAME: a same-named file is already in this package";
        return;
      }
      packageNames.add(file.filename);
      pending.set(index, file);
    });
    if (pending.size === 0) {
      return attempts;
    }

    const safe = this.assertWithinWriteScope(input.directoryId, "transfer subtitle"); // sync, derived scope
    // BEFORE snapshot: only a same-named file that APPEARS after submission counts
    // (a leftover from an earlier attempt must not fake a success).
    const beforeIds = new Set((await this.client.listFiles(safe)).map((it) => it.id));

    const tasks: SubtitleTask[] = []; // every task this batch created, in input order
    let mainFlowCompleted = false;
    try {
      // Per-file pipeline, in input order: resolve (one retry) → submit at once.
      // ONE counter for files that got no task, whichever step refused them; only a
      // created task resets it (a resolve that succeeds into a refused submit does not).
      let consecutiveFailedFiles = 0;
      // Widened with `as`: they are assigned only inside failFile, and a plain
      // `: string | null = null` would let TypeScript narrow them to null for good.
      let lastFailure = null as string | null;
      let abortReason = null as string | null;
      let lastSubmitAt = batchStart;
      const failFile = (attempt: TransferAttempt, message: string) => {
        attempt.providerMessage = message;
        lastFailure = message;
        consecutiveFailedFiles += 1;
        if (consecutiveFailedFiles >= SUBTITLE_MAX_CONSECUTIVE_FAILED_FILES) {
          abortReason = `aborted after ${SUBTITLE_MAX_CONSECUTIVE_FAILED_FILES} consecutive files failed to submit (last: ${message})`;
        }
      };
      for (const [index, file] of pending) {
        const attempt = attempts[index]!;
        if (abortReason !== null) {
          attempt.providerMessage = `SUBTITLE_NOT_SUBMITTED: ${abortReason}`;
          continue;
        }
        if (this.now() - batchStart > this.subtitleSubmitWindowMs) {
          // "Package too big" only holds when something WAS submitted; with nothing
          // submitted the window ran out on slow failures, and the last one is the
          // actionable fact.
          attempt.providerMessage =
            tasks.length > 0
              ? `SUBTITLE_NOT_SUBMITTED: 字幕直链约 5 分钟过期,整包太大,有效期内只提交了前 ${tasks.length} 个;本文件未尝试`
              : lastFailure !== null
                ? `SUBTITLE_NOT_SUBMITTED: 字幕直链约 5 分钟过期,有效期内一个文件都没提交成功(最近一次失败: ${lastFailure});本文件未尝试`
                : "SUBTITLE_NOT_SUBMITTED: 字幕直链约 5 分钟过期,开始提交前有效期已过;本文件未尝试";
          continue;
        }
        let resource: Pan123OfflineResource;
        try {
          resource = await this.resolveSubtitleUrl(file.url);
        } catch (error) {
          if (isPan123AuthError(error)) {
            throw error;
          }
          failFile(attempt, errorMessageOf(error));
          continue;
        }
        // The window gated the START; a slow resolve can still end past the link's life.
        if (this.now() - batchStart > this.subtitleLinkLifetimeMs) {
          failFile(
            attempt,
            `SUBTITLE_NOT_SUBMITTED: 字幕直链约 5 分钟过期,本文件解析完成时已超过 ${Math.round(this.subtitleLinkLifetimeMs / 1000)} 秒,提交也会落空;本文件未提交`,
          );
          continue;
        }
        try {
          const taskId = await this.client.submitOffline({
            resourceId: resource.resourceId,
            fileIds: resource.fileIds,
            uploadDirId: safe,
          });
          lastSubmitAt = this.now();
          consecutiveFailedFiles = 0;
          tasks.push({
            index,
            taskId,
            landingName: resource.resolvedName || file.filename,
            filename: file.filename,
            state: "waiting",
          });
        } catch (error) {
          if (isPan123AuthError(error)) {
            throw error;
          }
          const message = errorMessageOf(error);
          failFile(
            attempt,
            message.startsWith("PAN123_OFFLINE_SUBMIT_FAILED:") ? message : `PAN123_OFFLINE_SUBMIT_FAILED: ${message}`,
          );
        }
      }

      // Unified poll: ONE task/list call per round for every task still waiting;
      // sleep only BETWEEN rounds. status 2 = done (the directory still decides),
      // 1 = failed (fixed template — never the uploader-controlled task.name),
      // 0/3/absent = keep waiting. A non-auth poll error is tolerated; 3 in a row
      // stop the poll early.
      let consecutivePollErrors = 0;
      let pollAbandoned = false;
      for (let round = 0; round < this.subtitleTaskPollMaxPolls; round++) {
        const waiting = new Map(tasks.filter((t) => t.state === "waiting").map((t) => [t.taskId, t]));
        if (waiting.size === 0) {
          break;
        }
        if (round > 0) {
          await this.sleep(this.subtitleTaskPollIntervalMs);
        }
        let rows: Pan123OfflineTask[];
        try {
          rows = await this.client.listOfflineTasks([...waiting.keys()]);
        } catch (error) {
          if (isPan123AuthError(error)) {
            throw error;
          }
          consecutivePollErrors += 1;
          if (consecutivePollErrors >= SUBTITLE_MAX_CONSECUTIVE_POLL_ERRORS) {
            pollAbandoned = true;
            break;
          }
          continue;
        }
        consecutivePollErrors = 0;
        for (const row of rows) {
          const task = waiting.get(row.taskId);
          if (!task) {
            continue;
          }
          if (row.status === 2) {
            task.state = "done";
          } else if (row.status === 1) {
            task.state = "failed";
            attempts[task.index]!.providerMessage = `PAN123_OFFLINE_FAILED: offline task failed at progress=${row.progress}`;
          }
        }
      }

      // Claim from ONE listing — the task row has no file id, and a task still
      // waiting (or never seen in task/list) may well have landed.
      const claimable = tasks.filter((t) => t.state !== "failed");
      if (pollAbandoned && claimable.length > 0) {
        // Capped: a wall clock that steps back must not turn this into an hour-long sleep.
        const wait = Math.min(SUBTITLE_LANDING_GRACE_MS, SUBTITLE_LANDING_GRACE_MS - (this.now() - lastSubmitAt));
        if (wait > 0) {
          await this.sleep(wait);
        }
      }
      if (claimable.length > 0) {
        let listing: Pan123Item[] | null = null;
        let listingError = "";
        try {
          listing = await this.client.listFiles(safe);
        } catch (error) {
          if (isPan123AuthError(error)) {
            throw error;
          }
          listingError = errorMessageOf(error);
        }
        const claimed =
          listing === null
            ? new Map<SubtitleTask, Pan123Item>()
            : claimSubtitleLandings(
                claimable,
                listing.filter((it) => !it.isFolder && !beforeIds.has(it.id)),
              );
        for (const task of claimable) {
          const attempt = attempts[task.index]!;
          const landed = claimed.get(task);
          if (landed !== undefined) {
            attempt.status = "succeeded";
            attempt.materializedFileIds = [landed.id];
            // The real name: resolvedName or 123's name(1).ext twin, not always the input.
            attempt.materializedNames = [landed.name];
            attempt.providerMessage = "";
            continue;
          }
          attempt.status = "no_target_change";
          attempt.providerMessage =
            listing === null
              ? `SUBTITLE_NOT_LANDED: 认领时列目录失败: ${listingError}`
              : task.state === "done"
                ? "SUBTITLE_NOT_LANDED: 任务报告完成但文件不在目标目录"
                : "SUBTITLE_NOT_LANDED: 离线任务在轮询窗口内未落盘(已放弃等待)";
        }
      }
      mainFlowCompleted = true;
    } finally {
      if (tasks.length > 0) {
        await this.deleteSubtitleTasks(tasks.map((t) => t.taskId), mainFlowCompleted);
      }
    }
    return attempts;
  }

  /** One subtitle url → offline resource. A non-auth failure is retried ONCE after
   *  subtitleResolveRetryDelayMs (some err_code=3 are transient assrt 503s); an
   *  auth failure is never retried. */
  private async resolveSubtitleUrl(url: string): Promise<Pan123OfflineResource> {
    try {
      return await this.client.resolveOffline(url);
    } catch (error) {
      if (isPan123AuthError(error)) {
        throw error;
      }
      await this.sleep(this.subtitleResolveRetryDelayMs);
      return await this.client.resolveOffline(url);
    }
  }

  /** Delete every task a subtitle batch created — finished ones too (live-verified:
   *  the file survives; frees the account's task list). Best-effort: a non-auth
   *  failure is swallowed (a subtitle landing late is staging junk discardStaging
   *  sweeps, not a double-landed video). A Pan123AuthError is rethrown only when
   *  `rethrowAuth` (the main flow completed normally) — never masking the error the
   *  main flow is already throwing. */
  private async deleteSubtitleTasks(taskIds: string[], rethrowAuth: boolean): Promise<void> {
    try {
      await this.client.deleteOfflineTasks(taskIds);
    } catch (error) {
      if (rethrowAuth && isPan123AuthError(error)) {
        throw error;
      }
    }
  }

  /** magnet/ed2k offline: resolve → submit → poll until status 2 or fail/timeout.
   * Returns false for a bounded timeout: this is a soft no_target_change, not a
   * dead magnet. Every submitted task is cancelled before the result is returned,
   * preventing a late landing from creating a duplicate. */
  private async transferOfflineMagnet(input: { url: string; targetDirId: string }): Promise<boolean> {
    const resolved = await this.client.resolveOffline(input.url);
    const taskId = await this.client.submitOffline({
      resourceId: resolved.resourceId,
      fileIds: resolved.fileIds,
      uploadDirId: input.targetDirId,
    });
    // Delete both terminal and timed-out tasks even when polling throws. A timed-
    // out task must not keep downloading after the agent moves on, otherwise it
    // can land late and double the next candidate's files.
    // M-1: when BOTH polling and cleanup fail, the cleanup error must win (an
    // uncancellable task of unknown state ⇒ stop) — but keep the poll error as
    // `cause` so triage doesn't lose it.
    let pollError: unknown;
    try {
      return await this.pollOfflineTask(taskId);
    } catch (error) {
      pollError = error;
      throw error;
    } finally {
      await this.deleteOfflineTaskWithRetry(taskId, pollError);
    }
  }

  private async deleteOfflineTaskWithRetry(taskId: string, cause?: unknown): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= OFFLINE_TASK_DELETE_MAX_ATTEMPTS; attempt++) {
      try {
        await this.client.deleteOfflineTasks([taskId]);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < OFFLINE_TASK_DELETE_MAX_ATTEMPTS) {
          await this.sleep(OFFLINE_TASK_DELETE_RETRY_DELAY_MS);
        }
      }
    }
    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(
      `PAN123_OFFLINE_CLEANUP_FAILED: task ${taskId} cancellation unconfirmed after ` +
        `${OFFLINE_TASK_DELETE_MAX_ATTEMPTS} attempts: ${detail}`,
      { cause: cause ?? lastError },
    );
  }

  private async pollOfflineTask(taskId: string): Promise<boolean> {
    for (let i = 0; i < this.offlineTaskPollMaxPolls; i++) {
      const task = await this.client.getOfflineTask(taskId);
      if (!task) {
        // Task row missing mid-poll: treat as still running, but if it is STILL
        // missing on the last poll, fail loud (PAN123_OFFLINE_TIMEOUT).
        if (i === this.offlineTaskPollMaxPolls - 1) {
          throw new Error("PAN123_OFFLINE_TIMEOUT: offline task disappeared before completion");
        }
      } else if (task.status === 2) {
        return true; // succeed
      } else if (task.status === 1) {
        // Never interpolate task.name: it is uploader-controlled and a torrent
        // named "...VIP..." would trip the systemic-block classifier (别甩锅
        // in reverse — one dead resource halting the whole run). Like 115's
        // executor, failure messages are fixed templates only.
        throw new Error(`PAN123_OFFLINE_FAILED: offline task failed at progress=${task.progress}`);
      }
      if (i < this.offlineTaskPollMaxPolls - 1) {
        await this.sleep(this.offlineTaskPollIntervalMs);
      }
    }
    return false;
  }

  async flattenDirectory(directoryId: string): Promise<{ moved: string[]; removed: string[] }> {
    const safeDirectoryId = this.assertWithinWriteScope(directoryId, "flatten directory");
    const videos = await this.collectVideos(safeDirectoryId, safeDirectoryId);
    const moveCandidates = videos.filter(
      (v) => v.sourceDirectoryId !== safeDirectoryId && v.sizeBytes >= this.minVideoSizeBytes,
    );
    // Moved things are always FILES (videos into the root) — 123's moveFiles takes
    // a bare id list, so only providerFileIds ride along.
    const moved = moveCandidates.map((v) => v.file.providerFileId);
    if (moved.length > 0) {
      await this.client.moveFiles({ fileIds: moved, targetParentId: safeDirectoryId });
    }

    const rootItems = await this.client.listFiles(safeDirectoryId);
    const removableDirectories: Array<{ id: string; name: string }> = [];
    for (const item of rootItems) {
      if (!isDirectory(item)) {
        continue;
      }
      const childId = idOf(item);
      if (!childId) {
        continue;
      }
      if (!(await this.directoryContainsLargeVideo(childId))) {
        removableDirectories.push({ id: childId, name: nameOf(item) });
      }
    }
    if (removableDirectories.length > 0) {
      // This call site KNOWS folderness+name from its own listing — both ride along.
      await this.client.trash(
        removableDirectories.map((d) => ({ id: d.id, name: d.name, isFolder: true })),
      );
    }
    return { moved, removed: removableDirectories.map((d) => d.id) };
  }

  async removeDirectory(directoryId: string): Promise<{ removed: boolean }> {
    const safe = this.assertWithinWriteScope(directoryId, "remove directory");
    if (this.protectedDirectoryIds.has(safe) || this.writeScopeDirectoryIds.has(safe)) {
      throw new Error(`SAFETY_VIOLATION: refusing to remove protected/root directory fileId=${safe}`);
    }
    // isFolder:true marks a directory delete. This call site only has the id, so
    // the entry goes WITHOUT fileName (file/trash only needs FileId).
    await this.client.trash([{ id: safe, isFolder: true }]);
    return { removed: true };
  }

  async listTree(input: { directoryId: string; maxDepth?: number }): Promise<PackageTreeFile[]> {
    const safeRoot = this.assertSafeRecursiveListTarget(input.directoryId, "walk the tree of");
    const maxDepth = input.maxDepth ?? 6;
    const results: PackageTreeFile[] = [];
    const walk = async (dirId: string, prefix: string, depth: number): Promise<void> => {
      if (depth > maxDepth) {
        return;
      }
      const items = await this.client.listFiles(dirId);
      for (const item of items) {
        const name = nameOf(item);
        if (isDirectory(item)) {
          const childId = idOf(item);
          if (childId) {
            await walk(childId, `${prefix}${name}/`, depth + 1);
          }
          continue;
        }
        const providerFileId = idOf(item);
        if (!providerFileId) {
          continue;
        }
        results.push({ path: `${prefix}${name}`, providerFileId, sizeBytes: sizeOf(item) });
      }
    };
    await walk(safeRoot, "", 1);
    return results;
  }

  async listSubdirectories(input: {
    directoryId: string;
    maxDepth?: number;
  }): Promise<Array<{ id: string; path: string }>> {
    const safeRoot = this.assertSafeRecursiveListTarget(input.directoryId, "list subdirectories of");
    const maxDepth = input.maxDepth ?? 6;
    const results: Array<{ id: string; path: string }> = [];
    const walk = async (dirId: string, prefix: string, depth: number): Promise<void> => {
      if (depth > maxDepth) {
        return;
      }
      // A subdir DISCOVERED under an in-scope parent is itself within scope (the same
      // top-down derivation createDirectory relies on) — register it so a later
      // removeDirectory can clear it. 123's saveShare (file/copy/async) materializes wrapper subdirs
      // SERVER-SIDE (not via createDirectory), so without this the movie flatten's
      // removeDirectory(wrapper) hits WRITE_SCOPE_VIOLATION and leaves empty wrapper
      // dirs + non-video junk behind (the PR#58 光鸭 lesson). Listing an OUT-of-scope
      // dir does NOT widen scope (read ≠ write); registration is gated on the parent
      // already being in scope, computed BEFORE listing.
      const parentInScope = this.isWithinWriteScope(dirId);
      const items = await this.client.listFiles(dirId);
      for (const item of items) {
        if (!isDirectory(item)) {
          continue;
        }
        const childId = idOf(item);
        if (!childId) {
          continue;
        }
        if (parentInScope) {
          this.derivedScopeIds.add(normalizeId(childId));
        }
        const path = `${prefix}${nameOf(item)}`;
        results.push({ id: childId, path });
        await walk(childId, `${path}/`, depth + 1);
      }
    };
    await walk(safeRoot, "", 1);
    return results;
  }

  async listChildDirectories(directoryId: string): Promise<Array<{ id: string; name: string }>> {
    // Derived-scope registration (same rule as the recursive lister above):
    // a subdir DISCOVERED under an in-scope parent is itself in scope. Without
    // this, ensureMediaLibraryDirectory reusing an EXISTING show folder returns
    // an unregistered id and the follow-up createDirectory(Season NN) dies with
    // WRITE_SCOPE_VIOLATION (production 莉可丽丝 2026-07-23). Listing an
    // OUT-of-scope dir must NOT widen scope (read ≠ write) — gate on the
    // parent, computed BEFORE listing.
    const parentInScope = this.isWithinWriteScope(directoryId);
    const items = await this.client.listFiles(directoryId);
    const dirs: Array<{ id: string; name: string }> = [];
    for (const item of items) {
      if (!isDirectory(item)) {
        continue;
      }
      const id = idOf(item);
      if (id) {
        if (parentInScope) {
          this.derivedScopeIds.add(normalizeId(id));
        }
        dirs.push({ id, name: nameOf(item) });
      }
    }
    return dirs;
  }

  async moveFiles(input: { fileIds: string[]; targetDirectoryId: string }): Promise<{ moved: string[] }> {
    if (input.fileIds.length === 0) {
      return { moved: [] };
    }
    const safeTargetId = this.assertWithinWriteScope(input.targetDirectoryId, "move files into");
    await this.client.moveFiles({ fileIds: input.fileIds, targetParentId: safeTargetId });
    return { moved: input.fileIds };
  }

  async deleteFiles(input: { directoryId: string; fileIds: string[] }): Promise<{ deleted: string[] }> {
    if (input.fileIds.length === 0) {
      return { deleted: [] };
    }
    const safeDirectoryId = this.assertWithinWriteScope(input.directoryId, "delete files");
    const treeFiles = await this.assertFilesBelongToDirectory(safeDirectoryId, input.fileIds);
    // Names are free from the just-walked tree (basename of the path); every id
    // passed the verification above, i.e. it IS one of these tree FILES.
    const nameById = new Map(treeFiles.map((f) => [f.providerFileId, basenameOf(f.path)]));
    await this.client.trash(
      input.fileIds.map((id) => {
        const name = nameById.get(id);
        return { id, ...(name ? { name } : {}), isFolder: false };
      }),
    );
    return { deleted: input.fileIds };
  }

  private async directoryContainsLargeVideo(directoryId: string): Promise<boolean> {
    const videos = await this.collectVideos(directoryId, directoryId);
    return videos.some((v) => v.sizeBytes >= this.minVideoSizeBytes);
  }

  private async collectVideos(rootId: string, currentId: string, depth = 1): Promise<VideoFact[]> {
    if (depth > MAX_RECURSIVE_COLLECT_DEPTH) {
      return [];
    }
    const items = await this.client.listFiles(currentId);
    const videos: VideoFact[] = [];
    for (const item of items) {
      if (isDirectory(item)) {
        const childId = idOf(item);
        if (childId) {
          videos.push(...(await this.collectVideos(rootId, childId, depth + 1)));
        }
        continue;
      }
      const file = verifiedFileFromItem(item, rootId, this.videoExtensions);
      if (file) {
        videos.push({ file, sourceDirectoryId: currentId, sizeBytes: file.sizeBytes });
      }
    }
    return videos;
  }

  private async collectUnparsedVideos(directoryId: string, depth = 1): Promise<UnparsedVideoFile[]> {
    if (depth > MAX_RECURSIVE_COLLECT_DEPTH) {
      return [];
    }
    const items = await this.client.listFiles(directoryId);
    const unparsed: UnparsedVideoFile[] = [];
    for (const item of items) {
      if (isDirectory(item)) {
        const childId = idOf(item);
        if (childId) {
          unparsed.push(...(await this.collectUnparsedVideos(childId, depth + 1)));
        }
        continue;
      }
      const name = nameOf(item);
      if (!isVideoName(name, this.videoExtensions) || episodeCodeFromFileName(name) !== null) {
        continue;
      }
      const providerFileId = idOf(item);
      if (!providerFileId) {
        continue;
      }
      unparsed.push({ providerFileId, name, sizeBytes: sizeOf(item) });
    }
    return unparsed;
  }

  /** Verify against the FULL tree (listTree), not listVideoFiles: the agent's
   *  eyes (inspectStaging/inspectTargetDir) see every file, and cleanup targets
   *  are mostly NON-video (extra subtitles, ads, nfo). Verifying videos-only made
   *  deleting a subtitle impossible on every drive — caught live 2026-07-02 on
   *  光鸭 (黑客帝国3 cleanup refused twice). Returns the walked tree so the
   *  caller can reuse it (e.g. deleteFiles harvests basename for trash names)
   *  instead of walking twice. */
  private async assertFilesBelongToDirectory(
    directoryId: string,
    fileIds: string[],
  ): Promise<PackageTreeFile[]> {
    const treeFiles = await this.listTree({ directoryId });
    const verified = new Set(treeFiles.map((f) => f.providerFileId));
    const unverified = fileIds.filter((id) => !verified.has(id));
    if (unverified.length === 0) {
      return treeFiles;
    }
    throw new Error(
      "SAFETY_VIOLATION: refusing to delete unverified file ids from target directory; " +
        `fileId=${directoryId}; fileIds=${unverified.join(",")}`,
    );
  }

  /** Refuse recursive listing of root/protected dirs (huge scan / 风控 risk). */
  private assertSafeRecursiveListTarget(directoryId: string, action: string): string {
    const normalized = normalizeId(directoryId);
    if (this.protectedDirectoryIds.has(normalized)) {
      throw new Error(
        `SAFETY_VIOLATION: refusing to recursively ${action} protected directory fileId=${normalized}`,
      );
    }
    return normalized;
  }

  /** Non-throwing scope membership check (mirrors assertWithinWriteScope). Empty
   *  scope (dev) treats everything as in-scope. Used to gate derived-scope
   *  registration during listing. */
  private isWithinWriteScope(directoryId: string): boolean {
    if (this.writeScopeDirectoryIds.size === 0) {
      return true;
    }
    const normalized = directoryId.trim();
    if (!normalized) {
      return false;
    }
    return this.writeScopeDirectoryIds.has(normalized) || this.derivedScopeIds.has(normalized);
  }

  /**
   * 123 has NO confirmed parent-walk / breadcrumb endpoint, so we cannot verify a
   * write target by walking up to a scope root (夸克's model). Instead we use
   * DERIVED SCOPE (光鸭/天翼's model): a write is allowed iff its target id is a
   * connect-time scope root (writeScopeDirectoryIds) OR a nested dir
   * find-or-created/discovered under an already-in-scope parent during this run
   * (derivedScopeIds). Empty scope (dev) allows everything. SYNCHRONOUS — no
   * network; callers do NOT await. 123's root id "0" is a normal non-empty id,
   * so every legitimate target survives normalizeId's throw-on-empty.
   */
  private assertWithinWriteScope(directoryId: string, action: string): string {
    const normalized = normalizeId(directoryId);
    if (this.writeScopeDirectoryIds.size === 0) {
      return normalized;
    }
    if (this.writeScopeDirectoryIds.has(normalized) || this.derivedScopeIds.has(normalized)) {
      return normalized;
    }
    throw new Error(
      `WRITE_SCOPE_VIOLATION: refusing to ${action} outside configured write scope; fileId=${normalized}`,
    );
  }
}

/** 123 分享链有多镜像域(123pan.com / 123684.com / 123865.com / 123912.com,com/cn),
 *  提取码在 `pwd`/`password` query。先 split("#") 去 fragment 再解 query(照 天翼
 *  parseTianyiShareUrl 的风格)。providerPayload.password 优先于此(见 transfer)。 */
export function parsePan123ShareUrl(url: string): { shareKey: string; sharePwd: string } | null {
  const noFragment = url.split("#")[0] ?? url;
  const m = /https?:\/\/(?:www\.)?123(?:684|865|912|pan)\.(?:com|cn)\/s\/([0-9A-Za-z_-]+)/.exec(noFragment);
  if (!m?.[1]) {
    return null;
  }
  const params = new URLSearchParams(noFragment.split("?")[1] ?? "");
  return { shareKey: m[1], sharePwd: params.get("pwd") ?? params.get("password") ?? "" };
}

function verifiedFileFromItem(
  item: Pan123Item,
  storageDirectoryId: string,
  videoExtensions: Set<string>,
): VerifiedFile | null {
  const name = nameOf(item);
  if (!isVideoName(name, videoExtensions)) {
    return null;
  }
  const providerFileId = idOf(item);
  if (!providerFileId) {
    return null;
  }
  return {
    id: providerFileId,
    storageDirectoryId,
    name,
    sizeBytes: sizeOf(item),
    episodeCode: episodeCodeFromFileName(name),
    providerFileId,
  };
}

function isDirectory(item: Pan123Item): boolean {
  return item.isFolder === true;
}

function idOf(item: Pan123Item): string {
  return item.id;
}

function nameOf(item: Pan123Item): string {
  return item.name;
}

function sizeOf(item: Pan123Item): number {
  return item.size;
}

function isVideoName(name: string, videoExtensions: Set<string>): boolean {
  const lower = name.toLowerCase();
  return [...videoExtensions].some((ext) => lower.endsWith(ext));
}

/** Basename of a listTree path ("Sub/dir/多余字幕.srt" → "多余字幕.srt"). */
function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function normalizeId(directoryId: string): string {
  const normalized = directoryId.trim();
  if (!normalized) {
    throw new Error("directoryId must not be empty");
  }
  return normalized;
}

function stringValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return "";
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
