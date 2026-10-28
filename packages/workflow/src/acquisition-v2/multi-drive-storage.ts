import type { TransferAttempt } from "../domain.js";
import { ensureMediaLibraryDirectory, findExistingMediaLibraryDirectory } from "../media-library-folder.js";
import { formatByteSize, formatDriveSpaceSummary } from "../domain.js";
import type { AcquisitionDriveContext, StorageExecutor } from "../ports.js";
import { brandOfUrl, candidateDriveLabel, storageProviderForResourceType } from "./resource-link.js";
import type {
  SimTreeFile,
  StorageV2,
  SubtitleLandingResult,
  TransferAttemptResult,
} from "./storage-115-simulator.js";
import {
  withStagingCleanup,
  type StagingCleanupUnverified,
  type StagingKeptUnmoved,
  type StagingLeak,
} from "./directory-lifecycle.js";

/** Synthetic directory handles passed into `TaskSandbox` when `MultiDriveStorageV2`
 *  owns the per-drive lazy directory lifecycle. */
export const MULTI_DRIVE_STAGING_HANDLE = "__multi_staging__";
export const MULTI_DRIVE_MOVIE_HANDLE = "__multi_movie__";
export function multiDriveSeasonHandle(season: number): string {
  return `__multi_season_${season}__`;
}
export function parseMultiDriveSeasonHandle(directoryId: string): number | null {
  const m = /^__multi_season_(\d+)__$/.exec(directoryId);
  return m ? Number(m[1]) : null;
}

const MAGNET_CAPABLE_PROVIDERS = new Set(["pan115", "guangya", "pan123"]);

export interface MultiDriveTargetSpec {
  kind: "tv" | "movie";
  /** Category key in `drive.parents` ("tv" | "anime" | "movies"). */
  categoryKey: "tv" | "anime" | "movies";
  title: string;
  year: number | string;
  tmdbId: number;
  seasons: number[];
  workflowRunId: string;
}

export interface MultiDriveCandidateInfo {
  url: string;
  sizeBytes?: number;
}

export interface MultiDriveStorageV2Options {
  drives: AcquisitionDriveContext[];
  /** Primary drive storageId (when the run was initiated on a specific drive, e.g. an ongoing show's home drive). */
  primaryStorageId?: string | null;
  target: MultiDriveTargetSpec;
  /** Build a per-drive StorageV2 from a drive's StorageExecutor. */
  buildDriveAdapter: (drive: AcquisitionDriveContext) => StorageV2 & { attempts?: () => TransferAttempt[] };
  /** Resolve a candidate's raw URL and optional known size from its ID/alias. */
  resolveCandidate: (candidateId: string) => MultiDriveCandidateInfo | undefined;
}

interface DriveRuntimeState {
  drive: AcquisitionDriveContext;
  adapter: StorageV2 & { attempts?: () => TransferAttempt[] };
  showDirectoryId?: string;
  stagingDirectoryId?: string;
  movieDirectoryId?: string;
  seasonDirectoryIds: Map<number, string>;
}

/**
 * Multi-drive coordinator implementing `StorageV2`.
 *
 * Key invariants:
 * 1. Lazy directory creation: `showDirectoryId`, `stagingDirectoryId`, and `Season NN`
 *    (or `movieDirectoryId` for films) are created on a drive ONLY when a candidate is
 *    actually transferred to or moved on that drive — never up front across all N drives.
 * 2. Hard space gate: before any transfer hits the network, the target drive's cached
 *    space is checked. If `remainingBytes <= 0` (over-quota, e.g. Quark -1368 GB or
 *    Tianyi -41 GB) or `sizeBytes > remainingBytes`, `SANDBOX_DRIVE_OUT_OF_SPACE` is
 *    thrown immediately.
 * 3. Per-drive scoping: when >1 drive is in play, file IDs and directory IDs exposed to
 *    the sandbox are scoped as `<storageId>::<rawId>` so two drives that happen to return
 *    the same provider ID never collide in `moveFiles`, `deleteFiles`, `listSubdirectories`,
 *    or `unmovedFileIds`.
 */
