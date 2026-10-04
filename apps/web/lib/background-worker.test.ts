import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueueClaimOptions } from "@media-track/workflow";
import { clearUpdateHold, inFlightCount, setUpdateHold } from "./update-hold";
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

  it("runs the auto-update check after the sweep and survives its failure", async () => {
    const calls: string[] = [];
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const drained = await drainQueueOnce({
        runNext: async () => ({ status: "idle" }),
        runScheduled: async () => void calls.push("sweep"),
        autoUpdate: async () => {
          calls.push("auto");
          throw new Error("boom");
        },
      });
      expect(drained).toBe(0);
      expect(calls).toEqual(["sweep", "auto"]);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("auto-update check failed: boom"));
    } finally {
      error.mockRestore();
    }
  });

  it("checks auto-update even when a failing drain and sweep came first", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const autoUpdate = vi.fn(async () => undefined);
      await drainQueueOnce({
        runNext: async () => {
          throw new Error("queue down");
        },
        runScheduled: async () => {
          throw new Error("sweep down");
        },
        autoUpdate,
      });
      expect(autoUpdate).toHaveBeenCalledTimes(1);
    } finally {
      error.mockRestore();
    }
  });

  it("still checks auto-update when no drive is configured (it does not touch any drive)", async () => {
    const runNext = vi.fn(async () => ({ status: "idle" as const }));
    const runScheduled = vi.fn(async () => ({ outcomes: [] }));
    const autoUpdate = vi.fn(async () => undefined);

    const drained = await drainQueueOnce({ runNext, runScheduled, autoUpdate, isDriveConfigured: async () => false });

    expect(drained).toBe(0);
    expect(runNext).not.toHaveBeenCalled();
    expect(runScheduled).not.toHaveBeenCalled();
    expect(autoUpdate).toHaveBeenCalledTimes(1);
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

  it("each tick also runs the runtime's auto-update check, counted as in flight", async () => {
    let inFlightDuringCheck = -1;
    const runtime = {
      recover: vi.fn(async () => 0),
      runNext: vi.fn(async () => ({ status: "idle" })),
      runScheduled: vi.fn(async () => undefined),
      autoUpdate: vi.fn(async () => {
        inFlightDuringCheck = inFlightCount();
      }),
    };

    startBackgroundWorker({ pollMs: 1000, runtime });
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.autoUpdate).toHaveBeenCalledTimes(1);
    expect(inFlightDuringCheck).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(runtime.autoUpdate).toHaveBeenCalledTimes(2);
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

  it("counts a tick as in flight while it runs", async () => {
    let seen = -1;
    const runtime = {
      recover: vi.fn(async () => 0),
      runNext: vi.fn(async () => {
        seen = inFlightCount();
        return { status: "idle" };
      }),
      runScheduled: vi.fn(async () => undefined),
    };
    startBackgroundWorker({ pollMs: 1000, runtime });
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toBe(1);
    expect(inFlightCount()).toBe(0);
  });

  it("each tick drains with the runtime's concurrency: runs on two drives overlap", async () => {
    const q = fakeQueue([
      { id: "a", drive: "cs_a" },
      { id: "b", drive: "cs_b" },
    ]);
    const runtime = {
      recover: vi.fn(async () => 0),
      runNext: q.runNext,
      runScheduled: vi.fn(async () => undefined),
      concurrency: vi.fn(async () => 2),
    };
    startBackgroundWorker({ pollMs: 1000, runtime });
    await vi.advanceTimersByTimeAsync(0);
    expect(q.events).toEqual(["start a", "start b"]);
    expect(runtime.runScheduled).not.toHaveBeenCalled();
    q.finish("a");
    q.finish("b");
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.runScheduled).toHaveBeenCalledTimes(1);
  });

  it("starts nothing while the update hold is on, and resumes once it is released", async () => {
    const runtime = {
      recover: vi.fn(async () => 0),
      runNext: vi.fn(async () => ({ status: "idle" })),
      runScheduled: vi.fn(async () => undefined),
    };
    setUpdateHold(Date.now(), 60_000);
    try {
      startBackgroundWorker({ pollMs: 1000, runtime });
      await vi.advanceTimersByTimeAsync(3000);
      expect(runtime.runNext).not.toHaveBeenCalled();
      expect(runtime.runScheduled).not.toHaveBeenCalled();
    } finally {
      clearUpdateHold();
    }
    await vi.advanceTimersByTimeAsync(1000);
    expect(runtime.runNext).toHaveBeenCalled();
    expect(runtime.runScheduled).toHaveBeenCalled();
  });
});

