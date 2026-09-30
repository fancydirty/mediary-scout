import type { WorkflowKind } from "./domain.js";
import type { StorageExecutor } from "./ports.js";
import { isActiveWorkflowStatus, type TrackedSeasonState, type WorkflowRepository } from "./repository.js";
import {
  legacyMediaLibraryFolderName,
  mediaLibraryFolderName,
  tmdbIdFromMediaLibraryFolderName,
} from "./media-library-folder.js";
import { drivePacer, realtimeDriveClock, type DriveClock } from "./drive-pacer.js";
import { JANITOR_LIST_DEPTH } from "./staging-depth.js";
import type { MayStartRun } from "./worker.js";

/** Every kind. `blockIfTitleHasActiveRun` ignores staging_recovery so a user
 *  action can proceed; this reservation must still wait for one. */
const TITLE_BLOCK_KINDS: Record<WorkflowKind, true> = {
  type1_package_init: true,
  type2_init: true,
  type3_monitor: true,
  movie_init: true,
  replace_request: true,
  staging_recovery: true,
};

/** A failed run is requeued on the same id within 15 minutes. Don't touch its staging until that window is long gone. */
const SWEEP_SETTLE_MS = 60 * 60 * 1000;
/** Non-empty leftovers judged later. The rest wait for the next sweep. */
const RECOVERY_CAP = 5;

export interface StagingJanitorDrive {
  accountId: string;
  storageId: string;
  status: "active" | "frozen";
  /** Drive brand. pan123 listings are spaced; other brands are not (115 paces itself). */
  provider: string;
  tvCid: string | null;
  animeCid: string | null;
  executor: Partial<Pick<StorageExecutor, "listChildDirectories" | "listTree" | "listSubdirectories" | "removeDirectory">>;
}

/** Calls are spaced and 123's rate limit is waited out by drivePacer. When it gives
 *  up, the resume cursor stays where the walk stopped. */
export type StagingJanitorClock = DriveClock;

type SweepRepository = Pick<
  WorkflowRepository,
  | "getWorkflowRunSnapshot"
  | "getAccountSetting"
  | "setAccountSetting"
  | "listTrackedSeasonStates"
  | "listActiveWorkflowRuns"
  | "findActiveStagingRecovery"
  | "reserveWorkflowRun"
>;

/** The run was claimed again, or a missing run gained a snapshot, since the first read. */
function runCameBack(
  first: Awaited<ReturnType<SweepRepository["getWorkflowRunSnapshot"]>>,
  again: Awaited<ReturnType<SweepRepository["getWorkflowRunSnapshot"]>>,
): boolean {
  return Boolean((again && isActiveWorkflowStatus(again.workflowRun.status)) || (!first && again));
}

function settledForSweep(
  snapshot: Awaited<ReturnType<SweepRepository["getWorkflowRunSnapshot"]>>,
  now: string,
): boolean {
  if (!snapshot) return true;
  if (isActiveWorkflowStatus(snapshot.workflowRun.status)) return false;
  const at = snapshot.workflowRun.finishedAt ?? snapshot.workflowRun.startedAt;
  const age = Date.parse(now) - Date.parse(at);
  return Number.isFinite(age) && age > SWEEP_SETTLE_MS;
}

/** A subdirectory path with this many segments was recorded but not opened.
 *  115, 123, quark, 光鸭 and 天翼 all walk the same way: depth 1 is the orphan,
 *  each child adds one `path` segment, and `depth > maxDepth` returns before
 *  listing. A dir whose path has JANITOR_LIST_DEPTH segments may hold files
 *  the file walk never saw. */
function subdirectorySitsAtDepthLimit(path: string): boolean {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  return segments.length >= JANITOR_LIST_DEPTH;
}

type CapableExecutor = Pick<StorageExecutor, "listChildDirectories" | "listTree" | "removeDirectory"> &
  Partial<Pick<StorageExecutor, "listSubdirectories">>;

function canSweep(executor: StagingJanitorDrive["executor"]): executor is CapableExecutor {
  return (
    typeof executor.listChildDirectories === "function" &&
    typeof executor.listTree === "function" &&
    typeof executor.removeDirectory === "function"
  );
}