export class MultiDriveStorageV2 implements StorageV2 {
  private readonly states = new Map<string, DriveRuntimeState>();
  private readonly orderedDrives: AcquisitionDriveContext[];
  private readonly primaryStorageId: string | null;
  private readonly target: MultiDriveTargetSpec;
  private readonly resolveCandidate: (candidateId: string) => MultiDriveCandidateInfo | undefined;
  private readonly fileToDrive = new Map<string, string>();
  private readonly dirToDrive = new Map<string, { storageId: string; realDirId: string }>();
  private lastTouchedStorageId: string | null = null;

  constructor(options: MultiDriveStorageV2Options) {
    if (options.drives.length === 0) {
      throw new Error("MultiDriveStorageV2 requires at least one drive");
    }
    this.orderedDrives = [...options.drives];
    this.primaryStorageId = options.primaryStorageId ?? options.drives[0]!.storageId;
    this.target = options.target;
    this.resolveCandidate = options.resolveCandidate;
    for (const drive of options.drives) {
      this.states.set(drive.storageId, {
        drive,
        adapter: options.buildDriveAdapter(drive),
        seasonDirectoryIds: new Map(),
      });
    }
  }

  private scopedId(storageId: string, rawId: string): string {
    if (this.orderedDrives.length <= 1) return rawId;
    if (rawId.startsWith(`${storageId}::`)) return rawId;
    return `${storageId}::${rawId}`;
  }

  private unscopedId(id: string): { storageId?: string; rawId: string } {
    const sep = id.indexOf("::");
    if (sep > 0) {
      const prefix = id.slice(0, sep);
      if (this.states.has(prefix)) {
        return { storageId: prefix, rawId: id.slice(sep + 2) };
      }
    }
    return { rawId: id };
  }

  /** Ordered drive contexts in this coordinator. */
  drives(): readonly AcquisitionDriveContext[] {
    return this.orderedDrives;
  }

  /** Which drive a file ID belongs to (populated on transfer and listTree). */
  driveOfFile(fileId: string): string | undefined {
    const { storageId } = this.unscopedId(fileId);
    if (storageId) return storageId;
    return this.fileToDrive.get(fileId);
  }

  /** Aggregate transfer attempts recorded across all drives this run, with
   *  `materializedFileIds` scoped so they match `TaskSandbox.materializedBy` keys. */
  attempts(): TransferAttempt[] {
    const all: TransferAttempt[] = [];
    for (const state of this.states.values()) {
      if (state.adapter.attempts) {
        for (const attempt of state.adapter.attempts()) {
          all.push({
            ...attempt,
            materializedFileIds: attempt.materializedFileIds.map((id) =>
              this.scopedId(state.drive.storageId, id),
            ),
          });
        }
      }
    }
    return all;
  }

  /** Every drive on which a season/movie target directory was materialized this run. */
  touchedTargetDrives(): Array<{
    storageId: string;
    provider: string;
    label: string;
    executor: StorageExecutor;
    directoryIds: string[];
    showDirectoryId?: string;
    seasonDirectoryIds: Record<number, string>;
  }> {
    const out: Array<{
      storageId: string;
      provider: string;
      label: string;
      executor: StorageExecutor;
      directoryIds: string[];
      showDirectoryId?: string;
      seasonDirectoryIds: Record<number, string>;
    }> = [];
    for (const state of this.states.values()) {
      let dirs: string[];
      if (this.target.kind === "movie") {
        dirs = state.movieDirectoryId ? [state.movieDirectoryId] : [];
      } else {
        dirs = [...state.seasonDirectoryIds.values()];
      }
      if (dirs.length > 0) {
        out.push({
          storageId: state.drive.storageId,
          provider: state.drive.provider,
          label: state.drive.label,
          executor: state.drive.storage,
          directoryIds: dirs,
          ...(state.showDirectoryId ? { showDirectoryId: state.showDirectoryId } : {}),
          seasonDirectoryIds: Object.fromEntries(state.seasonDirectoryIds),
        });
      }
    }
    return out;
  }

