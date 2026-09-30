import { ensureMediaLibraryDirectory } from "../media-library-folder.js";
import type { AuditEvent } from "../domain.js";
import type { DrivePace } from "../drive-pacer.js";
import type { StorageExecutor } from "../ports.js";

/**
 * Phase 7a — directory lifecycle. Before the agent runs, the system ensures the
 * 115 directory tree exists and hands the agent scoped handles. Every level is
 * verify-or-create: a directory the DB thinks exists may have been deleted by
 * the user, so we go through createDirectory (find-or-create) which lists the
 * parent for the name and reuses it if present, recreates it if gone. The cid is
 * never trusted blindly — the directory is verified like a resource is.
 *
 * Staging lives UNDER the show directory, never inside a Season directory (a
 * recursive lister would otherwise leak isolated files as "obtained").
 */
export interface AcquisitionDirectories {
  showDirectoryId: string;
  /** season number -> its scoped Season directory id. */
  seasonDirectoryIds: Record<number, string>;
  stagingDirectoryId: string;
}

export interface EnsureSeasonDirectoriesRequest {
  executor: Pick<StorageExecutor, "createDirectory" | "listChildDirectories">;
  /** Library category parent (Movies/TV/Anime), chosen by title.type upstream. */
  categoryParentId: string;
  showName: string;
  year: number;
  /** TMDB id — encoded into the show folder name as `{tmdb-N}`. */
  tmdbId: number;
  /** The season number(s) this task covers (one, several, or all). */
  seasons: number[];
  /** Run-scoped suffix so each run gets its own staging dir under the show dir. */
  workflowRunId: string;
}

export async function ensureSeasonAcquisitionDirectories(
  request: EnsureSeasonDirectoriesRequest,
): Promise<AcquisitionDirectories> {
  // Show dir under the category. Prefer `Title (Year) {tmdb-N}`; reuse legacy
  // `Title (Year)` when present so we never fork a second library folder.
  const showDirectoryId = await ensureMediaLibraryDirectory({
    executor: request.executor,
    parentId: request.categoryParentId,
    title: request.showName,
    year: request.year,
    tmdbId: request.tmdbId,
  });
  // Each requested season's Season NN directory under the show dir.
  const seasonDirectoryIds: Record<number, string> = {};
  for (const season of request.seasons) {
    seasonDirectoryIds[season] = await request.executor.createDirectory({
      name: `Season ${String(season).padStart(2, "0")}`,
      parentId: showDirectoryId,
    });
  }
  // Staging UNDER the show dir (never inside a Season dir).
  const stagingDirectoryId = await request.executor.createDirectory({
    name: `staging-${request.workflowRunId}`,
    parentId: showDirectoryId,
  });
  return { showDirectoryId, seasonDirectoryIds, stagingDirectoryId };
}

/** A leftover staging dir the janitor handed over, and how this run reaches it. */
export interface StagingRecoveryDirectories {
  showDirectoryId: string;
  stagingDirectoryId: string;
  /** The drive's category dirs to walk down from, most likely first. Only for drives
   *  whose executor writes where it listed (123 / 光鸭 / 天翼); omitted on 115 / 夸克. */
  categoryDirectoryIds?: string[];
  /** Spaces the walk's calls and waits out the drive's rate limit (123). */
  pace?: DrivePace;
}

/**
 * A leftover staging dir is already the run's staging. Season dirs are resolved
 * the same way as other runs (reuse `Season NN` when it is there, create it only
 * when it is not). The show dir and the staging dir are not created.
 */
export async function bindRecoveryDirectories(
  input: StagingRecoveryDirectories & {
    executor: Pick<StorageExecutor, "createDirectory" | "listChildDirectories">;
    seasons: number[];
  },
): Promise<AcquisitionDirectories> {
  const pace: DrivePace = input.pace ?? (<T>(run: () => Promise<T>) => run());
  // 123 / 光鸭 / 天翼 accept a write only into a directory this executor reached from a
  // scope root (the category dirs) or created. The janitor's ids come from another
  // executor, so walk down again: category → show here, show → season + staging below.
  // A show no longer under any category stays out of scope. A failed listing fails the
  // run: without the walk nothing here could be written.
  for (const categoryId of new Set(input.categoryDirectoryIds ?? [])) {
    const shows = await pace(() => input.executor.listChildDirectories(categoryId));
    if (shows.some((show) => show.id === input.showDirectoryId)) break;
  }
  const children = await pace(() => input.executor.listChildDirectories(input.showDirectoryId));
  const seasonDirectoryIds: Record<number, string> = {};
  for (const season of input.seasons) {
    const name = `Season ${String(season).padStart(2, "0")}`;
    const existing = children.find((child) => child.name === name);
    seasonDirectoryIds[season] = existing
      ? existing.id
      : await pace(() => input.executor.createDirectory({ name, parentId: input.showDirectoryId }));
  }
  return {
    showDirectoryId: input.showDirectoryId,
    seasonDirectoryIds,
    stagingDirectoryId: input.stagingDirectoryId,
  };
}

