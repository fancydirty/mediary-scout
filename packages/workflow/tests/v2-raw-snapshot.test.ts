import { describe, expect, it, vi } from "vitest";
import { buildSandboxToolSet } from "../src/acquisition-v2/agent-loop.js";
import { TaskSandbox } from "../src/acquisition-v2/sandbox.js";
import { FakeResourceProviderV2 } from "../src/acquisition-v2/fake-provider.js";
import type { ResourceProviderV2, ResourceSnapshotV2 } from "../src/acquisition-v2/fake-provider.js";
import { Storage115Simulator } from "../src/acquisition-v2/storage-115-simulator.js";
import { buildTvAnimeSystemPrompt, buildMovieSystemPrompt } from "../src/acquisition-v2/task-agents.js";
import { JEV_UNCERTAIN_LEGEND } from "../src/jev-judge.js";
import type { JevJudgeTarget } from "../src/jev-judge.js";
import { JevPrefilterProvider } from "../src/jev-prefilter-provider.js";
import { resourceLinkKey } from "../src/acquisition-v2/resource-link.js";
import { RealResourceProviderV2 } from "../src/acquisition-v2/real-provider-adapter.js";
import { CandidateRegistry } from "../src/acquisition-v2/candidate-registry.js";
import type { ResourceProvider } from "../src/ports.js";
import type { ResourceSnapshot } from "../src/domain.js";

async function createTestSandbox(
  candidateTitles: string[],
  keyword = "铁拳教育",
  prefilter?: { scores: Record<string, number>; dropped?: number },
) {
  const fake = new FakeResourceProviderV2({
    results: {
      [keyword]: candidateTitles.map((title, idx) => ({
        id: `c${idx}`,
        title,
      })),
    },
  });
  // The fake models PanSou, which knows nothing about a prefilter — in production the
  // JevPrefilterProvider stamps these fields on top, so stamp them the same way here.
  const provider: ResourceProviderV2 = prefilter
    ? {
        search: async (kw: string): Promise<ResourceSnapshotV2> => ({
          ...(await fake.search(kw)),
          prefilterScores: prefilter.scores,
          ...(prefilter.dropped === undefined ? {} : { prefilterDropped: prefilter.dropped }),
        }),
      }
    : fake;
  const storage = new Storage115Simulator({ packs: {} });
  const stagingDirectoryId = await storage.createDirectory({ name: "staging", parentId: "root" });
  const targetSeasonDirectoryId = await storage.createDirectory({ name: "Season 1", parentId: "root" });
  return new TaskSandbox({
    provider,
    storage,
    stagingDirectoryId,
    targetSeasonDirectoryIds: { 1: targetSeasonDirectoryId },
    need: ["S01E01"],
  });
}