/** `staging-<runId>` → runId. Anything else (Season 01, extras, a bare "staging") is not ours. */
function stagingRunId(name: string): string | null {
  const match = /^staging-(.+)$/.exec(name);
  return match?.[1] ? match[1] : null;
}

function cursorKey(storageId: string): string {
  return `staging_janitor_cursor:${storageId}`;
}

/** The tracked seasons of the show this directory belongs to, lowest season first. */
function seasonsForShow(
  show: { id: string; name: string },
  children: Array<{ id: string; name: string }>,
  states: TrackedSeasonState[],
  mediaType: "tv" | "anime",
): TrackedSeasonState[] | null {
  const childIds = new Set(children.map((child) => child.id));
  const byTitle = new Map<string, TrackedSeasonState[]>();
  for (const state of states) {
    if (state.title.type !== mediaType) continue;
    const list = byTitle.get(state.title.id) ?? [];
    list.push(state);
    byTitle.set(state.title.id, list);
  }
  const matches = (seasons: TrackedSeasonState[]): boolean =>
    seasons.some(
      (season) => season.season.storageDirectoryId === show.id || childIds.has(season.season.storageDirectoryId),
    );
  const idHits = [...byTitle.entries()].filter(([, seasons]) => matches(seasons)).map(([id]) => id);
  let titleId = idHits.length === 1 ? idHits[0] : undefined;
  if (!titleId && idHits.length === 0) {
    const nameHits = [...byTitle.entries()]
      .filter(([, seasons]) => {
        const title = seasons[0]!.title;
        const names = [
          mediaLibraryFolderName({ title: title.title, year: title.year, tmdbId: title.tmdbId }),
          legacyMediaLibraryFolderName({ title: title.title, year: title.year }),
        ];
        return names.includes(show.name);
      })
      .map(([id]) => id);
    if (nameHits.length === 1) titleId = nameHits[0];
  }
  if (!titleId) return null;
  return byTitle.get(titleId)!.sort((a, b) => a.season.seasonNumber - b.season.seasonNumber);
}

/** tv and anime share TMDB's tv id namespace. A movie with the same number is a different title. */
function tvNamespaceTitleIsTracked(states: TrackedSeasonState[], tmdbId: number): boolean {
  return states.some(
    (state) => state.title.tmdbId === tmdbId && (state.title.type === "tv" || state.title.type === "anime"),
  );
}

