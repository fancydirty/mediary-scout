import { describe, expect, it } from "vitest";
import { TaskSandbox } from "../src/acquisition-v2/sandbox.js";
import { FakeResourceProviderV2 } from "../src/acquisition-v2/fake-provider.js";
import { RealResourceProviderV2 } from "../src/acquisition-v2/real-provider-adapter.js";
import { CandidateRegistry } from "../src/acquisition-v2/candidate-registry.js";
import type { ResourceProvider } from "../src/ports.js";

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

describe("searchResources dedup 强提示（病2a）", () => {
  function makeSandbox() {
    const provider = new FakeResourceProviderV2({
      results: { "攻壳机动队": [{ id: "c1", title: "攻壳机动队 SAC 全集" }, { id: "c2", title: "攻壳机动队 剧场版" }] },
    });
    return new TaskSandbox({ provider, titleTerms: ["攻壳机动队"] });
  }

  it("第 2 次同词搜索返回带次数与候选数的强提示", async () => {
    const sandbox = makeSandbox();
    await sandbox.searchResources("攻壳机动队");
    const second = await sandbox.searchResources("攻壳机动队");
    expect(second.deduped).toBe(true);
    expect(second.repeatNotice).toContain("第 2 次");
    expect(second.repeatNotice).toContain("2 候选");
    expect(second.repeatNotice).toContain("换实质不同的新词");
  });

  it("第 3 次起提示升级为「再重复将视为无进展」", async () => {
    const sandbox = makeSandbox();
    await sandbox.searchResources("攻壳机动队");
    await sandbox.searchResources("攻壳机动队");
    const third = await sandbox.searchResources("攻壳机动队");
    expect(third.repeatNotice).toContain("第 3 次");
    expect(third.repeatNotice).toContain("再重复将视为无进展");
  });

  it("第 5 次起提示文本固定（不再带递增计数）——让 repetition-stop 的 4 连相同还能命中", async () => {
    const sandbox = makeSandbox();
    for (let i = 0; i < 4; i++) await sandbox.searchResources("攻壳机动队");
    const fifth = await sandbox.searchResources("攻壳机动队");
    const sixth = await sandbox.searchResources("攻壳机动队");
    expect(fifth.repeatNotice).toBe(sixth.repeatNotice);
    expect(fifth.repeatNotice).toContain("已重复多次");
  });

  it("复搜系统预搜(prime)的 raw 词同样计数（prime 记为第 1 次）", async () => {
    const sandbox = makeSandbox();
    await sandbox.primeRawSnapshot("攻壳机动队");
    const first = await sandbox.searchResources("攻壳机动队");
    expect(first.deduped).toBe(true);
    expect(first.repeatNotice).toContain("第 2 次");
  });

  it("新词 fresh 搜索不带 repeatNotice", async () => {
    const sandbox = makeSandbox();
    const fresh = await sandbox.searchResources("攻壳机动队");
    expect(fresh.repeatNotice).toBeUndefined();
  });

  it("空结果快照的重复提示同样报次数与「共 0 候选」", async () => {
    const provider = new FakeResourceProviderV2({ results: { "攻壳机动队": [] } });
    const sandbox = new TaskSandbox({ provider, titleTerms: ["攻壳机动队"] });
    await sandbox.searchResources("攻壳机动队");
    const second = await sandbox.searchResources("攻壳机动队");
    expect(second.repeatNotice).toContain("第 2 次");
    expect(second.repeatNotice).toContain("共 0 候选");
  });

  it("带画质词的重复搜索:提示引用剥离后的有效词,不是 raw 原词", async () => {
    const sandbox = makeSandbox();
    await sandbox.searchResources("攻壳机动队");
    // 画质词被 C5 剥离 → 有效词与第 1 次相同 → dedup 命中,计为第 2 次
    const second = await sandbox.searchResources("攻壳机动队 1080P");
    expect(second.deduped).toBe(true);
    expect(second.repeatNotice).toContain("第 2 次");
    expect(second.repeatNotice).toContain("攻壳机动队");
    expect(second.repeatNotice).not.toContain("1080");
  });
});

