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
  /** Claim+run the next queued workflow; "idle" means the queue is empty. */
  runNext: () => Promise<{ status: string }>;
  /** The daily 巡检 — self-gated to run at most once per day after the set time. */
  runScheduled: () => Promise<unknown>;
  /** Safety cap on runs per tick so a never-idle queue can't spin forever. */
  maxDrains?: number;
  /** Whether any drive is connected. When provided and false (a fresh instance
   *  with no 网盘 yet), the tick skips drain + sweep QUIETLY instead of building a
   *  drive client that throws "PAN115_COOKIE is required" every poll. Optional so
   *  existing callers/tests behave unchanged (absent ⇒ assume configured). */
  isDriveConfigured?: (() => Promise<boolean>) | undefined;
}

/**
 * One drain tick: claim+run queued workflows until the queue is idle (or the
 * safety cap is hit), then attempt the self-gated daily sweep. Returns how many
 * queued runs were executed. The sweep is always attempted, even if draining
 * threw, so a transient queue failure never starves 巡检.
 */
export async function drainQueueOnce(deps: DrainDeps): Promise<number> {
  // Fresh instance, no 网盘 connected yet → nothing the worker can do. Skip QUIETLY
  // (don't call runNext/runScheduled, which would build a drive client and throw
  // every poll). Resumes automatically once the user connects a drive.
  if (deps.isDriveConfigured && !(await deps.isDriveConfigured())) {
    return 0;
  }
  const maxDrains = deps.maxDrains ?? 50;
  let drained = 0;
  try {
    for (let i = 0; i < maxDrains; i += 1) {
      const result = await deps.runNext();
      if (result.status === "idle") {
        break;
      }
      drained += 1;
    }
  } catch (error) {
    console.error(
      `[background-worker] drain failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    await deps.runScheduled();
  } catch (error) {
    console.error(
      `[background-worker] daily sweep failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return drained;
}

let started = false;

/**
 * The runtime the worker drives. Injectable so the loop is testable without a
 * real Postgres / Next server; production defaults to the workflow-runtime glue.
 */
export interface WorkerRuntime {
  /** Claim+run the next queued workflow; "idle" = queue empty. */
  runNext: () => Promise<{ status: string }>;
  /** Self-gated daily 巡检. */
  runScheduled: () => Promise<unknown>;
  /** Requeue orphaned "running" runs left by a dead worker; returns the count. */
  recover: () => Promise<number>;
  /** Whether any drive is connected (gates the tick — see DrainDeps). Optional so
   *  test runtimes can omit it (absent ⇒ assume configured). */
  isDriveConfigured?: () => Promise<boolean>;
}

async function defaultRuntime(): Promise<WorkerRuntime> {
  const { runNextQueuedWorkflow, runScheduledType3, recoverOrphanedRuns, workerHasConfiguredDrive } =
    await import("./workflow-runtime");
  return {
    runNext: () => runNextQueuedWorkflow(),
    runScheduled: () => runScheduledType3(),
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
 * drains the queue and runs the self-gated daily sweep. Ticks never overlap —
 * a long workflow holds the tick until it finishes, and the next tick picks up
 * whatever queued while it ran. This is what makes a browser "获取" click
 * actually run end-to-end with no external trigger.
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
    if (running) {
      return;
    }
    running = true;
    try {
      const runtime = await loadRuntime();
      const drained = await drainQueueOnce({
        runNext: runtime.runNext,
        runScheduled: runtime.runScheduled,
        isDriveConfigured: runtime.isDriveConfigured,
      });
      if (drained > 0) {
        console.log(`[background-worker] drained ${drained} queued run(s) this tick`);
      }
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