async function sweepDrive(
  drive: StagingJanitorDrive,
  repository: SweepRepository,
  now: string,
  clock: StagingJanitorClock,
  mayStartRun: MayStartRun | undefined,
): Promise<{
  removed: number;
  queued: number;
  notRemoved: number;
  skippedDeep: number;
  removedUntracked: number;
  skippedUnmatched: number;
  held: boolean;
}> {
  if (drive.status !== "active" || !canSweep(drive.executor)) {
    return { removed: 0, queued: 0, notRemoved: 0, skippedDeep: 0, removedUntracked: 0, skippedUnmatched: 0, held: false };
  }
  const executor = drive.executor;
  const pace = drivePacer(drive.provider, clock);
  const scope = { accountId: drive.accountId, connectedStorageId: drive.storageId };
  const states = await repository.listTrackedSeasonStates(scope);
  const active = await repository.listActiveWorkflowRuns(scope);
  const busyTitles = new Set(active.map((run) => run.title.id));
  let removed = 0;
  let notRemoved = 0;
  let queued = 0;
  let skippedDeep = 0;
  let removedUntracked = 0;
  let skippedUnmatched = 0;

  const shows: Array<{ id: string; name: string; type: "tv" | "anime" }> = [];
  for (const category of [
    drive.tvCid ? { id: drive.tvCid, type: "tv" as const } : null,
    drive.animeCid ? { id: drive.animeCid, type: "anime" as const } : null,
  ]) {
    if (!category) continue;
    // A category listing that throws has no show id. Leave the previous cursor.
    const children = await pace(() => executor.listChildDirectories(category.id));
    for (const child of children) shows.push({ ...child, type: category.type });
  }

  const savedCursor = await repository.getAccountSetting(drive.accountId, cursorKey(drive.storageId));
  const cursorIndex = savedCursor ? shows.findIndex((show) => show.id === savedCursor) : -1;
  const start = cursorIndex < 0 ? 0 : cursorIndex;
  const startedFromSavedCursor = cursorIndex >= 0;

  let held = false;
  for (let index = start; index < shows.length; index += 1) {
    const show = shows[index]!;
    // An update is about to replace this process: stop before the next show's deletes,
    // and resume from this show on the next sweep.
    if (mayStartRun && !mayStartRun()) {
      held = true;
      await repository.setAccountSetting(drive.accountId, cursorKey(drive.storageId), show.id);
      break;
    }
    try {
      const children = await pace(() => executor.listChildDirectories(show.id));
      for (const child of children) {
        const runId = stagingRunId(child.name);
        if (!runId) continue;
        const snapshot = await repository.getWorkflowRunSnapshot(runId, drive.accountId);
        // Missing, or finished more than an hour ago. A run that just failed can be
        // requeued on this same id and recreate this directory.
        if (!settledForSweep(snapshot, now)) continue;
        const tree = await pace(() => executor.listTree({ directoryId: child.id, maxDepth: JANITOR_LIST_DEPTH }));
        // A directory at the depth limit was not opened. A file below it is
        // invisible here, and a recovery's discardStaging would delete it.
        // Leave the orphan whether or not other files were visible.
        const subdirs =
          typeof executor.listSubdirectories === "function"
            ? await pace(() => executor.listSubdirectories!({ directoryId: child.id, maxDepth: JANITOR_LIST_DEPTH }))
            : null;
        if (subdirs === null || subdirs.some((dir) => subdirectorySitsAtDepthLimit(dir.path))) {
          skippedDeep += 1;
          continue;
        }
        // Re-read after both listings, right before any delete or queue: the run
        // can be requeued on this id while the provider walks the tree.
        const again = await repository.getWorkflowRunSnapshot(runId, drive.accountId);
        if (runCameBack(snapshot, again)) continue;
        // No files anywhere in the walk, wrapper folders included.
        if (tree.length === 0) {
          const result = await pace(() => executor.removeDirectory(child.id));
          if (result.removed) removed += 1;
          else notRemoved += 1;
          continue;
        }
        const seasons = seasonsForShow(show, children, states, show.type);
        // No season matched. A `{tmdb-N}` folder is untracked when this drive has
        // no tv/anime season with that id. Its files were for a title this drive
        // no longer tracks: nothing will ever move them into a season, and keeping
        // them leaves a half-finished folder in the library for good. A legacy
        // name, or a tracked id we failed to match, stays — deleting it might
        // throw away a real title.
        if (!seasons || seasons.length === 0) {
          const tmdbId = tmdbIdFromMediaLibraryFolderName(show.name);
          // The snapshot above is from the start of the sweep. A title the user
          // starts tracking during the walk must not lose its leftover.
          if (tmdbId !== null && !tvNamespaceTitleIsTracked(states, tmdbId)) {
            const fresh = await repository.listTrackedSeasonStates(scope);
            if (!tvNamespaceTitleIsTracked(fresh, tmdbId)) {
              const result = await pace(() => executor.removeDirectory(child.id));
              if (result.removed) removedUntracked += 1;
              else notRemoved += 1;
              continue;
            }
          }
          skippedUnmatched += 1;
          continue;
        }
        if (queued >= RECOVERY_CAP) continue;
        if (busyTitles.has(seasons[0]!.title.id)) continue;
        const already = await repository.findActiveStagingRecovery({
          accountId: drive.accountId,
          connectedStorageId: drive.storageId,
          stagingDirectoryId: child.id,
        });
        if (already) continue;
        const lock = seasons[0]!;
        const reservation = await repository.reserveWorkflowRun({
          accountId: drive.accountId,
          connectedStorageId: drive.storageId,
          title: lock.title,
          season: lock.season,
          workflowRun: {
            id: crypto.randomUUID(),
            kind: "staging_recovery",
            status: "queued",
            trackedSeasonId: lock.season.id,
            startedAt: now,
            finishedAt: null,
            auditEvents: [
              {
                type: "staging_recovery_queued",
                message: `Queued staging recovery for ${child.id}`,
                data: {
                  stagingDirectoryId: child.id,
                  showDirectoryId: show.id,
                  seasonNumbers: seasons.map((season) => season.season.seasonNumber),
                },
              },
            ],
          },
          episodes: lock.episodes,
          resourceSnapshots: [],
          decisions: [],
          transferAttempts: [],
          notifications: [],
          blockIfTitleHasActiveKinds: Object.keys(TITLE_BLOCK_KINDS) as WorkflowKind[],
          requireTrackedSeason: true,
          keepCurrentEpisodes: true,
        });
        if (reservation.status !== "reserved") continue;
        queued += 1;
        busyTitles.add(lock.title.id);
      }
    } catch (error) {
      // A show that throws on the sweep we resumed onto has failed twice in a
      // row. Skip it until the next full pass so the shows after it still run.
      const resumeAt =
        startedFromSavedCursor && index === start ? (shows[index + 1]?.id ?? "") : show.id;
      await repository.setAccountSetting(drive.accountId, cursorKey(drive.storageId), resumeAt);
      throw error;
    }
  }

  if (!held) await repository.setAccountSetting(drive.accountId, cursorKey(drive.storageId), "");
  return { removed, queued, notRemoved, skippedDeep, removedUntracked, skippedUnmatched, held };
}