describe("raw snapshot pre-warming", () => {
  it("primeRawSnapshot pre-warms a raw search and makes it available via viewResourceSnapshot", async () => {
    const sandbox = await createTestSandbox(["铁拳教育 S01", "铁拳教育 全集", "铁拳教育 1080p"]);

    // 预热:系统发起的 raw 搜索
    await sandbox.primeRawSnapshot("铁拳教育");

    // viewResourceSnapshot 返回预搜候选的结构化文档
    const snapshot = sandbox.viewResourceSnapshot();

    expect(snapshot.document).toBeTruthy();
    expect(snapshot.document).toContain("c0"); // 含 id
    expect(snapshot.document).toContain("铁拳教育 S01"); // 含 title
    expect(snapshot.candidateCount).toBe(3);
  });

  it("pre-warmed search does NOT consume the agent's distinct search budget", async () => {
    const sandbox = await createTestSandbox(["Resource A", "Resource B"]);

    await sandbox.primeRawSnapshot("test-title");

    // The agent still has the FULL budget of 8 distinct searches: 8 fresh keywords
    // all run (none refused), and only the 9th distinct agent search is refused —
    // proving the system pre-warm took none of the agent's slots.
    for (let i = 0; i < 8; i++) {
      const r = await sandbox.searchResources(`agent-kw-${i}`);
      expect(r.refused, `agent search #${i + 1} should run`).toBeUndefined();
    }
    const ninth = await sandbox.searchResources("agent-kw-8");
    expect(ninth.refused).toBeTruthy();
    expect(ninth.snapshot).toBeUndefined();
  });

  it("agent re-searching the same raw keyword hits dedup and does NOT re-hit the provider", async () => {
    let searchCount = 0;
    const provider = new FakeResourceProviderV2({
      results: { raw: [{ id: "c1", title: "Title" }] },
      onSearch: () => { searchCount++; },
    });
    const storage = new Storage115Simulator({ packs: {} });
    const stagingDirectoryId = await storage.createDirectory({ name: "staging", parentId: "root" });
    const sandbox = new TaskSandbox({
      provider,
      storage,
      stagingDirectoryId,
      targetSeasonDirectoryIds: { 1: await storage.createDirectory({ name: "Season 1", parentId: "root" }) },
      need: ["S01E01"],
    });

    // 预热搜索 raw
    await sandbox.primeRawSnapshot("raw");
    expect(searchCount).toBe(1);

    // agent 再搜同一 raw 词 → 命中 dedup,不重打 provider
    const result = await sandbox.searchResources("raw");
    expect(result.deduped).toBe(true);
    expect(searchCount).toBe(1); // 仍然是 1,未增加
  });

  it("viewResourceSnapshot can be called multiple times without consuming budget", async () => {
    const sandbox = await createTestSandbox(["A", "B", "C"], "title");
    await sandbox.primeRawSnapshot("title");

    const snap1 = sandbox.viewResourceSnapshot();
    const snap2 = sandbox.viewResourceSnapshot();

    expect(snap1.candidateCount).toBe(3);
    expect(snap2.candidateCount).toBe(3);
    // 不抛错,不耗预算
  });

  it("viewResourceSnapshot truncates at 120 candidates and notes remaining count", async () => {
    const manyCandidates = Array.from({ length: 150 }, (_, i) => `Candidate ${i + 1}`);
    const sandbox = await createTestSandbox(manyCandidates, "title");
    await sandbox.primeRawSnapshot("title");

    const snap = sandbox.viewResourceSnapshot();

    expect(snap.candidateCount).toBe(150);
    // 文档应截断并提示
    expect(snap.document).toMatch(/还有.*条|还有 30 条|截断|更多/);
    // 实际文档中的候选数应 <= 120
    const lines = snap.document.split("\n").filter(line => line.match(/\[c\d+\]/));
    expect(lines.length).toBeLessThanOrEqual(120);
  });
});

describe("system prompt carries raw snapshot pointer", () => {
  it("TV prompt includes prefetched candidate count and pointer when provided", () => {
    const prompt = buildTvAnimeSystemPrompt({ prefetchedCandidateCount: 84 });

    expect(prompt).toContain("84");
    expect(prompt).toMatch(/预搜|pre.*search|already.*search/i);
    expect(prompt).toContain("viewResourceSnapshot");
  });

  it("movie prompt includes prefetched candidate count and pointer when provided", () => {
    const prompt = buildMovieSystemPrompt({ prefetchedCandidateCount: 185 });

    expect(prompt).toContain("185");
    expect(prompt).toMatch(/预搜|pre.*search|already.*search/i);
    expect(prompt).toContain("viewResourceSnapshot");
  });

  it("prompt does NOT embed the full candidate list (only a pointer + count)", () => {
    // 即使有 150 个候选,prompt 里不应该有全量标题列表
    const prompt = buildTvAnimeSystemPrompt({ prefetchedCandidateCount: 150 });

    // 应该只有计数,不应该有类似 "[c0] Title A\n[c1] Title B..." 的大段列表
    // 用一个启发式检查:不应该有多个 [cN] 格式的 id
    const idMatches = prompt.match(/\[c\d+\]/g);
    expect(idMatches).toBeNull(); // 完全没有候选 id,或最多有示例性的 1-2 个
  });

  it("tells the agent what the 近 30 天 note means, on both the raw pointer and the search tools", () => {
    const fact = "none of the files those transfers landed ended up in the library";
    for (const prompt of [
      buildTvAnimeSystemPrompt({ prefetchedCandidateCount: 12 }),
      buildMovieSystemPrompt({ prefetchedCandidateCount: 12 }),
      buildTvAnimeSystemPrompt({
        prefetchedCandidateCount: 12,
        userRequests: { messages: [{ body: "换一版", episodeTags: ["S01E01"], createdAt: "2026-09-27T00:00:00.000Z" }], rejected: [], pending: [] },
      }),
    ]) {
      expect(prompt).toContain("近 30 天转过");
      expect(prompt).toContain("文件每次都被丢掉");
      expect(prompt).toContain(fact);
      expect(prompt).not.toContain("held only files the library already had");
    }
    const sandbox = new TaskSandbox({
      provider: new FakeResourceProviderV2({ results: {} }),
      need: ["S01E01"],
    });
    const tools = buildSandboxToolSet(sandbox);
    for (const name of ["viewResourceSnapshot", "searchResources"] as const) {
      const description = tools[name]!.description ?? "";
      expect(description).toContain("近 30 天转过");
      expect(description).toContain("文件每次都被丢掉");
      expect(description).toContain(fact);
      expect(description).not.toContain("held only files the library already had");
    }
  });

  it("prompt without prefetchedCandidateCount does NOT mention raw snapshot", () => {
    const tvPrompt = buildTvAnimeSystemPrompt({});
    const moviePrompt = buildMovieSystemPrompt({});

    expect(tvPrompt).not.toContain("viewResourceSnapshot");
    expect(moviePrompt).not.toContain("viewResourceSnapshot");
  });
});

