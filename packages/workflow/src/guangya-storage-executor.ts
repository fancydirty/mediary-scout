/**
 * 光鸭云盘 (GuangYaPan) StorageExecutor — the brand-3 analogue of
 * QuarkStorageExecutor / Storage115Executor, over GuangYaClient. Implements the
 * 12 StorageExecutor port methods. Mirrors the quark executor's structure;
 * only the brand-specific bits differ.
 *
 * Differences from quark:
 *  - 转存 is OFFLINE/磁力 (resolve_res → create_task → poll). This is the OPPOSITE
 *    of quark: a MAGNET works, a share link fails LOUD (GUANGYA_ONLY_MAGNET).
 *    Share-link 转存 is a phase-2 feature.
 *  - 光鸭 has NO parent-walk / breadcrumb API, so the write-scope guard is a flat
 *    membership check: the transfer/createDir target is always a known scope dir
 *    id, so we allow iff the id is in the write scope (empty scope = dev, allow all).
 *  - A 光鸭 item is a directory when `resType === 2`; ids key on `fileId`, names on
 *    `fileName`, sizes on `fileSize`. Directory listing uses `listFiles(dirId)`.
 */
import type { PackageTreeFile, ResourceCandidate, TransferAttempt, TransferStatus, VerifiedFile } from "./domain.js";
import { episodeCodeFromFileName } from "./episode-code.js";
import { isGuangYaAuthError } from "./guangya-client.js";
import type { StorageExecutor, UnparsedVideoFile } from "./ports.js";

const MAX_RECURSIVE_COLLECT_DEPTH = 6;
const DEFAULT_MIN_VIDEO_SIZE_BYTES = 10 * 1024 * 1024;

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

/** A directory-listing entry as the executor consumes it (mirrors GuangYaItem). */
export interface GuangYaStorageItem {
  fileId: string;
  parentId: string;
  fileName: string;
  fileSize: number;
  resType: number;
}

/** Resolved subfile inside a bt/磁力 resource. */
export interface GuangYaSubfile {
  fileName: string;
  fileIndex: number;
  fileSize: number;
}

/** resolve_res result the executor relies on (bt resources carry btResInfo). */
export interface GuangYaResolvedRes {
  resType: number;
  url?: string;
  btResInfo?: {
    infoHash: string;
    fileName: string;
    subfiles: GuangYaSubfile[];
  };
}

/** One offline-task status row from list_task. */
export interface GuangYaTaskStatus {
  taskId: string;
  status: number;
  progress?: number;
  fileId?: string;
}

/**
 * The structural slice of GuangYaClient the executor depends on. The real
 * GuangYaClient (whose resolveRes/listTask return `unknown`) is adapted to this
 * typed shape by the factory (a later task); tests inject a typed fake directly.
 */
export interface GuangYaStorageClient {
  listFiles(parentId: string): Promise<GuangYaStorageItem[]>;
  createDir(parentId: string, dirName: string): Promise<string>;
  renameFile(fileId: string, newName: string): Promise<void>;
  deleteFiles(fileIds: string[]): Promise<void>;
  moveFiles(fileIds: string[], parentId: string): Promise<void>;
  resolveRes(url: string): Promise<GuangYaResolvedRes>;
  createTask(input: {
    url: string;
    parentId: string;
    newName: string;
    fileIndexes?: number[];
  }): Promise<string>;
  listTask(taskIds: string[]): Promise<GuangYaTaskStatus[]>;
}

export interface GuangYaStorageExecutorOptions {
  client: GuangYaStorageClient;
  /** Directory fileIds inside which writes/deletes are allowed (the drive's scope
   *  roots: rootDir + Movies/TV/Anime). Empty = allow all (dev only). */
  writeScopeDirectoryIds?: string[];
  /** Directories that may never be removed (root + scope roots). NOTE: unlike
   *  quark these are NOT auto-blocked from recursive listing, because 光鸭's write
   *  target IS a scope dir and transfer must read it before/after. */
  protectedDirectoryIds?: string[];
  minVideoSizeBytes?: number;
  videoExtensions?: string[];
  /** Poll caps for an offline task (overridable so tests don't sleep). */
  taskPollMaxPolls?: number;
  taskPollIntervalMs?: number;
}

interface VideoFact {
  file: VerifiedFile;
  sourceDirectoryId: string;
  sizeBytes: number;
}

export class GuangYaStorageExecutor implements StorageExecutor {
  private readonly client: GuangYaStorageClient;
  private readonly writeScopeDirectoryIds: Set<string>;
  private readonly protectedDirectoryIds: Set<string>;
  private readonly minVideoSizeBytes: number;
  private readonly videoExtensions: Set<string>;
  private readonly taskPollMaxPolls: number;
  private readonly taskPollIntervalMs: number;
  private nextTransferNumber = 1;