describe("searchResources anime 禁忌词警告接线（病2b）", () => {
  it("anime profile 的 sandbox 对含年份关键词附加 warnings（不阻断，快照照常返回）", async () => {
    const provider = new FakeResourceProviderV2({
      results: { "攻壳机动队 2020": [{ id: "c1", title: "攻壳机动队 SAC_2045" }] },
    });
    const sandbox = new TaskSandbox({
      provider,
      titleTerms: ["攻壳机动队"],
      searchProfile: "jp-anime",
    });
    const result = await sandbox.searchResources("攻壳机动队 2020");
    expect(result.snapshot).toBeDefined(); // 不阻断
    expect(result.warnings?.some((w) => w.includes("年份"))).toBe(true);
  });

  it("未传 searchProfile（旧调用方）→ 无 warnings 字段", async () => {
    const provider = new FakeResourceProviderV2({
      results: { "默杀 2024": [{ id: "c1", title: "默杀 2024" }] },
    });
    const sandbox = new TaskSandbox({ provider, titleTerms: ["默杀"] });
    const result = await sandbox.searchResources("默杀 2024");
    expect(result.warnings).toBeUndefined();
  });
});

describe("searchResources 大快照消化提醒（病3）", () => {
  const many = Array.from({ length: 58 }, (_, i) => ({ id: `c${i}`, title: `攻壳机动队 SAC 第${i}包` }));

  it("上一搜索 ≥10 候选、紧接换词搜 → 新结果前置消化提醒（一次）", async () => {
    const provider = new FakeResourceProviderV2({
      results: { "攻殻機動隊": many, "攻壳机动队 arise": [{ id: "x", title: "ARISE" }] },
    });
    const sandbox = new TaskSandbox({ provider, titleTerms: ["攻壳机动队", "攻殻機動隊", "ARISE"] });
    await sandbox.searchResources("攻殻機動隊");
    const second = await sandbox.searchResources("攻壳机动队 ARISE");
    expect(second.digestHint).toContain("攻殻機動隊");
    expect(second.digestHint).toContain("58");
    // 提示必须指对地方：待消化的永远是 agent 自己的搜索快照（prime 从不注册
    // pendingDigest），其候选列表在先前 searchResources 的返回里——而
    // viewResourceSnapshot 只能看 raw 预搜快照，指过去就是指错。
    expect(second.digestHint).not.toContain("viewResourceSnapshot");
    expect(second.digestHint).toContain("回读");
    // 只提示一次/快照：
    const third = await sandbox.searchResources("攻殻機動隊");
    expect(third.digestHint).toBeUndefined();
  });

  it("小快照(<10)不触发", async () => {
    const provider = new FakeResourceProviderV2({
      results: { "攻壳机动队": [{ id: "a", title: "t" }], "ghost in the shell": [{ id: "b", title: "t2" }] },
    });
    const sandbox = new TaskSandbox({ provider, titleTerms: ["攻壳机动队", "Ghost in the Shell"] });
    await sandbox.searchResources("攻壳机动队");
    const second = await sandbox.searchResources("Ghost in the Shell");
    expect(second.digestHint).toBeUndefined();
  });

  it("提示引用原大小写的有效词（与 repeatNotice 口径一致），不是小写规范形", async () => {
    const latinMany = Array.from({ length: 12 }, (_, i) => ({ id: `g${i}`, title: `GITS pack ${i}` }));
    const provider = new FakeResourceProviderV2({
      // FakeResourceProviderV2 normalizes fixture keys, so the lowercase key still matches.
      results: { "ghost in the shell": latinMany, "攻壳机动队": [{ id: "a", title: "t" }] },
    });
    const sandbox = new TaskSandbox({ provider, titleTerms: ["攻壳机动队", "Ghost in the Shell"] });
    await sandbox.searchResources("Ghost in the Shell");
    const second = await sandbox.searchResources("攻壳机动队");
    expect(second.digestHint).toContain("Ghost in the Shell");
    expect(second.digestHint).not.toContain("ghost in the shell");
  });
});