describe("system prompt carries subtitle snapshot pointer (symmetric with raw pointer)", () => {
  it("TV/movie prompts include the subtitle pointer when the run is subtitle-active with candidates", () => {
    for (const build of [buildTvAnimeSystemPrompt, buildMovieSystemPrompt]) {
      const prompt = build({ subtitle: true, subtitleCandidateCount: 12 });
      expect(prompt).toContain("12");
      expect(prompt).toContain("viewSubtitleSnapshot");
      expect(prompt).toMatch(/字幕|subtitle/i);
    }
  });

  it("no subtitle pointer when the flow is inactive or the snapshot is empty", () => {
    // The skill INDEX may mention viewSubtitleSnapshot (it tells the agent when to
    // read the subtitle section) — what must NOT render is the POINTER header.
    expect(buildTvAnimeSystemPrompt({})).not.toContain("SUBTITLE SNAPSHOT");
    expect(buildTvAnimeSystemPrompt({ subtitle: true, subtitleCandidateCount: 0 })).not.toContain(
      "SUBTITLE SNAPSHOT",
    );
  });
});

describe("viewResourceSnapshot renders the Jev uncertainty flag", () => {
  it("appends ⚠ 相关度存疑(p) only for candidates in the uncertain band", async () => {
    const sandbox = await createTestSandbox(
      ["交锋 全24集", "权利交锋 S01E08", "📅 9月6日"],
      "交锋",
      { scores: { c0: 0.95, c1: 0.52 } },
    );
    await sandbox.primeRawSnapshot("交锋");
    const doc = sandbox.viewResourceSnapshot().document;
    expect(doc).toContain("[c0] 交锋 全24集\n");
    expect(doc).toContain("[c1] 权利交锋 S01E08 ⚠ 相关度存疑(0.52)\n");
    expect(doc).toContain("[c2] 📅 9月6日\n");
    // A flag with no legend is a naked number — the agent must be told it is not an exclusion.
    expect(doc).toContain(JEV_UNCERTAIN_LEGEND);
  });

  it("drops the flags and says why when most rows of a long list would carry one", async () => {
    // Re:从零 patrol: the judge doubted 150 of 155 rows (fansub 第四季 vs TMDB's one
    // season). A ⚠ on nearly every line is noise; one sentence replaces them.
    const titles = Array.from({ length: 12 }, (_, i) => `Re:从零 第四季 ${i + 1}`);
    const scores = Object.fromEntries(titles.map((_, i) => [`c${i}`, i < 7 ? 0.5 : 0.9]));
    const sandbox = await createTestSandbox(titles, "Re:从零", { scores });
    await sandbox.primeRawSnapshot("Re:从零");
    const doc = sandbox.viewResourceSnapshot().document;
    expect(doc).not.toContain("⚠ 相关度存疑");
    expect(doc).not.toContain(JEV_UNCERTAIN_LEGEND);
    expect(doc).toContain("没有逐条标 ⚠");
    const result = await sandbox.searchResources("Re:从零");
    expect(result.snapshot!.candidates.every((c) => !c.title.includes("⚠"))).toBe(true);
    expect(result.warnings?.some((w) => w.includes("没有逐条标 ⚠"))).toBe(true);
  });

  it("decides on the rows the document shows, not on rows past the 120 cut", async () => {
    // 200 rows; only rows 121-200 are doubted. The visible 120 are clean → no
    // suppression note, and no ⚠ either (none of the shown rows carries one).
    const titles = Array.from({ length: 200 }, (_, i) => `Candidate ${i + 1}`);
    const scores = Object.fromEntries(titles.map((_, i) => [`c${i}`, i >= 120 ? 0.5 : 0.9]));
    const sandbox = await createTestSandbox(titles, "title", { scores });
    await sandbox.primeRawSnapshot("title");
    const doc = sandbox.viewResourceSnapshot().document;
    expect(doc).not.toContain("没有逐条标 ⚠");
    expect(doc).not.toContain(JEV_UNCERTAIN_LEGEND);
  });

  it("keeps the flags when only a minority of a long list is doubted", async () => {
    const titles = Array.from({ length: 12 }, (_, i) => `交锋 ${i + 1}`);
    const scores = Object.fromEntries(titles.map((_, i) => [`c${i}`, i < 6 ? 0.5 : 0.9]));
    const sandbox = await createTestSandbox(titles, "交锋", { scores });
    await sandbox.primeRawSnapshot("交锋");
    const doc = sandbox.viewResourceSnapshot().document;
    expect(doc).toContain("[c0] 交锋 1 ⚠ 相关度存疑(0.50)\n");
    expect(doc).toContain(JEV_UNCERTAIN_LEGEND);
  });

  it("renders no flag and no legend when nothing is in the uncertain band", async () => {
    const sandbox = await createTestSandbox(["交锋 全24集"], "交锋", { scores: { c0: 0.9 } });
    await sandbox.primeRawSnapshot("交锋");
    const doc = sandbox.viewResourceSnapshot().document;
    expect(doc).toContain("[c0] 交锋 全24集\n");
    expect(doc).not.toContain("相关度存疑");
  });

  it("attaches the legend only when a flagged row survives the 120-row truncation", async () => {
    const titles = Array.from({ length: 121 }, (_, i) => `Candidate ${i + 1}`);

    // c120 is the 121st row — truncated away. Explaining a ⚠ that is nowhere in the
    // document teaches the agent the flag means something other than what it sees.
    const hidden = await createTestSandbox(titles, "title", { scores: { c120: 0.52 } });
    await hidden.primeRawSnapshot("title");
    const hiddenDoc = hidden.viewResourceSnapshot().document;
    expect(hiddenDoc).not.toContain("相关度存疑");
    expect(hiddenDoc).not.toContain(JEV_UNCERTAIN_LEGEND);

    // c119 is the last visible row — the flag renders, so the legend must too.
    const visible = await createTestSandbox(titles, "title", { scores: { c119: 0.52 } });
    await visible.primeRawSnapshot("title");
    const visibleDoc = visible.viewResourceSnapshot().document;
    expect(visibleDoc).toContain("[c119] Candidate 120 ⚠ 相关度存疑(0.52)\n");
    expect(visibleDoc).toContain(JEV_UNCERTAIN_LEGEND);
  });

  it("explains an all-dropped prefilter instead of showing a bare empty snapshot", async () => {
    const sandbox = await createTestSandbox([], "交锋", { scores: {}, dropped: 7 });
    await sandbox.primeRawSnapshot("交锋");
    const doc = sandbox.viewResourceSnapshot().document;
    expect(doc).toMatch(/7 个被系统按片名预筛剔除/);
  });

  // The pre-warm's count only decides the prompt POINTER, and 0 → no pointer, exactly as
  // for a pre-warm that found nothing (the prefilter never edits the system prompt). The
  // warning is not lost: it rides on the empty result itself. Searching the bare title is
  // the agent's normal first move without a pointer, it is answered from the pre-warm
  // (dedup, no provider call, no budget) and carries the same warning.
  it("an all-dropped pre-warm adds no prompt pointer; the agent's first search of the bare title gets the empty result WITH the warning (dedup)", async () => {
    let providerCalls = 0;
    const sandbox = new TaskSandbox({
      provider: {
        async search(keyword: string): Promise<ResourceSnapshotV2> {
          providerCalls += 1;
          return { id: "s", keyword, candidates: [], prefilterScores: {}, prefilterDropped: 7 };
        },
      },
      searchBudget: 8,
    });
    await sandbox.primeRawSnapshot("交锋");
    const { candidateCount } = sandbox.viewResourceSnapshot();

    expect(candidateCount).toBe(0);
    expect(buildTvAnimeSystemPrompt({ prefetchedCandidateCount: candidateCount })).toBe(buildTvAnimeSystemPrompt({}));

    const result = await sandbox.searchResources("交锋");
    expect(result.deduped).toBe(true);
    expect(providerCalls).toBe(1); // the pre-warm only
    expect(result.snapshot!.candidates).toEqual([]);
    expect(result.warnings?.some((w) => /7 个被系统按片名预筛剔除/.test(w))).toBe(true);
  });
});