  constructor(options: GuangYaStorageExecutorOptions) {
    this.client = options.client;
    this.writeScopeDirectoryIds = new Set(options.writeScopeDirectoryIds ?? []);
    this.protectedDirectoryIds = new Set(["0", ...(options.protectedDirectoryIds ?? [])]);
    this.minVideoSizeBytes = options.minVideoSizeBytes ?? DEFAULT_MIN_VIDEO_SIZE_BYTES;
    this.videoExtensions = new Set(
      (options.videoExtensions ?? DEFAULT_VIDEO_EXTENSIONS).map((ext) => ext.toLowerCase()),
    );
    this.taskPollMaxPolls = options.taskPollMaxPolls ?? 60;
    this.taskPollIntervalMs = options.taskPollIntervalMs ?? 3000;
  }

  async createDirectory(input: { name: string; parentId: string }): Promise<string> {
    const safeParentId = this.assertWithinWriteScope(input.parentId, "create directory");
    // Find-or-create: seasons of one title initialize at different times and must
    // land under the SAME show directory (光鸭 happily makes duplicate folders).
    const items = await this.client.listFiles(safeParentId);
    for (const item of items) {
      if (isDirectory(item) && nameOf(item) === input.name) {
        const existingId = idOf(item);
        if (existingId) {
          return existingId;
        }
      }
    }
    return this.client.createDir(safeParentId, input.name);
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
    await this.client.renameFile(input.fileId, input.newName);
  }

  async transfer(input: {
    workflowRunId: string;
    directoryId: string;
    candidate: ResourceCandidate;
  }): Promise<TransferAttempt> {
    const url = stringValue(input.candidate.providerPayload["url"]);
    const isMagnet =
      input.candidate.type === "magnet" || url.startsWith("magnet:") || url.startsWith("ed2k:");
    if (!isMagnet) {
      throw new Error(
        "GUANGYA_ONLY_MAGNET: 光鸭 v1 仅支持磁力/离线候选(分享链转存留 phase 2);请改用磁力候选",
      );
    }

    const safe = this.assertWithinWriteScope(input.directoryId, "transfer");
    const before = new Set((await this.listVideoFiles(safe)).map((f) => f.id));

    let providerMessage = "";
    try {
      const resolved = await this.client.resolveRes(url);
      const subs = resolved.btResInfo?.subfiles ?? [];
      const videoIndexes = subs
        .map((s, i) => ({ idx: s.fileIndex ?? i, name: s.fileName }))
        .filter((s) => isVideoName(s.name, this.videoExtensions))
        .map((s) => s.idx);
      const taskInput: Parameters<GuangYaStorageClient["createTask"]>[0] = {
        url: resolved.url || url,
        parentId: safe,
        newName: resolved.btResInfo?.fileName || "offline",
      };
      if (videoIndexes.length) {
        taskInput.fileIndexes = videoIndexes;
      }
      const taskId = await this.client.createTask(taskInput);
      await this.pollTask(taskId);
    } catch (error) {
      // Auth failures must surface so the worker freezes the drive — never absorbed.
      if (isGuangYaAuthError(error)) {
        throw error;
      }
      // Any other failure (dead/expired magnet, bad params) is a FAILED attempt
      // with a loud message; the agent moves to the next candidate.
      providerMessage = error instanceof Error ? error.message : String(error);
    }

    const after = await this.listVideoFiles(safe);
    const materializedFileIds = after.filter((f) => !before.has(f.id)).map((f) => f.id);
    const status: TransferStatus = providerMessage
      ? "failed"
      : materializedFileIds.length > 0
        ? "succeeded"
        : "no_target_change";

    const attempt: TransferAttempt = {
      id: `${input.workflowRunId}_transfer_${this.nextTransferNumber}`,
      workflowRunId: input.workflowRunId,
      candidateId: input.candidate.id,
      status,
      providerMessage:
        providerMessage ||
        (status === "no_target_change" ? "离线任务完成但目标目录未出现新视频" : ""),
      materializedFileIds,
    };
    this.nextTransferNumber += 1;
    return attempt;
  }

  async flattenDirectory(directoryId: string): Promise<{ moved: string[]; removed: string[] }> {
    const safeDirectoryId = this.assertWithinWriteScope(directoryId, "flatten directory");
    const videos = await this.collectVideos(safeDirectoryId, safeDirectoryId);
    const moveCandidates = videos.filter(
      (v) => v.sourceDirectoryId !== safeDirectoryId && v.sizeBytes >= this.minVideoSizeBytes,
    );
    const moved = moveCandidates.map((v) => v.file.providerFileId);
    if (moved.length > 0) {
      await this.client.moveFiles(moved, safeDirectoryId);
    }

    const rootItems = await this.client.listFiles(safeDirectoryId);
    const removableDirectoryIds: string[] = [];
    for (const item of rootItems) {
      if (!isDirectory(item)) {
        continue;
      }
      const childId = idOf(item);
      if (!childId) {
        continue;
      }
      if (!(await this.directoryContainsLargeVideo(childId))) {
        removableDirectoryIds.push(childId);
      }
    }
    if (removableDirectoryIds.length > 0) {
      await this.client.deleteFiles(removableDirectoryIds);
    }
    return { moved, removed: removableDirectoryIds };
  }

