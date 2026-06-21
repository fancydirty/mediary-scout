import { describe, expect, it } from "vitest";
import { TaskSandbox } from "../src/acquisition-v2/sandbox.js";
import { FakeResourceProviderV2 } from "../src/acquisition-v2/fake-provider.js";

describe("TaskSandbox — searchResources (system-budgeted, dedup, snapshot-bound)", () => {
  it("returns the full candidate snapshot for a fresh keyword", async () => {
    const provider = new FakeResourceProviderV2({
      results: { show: [{ id: "c1", title: "Show", episodeHints: [], qualityHints: [] }] },
    });
    const sandbox = new TaskSandbox({ provider, searchBudget: 8 });

    const result = await sandbox.searchResources("Show");

    expect(result.snapshot?.candidates).toHaveLength(1);
    expect(result.refused).toBeUndefined();
  });

  it("dedups a repeated keyword (case/space variant) without hitting the provider again", async () => {
    let calls = 0;
    const sandbox = new TaskSandbox({
      provider: { async search(keyword) { calls += 1; return { id: "snap_x", keyword, candidates: [] }; } },
      searchBudget: 8,
    });

    await sandbox.searchResources("keyword");
    const result = await sandbox.searchResources("  KEYWORD ");

    expect(result.deduped).toBe(true);
    expect(calls).toBe(1);
  });

  it("refuses once the distinct-search budget is exhausted (no unbounded model loop)", async () => {
    const sandbox = new TaskSandbox({
      provider: { async search(keyword) { return { id: `s_${keyword}`, keyword, candidates: [] }; } },
      searchBudget: 2,
    });

    await sandbox.searchResources("a");
    await sandbox.searchResources("b");
    const result = await sandbox.searchResources("c");

    expect(result.refused).toBeTruthy();
    expect(result.snapshot).toBeUndefined();
  });

  it("records observed snapshots so a later transfer can be snapshot-bound", async () => {
    const provider = new FakeResourceProviderV2({
      results: { show: [{ id: "c1", title: "Show", episodeHints: [], qualityHints: [] }] },
    });
    const sandbox = new TaskSandbox({ provider, searchBudget: 8 });

    const result = await sandbox.searchResources("Show");

    expect(sandbox.hasObservedSnapshot(result.snapshot!.id)).toBe(true);
    expect(sandbox.hasObservedSnapshot("never-observed")).toBe(false);
  });

  it("rejects a keyword that does not reference the title (no provider hit, no budget spent)", async () => {
    let calls = 0;
    const sandbox = new TaskSandbox({
      provider: { async search(keyword) { calls += 1; return { id: `s_${keyword}`, keyword, candidates: [] }; } },
      searchBudget: 8,
      titleTerms: ["公民义警", "Citizen Vigilante"],
    });

    // The "2026 电影" garbage fallback: genre+year, no title → refused before the provider.
    await expect(sandbox.searchResources("2026 电影")).rejects.toThrow(/片名/);
    expect(calls).toBe(0);

    // A title-bearing keyword still works, and the rejected one consumed no budget.
    const ok = await sandbox.searchResources("公民义警 2026");
    expect(ok.snapshot).toBeDefined();
    expect(calls).toBe(1);
  });
});