  /** Select the target drive for a candidate (and enforce the hard space gate). */
  resolveDriveForCandidate(candidateId: string, explicitStorageId?: string): DriveRuntimeState {
    const info = this.resolveCandidate(candidateId);
    const url = info?.url ?? "";
    const channel = brandOfUrl(url);
    const requiredProvider = channel ? storageProviderForResourceType(channel) : null;

    if (explicitStorageId) {
      const explicit = this.states.get(explicitStorageId);
      if (!explicit) {
        throw new Error(`SANDBOX_UNKNOWN_DRIVE: storageId ${explicitStorageId} is not an active connected drive`);
      }
      if (requiredProvider && explicit.drive.provider !== requiredProvider) {
        const expectedLabel = candidateDriveLabel(channel ?? "") ?? requiredProvider;
        throw new Error(
          `SANDBOX_CROSS_BRAND_TRANSFER_FORBIDDEN: candidate ${candidateId} is a ${expectedLabel} share link and cannot be transferred into ${explicit.drive.label}`,
        );
      }
      if (channel === "magnet" && !MAGNET_CAPABLE_PROVIDERS.has(explicit.drive.provider)) {
        throw new Error(
          `SANDBOX_MAGNET_UNSUPPORTED_ON_DRIVE: ${explicit.drive.label} does not support magnet/offline transfers`,
        );
      }
      this.assertDriveHasSpace(explicit.drive, candidateId, info?.sizeBytes);
      return explicit;
    }

    const compatible = this.orderedDrives
      .map((d) => this.states.get(d.storageId)!)
      .filter((s) => {
        if (requiredProvider) return s.drive.provider === requiredProvider;
        if (channel === "magnet") return MAGNET_CAPABLE_PROVIDERS.has(s.drive.provider);
        return true;
      });

    if (compatible.length === 0) {
      const label = candidateDriveLabel(channel ?? "") ?? (channel ?? "该类型");
      throw new Error(
        `SANDBOX_NO_COMPATIBLE_DRIVE: candidate ${candidateId} requires a ${label} drive, but no active ${label} drive is connected`,
      );
    }

    const withSpace = compatible.filter((s) => this.hasEnoughSpace(s.drive, info?.sizeBytes));
    if (withSpace.length > 0) {
      const primary = this.primaryStorageId
        ? withSpace.find((s) => s.drive.storageId === this.primaryStorageId)
        : undefined;
      return primary ?? withSpace[0]!;
    }

    this.assertDriveHasSpace(compatible[0]!.drive, candidateId, info?.sizeBytes);
    return compatible[0]!;
  }

  private hasEnoughSpace(drive: AcquisitionDriveContext, requiredBytes?: number): boolean {
    if (!drive.space) return true;
    const summary = formatDriveSpaceSummary(drive.space);
    if (summary.overQuota || summary.remainingBytes === null || summary.remainingBytes <= 0) {
      return false;
    }
    if (requiredBytes !== undefined && Number.isFinite(requiredBytes) && requiredBytes > 0) {
      return summary.remainingBytes >= requiredBytes;
    }
    return true;
  }

  private assertDriveHasSpace(
    drive: AcquisitionDriveContext,
    candidateId: string,
    requiredBytes?: number,
  ): void {
    if (!drive.space) return;
    const summary = formatDriveSpaceSummary(drive.space);
    if (summary.overQuota || (summary.remainingBytes !== null && summary.remainingBytes <= 0)) {
      throw new Error(
        `SANDBOX_DRIVE_OUT_OF_SPACE: ${drive.label} 空间已满或超额（${summary.agentText}），禁止向该网盘转存候选 ${candidateId}。请改用其他有剩余空间的网盘候选，或如实上报因网盘空间不足无法入库。`,
      );
    }
    if (
      requiredBytes !== undefined &&
      Number.isFinite(requiredBytes) &&
      requiredBytes > 0 &&
      summary.remainingBytes !== null &&
      summary.remainingBytes < requiredBytes
    ) {
      throw new Error(
        `SANDBOX_DRIVE_OUT_OF_SPACE: ${drive.label} 剩余空间（${formatByteSize(summary.remainingBytes)}）不足以容纳候选 ${candidateId}（需 ${formatByteSize(requiredBytes)}），禁止写入。`,
      );
    }
  }