  async removeDirectory(directoryId: string): Promise<{ removed: boolean }> {
    const safe = this.assertWithinWriteScope(directoryId, "remove directory");
    if (this.protectedDirectoryIds.has(safe) || this.writeScopeDirectoryIds.has(safe)) {
      throw new Error(`SAFETY_VIOLATION: refusing to remove protected/root directory fileId=${safe}`);
    }
    await this.client.deleteFiles([safe]);
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
      const items = await this.client.listFiles(dirId);
      for (const item of items) {
        if (!isDirectory(item)) {
          continue;
        }
        const childId = idOf(item);
        if (!childId) {
          continue;
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
    const items = await this.client.listFiles(directoryId);
    const dirs: Array<{ id: string; name: string }> = [];
    for (const item of items) {
      if (!isDirectory(item)) {
        continue;
      }
      const id = idOf(item);
      if (id) {
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
    await this.client.moveFiles(input.fileIds, safeTargetId);
    return { moved: input.fileIds };
  }

  async deleteFiles(input: { directoryId: string; fileIds: string[] }): Promise<{ deleted: string[] }> {
    if (input.fileIds.length === 0) {
      return { deleted: [] };
    }
    const safeDirectoryId = this.assertWithinWriteScope(input.directoryId, "delete files");
    await this.assertFilesBelongToDirectory(safeDirectoryId, input.fileIds);
    await this.client.deleteFiles(input.fileIds);
    return { deleted: input.fileIds };
  }

  /** Poll list_task until the task leaves the in-progress state or a cap is hit.
   *  ⚠️ status semantics (2 = done? is there a distinct failed code?) are a PLACEHOLDER
   *  to be refined after the live e2e (Task 8) observes real status codes. v1: treat status>=2 as terminal. */
  private async pollTask(taskId: string): Promise<void> {
    for (let i = 0; i < this.taskPollMaxPolls; i++) {
      const tasks = await this.client.listTask([taskId]);
      const t = tasks.find((x) => x.taskId === taskId);
      if (!t) {
        return;
      }
      if (t.status >= 2) {
        return;
      }
      await new Promise((r) => setTimeout(r, this.taskPollIntervalMs));
    }
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

  private async assertFilesBelongToDirectory(directoryId: string, fileIds: string[]): Promise<void> {
    const verified = new Set((await this.listVideoFiles(directoryId)).map((f) => f.providerFileId));
    const unverified = fileIds.filter((id) => !verified.has(id));
    if (unverified.length === 0) {
      return;
    }
    throw new Error(
      "SAFETY_VIOLATION: refusing to delete unverified file ids from target directory; " +
        `fileId=${directoryId}; fileIds=${unverified.join(",")}`,
    );
  }

  /** Refuse recursive listing of root/protected dirs (huge scan / 风控 risk).
   *  Unlike quark, write-scope dirs are NOT auto-protected here (光鸭's write target
   *  IS a scope dir, and transfer must read it). */
  private assertSafeRecursiveListTarget(directoryId: string, action: string): string {
    const normalized = normalizeId(directoryId);
    if (this.protectedDirectoryIds.has(normalized)) {
      throw new Error(
        `SAFETY_VIOLATION: refusing to recursively ${action} protected directory fileId=${normalized}`,
      );
    }
    return normalized;
  }

  /**
   * 光鸭 has NO parent-walk / breadcrumb API, so the guard is a flat membership
   * check: the transfer/createDir target is always a known scope dir id. Allow iff
   * the id is in the write scope; empty scope (dev) allows everything.
   */
  private assertWithinWriteScope(directoryId: string, action: string): string {
    const normalized = normalizeId(directoryId);
    if (this.writeScopeDirectoryIds.size === 0) {
      return normalized;
    }
    if (this.writeScopeDirectoryIds.has(normalized)) {
      return normalized;
    }
    throw new Error(
      `WRITE_SCOPE_VIOLATION: refusing to ${action} outside configured write scope; fileId=${normalized}`,
    );
  }
}

function verifiedFileFromItem(
  item: GuangYaStorageItem,
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

function isDirectory(item: GuangYaStorageItem): boolean {
  return item.resType === 2;
}

function idOf(item: GuangYaStorageItem): string {
  return stringValue(item.fileId);
}

function nameOf(item: GuangYaStorageItem): string {
  return stringValue(item.fileName);
}

function sizeOf(item: GuangYaStorageItem): number {
  return numberValue(item.fileSize);
}

function isVideoName(name: string, videoExtensions: Set<string>): boolean {
  const lower = name.toLowerCase();
  return [...videoExtensions].some((ext) => lower.endsWith(ext));
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

function numberValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}
