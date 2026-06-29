import { describe, expect, it } from "vitest";
import { TaskSandbox } from "../src/acquisition-v2/sandbox.js";
import { FakeResourceProviderV2 } from "../src/acquisition-v2/fake-provider.js";

describe("TaskSandbox — searchResources (system-budgeted, dedup, snapshot-bound)", () => {
  it("returns the full candidate snapshot for a fresh keyword", async () => {
    const provider = new FakeResourceProviderV2({
      results: { show: [{ id: "c1", title: "Show" }] },
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
      results: { show: [{ id: "c1", title: "Show" }] },
    });
    const sandbox = new TaskSandbox({ provider, searchBudget: 8 });

    const result = await sandbox.searchResources("Show");

    expect(sandbox.hasObservedSnapshot(result.snapshot!.id)).toBe(true);
    expect(sandbox.hasObservedSnapshot("never-observed")).toBe(false);
  });

  it("movie (subtitleFallback): 9th/10th search run but carry the 8+2 reserve note; 11th is exhausted with fallback authorization", async () => {
    const sandbox = new TaskSandbox({
      provider: { async search(keyword) { return { id: `s_${keyword}`, keyword, candidates: [] }; } },
      subtitleFallback: true,
    });
    for (let i = 0; i < 8; i++) {
      const r = await sandbox.searchResources(`kw${i}`);
      expect(r.snapshot).toBeDefined();
      expect(r.note).toBeUndefined(); // first 8 are normal 中字-seeking searches
    }
    const ninth = await sandbox.searchResources("kw8");
    expect(ninth.snapshot).toBeDefined();
    expect(ninth.note).toMatch(/预留|兜底/);
    const tenth = await sandbox.searchResources("kw9");
    expect(tenth.snapshot).toBeDefined();
    expect(tenth.note).toMatch(/预留|兜底/);
    const eleventh = await sandbox.searchResources("kw10");
    expect(eleventh.snapshot).toBeUndefined();
    expect(eleventh.refused).toMatch(/兜底|可能无中|subtitleFallback/);
  });

  it("non-movie: budget stays 8, no reserve note, original exhausted message (floor stays hard)", async () => {
    const sandbox = new TaskSandbox({
      provider: { async search(keyword) { return { id: `s_${keyword}`, keyword, candidates: [] }; } },
    });
    for (let i = 0; i < 8; i++) {
      const r = await sandbox.searchResources(`kw${i}`);
      expect(r.note).toBeUndefined();
    }
    const ninth = await sandbox.searchResources("kw8");
    expect(ninth.refused).toMatch(/budget exhausted/);
    expect(ninth.refused).not.toMatch(/兜底/);
  });

  it("strips quality/subtitle tokens from an agent keyword, searches the bare title, and notes it (C5)", async () => {
    const provider = new FakeResourceProviderV2({
      results: { 铁拳教育: [{ id: "c1", title: "铁拳教育 全12集" }] },
    });
    const sandbox = new TaskSandbox({ provider, searchBudget: 8, titleTerms: ["铁拳教育"] });

    const result = await sandbox.searchResources("铁拳教育 1080p 中字");

    expect(result.snapshot?.candidates).toHaveLength(1);
    expect(result.notice).toMatch(/已移除|画质|raw/);
  });

  it("strips quality/subtitle tokens BEFORE the title gate, so a quality-only-tail keyword still passes", async () => {
    let searched = "";
    const sandbox = new TaskSandbox({
      provider: {
        async search(keyword) {
          searched = keyword;
          return { id: `s_${keyword}`, keyword, candidates: [] };
        },
      },
      searchBudget: 8,
      titleTerms: ["奥本海默"],
    });

    await sandbox.searchResources("奥本海默 4K 蓝光 BluRay");

    expect(searched).toBe("奥本海默");
  });

  it("leaves a bare title keyword untouched (no strip, no notice)", async () => {
    const provider = new FakeResourceProviderV2({
      results: { 铁拳教育: [{ id: "c1", title: "铁拳教育 全12集" }] },
    });
    const sandbox = new TaskSandbox({ provider, searchBudget: 8, titleTerms: ["铁拳教育"] });

    const result = await sandbox.searchResources("铁拳教育");

    expect(result.snapshot?.candidates).toHaveLength(1);
    expect(result.notice).toBeUndefined();
  });

  it("does NOT emit the strip notice when only whitespace changed (no quality token removed)", async () => {
    const provider = new FakeResourceProviderV2({
      results: { "奥本海默 第二季": [{ id: "c1", title: "奥本海默 第二季 全集" }] },
    });
    const sandbox = new TaskSandbox({ provider, searchBudget: 8, titleTerms: ["奥本海默"] });

    const result = await sandbox.searchResources("奥本海默   第二季");

    expect(result.notice).toBeUndefined();
  });

  it("emits the strip notice on EVERY quality-laden search (shared /g regex lastIndex never leaks)", async () => {
    const provider = new FakeResourceProviderV2({
      results: { 铁拳教育: [{ id: "c1", title: "铁拳教育 全集" }], 奥本海默: [{ id: "c2", title: "奥本海默 全集" }] },
    });
    const sandbox = new TaskSandbox({ provider, searchBudget: 8, titleTerms: ["铁拳教育", "奥本海默"] });

    const first = await sandbox.searchResources("铁拳教育 1080p");
    const second = await sandbox.searchResources("奥本海默 中字");

    expect(first.notice).toMatch(/已移除|画质|raw/);
    expect(second.notice).toMatch(/已移除|画质|raw/);
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