/**
 * Daily-patrol pass over leftover `staging-<runId>` dirs. An orphan with no files
 * (empty wrapper folders included) is removed once its run is missing or finished
 * more than an hour ago. A non-empty one queues one silent `staging_recovery` run
 * — at most 5 per drive per sweep — and is never mentioned to the user.
 * A non-empty leftover whose show folder is `{tmdb-N}`, and this drive no longer
 * tracks that tv/anime id, is removed too (the staging dir only, not the show).
 *
 * ponytail: one fresh executor per drive, so the 115 guard still caps a single
 * sweep (~295 listings). A listing throw stores `staging_janitor_cursor:<storageId>`
 * (the show dir id) and the next sweep continues there. If that same show throws
 * again, the cursor moves to the next show so one directory cannot stall the drive.
 * pan123 calls are spaced 1500ms; other brands are not. Sequential on purpose.
 */
export async function sweepOrphanStagingDirs(input: {
  repository: SweepRepository;
  drives: StagingJanitorDrive[];
  now: string;
  clock?: StagingJanitorClock;
  log?: (line: string) => void;
  /** Checked before each show folder. A false stops the sweep there. */
  mayStartRun?: MayStartRun;
}): Promise<{ held: boolean }> {
  const log = input.log ?? ((line: string) => console.log(line));
  const clock = input.clock ?? realtimeDriveClock;
  let held = false;
  for (const drive of input.drives) {
    if (held) break;
    try {
      const counts = await sweepDrive(drive, input.repository, input.now, clock, input.mayStartRun);
      held = counts.held;
      const removal =
        counts.notRemoved > 0
          ? `removed ${counts.removed} empty (${counts.notRemoved} could not be removed)`
          : `removed ${counts.removed} empty`;
      const untracked = counts.removedUntracked > 0 ? `, removed ${counts.removedUntracked} untracked` : "";
      const unmatched = counts.skippedUnmatched > 0 ? `, skipped ${counts.skippedUnmatched} unmatched` : "";
      const deep = counts.skippedDeep > 0 ? `, skipped ${counts.skippedDeep} deep` : "";
      log(
        `[patrol] staging janitor ${drive.storageId}: ${removal}, queued ${counts.queued} recovery${untracked}${unmatched}${deep}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[patrol] staging janitor ${drive.storageId}: failed: ${message}`);
    }
  }
  if (held) log("[patrol] staging janitor stopped: an update is about to replace this process");
  return { held };
}
