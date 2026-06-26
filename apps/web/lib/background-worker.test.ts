import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  drainQueueOnce,
  startBackgroundWorker,
  __resetBackgroundWorkerForTests,
} from "./background-worker";

describe("drainQueueOnce — the in-process queue drainer (one tick)", () => {
  it("claims queued runs until the queue is idle, then runs the daily sweep once", async () => {
    const statuses = ["ran", "ran", "idle"] as const;
    let i = 0;
    const runNext = vi.fn(async () => ({ status: statuses[i++] ?? "idle" }));
    const runScheduled = vi.fn(async () => ({ outcomes: [] }));

    const drained = await drainQueueOnce({ runNext, runScheduled });

    expect(drained).toBe(2); // two runs executed before idle
    expect(runNext).toHaveBeenCalledTimes(3); // two ran + one idle
    expect(runScheduled).toHaveBeenCalledTimes(1);
  });

  it("does nothing but the sweep when the queue is already idle", async () => {
    const runNext = vi.fn(async () => ({ status: "idle" as const }));
    const runScheduled = vi.fn(async () => ({ outcomes: [] }));

    const drained = await drainQueueOnce({ runNext, runScheduled });

    expect(drained).toBe(0);
    expect(runNext).toHaveBeenCalledTimes(1);
    expect(runScheduled).toHaveBeenCalledTimes(1);
  });

  it("stops at the safety cap so a never-idle queue can't spin forever in one tick", async () => {
    const runNext = vi.fn(async () => ({ status: "ran" as const }));
    const runScheduled = vi.fn(async () => ({ outcomes: [] }));

    const drained = await drainQueueOnce({ runNext, runScheduled, maxDrains: 5 });

    expect(drained).toBe(5);
    expect(runNext).toHaveBeenCalledTimes(5);
  });

  it("a failing runNext does not prevent the daily sweep from being attempted", async () => {
    const runNext = vi.fn(async () => {
      throw new Error("transient queue failure");
    });
    const runScheduled = vi.fn(async () => ({ outcomes: [] }));

    const drained = await drainQueueOnce({ runNext, runScheduled });

    expect(drained).toBe(0);
    expect(runScheduled).toHaveBeenCalledTimes(1);
  });

  // Fresh instance with no drive connected yet: the worker can't acquire anywhere,
  // so it must skip BOTH drain and sweep QUIETLY — not call them and let them throw
  // "PAN115_COOKIE is required" every tick, which spammed the logs and made new users
  // think the deploy was broken.
  it("skips drain AND sweep quietly when no drive is configured", async () => {
    const runNext = vi.fn(async () => ({ status: "idle" as const }));
    const runScheduled = vi.fn(async () => ({ outcomes: [] }));
    const isDriveConfigured = vi.fn(async () => false);

    const drained = await drainQueueOnce({ runNext, runScheduled, isDriveConfigured });

    expect(drained).toBe(0);
    expect(isDriveConfigured).toHaveBeenCalledTimes(1);
    expect(runNext).not.toHaveBeenCalled(); // never tried → no "drain failed" throw
    expect(runScheduled).not.toHaveBeenCalled(); // never tried → no "daily sweep failed" throw
  });

  it("drains + sweeps normally when a drive IS configured", async () => {
    const runNext = vi.fn(async () => ({ status: "idle" as const }));
    const runScheduled = vi.fn(async () => ({ outcomes: [] }));

    await drainQueueOnce({ runNext, runScheduled, isDriveConfigured: async () => true });

    expect(runNext).toHaveBeenCalledTimes(1);
    expect(runScheduled).toHaveBeenCalledTimes(1);
  });
});

describe("startBackgroundWorker — the in-process worker loop (auto-drive)", () => {
  beforeEach(() => {
    __resetBackgroundWorkerForTests();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    __resetBackgroundWorkerForTests();
  });

  it("on start: recovers orphaned runs BEFORE draining, then auto-drains the queued run (no manual trigger)", async () => {
    const order: string[] = [];
    const recover = vi.fn(async () => {
      order.push("recover");
      return 1;
    });
    let runs = 1; // one queued run waiting
    const runNext = vi.fn(async () => {
      order.push("runNext");
      if (runs > 0) {
        runs -= 1;
        return { status: "ran" };
      }
      return { status: "idle" };
    });
    const runScheduled = vi.fn(async () => {
      order.push("sweep");
    });

    startBackgroundWorker({ pollMs: 1000, runtime: { runNext, runScheduled, recover } });
    // flush the immediate recovery + first tick (both kicked synchronously on start)
    await vi.advanceTimersByTimeAsync(0);

    expect(order[0]).toBe("recover"); // recovery happens before the first drain
    expect(recover).toHaveBeenCalledTimes(1);
    expect(runNext).toHaveBeenCalled(); // the queued run was drained automatically
    expect(runScheduled).toHaveBeenCalled();
  });

  it("is idempotent — a second start does not spawn a second loop", async () => {
    const runtime = {
      recover: vi.fn(async () => 0),
      runNext: vi.fn(async () => ({ status: "idle" })),
      runScheduled: vi.fn(async () => undefined),
    };

    startBackgroundWorker({ pollMs: 1000, runtime });
    startBackgroundWorker({ pollMs: 1000, runtime });
    await vi.advanceTimersByTimeAsync(0);

    expect(runtime.recover).toHaveBeenCalledTimes(1); // only one loop started
  });

  it("keeps draining on each poll interval after the first tick", async () => {
    const runtime = {
      recover: vi.fn(async () => 0),
      runNext: vi.fn(async () => ({ status: "idle" })),
      runScheduled: vi.fn(async () => undefined),
    };

    startBackgroundWorker({ pollMs: 1000, runtime });
    await vi.advanceTimersByTimeAsync(0); // first tick
    const afterFirst = runtime.runNext.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000); // second tick fires
    expect(runtime.runNext.mock.calls.length).toBeGreaterThan(afterFirst);
  });
});