/** The production chain, no hand-stamped V2 fields: a domain ResourceProvider →
 *  JevPrefilterProvider → RealResourceProviderV2 → TaskSandbox. Both seam tests build
 *  their sandbox here so a boundary that stops carrying the flag fails both at once. */
async function createRealChainSandbox(
  titles: string[],
  scores: Record<string, number>,
  target: JevJudgeTarget = { kind: "tv", title: "交锋", aliases: [] },
) {
  const inner: ResourceProvider = {
    search: async ({ keyword }): Promise<ResourceSnapshot> => ({
      id: "snap_1",
      provider: "pansou",
      keyword,
      createdAt: "2026-09-19T00:00:00.000Z",
      candidates: titles.map((title, index) => ({
        id: `c${index + 1}`, snapshotId: "snap_1", index, title, type: "115", source: "pansou", providerPayload: {},
      })),
    }),
  };
  const prefiltered = new JevPrefilterProvider({
    inner,
    target,
    judge: { judgeCandidates: async () => ({ scores, model: "m" }) },
    log: () => {},
  });
  const provider = new RealResourceProviderV2({
    provider: prefiltered,
    registry: new CandidateRegistry(),
    workflowRunId: "run-1",
  });
  const storage = new Storage115Simulator({ packs: {} });
  const stagingDirectoryId = await storage.createDirectory({ name: "staging", parentId: "root" });
  const seasonDirectoryId = await storage.createDirectory({ name: "Season 1", parentId: "root" });
  return new TaskSandbox({
    provider,
    storage,
    stagingDirectoryId,
    targetSeasonDirectoryIds: { 1: seasonDirectoryId },
    need: ["S01E01"],
  });
}