  private async ensureDriveStagingDir(state: DriveRuntimeState): Promise<string> {
    if (this.target.kind === "movie") {
      return this.ensureDriveMovieDir(state);
    }
    if (state.stagingDirectoryId) {
      return state.stagingDirectoryId;
    }
    const showDirId = await this.ensureDriveShowDir(state);
    const stagingDirId = await state.drive.storage.createDirectory({
      name: `staging-${this.target.workflowRunId}`,
      parentId: showDirId,
    });
    state.stagingDirectoryId = stagingDirId;
    const scoped = this.scopedId(state.drive.storageId, stagingDirId);
    this.dirToDrive.set(scoped, { storageId: state.drive.storageId, realDirId: stagingDirId });
    this.dirToDrive.set(stagingDirId, { storageId: state.drive.storageId, realDirId: stagingDirId });
    return stagingDirId;
  }

  private async ensureDriveShowDir(state: DriveRuntimeState): Promise<string> {
    if (state.showDirectoryId) {
      return state.showDirectoryId;
    }
    const parentId = state.drive.parents[this.target.categoryKey];
    const showDirId = await ensureMediaLibraryDirectory({
      executor: state.drive.storage,
      parentId,
      title: this.target.title,
      year: this.target.year,
      tmdbId: this.target.tmdbId,
    });
    state.showDirectoryId = showDirId;
    const scoped = this.scopedId(state.drive.storageId, showDirId);
    this.dirToDrive.set(scoped, { storageId: state.drive.storageId, realDirId: showDirId });
    this.dirToDrive.set(showDirId, { storageId: state.drive.storageId, realDirId: showDirId });
    return showDirId;
  }

  private async ensureDriveSeasonDir(state: DriveRuntimeState, season: number): Promise<string> {
    const existing = state.seasonDirectoryIds.get(season);
    if (existing) {
      return existing;
    }
    const showDirId = await this.ensureDriveShowDir(state);
    const seasonName = `Season ${String(season).padStart(2, "0")}`;
    let foundId: string | undefined;
    try {
      const children = await state.drive.storage.listChildDirectories(showDirId);
      foundId = children.find((c) => c.name === seasonName)?.id;
    } catch {
      foundId = undefined;
    }
    const seasonDirId =
      foundId ??
      (await state.drive.storage.createDirectory({
        name: seasonName,
        parentId: showDirId,
      }));
    state.seasonDirectoryIds.set(season, seasonDirId);
    const scoped = this.scopedId(state.drive.storageId, seasonDirId);
    this.dirToDrive.set(scoped, { storageId: state.drive.storageId, realDirId: seasonDirId });
    this.dirToDrive.set(seasonDirId, { storageId: state.drive.storageId, realDirId: seasonDirId });
    return seasonDirId;
  }

  private async findExistingSeasonDirReadOnly(state: DriveRuntimeState, season: number): Promise<string | null> {
    const cached = state.seasonDirectoryIds.get(season);
    if (cached) return cached;
    let showDirId = state.showDirectoryId;
    if (!showDirId) {
      const parentId = state.drive.parents[this.target.categoryKey];
      const existingShow = await findExistingMediaLibraryDirectory({
        executor: state.drive.storage,
        parentId,
        title: this.target.title,
        year: this.target.year,
        tmdbId: this.target.tmdbId,
      });
      if (!existingShow) return null;
      showDirId = existingShow;
      state.showDirectoryId = showDirId;
      const scopedShow = this.scopedId(state.drive.storageId, showDirId);
      this.dirToDrive.set(scopedShow, { storageId: state.drive.storageId, realDirId: showDirId });
      this.dirToDrive.set(showDirId, { storageId: state.drive.storageId, realDirId: showDirId });
    }
    const seasonName = `Season ${String(season).padStart(2, "0")}`;
    const children = await state.drive.storage.listChildDirectories(showDirId);
    const hit = children.find((c) => c.name === seasonName);
    if (!hit) return null;
    state.seasonDirectoryIds.set(season, hit.id);
    const scoped = this.scopedId(state.drive.storageId, hit.id);
    this.dirToDrive.set(scoped, { storageId: state.drive.storageId, realDirId: hit.id });
    this.dirToDrive.set(hit.id, { storageId: state.drive.storageId, realDirId: hit.id });
    return hit.id;
  }