/**
 * Run an acquisition body, then ALWAYS discard the run's staging dir — on success,
 * failure, or honest no-coverage alike. The agent keeps its own discardStaging and
 * normally calls it; this finally is the HARNESS-level leak guard for the paths
 * where it doesn't (e.g. 斗破苍穹: a 335-file pack hit the list cap → the agent
 * reportNoCoverage'd and finished, leaving 335 transferred files in staging).
 * removeDirectory is idempotent: if the agent already discarded, the "already gone"
 * error is swallowed so cleanup never masks the real result. It only ever touches
 * THIS run's ephemeral staging dir — never a Season/library dir.
 *
 * VERIFY THE LANDING POINT, DON'T TRUST THE CALL (2026-09-20 123网盘): file/trash
 * answered code:0 to a string FileId and deleted nothing; removeDirectory dutifully
 * returned {removed:true}; this finally swallowed the rest — 80 staging dirs /
 * ~1.4 TB leaked over a month with zero signal. So when the caller hands over the
 * parent dir, the cleanup READS BACK whether the staging dir is still listed under
 * it and reports a leak through `onLeak` (audit trail + notification upstream).
 * The read-back is best-effort when removal succeeded: a failing listing then
 * never masks the run's outcome. When removal itself failed AND the read-back
 * could not be done (threw, or the executor cannot list), that is no longer
 * silent — it is a `staging_cleanup_unverified` event (2026-09-27: the 115 budget
 * was spent, so both the delete and the listing were refused and nothing was recorded).
 */
export interface StagingLeak {
  stagingDirectoryId: string;
  /** The show dir the staging dir was created under — where a hand cleanup has to
   *  look. Carried on the leak itself because the failure persist path has no
   *  `directories` object to look it up from (Copilot #260 r2). */
  showDirectoryId: string;
  /** The removeDirectory error when the cleanup threw; undefined when it "succeeded". */
  error?: unknown;
}

/** Leaks detected on the THROW path ride on the thrown error itself: the body
 *  failed, so no result object exists to carry them, and the only code that
 *  persists such a run is the failure handler (worker.ts) — which reads them back
 *  via `stagingLeaksOf`. Attached as a symbol-keyed property so the error's
 *  identity (class, message, cause chain) is untouched: brand *AuthError freezes
 *  and transient-error classification keep working (Copilot #260 r1). */
const STAGING_LEAKS = Symbol.for("media-track.stagingLeaks");
const STAGING_CLEANUP_UNVERIFIED = Symbol.for("media-track.stagingCleanupUnverified");
const STAGING_KEPT_UNMOVED = Symbol.for("media-track.stagingKeptUnmoved");

/** Removal failed and we could not read the show dir back to see if staging is
 *  still there. Distinct from a confirmed leak. */
export interface StagingCleanupUnverified {
  stagingDirectoryId: string;
  showDirectoryId: string;
  error: unknown;
}