describe("sandbox 审计事件收集（病4）", () => {
  it("no_coverage 上报、dedup 重复、禁忌词警告 三类事件入 auditTrail", async () => {
    const provider = new FakeResourceProviderV2({
      results: { "攻壳机动队": [{ id: "c1", title: "t" }], "攻壳机动队 2020": [] },
    });
    const sandbox = new TaskSandbox({ provider, titleTerms: ["攻壳机动队"], searchProfile: "jp-anime" });
    await sandbox.searchResources("攻壳机动队");
    await sandbox.searchResources("攻壳机动队"); // dedup
    await sandbox.searchResources("攻壳机动队 2020"); // taboo 年份
    await sandbox.reportNoCoverage("确无资源");

    const trail = sandbox.auditTrail();
    expect(trail.some((e) => e.type === "no_coverage_reported" && e.data?.reason === "确无资源")).toBe(true);
    expect(trail.some((e) => e.type === "search_dedup" && e.data?.count === 2)).toBe(true);
    expect(trail.some((e) => e.type === "search_taboo_warning")).toBe(true);
    // 每个事件都有人类可读 message（AuditEvent 契约）。
    expect(trail.every((e) => typeof e.message === "string" && e.message.length > 0)).toBe(true);
  });

  it("被 §9 拒绝的上报不产生 no_coverage_reported 事件", async () => {
    const provider = new FakeResourceProviderV2({ results: {} });
    const sandbox = new TaskSandbox({ provider, titleTerms: ["x"] });
    await expect(sandbox.reportNoCoverage("premature")).rejects.toThrow("SANDBOX_NO_PROVIDER_EVIDENCE");
    expect(sandbox.auditTrail()).toEqual([]);
  });

  it("§9 证据基含系统预搜：prime 过的任务可诚实上报，无需冗余 fresh 搜索", async () => {
    // 提示词明令 agent 别重搜 raw（viewResourceSnapshot 免费）；预搜本身就是
    // 一次真 provider 搜索。只认 agent 自己的 fresh 搜索会把守规矩 agent 的
    // 诚实上报拒掉，逼它多烧轮次——正是病1 要杀的死尾巴。
    const provider = new FakeResourceProviderV2({ results: {} });
    const sandbox = new TaskSandbox({ provider, titleTerms: ["攻壳机动队"] });
    await sandbox.primeRawSnapshot("攻壳机动队");
    const report = await sandbox.reportNoCoverage("raw 快照无该作品覆盖");
    expect(report.searchesPerformed).toBe(1);
    expect(sandbox.auditTrail().some((e) => e.type === "no_coverage_reported")).toBe(true);
  });

  it("§9 证据基含 dedup 复搜：agent 复搜 prime 词后上报同样放行", async () => {
    const provider = new FakeResourceProviderV2({ results: {} });
    const sandbox = new TaskSandbox({ provider, titleTerms: ["攻壳机动队"] });
    await sandbox.primeRawSnapshot("攻壳机动队");
    await sandbox.searchResources("攻壳机动队"); // dedup 命中，seenKeywords 不变
    await expect(sandbox.reportNoCoverage("确无资源")).resolves.toMatchObject({ searchesPerformed: 1 });
  });
});