  private async findExistingMovieDirReadOnly(state: DriveRuntimeState): Promise<string | null> {
    if (state.movieDirectoryId) return state.movieDirectoryId;
    const existing = await findExistingMediaLibraryDirectory({
      executor: state.drive.storage,
      parentId: state.drive.parents.movies,
      title: this.target.title,
      year: this.target.year,
      tmdbId: this.target.tmdbId,
    });
    if (!existing) return null;
    state.movieDirectoryId = existing;
    const scoped = this.scopedId(state.drive.storageId, existing);
    this.dirToDrive.set(scoped, { storageId: state.drive.storageId, realDirId: existing });
    this.dirToDrive.set(existing, { storageId: state.drive.storageId, realDirId: existing });
    return existing;
  }

  private async ensureDriveMovieDir(state: DriveRuntimeState): Promise<string> {
    if (state.movieDirectoryId) {
      return state.movieDirectoryId;
    }
    const movieDirId = await ensureMediaLibraryDirectory({
      executor: state.drive.storage,
      parentId: state.drive.parents.movies,
      title: this.target.title,
      year: this.target.year,
      tmdbId: this.target.tmdbId,
    });
    state.movieDirectoryId = movieDirId;
    state.stagingDirectoryId = movieDirId;
    const scoped = this.scopedId(state.drive.storageId, movieDirId);
    this.dirToDrive.set(scoped, { storageId: state.drive.storageId, realDirId: movieDirId });
    this.dirToDrive.set(movieDirId, { storageId: state.drive.storageId, realDirId: movieDirId });
    return movieDirId;
  }

  private defaultState(): DriveRuntimeState {
    const id = this.lastTouchedStorageId ?? this.primaryStorageId ?? this.orderedDrives[0]!.storageId;
    return this.states.get(id) ?? this.states.get(this.orderedDrives[0]!.storageId)!;
  }

  private async resolveRealDir(
    directoryId: string,
    preferredState?: DriveRuntimeState,
  ): Promise<{ state: DriveRuntimeState; realDirId: string }> {
    const state = preferredState ?? this.defaultState();
    if (directoryId === MULTI_DRIVE_STAGING_HANDLE || directoryId === MULTI_DRIVE_MOVIE_HANDLE) {
      return { state, realDirId: await this.ensureDriveStagingDir(state) };
    }
    const seasonNum = parseMultiDriveSeasonHandle(directoryId);
    if (seasonNum !== null) {
      return { state, realDirId: await this.ensureDriveSeasonDir(state, seasonNum) };
    }
    const parsed = this.unscopedId(directoryId);
    if (parsed.storageId) {
      const s = this.states.get(parsed.storageId)!;
      return { state: s, realDirId: parsed.rawId };
    }
    const owner = this.dirToDrive.get(directoryId);
    if (owner) {
      return { state: this.states.get(owner.storageId)!, realDirId: owner.realDirId };
    }
    return { state, realDirId: directoryId };
  }

  candidateLinkKind(candidateId: string): "share" | "magnet" | "unknown" {
    const first = this.orderedDrives[0]!;
    return this.states.get(first.storageId)!.adapter.candidateLinkKind(candidateId);
  }

  async createDirectory(input: { name: string; parentId: string }): Promise<string> {
    const { state, realDirId } = await this.resolveRealDir(input.parentId);
    const created = await state.adapter.createDirectory({
      name: input.name,
      parentId: realDirId,
    });
    const scoped = this.scopedId(state.drive.storageId, created);
    this.dirToDrive.set(scoped, { storageId: state.drive.storageId, realDirId: created });
    this.dirToDrive.set(created, { storageId: state.drive.storageId, realDirId: created });
    return scoped;
  }

