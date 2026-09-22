import { ensureMediaLibraryDirectory } from "../media-library-folder.js";
import type { AuditEvent } from "../domain.js";
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
 * The read-back is best-effort: a failing listing never masks the run's outcome.
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
    executor: Pick<StorageExecutor, "removeDirectory"> & Partial<Pick<StorageExecutor, "listChildDirectories">>;
    stagingDirectoryId: string;
    /** The show dir the staging dir was created under. When given (together with a
     *  listChildDirectories-capable executor) the cleanup verifies removal by reading
     *  back the parent. Omit for the legacy fire-and-forget form. */
    parentDirectoryId?: string;
    onLeak?: (leak: StagingLeak) => void;
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
    let cleanupError: unknown;
    try {
      await args.executor.removeDirectory(args.stagingDirectoryId);
    } catch (error) {
      // Idempotent: staging may already be gone (agent discarded it). Never let
      // a cleanup failure throw over the real outcome.
      cleanupError = error;
    }
    if (args.parentDirectoryId !== undefined && args.executor.listChildDirectories && args.onLeak) {
      try {
        const children = await args.executor.listChildDirectories(args.parentDirectoryId);
        if (children.some((child) => child.id === args.stagingDirectoryId)) {
          const leak: StagingLeak = {
            stagingDirectoryId: args.stagingDirectoryId,
            showDirectoryId: args.parentDirectoryId,
            error: cleanupError,
          };
          args.onLeak(leak);
          if (threw) {
            // The rethrown body error is the only thing leaving this frame: make
            // it carry the leak so the failure persist path can record it.
            attachStagingLeaks(bodyError, [leak]);
          }
        }
      } catch {
        // Read-back is diagnostic only; a listing failure must not mask the result.
      }
    }
  }
}