export function attachStagingLeaks<E>(error: E, leaks: StagingLeak[]): E {
  if (leaks.length > 0 && typeof error === "object" && error !== null) {
    const prior = stagingLeaksOf(error);
    Object.defineProperty(error, STAGING_LEAKS, {
      value: [...prior, ...leaks],
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  return error;
}

export function stagingLeaksOf(error: unknown): StagingLeak[] {
  if (typeof error !== "object" || error === null) {
    return [];
  }
  const leaks = (error as Record<symbol, unknown>)[STAGING_LEAKS];
  return Array.isArray(leaks) ? (leaks as StagingLeak[]) : [];
}

export function attachStagingCleanupUnverified<E>(error: E, events: StagingCleanupUnverified[]): E {
  if (events.length > 0 && typeof error === "object" && error !== null) {
    const prior = stagingCleanupUnverifiedOf(error);
    Object.defineProperty(error, STAGING_CLEANUP_UNVERIFIED, {
      value: [...prior, ...events],
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  return error;
}

export function stagingCleanupUnverifiedOf(error: unknown): StagingCleanupUnverified[] {
  if (typeof error !== "object" || error === null) {
    return [];
  }
  const events = (error as Record<symbol, unknown>)[STAGING_CLEANUP_UNVERIFIED];
  return Array.isArray(events) ? (events as StagingCleanupUnverified[]) : [];
}

export function stagingCleanupUnverifiedAuditEvent(event: StagingCleanupUnverified): AuditEvent {
  const text = event.error instanceof Error ? event.error.message : String(event.error);
  return {
    type: "staging_cleanup_unverified",
    message: `staging 目录清理失败且无法复核是否还在网盘上(${event.stagingDirectoryId})：${text}`,
    data: {
      stagingDirectoryId: event.stagingDirectoryId,
      showDirectoryId: event.showDirectoryId,
      cleanupError: text,
    },
  };
}

/** Staging was left in place because a move failed and those files never reached
 *  a season dir (and were not deleted). */
export interface StagingKeptUnmoved {
  stagingDirectoryId: string;
  showDirectoryId: string;
  fileCount: number;
}

export function attachStagingKeptUnmoved<E>(error: E, events: StagingKeptUnmoved[]): E {
  if (events.length > 0 && typeof error === "object" && error !== null) {
    const prior = stagingKeptUnmovedOf(error);
    Object.defineProperty(error, STAGING_KEPT_UNMOVED, {
      value: [...prior, ...events],
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  return error;
}

export function stagingKeptUnmovedOf(error: unknown): StagingKeptUnmoved[] {
  if (typeof error !== "object" || error === null) {
    return [];
  }
  const events = (error as Record<symbol, unknown>)[STAGING_KEPT_UNMOVED];
  return Array.isArray(events) ? (events as StagingKeptUnmoved[]) : [];
}

export function stagingKeptAuditEvent(event: StagingKeptUnmoved): AuditEvent {
  return {
    type: "staging_kept_unmoved_files",
    message: `staging 目录里还有 ${event.fileCount} 个移动失败、没进季目录的文件，已保留不删：${event.stagingDirectoryId}`,
    data: {
      stagingDirectoryId: event.stagingDirectoryId,
      showDirectoryId: event.showDirectoryId,
      fileCount: event.fileCount,
    },
  };
}

/** Leaks, unverified cleanups, then dirs kept because a move failed. The failure
 *  persist sites (worker) record all of them or they record none. */
export function stagingFailureAuditEvents(error: unknown): AuditEvent[] {
  return [
    ...stagingLeaksOf(error).map((leak) => stagingLeakAuditEvent(leak)),
    ...stagingCleanupUnverifiedOf(error).map((event) => stagingCleanupUnverifiedAuditEvent(event)),
    ...stagingKeptUnmovedOf(error).map((event) => stagingKeptAuditEvent(event)),
  ];
}

/** The ONE shape of the `staging_leaked` audit event, shared by the success path
 *  (workflow-v2 result) and every failure persist site (worker). */
export function stagingLeakAuditEvent(leak: StagingLeak): AuditEvent {
  return {
    type: "staging_leaked",
    message: `staging 目录清理后仍在网盘上(${leak.stagingDirectoryId})——本次转存的临时文件没有被删除,请手动清理`,
    data: {
      stagingDirectoryId: leak.stagingDirectoryId,
      showDirectoryId: leak.showDirectoryId,
      ...(leak.error === undefined
        ? {}
        : { cleanupError: leak.error instanceof Error ? leak.error.message : String(leak.error) }),
    },
  };
}

export async function withStagingCleanup<T>(
  args: {
    executor: Pick<StorageExecutor, "removeDirectory"> &
      Partial<Pick<StorageExecutor, "listChildDirectories" | "withCleanupBudget">>;
    stagingDirectoryId: string;
    /** The show dir the staging dir was created under. When given (together with a
     *  listChildDirectories-capable executor) the cleanup verifies removal by reading
     *  back the parent. Omit for the legacy fire-and-forget form. */
    parentDirectoryId?: string;
    onLeak?: (leak: StagingLeak) => void;
    /** Removal failed and the show dir could not be read back. Same role as onLeak
     *  for the success path; the throw path also rides on the error. */
    onCleanupUnverified?: (event: StagingCleanupUnverified) => void;
    /** Non-null: files whose move failed are still only in staging. Do not remove
     *  the dir (a kept dir would also look like a leak, so skip the read-back). */
    keep?: () => { fileCount: number } | null;
    /** A recovery adopted an existing leftover. A throw must leave that dir
     *  where it is. */
    preserveOnThrow?: boolean;
    /** Recovery only. A normal return discards the adopted dir only when this
     *  is true (the agent called finish or discardStaging). Anything else keeps
     *  it for a later sweep. Absent on an ordinary run, whose fresh staging is
     *  always discarded. */
    discardOnNormalReturn?: () => boolean;
    onKept?: (event: StagingKeptUnmoved) => void;
  },
  run: () => Promise<T>,
): Promise<T> {
  let bodyError: unknown;
  let threw = false;
  try {
    return await run();
  } catch (error) {
    threw = true;
    bodyError = error;
    throw error;
  } finally {
    const cleanup = async (): Promise<void> => {
      const kept = args.keep?.() ?? null;
      if (kept) {
        const event: StagingKeptUnmoved = {
          stagingDirectoryId: args.stagingDirectoryId,
          showDirectoryId: args.parentDirectoryId ?? "",
          fileCount: kept.fileCount,
        };
        args.onKept?.(event);
        if (threw) {
          attachStagingKeptUnmoved(bodyError, [event]);
        }
        return;
      }
      // No unmoved files to report. A thrown recovery must not delete the
      // adopted leftover. A normal return deletes it only after finish or
      // discardStaging; any other exit leaves it for the next sweep.
      if (threw && args.preserveOnThrow) {
        return;
      }
      if (!threw && args.discardOnNormalReturn && !args.discardOnNormalReturn()) {
        return;
      }
      let removalFailed = false;
      let removalError: unknown;
      try {
        const removed = await args.executor.removeDirectory(args.stagingDirectoryId);
        if (removed?.removed === false) {
          removalFailed = true;
          removalError = new Error("removeDirectory returned {removed:false}");
        }
      } catch (error) {
        // Idempotent: staging may already be gone (agent discarded it). Never let
        // a cleanup failure throw over the real outcome.
        removalFailed = true;
        removalError = error;
      }

      const parentId = args.parentDirectoryId;
      if (parentId === undefined) {
        return;
      }
      const reportUnverified = (error: unknown): void => {
        const event: StagingCleanupUnverified = {
          stagingDirectoryId: args.stagingDirectoryId,
          showDirectoryId: parentId,
          error,
        };
        args.onCleanupUnverified?.(event);
        if (threw) {
          attachStagingCleanupUnverified(bodyError, [event]);
        }
      };
      const list = args.executor.listChildDirectories;
      if (typeof list !== "function") {
        if (removalFailed) {
          reportUnverified(removalError);
        }
        return;
      }
      try {
        const children = await list.call(args.executor, parentId);
        if (children.some((child) => child.id === args.stagingDirectoryId)) {
          const leak: StagingLeak = {
            stagingDirectoryId: args.stagingDirectoryId,
            showDirectoryId: parentId,
            error: removalError,
          };
          args.onLeak?.(leak);
          if (threw) {
            // The rethrown body error is the only thing leaving this frame: make
            // it carry the leak so the failure persist path can record it.
            attachStagingLeaks(bodyError, [leak]);
          }
        }
      } catch (readBackError) {
        // A successful removal plus a failed listing stays quiet (the dir is
        // gone as far as the delete told us). A failed removal we could not
        // check is the silent hole the 115 budget exhaustion fell into.
        if (!removalFailed) {
          return;
        }
        const removalText = removalError instanceof Error ? removalError.message : String(removalError);
        const readText = readBackError instanceof Error ? readBackError.message : String(readBackError);
        reportUnverified(new Error(`${removalText}; read-back failed: ${readText}`));
      }
    };
    if (typeof args.executor.withCleanupBudget === "function") {
      await args.executor.withCleanupBudget(cleanup);
    } else {
      await cleanup();
    }
  }
}