  async transferCandidate(input: {
    candidateId: string;
    intoDirectoryId: string;
    storageId?: string;
  }): Promise<TransferAttemptResult> {
    const state = this.resolveDriveForCandidate(input.candidateId, input.storageId);
    const { realDirId } = await this.resolveRealDir(input.intoDirectoryId, state);
    this.lastTouchedStorageId = state.drive.storageId;
    const result = await state.adapter.transferCandidate({
      candidateId: input.candidateId,
      intoDirectoryId: realDirId,
    });
    const scopedIds = result.materializedFileIds.map((fid) => {
      const scoped = this.scopedId(state.drive.storageId, fid);
      this.fileToDrive.set(scoped, state.drive.storageId);
      return scoped;
    });
    return {
      ...result,
      materializedFileIds: scopedIds,
    };
  }

  async transferSubtitleUrls(input: {
    files: Array<{ url: string; filename: string }>;
    intoDirectoryId: string;
  }): Promise<SubtitleLandingResult[]> {
    const candidates = [
      ...(this.lastTouchedStorageId ? [this.states.get(this.lastTouchedStorageId)!] : []),
      ...this.orderedDrives.map((d) => this.states.get(d.storageId)!),
    ];
    const chosen =
      candidates.find((s) => typeof s.drive.storage.transferSubtitleUrl === "function") ?? candidates[0]!;
    const { realDirId } = await this.resolveRealDir(input.intoDirectoryId, chosen);
    const results = await chosen.adapter.transferSubtitleUrls({
      files: input.files,
      intoDirectoryId: realDirId,
    });
    return results.map((r) => ({
      ...r,
      materializedFileIds: r.materializedFileIds.map((fid) => {
        const scoped = this.scopedId(chosen.drive.storageId, fid);
        this.fileToDrive.set(scoped, chosen.drive.storageId);
        return scoped;
      }),
    }));
  }

  async listTree(input: { directoryId: string; maxDepth?: number }): Promise<SimTreeFile[]> {
    if (input.directoryId === MULTI_DRIVE_MOVIE_HANDLE) {
      let activeStates = [...this.states.values()].filter((s) => s.movieDirectoryId !== undefined);
      if (activeStates.length === 0) {
        const primary = this.states.get(this.primaryStorageId ?? "") ?? this.defaultState();
        try {
          const found = await this.findExistingMovieDirReadOnly(primary);
          if (found) activeStates = [primary];
        } catch {
          activeStates = [];
        }
      }
      if (activeStates.length === 0) {
        return [];
      }
      const trees = await Promise.all(
        activeStates.map(async (state) => {
          const files = await state.adapter.listTree({
            directoryId: state.movieDirectoryId!,
            ...(input.maxDepth === undefined ? {} : { maxDepth: input.maxDepth }),
          });
          return files.map((f) => {
            const scoped = this.scopedId(state.drive.storageId, f.id);
            this.fileToDrive.set(scoped, state.drive.storageId);
            return {
              ...f,
              id: scoped,
            };
          });
        }),
      );
      return trees.flat();
    }

    if (input.directoryId === MULTI_DRIVE_STAGING_HANDLE) {
      const activeStates = [...this.states.values()].filter((s) => s.stagingDirectoryId !== undefined);
      if (activeStates.length === 0) {
        return [];
      }
      const trees = await Promise.all(
        activeStates.map(async (state) => {
          const files = await state.adapter.listTree({
            directoryId: state.stagingDirectoryId!,
            ...(input.maxDepth === undefined ? {} : { maxDepth: input.maxDepth }),
          });
          return files.map((f) => {
            const scoped = this.scopedId(state.drive.storageId, f.id);
            this.fileToDrive.set(scoped, state.drive.storageId);
            return {
              ...f,
              id: scoped,
            };
          });
        }),
      );
      return trees.flat();
    }

    const seasonNum = parseMultiDriveSeasonHandle(input.directoryId);
    if (seasonNum !== null) {
      let statesWithSeason = [...this.states.values()].filter((s) => s.seasonDirectoryIds.has(seasonNum));
      if (statesWithSeason.length === 0) {
        const primary = this.states.get(this.primaryStorageId ?? "") ?? this.defaultState();
        try {
          const found = await this.findExistingSeasonDirReadOnly(primary, seasonNum);
          if (found) statesWithSeason = [primary];
        } catch {
          statesWithSeason = [];
        }
      }
      if (statesWithSeason.length === 0) {
        return [];
      }
      const trees = await Promise.all(
        statesWithSeason.map(async (state) => {
          const dirId = state.seasonDirectoryIds.get(seasonNum)!;
          const files = await state.adapter.listTree({
            directoryId: dirId,
            ...(input.maxDepth === undefined ? {} : { maxDepth: input.maxDepth }),
          });
          return files.map((f) => {
            const scoped = this.scopedId(state.drive.storageId, f.id);
            this.fileToDrive.set(scoped, state.drive.storageId);
            return {
              ...f,
              id: scoped,
            };
          });
        }),
      );
      return trees.flat();
    }

    const { state, realDirId } = await this.resolveRealDir(input.directoryId);
    const files = await state.adapter.listTree({
      directoryId: realDirId,
      ...(input.maxDepth === undefined ? {} : { maxDepth: input.maxDepth }),
    });
    return files.map((f) => {
      const scoped = this.scopedId(state.drive.storageId, f.id);
      this.fileToDrive.set(scoped, state.drive.storageId);
      return {
        ...f,
        id: scoped,
      };
    });
  }