describe("sandbox 搜索源健康态 → agent 可见警告（Task 9）", () => {
  /** 一个只按健康态作答的 provider：候选恒为空，用来把「源挂了」与「确实没有」
   *  这两个在候选层面完全同形的情形对照起来。 */
  function healthProvider(sourceHealth?: {
    status: "healthy" | "degraded" | "unreachable" | "protocol_error";
    unhealthySources: string[];
  }, candidates: Array<{ id: string; title: string }> = []) {
    return {
      async search(keyword: string) {
        return { id: `s_${keyword}`, keyword, candidates, ...(sourceHealth ? { sourceHealth } : {}) };
      },
    };
  }

  it("unreachable：警告点名搜索源失败，并明确「没有资源」不成立", async () => {
    const sandbox = new TaskSandbox({
      provider: healthProvider({ status: "unreachable", unhealthySources: ["pansou"] }),
      titleTerms: ["攻壳机动队"],
    });

    const result = await sandbox.searchResources("攻壳机动队");

    const warning = (result.warnings ?? []).find((w) => w.includes("搜索源"));
    expect(warning).toBeDefined();
    expect(warning).toContain("pansou");
    expect(warning).toContain("没有资源");
    expect(warning).toContain("reportNoCoverage");
  });

  it("protocol_error：警告与单纯挂掉相区分（地址可能不是 PanSou）", async () => {
    const sandbox = new TaskSandbox({
      provider: healthProvider({ status: "protocol_error", unhealthySources: ["pansou"] }),
      titleTerms: ["攻壳机动队"],
    });

    const result = await sandbox.searchResources("攻壳机动队");

    const warning = (result.warnings ?? []).find((w) => w.includes("搜索源"));
    expect(warning).toBeDefined();
    expect(warning).toContain("PanSou");
    // 两种故障的处置动作不同，文案必须可分辨。
    const unreachableSandbox = new TaskSandbox({
      provider: healthProvider({ status: "unreachable", unhealthySources: ["pansou"] }),
      titleTerms: ["攻壳机动队"],
    });
    const unreachable = await unreachableSandbox.searchResources("攻壳机动队");
    expect(warning).not.toBe((unreachable.warnings ?? []).find((w) => w.includes("搜索源")));
  });

  it("degraded：告知证据不完整，但已拿到的候选仍可用", async () => {
    const sandbox = new TaskSandbox({
      provider: healthProvider({ status: "degraded", unhealthySources: ["prowlarr"] }, [{ id: "c1", title: "攻壳机动队 1080p" }]),
      titleTerms: ["攻壳机动队"],
    });

    const result = await sandbox.searchResources("攻壳机动队");

    const warning = (result.warnings ?? []).find((w) => w.includes("搜索源"));
    expect(warning).toBeDefined();
    expect(warning).toContain("prowlarr");
    expect(warning).toContain("可用");
    // 候选照常返回，degraded 不是阻断。
    expect(result.snapshot?.candidates).toHaveLength(1);
  });

  it("healthy 且零候选：不产生源故障警告——这才是权威的「确实没有」（对照组）", async () => {
    const healthy = new TaskSandbox({
      provider: healthProvider({ status: "healthy", unhealthySources: [] }),
      titleTerms: ["攻壳机动队"],
    });
    const noHealthField = new TaskSandbox({
      provider: healthProvider(undefined),
      titleTerms: ["攻壳机动队"],
    });

    const a = await healthy.searchResources("攻壳机动队");
    const b = await noHealthField.searchResources("攻壳机动队");

    expect(a.snapshot?.candidates).toHaveLength(0);
    expect((a.warnings ?? []).some((w) => w.includes("搜索源"))).toBe(false);
    expect((b.warnings ?? []).some((w) => w.includes("搜索源"))).toBe(false);
    // 审计里也不该有源故障事件——否则运维会被健康的空搜索淹没。
    expect(healthy.auditTrail().some((e) => e.type === "search_source_unhealthy")).toBe(false);
    expect(noHealthField.auditTrail().some((e) => e.type === "search_source_unhealthy")).toBe(false);
  });

  it("源不健康时记审计事件（对齐 search_taboo_warning 形制）", async () => {
    const sandbox = new TaskSandbox({
      provider: healthProvider({ status: "unreachable", unhealthySources: ["pansou"] }),
      titleTerms: ["攻壳机动队"],
    });

    await sandbox.searchResources("攻壳机动队");

    const event = sandbox.auditTrail().find((e) => e.type === "search_source_unhealthy");
    expect(event).toBeDefined();
    expect(typeof event!.message).toBe("string");
    expect(event!.message.length).toBeGreaterThan(0);
    expect(event!.data?.status).toBe("unreachable");
    expect(event!.data?.unhealthySources).toEqual(["pansou"]);
    expect(event!.data?.keyword).toBe("攻壳机动队");
  });
});

