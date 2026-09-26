import { describe, expect, it } from "vitest";
import { runKeyedPool } from "../src/keyed-pool.js";

/** A task whose finish the test controls, recording what was in flight. */
function harness() {
  const inFlight = new Set<string>();
  const peaks: string[][] = [];
  const release = new Map<string, () => void>();
  const task = (item: { id: string; key: string }) =>
    new Promise<string>((resolve) => {
      inFlight.add(item.id);
      peaks.push([...inFlight].sort());
      release.set(item.id, () => {
        inFlight.delete(item.id);
        resolve(item.id.toUpperCase());
      });
    });
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { inFlight, peaks, release, task, tick };
}

describe("runKeyedPool", () => {
  it("runs different keys side by side up to the limit, and never two of one key", async () => {
    const h = harness();
    const items = [
      { id: "a1", key: "A" },
      { id: "a2", key: "A" },
      { id: "b1", key: "B" },
      { id: "c1", key: "C" },
    ];
    const done = runKeyedPool(items, { concurrency: 2, keyOf: (i) => i.key }, h.task);
    await h.tick();
    // a2 waits for a1 (same key); b1 takes the second slot.
    expect([...h.inFlight].sort()).toEqual(["a1", "b1"]);
    h.release.get("a1")!();
    await h.tick();
    expect([...h.inFlight].sort()).toEqual(["a2", "b1"]);
    h.release.get("b1")!();
    await h.tick();
    expect([...h.inFlight].sort()).toEqual(["a2", "c1"]);
    h.release.get("a2")!();
    h.release.get("c1")!();
    // Results in input order, whatever order they finished in.
    expect(await done).toEqual(["A1", "A2", "B1", "C1"]);
    for (const peak of h.peaks) expect(peak.length).toBeLessThanOrEqual(2);
  });

  it("concurrency 1 is strictly one after another", async () => {
    const order: string[] = [];
    const out = await runKeyedPool(["x", "y", "z"], { concurrency: 1, keyOf: (i) => i }, async (i) => {
      order.push(`start ${i}`);
      await new Promise((resolve) => setTimeout(resolve, 1));
      order.push(`end ${i}`);
      return i;
    });
    expect(out).toEqual(["x", "y", "z"]);
    expect(order).toEqual(["start x", "end x", "start y", "end y", "start z", "end z"]);
  });

  it("stops starting new work after a failure, lets running work finish, then rethrows", async () => {
    const started: string[] = [];
    let slowFinished = false;
    const run = runKeyedPool(["bad", "slow", "never"], { concurrency: 2, keyOf: (i) => i }, async (i) => {
      started.push(i);
      if (i === "bad") throw new Error("boom");
      await new Promise((resolve) => setTimeout(resolve, 5));
      slowFinished = true;
      return i;
    });
    await expect(run).rejects.toThrow("boom");
    expect(started).toEqual(["bad", "slow"]);
    expect(slowFinished).toBe(true);
  });

  it("handles a task that throws synchronously the same way as one that rejects", async () => {
    let slowFinished = false;
    const run = runKeyedPool(["slow", "bad"], { concurrency: 2, keyOf: (i) => i }, (i) => {
      if (i === "bad") throw new Error("sync boom");
      return new Promise<string>((resolve) =>
        setTimeout(() => {
          slowFinished = true;
          resolve(i);
        }, 5),
      );
    });
    await expect(run).rejects.toThrow("sync boom");
    expect(slowFinished).toBe(true);
  });

  it("treats a non-positive limit as 1 and handles an empty list", async () => {
    expect(await runKeyedPool([], { concurrency: 3, keyOf: String }, async () => 1)).toEqual([]);
    expect(await runKeyedPool([1, 2], { concurrency: 0, keyOf: String }, async (n) => n * 2)).toEqual([2, 4]);
  });
});