  async listSubdirectories(input: { directoryId: string; maxDepth?: number }): Promise<Array<{ id: string; path: string }>> {
    if (input.directoryId === MULTI_DRIVE_STAGING_HANDLE || input.directoryId === MULTI_DRIVE_MOVIE_HANDLE) {
      const activeStates = [...this.states.values()].filter((s) => s.stagingDirectoryId !== undefined);
      const lists = await Promise.all(
        activeStates.map(async (state) => {
          const subdirs = await state.adapter.listSubdirectories({
            directoryId: state.stagingDirectoryId!,
            ...(input.maxDepth === undefined ? {} : { maxDepth: input.maxDepth }),
          });
          return subdirs.map((sub) => {
            const scoped = this.scopedId(state.drive.storageId, sub.id);
            this.dirToDrive.set(scoped, { storageId: state.drive.storageId, realDirId: sub.id });
            this.dirToDrive.set(sub.id, { storageId: state.drive.storageId, realDirId: sub.id });
            return { id: scoped, path: sub.path };
          });
        }),
      );
      return lists.flat();
    }
    const { state, realDirId } = await this.resolveRealDir(input.directoryId);
    const subdirs = await state.adapter.listSubdirectories({
      directoryId: realDirId,
      ...(input.maxDepth === undefined ? {} : { maxDepth: input.maxDepth }),
    });
    return subdirs.map((sub) => {
      const scoped = this.scopedId(state.drive.storageId, sub.id);
      this.dirToDrive.set(scoped, { storageId: state.drive.storageId, realDirId: sub.id });
      this.dirToDrive.set(sub.id, { storageId: state.drive.storageId, realDirId: sub.id });
      return { id: scoped, path: sub.path };
    });
  }

  async moveFiles(input: { fileIds: string[]; targetDirectoryId: string }): Promise<{ moved: string[] }> {
    if (input.fileIds.length === 0) {
      return { moved: [] };
    }
    const byDrive = new Map<string, Array<{ scoped: string; raw: string }>>();
    for (const fid of input.fileIds) {
      const parsed = this.unscopedId(fid);
      const storageId =
        parsed.storageId ??
        this.fileToDrive.get(fid) ??
        this.defaultState().drive.storageId;
      const list = byDrive.get(storageId) ?? [];
      list.push({ scoped: fid, raw: parsed.rawId });
      byDrive.set(storageId, list);
    }

    const movedAll: string[] = [];
    for (const [storageId, items] of byDrive) {
      const state = this.states.get(storageId)!;
      const { realDirId } = await this.resolveRealDir(input.targetDirectoryId, state);
      const res = await state.adapter.moveFiles({
        fileIds: items.map((i) => i.raw),
        targetDirectoryId: realDirId,
      });
      const movedRaw = new Set(res.moved);
      for (const item of items) {
        if (movedRaw.has(item.raw) || movedRaw.has(item.scoped)) {
          movedAll.push(item.scoped);
        }
      }
    }

    return { moved: movedAll };
  }