describe("真适配器 → 沙箱 端到端：健康态不能在接缝处掉（Task 9）", () => {
  it("域快照的 unreachable 经 RealResourceProviderV2 一路到 agent 可见的 warnings", async () => {
    // 这条用真适配器而不是内联 fake，专为守住那道接缝：适配器一旦重新丢掉
    // sourceHealth（就是造成 6 天静默的那一手），这里必须红。
    const domainProvider: ResourceProvider = {
      search: async ({ keyword }) => ({
        id: "snap_unreachable",
        provider: "pansou",
        keyword,
        createdAt: "2026-06-14T00:00:00.000Z",
        candidates: [],
        sourceHealth: { status: "unreachable", unhealthySources: ["pansou"] },
      }),
    };
    const adapter = new RealResourceProviderV2({
      provider: domainProvider,
      registry: new CandidateRegistry(),
      workflowRunId: "run-1",
    });
    const sandbox = new TaskSandbox({ provider: adapter, titleTerms: ["攻壳机动队"] });

    const result = await sandbox.searchResources("攻壳机动队");

    expect(result.snapshot?.candidates).toHaveLength(0);
    const warning = (result.warnings ?? []).find((w) => w.includes("搜索源"));
    expect(warning).toBeDefined();
    expect(warning).toContain("pansou");
    expect(sandbox.auditTrail().some((e) => e.type === "search_source_unhealthy")).toBe(true);
  });
});

describe("预搜(prime)路径也必须带上健康态警告（Task 9 生产主路径）", () => {
  it("prime 时源就挂了：agent 复搜该词命中 dedup，警告仍随返回给它", async () => {
    // 生产里系统会先 primeRawSnapshot，agent 被提示词引导去 viewResourceSnapshot。
    // 当 prime 拿到 0 候选时，agent 通常会再 searchResources 同一个词 → 命中 dedup。
    // 那条路径若不带警告，agent 看到的依旧是一个「干净的空结果」。
    const sandbox = new TaskSandbox({
      provider: {
        async search(keyword: string) {
          return {
            id: `s_${keyword}`,
            keyword,
            candidates: [],
            sourceHealth: { status: "unreachable" as const, unhealthySources: ["pansou"] },
          };
        },
      },
      titleTerms: ["攻壳机动队"],
    });

    await sandbox.primeRawSnapshot("攻壳机动队");
    const result = await sandbox.searchResources("攻壳机动队");

    expect(result.deduped).toBe(true);
    const warning = (result.warnings ?? []).find((w) => w.includes("搜索源"));
    expect(warning).toBeDefined();
    expect(warning).toContain("pansou");
  });
});