describe("prefilter → adapter → sandbox seam (real classes, no hand-stamped fields)", () => {
  it("carries the Jev scores from the domain provider all the way into both agent read paths", async () => {
    // Every other Jev test stamps prefilterScores onto a fake V2 provider by hand,
    // which is exactly the shape of the bug that once dropped sourceHealth for 6 days:
    // the field existed at both ends and nobody wired the boundary between them.
    // This one builds the production chain and asserts the flag survives it.
    const sandbox = await createRealChainSandbox(
      ["交锋 全24集", "权利交锋 S01E08", "无敌少侠"],
      { c1: 0.95, c2: 0.52, c3: 0.05 },
    );

    await sandbox.primeRawSnapshot("交锋");
    const doc = sandbox.viewResourceSnapshot().document;
    expect(doc).toContain("[s1-1] 交锋 全24集\n");
    expect(doc).toContain("[s1-2] 权利交锋 S01E08 ⚠ 相关度存疑(0.52)\n");
    expect(doc).not.toContain("无敌少侠"); // 0.05 → dropped before the agent ever sees it
    expect(doc).toContain(JEV_UNCERTAIN_LEGEND);

    // The agent's own search path must tell the same story as the 活期文档.
    const result = await sandbox.searchResources("交锋");
    expect(result.snapshot!.candidates[1]!.title).toBe("权利交锋 S01E08 ⚠ 相关度存疑(0.52)");
  });

  it("a FLOORED row (0.04, below the drop band) reaches both read paths flagged with its real score", async () => {
    // The containment floor is only worth anything if the rescued row actually arrives:
    // the provider keeps it, but four layers later the presenter has to flag it rather
    // than render it as an ordinary result — a 0.04 shown bare would be the dishonest
    // half of the floor, and 0.04 is BELOW the uncertain band the flag was built for.
    const sandbox = await createRealChainSandbox(
      ["交锋 全24集", "权利交锋 S01E08"],
      { c1: 0.95, c2: 0.04 },
    );

    await sandbox.primeRawSnapshot("交锋");
    const doc = sandbox.viewResourceSnapshot().document;
    expect(doc).toContain("[s1-1] 交锋 全24集\n");
    expect(doc).toContain("[s1-2] 权利交锋 S01E08 ⚠ 相关度存疑(0.04)\n");
    expect(doc).toContain(JEV_UNCERTAIN_LEGEND);

    const result = await sandbox.searchResources("交锋");
    expect(result.snapshot!.candidates.map((c) => c.id)).toEqual(["s1-1", "s1-2"]);
    expect(result.snapshot!.candidates[1]!.title).toBe("权利交锋 S01E08 ⚠ 相关度存疑(0.04)");
  });
});