describe("defaultRuntime — 巡检调度接线（IGNORE_TIME_GATE 特例已退役）", () => {
  // per-slot 认领语义下桌面与容器同一入口：runScheduledType3 无参调用，闸全在
  // 内核里。曾经的 MEDIA_TRACK_PATROL_IGNORE_TIME_GATE 桌面特例（零点巡检 bug 源头）
  // 已删除——这里锁死它不复活。
  afterEach(() => {
    vi.doUnmock("./workflow-runtime");
    vi.resetModules();
  });

  async function runScheduledSpy(): Promise<ReturnType<typeof vi.fn>> {
    const spy = vi.fn(async () => ({ outcomes: [] }));
    vi.resetModules();
    vi.doMock("./workflow-runtime", () => ({
      runNextQueuedWorkflow: vi.fn(async () => ({ status: "idle" })),
      runScheduledType3: spy,
      runAutoUpdateIfDue: vi.fn(async () => undefined),
      recoverOrphanedRuns: vi.fn(async () => 0),
      workerHasConfiguredDrive: vi.fn(async () => true),
      getWorkerConcurrency: vi.fn(async () => 1),
    }));
    const { defaultRuntime } = await import("./background-worker");
    const runtime = await defaultRuntime();
    await runtime.runScheduled();
    return spy;
  }

  async function loadDefaultRuntime(runAutoUpdateIfDue: ReturnType<typeof vi.fn>) {
    vi.resetModules();
    vi.doMock("./workflow-runtime", () => ({
      runNextQueuedWorkflow: vi.fn(async () => ({ status: "idle" })),
      runScheduledType3: vi.fn(async () => ({ outcomes: [] })),
      runAutoUpdateIfDue,
      recoverOrphanedRuns: vi.fn(async () => 0),
      workerHasConfiguredDrive: vi.fn(async () => true),
      getWorkerConcurrency: vi.fn(async () => 1),
    }));
    const { defaultRuntime } = await import("./background-worker");
    return defaultRuntime();
  }

  it("runNext passes the drain's claim options on; concurrency reads the 同时处理 setting", async () => {
    const runNextQueuedWorkflow = vi.fn(async () => ({ status: "idle" }));
    const getWorkerConcurrency = vi.fn(async () => 4);
    vi.resetModules();
    vi.doMock("./workflow-runtime", () => ({
      runNextQueuedWorkflow,
      getWorkerConcurrency,
      runScheduledType3: vi.fn(async () => ({ outcomes: [] })),
      runAutoUpdateIfDue: vi.fn(async () => undefined),
      recoverOrphanedRuns: vi.fn(async () => 0),
      workerHasConfiguredDrive: vi.fn(async () => true),
    }));
    const { defaultRuntime } = await import("./background-worker");
    const runtime = await defaultRuntime();
    const claim: QueueClaimOptions = { excludeConnectedStorageIds: ["cs_a"], excludeUnbound: true };
    await runtime.runNext(claim);
    expect(runNextQueuedWorkflow).toHaveBeenCalledWith(claim);
    expect(await runtime.concurrency?.()).toBe(4);
  });

  it("autoUpdate → runAutoUpdateIfDue", async () => {
    const spy = vi.fn(async () => undefined);
    const runtime = await loadDefaultRuntime(spy);
    await runtime.autoUpdate?.();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("runScheduled → runScheduledType3 无参调用（无 ignoreTimeGate，即使 env 残留 flag）", async () => {
    process.env.MEDIA_TRACK_PATROL_IGNORE_TIME_GATE = "1";
    try {
      const spy = await runScheduledSpy();
      expect(spy).toHaveBeenCalledWith();
    } finally {
      delete process.env.MEDIA_TRACK_PATROL_IGNORE_TIME_GATE;
    }
  });
});

/**
 * A fake queue for the drain: a claim honours the drive filter it is given and reports
 * the claimed run's drive, then the run stays going until the test finishes it.
 */
function fakeQueue(initial: Array<{ id: string; drive: string | null }>) {
  const queue = [...initial];
  const events: string[] = [];
  const finishers = new Map<string, () => void>();
  const runNext = vi.fn(async (claim?: QueueClaimOptions) => {
    const at = queue.findIndex((run) =>
      run.drive === null
        ? claim?.excludeUnbound !== true
        : !(claim?.excludeConnectedStorageIds ?? []).includes(run.drive),
    );
    if (at === -1) return { status: "idle" };
    const [run] = queue.splice(at, 1);
    claim?.onClaimed?.({ workflowRunId: run!.id, connectedStorageId: run!.drive });
    events.push(`start ${run!.id}`);
    await new Promise<void>((resolve) => finishers.set(run!.id, resolve));
    events.push(`finish ${run!.id}`);
    return { status: "ran" };
  });
  return {
    runNext,
    events,
    add: (run: { id: string; drive: string | null }) => void queue.push(run),
    finish: (id: string) => finishers.get(id)!(),
  };
}

const poll = () => new Promise<void>((resolve) => setTimeout(resolve, 1));
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !condition(); i += 1) await poll();
  expect(condition()).toBe(true);
}
/** Let the drain look at the queue a few more times. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await poll();
}

describe("drainQueueOnce — several queued runs at once (the 同时处理 setting)", () => {
  it("runs queued runs on different drives side by side, up to the setting", async () => {
    const q = fakeQueue([
      { id: "a", drive: "cs_115" },
      { id: "b", drive: "cs_guangya" },
    ]);
    const runScheduled = vi.fn(async () => undefined);
    const drain = drainQueueOnce({ runNext: q.runNext, runScheduled, concurrency: async () => 2, pollMs: 1, sleep: poll });

    await until(() => q.events.includes("start b"));
    expect(q.events).toEqual(["start a", "start b"]); // b started while a is still going
    q.finish("a");
    q.finish("b");
    expect(await drain).toBe(2);
    expect(runScheduled).toHaveBeenCalledTimes(1);
  });

  it("starts a run queued while another drive's run is going (护肝人 on 115, then on 光鸭)", async () => {
    const q = fakeQueue([{ id: "115", drive: "cs_115" }]);
    const drain = drainQueueOnce({
      runNext: q.runNext,
      runScheduled: async () => undefined,
      concurrency: async () => 5,
      pollMs: 1,
      sleep: poll,
    });

    await until(() => q.events.includes("start 115"));
    q.add({ id: "guangya", drive: "cs_guangya" });
    await until(() => q.events.includes("start guangya"));
    expect(q.events).toEqual(["start 115", "start guangya"]);
    q.finish("115");
    q.finish("guangya");
    expect(await drain).toBe(2);
  });

  it("never runs two on the same drive: the second waits for the first", async () => {
    const q = fakeQueue([
      { id: "a1", drive: "cs_a" },
      { id: "a2", drive: "cs_a" },
      { id: "b", drive: "cs_b" },
    ]);
    const drain = drainQueueOnce({
      runNext: q.runNext,
      runScheduled: async () => undefined,
      concurrency: async () => 3,
      pollMs: 1,
      sleep: poll,
    });

    await until(() => q.events.includes("start b"));
    await settle();
    expect(q.events).toEqual(["start a1", "start b"]);
    q.finish("a1");
    await until(() => q.events.includes("start a2"));
    q.finish("b");
    q.finish("a2");
    expect(await drain).toBe(3);
  });

  /** runNext whose `heldCall`-th claim waits until the test releases it. */
  function holdClaim(q: ReturnType<typeof fakeQueue>, heldCall: number) {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const state = { calls: 0, release: () => release() };
    const runNext = vi.fn(async (claim?: QueueClaimOptions) => {
      state.calls += 1;
      if (state.calls === heldCall) await held;
      return q.runNext(claim);
    });
    return { runNext, state };
  }

  it("looks again when the run on a skipped drive finished while a claim was looking, instead of ending the tick", async () => {
    const q = fakeQueue([
      { id: "a1", drive: "cs_a" },
      { id: "a2", drive: "cs_a" },
    ]);
    const { runNext, state } = holdClaim(q, 2);
    const runScheduled = vi.fn(async () => void q.events.push("sweep"));
    const drain = drainQueueOnce({ runNext, runScheduled, concurrency: async () => 2, pollMs: 1, sleep: poll });

    await until(() => state.calls === 2); // this claim skips cs_a: a1 is going
    q.finish("a1");
    await until(() => q.events.includes("finish a1"));
    state.release(); // comes back empty-handed, with a1's drive still skipped
    await until(() => q.events.includes("start a2") || q.events.includes("sweep"));
    expect(q.events).toEqual(["start a1", "finish a1", "start a2"]); // not the sweep first
    q.finish("a2");
    expect(await drain).toBe(2);
    expect(q.events.at(-1)).toBe("sweep");
  });

  it("looks again at once when that happens while other runs are still going", async () => {
    const q = fakeQueue([
      { id: "a1", drive: "cs_a" },
      { id: "b", drive: "cs_b" },
      { id: "a2", drive: "cs_a" },
    ]);
    const { runNext, state } = holdClaim(q, 3);
    const drain = drainQueueOnce({
      runNext,
      runScheduled: async () => undefined,
      concurrency: async () => 3,
      pollMs: 1,
      // Never wakes by itself: only a run finishing makes the drain look again.
      sleep: () => new Promise<void>(() => undefined),
    });

    await until(() => state.calls === 3); // this claim skips cs_a and cs_b
    q.finish("a1");
    await until(() => q.events.includes("finish a1"));
    state.release();
    await until(() => q.events.includes("start a2"));
    expect(q.events).toEqual(["start a1", "start b", "finish a1", "start a2"]); // b still going
    q.finish("b");
    q.finish("a2");
    expect(await drain).toBe(3);
  });

  it("with the setting at 1 runs one after another, as before", async () => {
    const q = fakeQueue([
      { id: "a", drive: "cs_a" },
      { id: "b", drive: "cs_b" },
    ]);
    const drain = drainQueueOnce({
      runNext: q.runNext,
      runScheduled: async () => undefined,
      concurrency: async () => 1,
      pollMs: 1,
      sleep: poll,
    });

    await until(() => q.events.includes("start a"));
    await settle();
    expect(q.events).toEqual(["start a"]);
    q.finish("a");
    await until(() => q.events.includes("start b"));
    q.finish("b");
    await drain;
    expect(q.events).toEqual(["start a", "finish a", "start b", "finish b"]);
  });

  it("runs a run with no bound drive alone: nothing starts beside it, and it waits for the others", async () => {
    const q = fakeQueue([
      { id: "unbound", drive: null },
      { id: "b", drive: "cs_b" },
    ]);
    const drain = drainQueueOnce({
      runNext: q.runNext,
      runScheduled: async () => undefined,
      concurrency: async () => 3,
      pollMs: 1,
      sleep: poll,
    });

    await until(() => q.events.includes("start unbound"));
    await settle();
    expect(q.events).toEqual(["start unbound"]);
    q.finish("unbound");
    await until(() => q.events.includes("start b"));
    q.add({ id: "unbound2", drive: null });
    await settle();
    expect(q.events).toEqual(["start unbound", "finish unbound", "start b"]);
    q.finish("b");
    await until(() => q.events.includes("start unbound2"));
    q.finish("unbound2");
    expect(await drain).toBe(3);
  });

  it("runs the daily sweep only after every drained run has finished", async () => {
    const q = fakeQueue([
      { id: "a", drive: "cs_a" },
      { id: "b", drive: "cs_b" },
    ]);
    const runScheduled = vi.fn(async () => void q.events.push("sweep"));
    const drain = drainQueueOnce({ runNext: q.runNext, runScheduled, concurrency: async () => 2, pollMs: 1, sleep: poll });

    await until(() => q.events.includes("start b"));
    q.finish("b");
    await settle();
    expect(runScheduled).not.toHaveBeenCalled();
    q.finish("a");
    await drain;
    expect(q.events.at(-1)).toBe("sweep");
    expect(q.events.indexOf("sweep")).toBeGreaterThan(q.events.indexOf("finish a"));
  });

  it("starts no more than the safety cap in one tick", async () => {
    const q = fakeQueue([
      { id: "a", drive: "cs_a" },
      { id: "b", drive: "cs_b" },
      { id: "c", drive: "cs_c" },
    ]);
    const drain = drainQueueOnce({
      runNext: q.runNext,
      runScheduled: async () => undefined,
      concurrency: async () => 3,
      maxDrains: 2,
      pollMs: 1,
      sleep: poll,
    });

    await until(() => q.events.includes("start b"));
    await settle();
    expect(q.events).toEqual(["start a", "start b"]);
    q.finish("a");
    q.finish("b");
    expect(await drain).toBe(2);
  });

  it("a claim that throws starts nothing more; the run already going finishes and the sweep still runs", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const q = fakeQueue([{ id: "a", drive: "cs_a" }]);
      let calls = 0;
      const runNext = vi.fn(async (claim?: QueueClaimOptions) => {
        calls += 1;
        if (calls === 2) throw new Error("db down");
        return q.runNext(claim);
      });
      const runScheduled = vi.fn(async () => undefined);
      const drain = drainQueueOnce({ runNext, runScheduled, concurrency: async () => 3, pollMs: 1, sleep: poll });

      await until(() => calls >= 2);
      await settle();
      expect(calls).toBe(2); // no claim after the failed one
      q.finish("a");
      expect(await drain).toBe(1);
      expect(runScheduled).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("drain failed: db down"));
    } finally {
      error.mockRestore();
    }
  });
});
