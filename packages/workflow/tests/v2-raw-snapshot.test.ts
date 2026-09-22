import { describe, expect, it } from "vitest";
import { TaskSandbox } from "../src/acquisition-v2/sandbox.js";
import { FakeResourceProviderV2 } from "../src/acquisition-v2/fake-provider.js";
import type { ResourceProviderV2, ResourceSnapshotV2 } from "../src/acquisition-v2/fake-provider.js";
import { Storage115Simulator } from "../src/acquisition-v2/storage-115-simulator.js";
import { buildTvAnimeSystemPrompt, buildMovieSystemPrompt } from "../src/acquisition-v2/task-agents.js";
import { JEV_UNCERTAIN_LEGEND } from "../src/jev-judge.js";
import type { JevJudgeTarget } from "../src/jev-judge.js";
import { JevPrefilterProvider } from "../src/jev-prefilter-provider.js";
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
    expect(doc).toContain("[c1] 交锋 全24集\n");
    expect(doc).toContain("[c2] 权利交锋 S01E08 ⚠ 相关度存疑(0.52)\n");
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
    expect(doc).toContain("[c1] 交锋 全24集\n");
    expect(doc).toContain("[c2] 权利交锋 S01E08 ⚠ 相关度存疑(0.04)\n");
    expect(doc).toContain(JEV_UNCERTAIN_LEGEND);

    const result = await sandbox.searchResources("交锋");
    expect(result.snapshot!.candidates.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(result.snapshot!.candidates[1]!.title).toBe("权利交锋 S01E08 ⚠ 相关度存疑(0.04)");
  });
});