describe("证据全不健康时禁止上报「没有资源」（Task 10：从劝告变强制）", () => {
  type Health = { status: "healthy" | "degraded" | "unreachable" | "protocol_error"; unhealthySources: string[] };

  /** 按关键词分派健康态的 provider——这样一个证据基里可以同时存在健康与不健康
   *  的快照，用来分辨「全不健康」与「部分不健康」这两种必须区别对待的情形。 */
  function perKeywordProvider(plan: Record<string, { health?: Health; candidates?: Array<{ id: string; title: string }> }>) {
    return {
      async search(keyword: string) {
        const entry = plan[keyword.trim()] ?? {};
        return {
          id: `s_${keyword}`,
          keyword,
          candidates: entry.candidates ?? [],
          ...(entry.health ? { sourceHealth: entry.health } : {}),
        };
      },
    };
  }

  it("证据基里每一份快照都不健康 → 拒绝上报,并点名是搜索源故障", async () => {
    // Task 9 只给了 agent 一句警告。LLM 会无视警告——所以这里必须是机械的。
    const sandbox = new TaskSandbox({
      provider: perKeywordProvider({
        攻壳机动队: { health: { status: "unreachable", unhealthySources: ["pansou"] } },
        "攻殻機動隊": { health: { status: "protocol_error", unhealthySources: ["pansou"] } },
      }),
      titleTerms: ["攻壳机动队", "攻殻機動隊"],
    });
    await sandbox.searchResources("攻壳机动队");
    await sandbox.searchResources("攻殻機動隊");

    await expect(sandbox.reportNoCoverage("没搜到")).rejects.toThrow(/SANDBOX_SOURCE_UNHEALTHY/);
    // 拒绝语必须点名源故障、否掉「没有资源」这个结论,并告诉 agent 改做什么。
    await expect(sandbox.reportNoCoverage("没搜到")).rejects.toThrow(/搜索源/);
    await expect(sandbox.reportNoCoverage("没搜到")).rejects.toThrow(/没有资源/);
    await expect(sandbox.reportNoCoverage("没搜到")).rejects.toThrow(/pansou/);
  });

  it("只要有一份健康快照 → 放行（部分证据仍是证据）", async () => {
    // agent 搜了、有源答了、确实没找到——这是合法的 no_coverage,不能拦。
    const sandbox = new TaskSandbox({
      provider: perKeywordProvider({
        攻壳机动队: { health: { status: "unreachable", unhealthySources: ["pansou"] } },
        "攻殻機動隊": { health: { status: "healthy", unhealthySources: [] } },
      }),
      titleTerms: ["攻壳机动队", "攻殻機動隊"],
    });
    await sandbox.searchResources("攻壳机动队");
    await sandbox.searchResources("攻殻機動隊");

    await expect(sandbox.reportNoCoverage("确无资源")).resolves.toMatchObject({ reason: "确无资源" });
  });

  it("全部健康且零候选 → 放行（权威的「确实没有」,最关键的对照组）", async () => {
    // 这条断言守的是「产品还能不能报告真实的缺失」。它一红,修的这个 bug 就
    // 被换成了一个更坏的 bug:任何真实的「没有资源」都再也报不出来。
    const sandbox = new TaskSandbox({
      provider: perKeywordProvider({
        攻壳机动队: { health: { status: "healthy", unhealthySources: [] } },
      }),
      titleTerms: ["攻壳机动队"],
    });
    await sandbox.searchResources("攻壳机动队");

    const report = await sandbox.reportNoCoverage("资源市场确无该作品");
    expect(report.searchesPerformed).toBe(1);
    expect(sandbox.auditTrail().some((e) => e.type === "no_coverage_reported")).toBe(true);
  });

  it("唯一证据是不健康的【预搜】快照、agent 一次都没搜 → 拒绝（就是那次 6 天静默的原形）", async () => {
    // 生产主路径:系统 primeRawSnapshot,提示词明令 agent 别重搜该词。源当时挂着,
    // 预搜拿回空快照,agent 直接 reportNoCoverage —— 用户读到「暂未找到可用资源」。
    const sandbox = new TaskSandbox({
      provider: perKeywordProvider({
        攻壳机动队: { health: { status: "unreachable", unhealthySources: ["pansou"] } },
      }),
      titleTerms: ["攻壳机动队"],
    });
    await sandbox.primeRawSnapshot("攻壳机动队");

    await expect(sandbox.reportNoCoverage("raw 快照无覆盖")).rejects.toThrow(/SANDBOX_SOURCE_UNHEALTHY/);
  });

  it("degraded 算可用证据 → 放行", async () => {
    // 有意的选择:degraded = 至少一个源答了。若连 degraded 都拦,那么任何一个
    // 次要索引挂掉就再也报不出「没有资源」——过于激进,会把这道闸变成噪音。
    const sandbox = new TaskSandbox({
      provider: perKeywordProvider({
        攻壳机动队: { health: { status: "degraded", unhealthySources: ["prowlarr"] } },
      }),
      titleTerms: ["攻壳机动队"],
    });
    await sandbox.searchResources("攻壳机动队");

    await expect(sandbox.reportNoCoverage("主源答了,确无")).resolves.toMatchObject({ searchesPerformed: 1 });
  });

  it("拒绝会记审计事件（对齐 no_coverage_reported / search_taboo_warning 形制）,且不记成功上报", async () => {
    const sandbox = new TaskSandbox({
      provider: perKeywordProvider({
        攻壳机动队: { health: { status: "unreachable", unhealthySources: ["pansou"] } },
      }),
      titleTerms: ["攻壳机动队"],
    });
    await sandbox.searchResources("攻壳机动队");

    await expect(sandbox.reportNoCoverage("没搜到")).rejects.toThrow(/SANDBOX_SOURCE_UNHEALTHY/);

    const event = sandbox.auditTrail().find((e) => e.type === "no_coverage_refused_source_unhealthy");
    expect(event).toBeDefined();
    expect(typeof event!.message).toBe("string");
    expect(event!.message.length).toBeGreaterThan(0);
    expect(event!.data?.reason).toBe("没搜到");
    expect(event!.data?.unhealthySources).toEqual(["pansou"]);
    // 被拒的上报绝不能同时留下一条「已上报无覆盖」——否则审计自相矛盾。
    expect(sandbox.auditTrail().some((e) => e.type === "no_coverage_reported")).toBe(false);
  });
});