describe("candidate post dates reach both agent read paths", () => {
  it("prints · 发布 YYYY-MM-DD on the raw row and postedAt on searchResources candidates", async () => {
    const inner: ResourceProvider = {
      search: async ({ keyword }): Promise<ResourceSnapshot> => ({
        id: "snap_dates",
        provider: "pansou",
        keyword,
        createdAt: "2026-09-27T00:00:00.000Z",
        candidates: [
          {
            id: "dated",
            snapshotId: "snap_dates",
            index: 0,
            title: "黄泉的使者 (2026)",
            type: "123",
            source: "pansou",
            providerPayload: { url: "https://www.123pan.com/s/Ab-cD_12", datetime: "2026-04-06T08:00:00Z" },
          },
          {
            id: "unknown",
            snapshotId: "snap_dates",
            index: 1,
            title: "未知日期",
            type: "123",
            source: "pansou",
            providerPayload: { datetime: "0001-01-01T00:00:00Z" },
          },
        ],
      }),
    };
    const provider = new RealResourceProviderV2({ provider: inner, registry: new CandidateRegistry(), workflowRunId: "run-dates" });
    const storage = new Storage115Simulator({ packs: {} });
    const stagingDirectoryId = await storage.createDirectory({ name: "staging", parentId: "root" });
    const seasonDirectoryId = await storage.createDirectory({ name: "Season 1", parentId: "root" });
    const sandbox = new TaskSandbox({
      provider,
      storage,
      stagingDirectoryId,
      targetSeasonDirectoryIds: { 1: seasonDirectoryId },
      need: ["S01E01"],
    });

    await sandbox.primeRawSnapshot("黄泉的使者");
    const doc = sandbox.viewResourceSnapshot().document;
    expect(doc).toContain("[s1-1] 黄泉的使者 (2026) · 发布 2026-04-06\n");
    expect(doc).toContain("[s1-2] 未知日期\n");
    expect(doc).not.toMatch(/未知日期 · 发布/);

    const again = await sandbox.searchResources("黄泉的使者");
    expect(again.deduped).toBe(true);
    expect(again.snapshot!.candidates[0]).toMatchObject({ id: "s1-1", postedAt: "2026-04-06" });
    expect(again.snapshot!.candidates[1]).not.toHaveProperty("postedAt");
    expect(doc).not.toContain("近 30 天");
  });

  it("prints a link-history note after the post date, and omits it when the candidate has none", async () => {
    const note = "近 30 天转过 2 次（最近 09-25），最近一次留下 12 个文件";
    const provider = new FakeResourceProviderV2({
      results: {
        show: [
          { id: "a", title: "有记录", postedAt: "2026-09-01", linkHistory: note },
          { id: "b", title: "没有记录", postedAt: "2026-09-02" },
        ],
      },
    });
    const storage = new Storage115Simulator({ packs: {} });
    const stagingDirectoryId = await storage.createDirectory({ name: "staging", parentId: "root" });
    const seasonDirectoryId = await storage.createDirectory({ name: "Season 1", parentId: "root" });
    const sandbox = new TaskSandbox({
      provider,
      storage,
      stagingDirectoryId,
      targetSeasonDirectoryIds: { 1: seasonDirectoryId },
      need: ["S01E01"],
    });
    await sandbox.primeRawSnapshot("show");
    const doc = sandbox.viewResourceSnapshot().document;
    expect(doc).toContain(`[a] 有记录 · 发布 2026-09-01 · ${note}\n`);
    expect(doc).toContain("[b] 没有记录 · 发布 2026-09-02\n");
    expect(doc).not.toContain("没有记录 · 发布 2026-09-02 ·");
  });

  it("annotates both titles of one link from the candidate url, and searchResources returns the field", async () => {
    const share = "https://www.123pan.com/s/Ab-cD_12";
    const note = "近 30 天转过 31 次（最近 09-26），文件每次都被丢掉";
    const inner: ResourceProvider = {
      search: async ({ keyword }): Promise<ResourceSnapshot> => ({
        id: "snap_hist",
        provider: "pansou",
        keyword,
        createdAt: "2026-09-27T00:00:00.000Z",
        candidates: [
          {
            id: "a",
            snapshotId: "snap_hist",
            index: 0,
            title: "黄泉的使者 (2026)",
            type: "123",
            source: "pansou",
            providerPayload: { url: share, datetime: "2026-09-01T00:00:00Z" },
          },
          {
            id: "b",
            snapshotId: "snap_hist",
            index: 1,
            title: "🎬 黄泉的使者 (2026) 已更新",
            type: "123",
            source: "pansou",
            providerPayload: { url: share, datetime: "2026-09-01T00:00:00Z" },
          },
          {
            id: "c",
            snapshotId: "snap_hist",
            index: 2,
            title: "别的链接",
            type: "123",
            source: "pansou",
            providerPayload: { url: "https://www.123pan.com/s/OtherKey1", datetime: "2026-09-02T00:00:00Z" },
          },
        ],
      }),
    };
    const provider = new RealResourceProviderV2({
      provider: inner,
      registry: new CandidateRegistry(),
      workflowRunId: "run-hist",
      linkHistory: new Map([[resourceLinkKey(share)!, note]]),
    });
    const storage = new Storage115Simulator({ packs: {} });
    const stagingDirectoryId = await storage.createDirectory({ name: "staging", parentId: "root" });
    const seasonDirectoryId = await storage.createDirectory({ name: "Season 1", parentId: "root" });
    const sandbox = new TaskSandbox({
      provider,
      storage,
      stagingDirectoryId,
      targetSeasonDirectoryIds: { 1: seasonDirectoryId },
      need: ["S01E01"],
    });

    await sandbox.primeRawSnapshot("黄泉的使者");
    const doc = sandbox.viewResourceSnapshot().document;
    expect(doc).toContain(`[s1-1] 黄泉的使者 (2026) · 发布 2026-09-01 · ${note}\n`);
    expect(doc).toContain(`[s1-2] 🎬 黄泉的使者 (2026) 已更新 · 发布 2026-09-01 · ${note}\n`);
    expect(doc).toContain("[s1-3] 别的链接 · 发布 2026-09-02\n");
    expect(doc).not.toContain("别的链接 · 发布 2026-09-02 ·");

    const again = await sandbox.searchResources("黄泉的使者");
    expect(again.snapshot!.candidates[0]).toMatchObject({ id: "s1-1", postedAt: "2026-09-01", linkHistory: note });
    expect(again.snapshot!.candidates[1]).toMatchObject({ id: "s1-2", linkHistory: note });
    expect(again.snapshot!.candidates[0]!.linkHistory).toBe(again.snapshot!.candidates[1]!.linkHistory);
    expect(again.snapshot!.candidates[2]).not.toHaveProperty("linkHistory");
  });
});