  async renameFile(input: { directoryId: string; fileId: string; newName: string }): Promise<void> {
    const parsed = this.unscopedId(input.fileId);
    const storageId =
      parsed.storageId ??
      this.fileToDrive.get(input.fileId) ??
      this.dirToDrive.get(input.directoryId)?.storageId ??
      this.defaultState().drive.storageId;
    const state = this.states.get(storageId)!;
    const { realDirId } = await this.resolveRealDir(input.directoryId, state);
    await state.adapter.renameFile({
      directoryId: realDirId,
      fileId: parsed.rawId,
      newName: input.newName,
    });
  }

  async deleteFiles(input: { directoryId: string; fileIds: string[] }): Promise<{ deleted: string[] }> {
    if (input.fileIds.length === 0) {
      return { deleted: [] };
    }
    const byDrive = new Map<string, Array<{ scoped: string; raw: string }>>();
    for (const fid of input.fileIds) {
      const parsed = this.unscopedId(fid);
      const storageId =
        parsed.storageId ??
        this.fileToDrive.get(fid) ??
        this.dirToDrive.get(input.directoryId)?.storageId ??
        this.defaultState().drive.storageId;
      const list = byDrive.get(storageId) ?? [];
      list.push({ scoped: fid, raw: parsed.rawId });
      byDrive.set(storageId, list);
    }
    const deletedAll: string[] = [];
    for (const [storageId, items] of byDrive) {
      const state = this.states.get(storageId)!;
      const { realDirId } = await this.resolveRealDir(input.directoryId, state);
      const res = await state.adapter.deleteFiles({
        directoryId: realDirId,
        fileIds: items.map((i) => i.raw),
      });
      const deletedRaw = new Set(res.deleted);
      for (const item of items) {
        if (deletedRaw.has(item.raw) || deletedRaw.has(item.scoped)) {
          deletedAll.push(item.scoped);
        }
      }
    }
    return { deleted: deletedAll };
  }

  async removeDirectory(input: { directoryId: string }): Promise<{ removed: string[] }> {
    if (input.directoryId === MULTI_DRIVE_STAGING_HANDLE) {
      const activeStates = [...this.states.values()].filter((s) => s.stagingDirectoryId !== undefined);
      const removedAll: string[] = [];
      for (const state of activeStates) {
        const res = await state.adapter.removeDirectory({ directoryId: state.stagingDirectoryId! });
        removedAll.push(...res.removed.map((id) => this.scopedId(state.drive.storageId, id)));
      }
      return { removed: removedAll };
    }
    if (
      input.directoryId === MULTI_DRIVE_MOVIE_HANDLE ||
      parseMultiDriveSeasonHandle(input.directoryId) !== null
    ) {
      throw new Error(`SAFETY_VIOLATION: refusing to remove target handle ${input.directoryId}`);
    }
    const { state, realDirId } = await this.resolveRealDir(input.directoryId);
    const res = await state.adapter.removeDirectory({ directoryId: realDirId });
    return {
      removed: res.removed.map((id) => this.scopedId(state.drive.storageId, id)),
    };
  }

  /** Run harness-level staging cleanup across every drive that materialized a staging
   *  directory during this run, respecting per-drive `unmovedFileIds`. */
  async cleanupMaterializedStagings(options: {
    unmovedFileIds: ReadonlySet<string>;
    onLeak: (leak: StagingLeak) => void;
    onCleanupUnverified: (event: StagingCleanupUnverified) => void;
    onKept: (event: StagingKeptUnmoved) => void;
  }): Promise<void> {
    if (this.target.kind === "movie") {
      return;
    }
    for (const state of this.states.values()) {
      if (!state.stagingDirectoryId) {
        continue;
      }
      const driveUnmoved = [...options.unmovedFileIds].filter(
        (fid) => this.driveOfFile(fid) === state.drive.storageId,
      );
      await withStagingCleanup(
        {
          executor: state.drive.storage,
          stagingDirectoryId: state.stagingDirectoryId,
          ...(state.showDirectoryId ? { parentDirectoryId: state.showDirectoryId } : {}),
          onLeak: options.onLeak,
          onCleanupUnverified: options.onCleanupUnverified,
          keep: () => (driveUnmoved.length > 0 ? { fileCount: driveUnmoved.length } : null),
          onKept: options.onKept,
        },
        async () => {},
      );
    }
  }
}
