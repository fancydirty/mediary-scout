import type { QueueClaimOptions } from "@media-track/workflow";
import { isUpdateHoldActive, whileInFlight } from "./update-hold";

/**
 * In-process queue drainer.
 *
 * A browser "获取" click only ENQUEUES a workflow run (so it survives a closed
 * browser / reload — the queued/running state lives in Postgres). Something then
 * has to CLAIM and EXECUTE that run, or the UI spins "获取中" forever. On the
 * single long-running Node server (dev, and a single-instance deploy like
 * Railway) that something is this in-process loop: it claims queued runs and
 * runs the long workflows in the background, with all state in Postgres so it
 * stays resumable. A multi-instance deploy would instead run a dedicated worker
 * process that pokes /api/workflows/run-next; this loop is the single-instance
 * form of the same thing. Wired up from instrumentation.ts on server start.
 */

export interface DrainDeps {
  /** Claim+run the next queued workflow; "idle" means nothing claimable. The drain
   *  passes its drive filter and learns the claimed run's drive through `claim`. */
  runNext: (claim?: QueueClaimOptions) => Promise<{ status: string }>;
  /** The daily 巡检 — self-gated to run at most once per day after the set time. */
  runScheduled: () => Promise<unknown>;
  /** Safety cap on runs per tick so a never-idle queue can't spin forever. */
  maxDrains?: number;
  /** Whether any drive is connected. When provided and false (a fresh instance
   *  with no 网盘 yet), the tick skips drain + sweep QUIETLY instead of building a
   *  drive client that throws "PAN115_COOKIE is required" every poll. Optional so
   *  existing callers/tests behave unchanged (absent ⇒ assume configured). */
  isDriveConfigured?: (() => Promise<boolean>) | undefined;
  /** The daily auto-update check — self-gated, reads a few settings and returns. Runs
   *  after the sweep, and also when no drive is connected: it touches no drive. */
  autoUpdate?: (() => Promise<void>) | undefined;
  /** How many queued runs may go at once (the 同时处理 setting, shared with the patrol).
   *  Absent ⇒ 1: one after another. */
  concurrency?: (() => Promise<number>) | undefined;
  /** While runs are going, how often to look for newly queued ones. */
  pollMs?: number | undefined;
  /** Injectable wait (tests). */
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

async function checkAutoUpdate(deps: DrainDeps): Promise<void> {
  if (!deps.autoUpdate) return;
  try {
    await deps.autoUpdate();
  } catch (error) {
    console.error(
      `[background-worker] auto-update check failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * One drain tick: claim+run queued workflows (several at once on different drives,
 * see drainQueue) until nothing is going and nothing more can start (or the safety
 * cap is hit), then attempt the self-gated daily sweep and the auto-update check.
 * Returns how many queued runs were started. The sweep is always attempted,
 * even if draining threw, so a transient queue failure never starves 巡检; a failing
 * sweep never starves the auto-update check either.
 */
export async function drainQueueOnce(deps: DrainDeps): Promise<number> {
  // Fresh instance, no 网盘 connected yet → nothing the worker can do. Skip QUIETLY
  // (don't call runNext/runScheduled, which would build a drive client and throw
  // every poll). Resumes automatically once the user connects a drive.
  if (deps.isDriveConfigured && !(await deps.isDriveConfigured())) {
    await checkAutoUpdate(deps);
    return 0;
  }
  const drained = await drainQueue(deps);
  try {
    await deps.runScheduled();
  } catch (error) {
    console.error(
      `[background-worker] daily sweep failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  await checkAutoUpdate(deps);
  return drained;
}

async function readConcurrency(deps: DrainDeps): Promise<number> {
  if (!deps.concurrency) return 1;
  try {
    const value = Math.floor(await deps.concurrency());
    return Number.isFinite(value) && value >= 1 ? value : 1;
  } catch (error) {
    console.error(
      `[background-worker] could not read the concurrency setting, running one at a time: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

/**
 * Claim and run queued runs until nothing is going and nothing more can start. Up to
 * the concurrency setting go at once, never two on one drive (two runs on one drive
 * double the call rate its risk control sees): each claim skips the drives that have a
 * run going, and a run with no bound drive (it lands on the account's default drive,
 * not known here) only starts when nothing else runs. While runs are going it looks at
 * the queue again every `pollMs`, so a 获取 clicked on another drive starts right away
 * instead of waiting for the run in front of it. A throw stops new claims for this
 * drain; the runs already going finish. Returns how many runs were started.
 */
async function drainQueue(deps: DrainDeps): Promise<number> {
  const maxDrains = deps.maxDrains ?? 50;
  const pollMs = deps.pollMs ?? 3000;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const busyDrives = new Set<string>();
  const running = new Set<Promise<void>>();
  let unboundRunning = false;
  let failed = false;
  let started = 0;

  // One claim at a time, so the next claim already sees this one's drive as busy.
  // Settles as soon as a run is claimed (it keeps going in `running`), or once
  // runNext returns without claiming; the bookkeeping is done before it settles.
  const claimOne = () =>
    new Promise<boolean>((settleClaim) => {
      const excludeConnectedStorageIds = [...busyDrives];
      const excludeUnbound = running.size > 0;
      let claimedDrive: string | null | undefined;
      let ran = false;
      const job: Promise<void> = Promise.resolve()
        .then(() =>
          deps.runNext({
            excludeConnectedStorageIds,
            excludeUnbound,
            onClaimed: ({ connectedStorageId }) => {
              claimedDrive = connectedStorageId;
              if (connectedStorageId === null) unboundRunning = true;
              else busyDrives.add(connectedStorageId);
              settleClaim(true);
            },
          }),
        )
        .then(
          (result) => {
            ran = result.status !== "idle";
          },
          (error: unknown) => {
            failed = true;
            console.error(
              `[background-worker] drain failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          },
        )
        .finally(() => {
          if (claimedDrive === null) unboundRunning = false;
          else if (claimedDrive !== undefined) busyDrives.delete(claimedDrive);
          running.delete(job);
          settleClaim(ran || claimedDrive !== undefined);
        });
      running.add(job);
    });

  for (;;) {
    const limit = await readConcurrency(deps);
    while (!failed && !unboundRunning && running.size < limit && started < maxDrains) {
      if (!(await claimOne())) break;
      started += 1;
    }
    if (running.size === 0) break;
    await Promise.race([...running, sleep(pollMs)]);
  }
  return started;
}

let started = false;

/**
 * The runtime the worker drives. Injectable so the loop is testable without a
 * real Postgres / Next server; production defaults to the workflow-runtime glue.
 */
export interface WorkerRuntime {
  /** Claim+run the next queued workflow; "idle" = nothing claimable (see DrainDeps). */
  runNext: (claim?: QueueClaimOptions) => Promise<{ status: string }>;
  /** Self-gated daily 巡检. */
  runScheduled: () => Promise<unknown>;
  /** Requeue orphaned "running" runs left by a dead worker; returns the count. */
  recover: () => Promise<number>;
  /** Whether any drive is connected (gates the tick — see DrainDeps). Optional so
   *  test runtimes can omit it (absent ⇒ assume configured). */
  isDriveConfigured?: () => Promise<boolean>;
  /** Daily auto-update check (see DrainDeps). Optional so test runtimes can omit it. */
  autoUpdate?: () => Promise<void>;
  /** How many queued runs may go at once (see DrainDeps). Optional so test runtimes can omit it. */
  concurrency?: () => Promise<number>;
}

/**
 * The runtime the worker drives in production. Exported so a test can assert the
 * daily-sweep wiring. 调度闸全在 runScheduledType3 内核（per-slot 认领 + 合并补跑）
 * ——桌面与容器同一语义，无任何 env 特例（曾经的 MEDIA_TRACK_PATROL_IGNORE_TIME_GATE
 * 是桌面零点巡检 bug 的源头，已退役）。
 */
export async function defaultRuntime(): Promise<WorkerRuntime> {
  const {
    runNextQueuedWorkflow,
    runScheduledType3,
    runAutoUpdateIfDue,
    recoverOrphanedRuns,
    workerHasConfiguredDrive,
    getWorkerConcurrency,
  } = await import("./workflow-runtime");
  return {
    runNext: (claim) => runNextQueuedWorkflow(claim),
    concurrency: () => getWorkerConcurrency(),
    runScheduled: () => runScheduledType3(),
    autoUpdate: () => runAutoUpdateIfDue(),
    recover: () => recoverOrphanedRuns(),
    isDriveConfigured: () => workerHasConfiguredDrive(),
  };
}

/** Test-only: clear the singleton guard so a fresh loop can be started. */
export function __resetBackgroundWorkerForTests(): void {
  started = false;
}

/**
 * Start the in-process worker loop. Idempotent (a no-op if already started, so
 * Next's instrumentation calling it more than once is safe). On start it first
 * recovers orphaned "running" runs (crash recovery), THEN polls: each tick
 * drains the queue and runs the self-gated daily sweep. Ticks never overlap: a
 * tick's drain keeps runs on different drives going side by side (see drainQueue),
 * the sweep waits until they have all finished, and the next tick picks up whatever
 * is left. This is what makes a browser "获取" click actually run end-to-end with no
 * external trigger.
 */
export function startBackgroundWorker(options?: { pollMs?: number; runtime?: WorkerRuntime }): void {
  if (started) {
    return;
  }
  if (process.env.MEDIA_TRACK_INPROCESS_WORKER === "0") {
    // Opt-out for multi-instance deploys that run a dedicated worker process.
    return;
  }
  started = true;
  const pollMs = options?.pollMs ?? 3000;
  console.log(`[background-worker] started (poll ${pollMs}ms)`);
  const loadRuntime = options?.runtime ? async () => options.runtime! : defaultRuntime;
  let running = false;
  const tick = async () => {
    // An update is about to replace this process: start nothing new (see update-hold.ts).
    if (running || isUpdateHoldActive(Date.now())) {
      return;
    }
    running = true;
    try {
      // In flight for the updater's busy check: a tick may be between its hold check
      // and claiming a run, or cleaning staging at the end of a patrol.
      await whileInFlight(async () => {
        const runtime = await loadRuntime();
        const drained = await drainQueueOnce({
          runNext: runtime.runNext,
          runScheduled: runtime.runScheduled,
          isDriveConfigured: runtime.isDriveConfigured,
          autoUpdate: runtime.autoUpdate,
          concurrency: runtime.concurrency,
          pollMs,
        });
        if (drained > 0) {
          console.log(`[background-worker] drained ${drained} queued run(s) this tick`);
        }
      });
    } finally {
      running = false;
    }
  };
  // Recover orphaned runs BEFORE polling, then start the loop. A just-clicked
  // acquisition isn't delayed a full interval (immediate first tick).
  void (async () => {
    try {
      const runtime = await loadRuntime();
      const recovered = await runtime.recover();
      if (recovered > 0) {
        console.log(`[background-worker] recovered ${recovered} orphaned run(s) → requeued`);
      }
    } catch (error) {
      console.error(
        `[background-worker] orphan recovery failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    setInterval(() => {
      void tick();
    }, pollMs);
    void tick();
  })();
}
