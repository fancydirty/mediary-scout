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
import type { Pan123Client, Pan123Item } from "./pan123-client.js";
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
  /** Sleep primitive — injected so tests can advance the poll without real waiting. */
  sleep?: (ms: number) => Promise<void>;
}

interface VideoFact {
  file: VerifiedFile;
  sourceDirectoryId: string;
  sizeBytes: number;
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
  private readonly sleep: (ms: number) => Promise<void>;
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
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
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