describe("预搜退避重试（源头自愈：双源全挂先等 5 秒重试一次）", () => {
  /** 按调用次序作答的 provider——最后一次之后重复末位。带调用计数器。 */
  function sequencedProvider(
    stops: Array<{
      health?: { status: "healthy" | "degraded" | "unreachable" | "protocol_error"; unhealthySources: string[] };
      candidates?: Array<{ id: string; title: string }>;
      throws?: boolean;
    }>,
  ) {
    let calls = 0;
    return {
      get calls() {
        return calls;
      },
      async search(keyword: string) {
        const stop = stops[Math.min(calls, stops.length - 1)]!;
        calls += 1;
        if (stop.throws) throw new Error("PROVIDER_ERROR: down");
        return {
          id: `s_${calls}`,
          keyword,
          candidates: stop.candidates ?? [],
          ...(stop.health ? { sourceHealth: stop.health } : {}),
        };
      },
    };
  }

  it("首搜不健康 → 等满 5 秒才重试一次，取到好结果", async () => {
    // 生产实测源抖动多在 60 秒内自愈,5 秒退避窗口的救率高;这断言锁住
    // 「真的等了 5 秒」和「只重试一次」,而不只是「多打了一次」。
    vi.useFakeTimers();
    try {
      const provider = sequencedProvider([
        { health: { status: "unreachable", unhealthySources: ["pansou"] } },
        { health: { status: "healthy", unhealthySources: [] }, candidates: [{ id: "c1", title: "猛攻 4K" }] },
      ]);
      const sandbox = new TaskSandbox({ provider, titleTerms: ["猛攻"] });

      const priming = sandbox.primeRawSnapshot("猛攻");
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(provider.calls).toBe(1);
      expect(vi.getTimerCount()).toBe(1); // 退避计时器已挂上

      await vi.advanceTimersByTimeAsync(4999);
      expect(provider.calls).toBe(1); // 5 秒未到,不许提前重试

      await vi.advanceTimersByTimeAsync(1);
      await priming;
      expect(provider.calls).toBe(2);
      // 取到的是重试后的那份好结果。
      expect(sandbox.viewResourceSnapshot().candidateCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("重试仍坏 → 落原样快照，只重试一次（不无限重试）", async () => {
    vi.useFakeTimers();
    try {
      const provider = sequencedProvider([{ health: { status: "unreachable", unhealthySources: ["pansou"] } }]);
      const sandbox = new TaskSandbox({ provider, titleTerms: ["猛攻"] });

      const priming = sandbox.primeRawSnapshot("猛攻");
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(5000);
      await priming;

      expect(provider.calls).toBe(2); // 首搜 + 恰好一次重试
      expect(vi.getTimerCount()).toBe(0); // 没有第三个计时器 = 不在无限重试
      expect(sandbox.viewResourceSnapshot().candidateCount).toBe(0); // 坏快照照落,预搜不抛
    } finally {
      vi.useRealTimers();
    }
  });

  it("首搜抛错也退避重试一次，第二次成功即取到", async () => {
    vi.useFakeTimers();
    try {
      const provider = sequencedProvider([
        { throws: true },
        { health: { status: "healthy", unhealthySources: [] }, candidates: [{ id: "c1", title: "猛攻" }] },
      ]);
      const sandbox = new TaskSandbox({ provider, titleTerms: ["猛攻"] });

      const priming = sandbox.primeRawSnapshot("猛攻");
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(5000);
      await priming;

      expect(provider.calls).toBe(2);
      expect(sandbox.viewResourceSnapshot().candidateCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("健康的预搜一次到位，不退避（回归锁）", async () => {
    const provider = sequencedProvider([
      { health: { status: "healthy", unhealthySources: [] }, candidates: [{ id: "c1", title: "猛攻" }] },
    ]);
    const sandbox = new TaskSandbox({ provider, titleTerms: ["猛攻"] });

    await sandbox.primeRawSnapshot("猛攻");

    expect(provider.calls).toBe(1);
  });

  it("degraded 首搜是可用证据 → 不重试（0 次），落 degraded 那份，不被更坏的重试结果换掉", async () => {
    // degraded 是 fallback 救回的可用证据（有候选）。重试只为救「真的拿不到」，不为
    // 救「次优」——重试结果可能更坏：第二次若给出双挂空快照，绝不许它覆盖 degraded
    // 的候选（Copilot finding 的原形）。
    const provider = sequencedProvider([
      { health: { status: "degraded", unhealthySources: ["pansou"] }, candidates: [{ id: "c1", title: "猛攻 4K" }] },
      { health: { status: "unreachable", unhealthySources: ["pansou", "prowlarr"] }, candidates: [] },
    ]);
    const sandbox = new TaskSandbox({ provider, titleTerms: ["猛攻"] });

    vi.useFakeTimers();
    try {
      const priming = sandbox.primeRawSnapshot("猛攻");
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(provider.calls).toBe(1); // 0 次重试
      expect(vi.getTimerCount()).toBe(0); // 连退避计时器都没挂

      await vi.advanceTimersByTimeAsync(5000); // 无事发生
      await priming;
      expect(provider.calls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
    // 落的是 degraded 那份（有候选），不是不可用空快照
    expect(sandbox.viewResourceSnapshot().candidateCount).toBe(1);
  });

  it("首搜不可用 + 重试仍坏 → 落首搜那份（择优：重试可能更坏，不覆盖手里的证据）", async () => {
    // 生产里不可用快照都是 0 候选，落谁都无从分辨；这里用带候选的不可用快照（类型合法）
    // 让「落首搜那份」可断言——落点规则不许依赖「坏快照必然空」的巧合。
    vi.useFakeTimers();
    try {
      const provider = sequencedProvider([
        { health: { status: "unreachable", unhealthySources: ["pansou"] }, candidates: [{ id: "c1", title: "猛攻 4K" }] },
        { health: { status: "unreachable", unhealthySources: ["pansou", "prowlarr"] }, candidates: [] },
      ]);
      const sandbox = new TaskSandbox({ provider, titleTerms: ["猛攻"] });

      const priming = sandbox.primeRawSnapshot("猛攻");
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(5000);
      await priming;

      expect(provider.calls).toBe(2); // 仍只重试恰好一次
      expect(sandbox.viewResourceSnapshot().candidateCount).toBe(1); // 落首搜那份，不被更坏的重试换掉
    } finally {
      vi.useRealTimers();
    }
  });

  it("首搜不可用 + 重试抛错 → 落首搜那份，预搜不抛（回归锁）", async () => {
    vi.useFakeTimers();
    try {
      const provider = sequencedProvider([
        { health: { status: "unreachable", unhealthySources: ["pansou"] }, candidates: [{ id: "c1", title: "猛攻 4K" }] },
        { throws: true },
      ]);
      const sandbox = new TaskSandbox({ provider, titleTerms: ["猛攻"] });

      const priming = sandbox.primeRawSnapshot("猛攻");
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(5000);
      await priming;

      expect(provider.calls).toBe(2);
      expect(sandbox.viewResourceSnapshot().candidateCount).toBe(1); // 落首搜那份，不是抛给调用方
    } finally {
      vi.useRealTimers();
    }
  });

  it("两次都抛 → 抛第二次的错（回归锁，orchestrator 按「无预搜」降级）", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const provider = {
        async search(): Promise<ResourceSnapshotV2> {
          calls += 1;
          throw new Error(calls === 1 ? "FIRST_BOOM" : "SECOND_BOOM");
        },
      };
      const sandbox = new TaskSandbox({ provider, titleTerms: ["猛攻"] });

      const priming = sandbox.primeRawSnapshot("猛攻");
      // 处理器先挂上再推时钟：抛错发生在 advance 的中途，晚挂会先报 unhandled rejection。
      const rejection = expect(priming).rejects.toThrow("SECOND_BOOM"); // 第二次的错，不是第一次的
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(5000);
      await rejection;
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
