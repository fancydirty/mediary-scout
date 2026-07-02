import { describe, expect, it } from "vitest";
import { TaskSandbox } from "../src/acquisition-v2/sandbox.js";
import { FakeResourceProviderV2 } from "../src/acquisition-v2/fake-provider.js";
import { Storage115Simulator, type TransferAttemptResult } from "../src/acquisition-v2/storage-115-simulator.js";
import type { AssrtCandidate, AssrtSubtitleFile } from "../src/subtitle-provider.js";
import { buildSandboxToolSet } from "../src/acquisition-v2/agent-loop.js";

/** The provider object shape primeSubtitleSnapshot takes. */
type FakeAssrtProvider = {
  search(keyword: string): Promise<AssrtCandidate[]>;
  detail(id: number): Promise<AssrtSubtitleFile[]>;
};

function makeAssrtProvider(
  searchResults: AssrtCandidate[],
  detailByCandidate: Record<number, AssrtSubtitleFile[]>,
  spy?: { searchCalls?: number; detailCalls?: number },
): FakeAssrtProvider {
  return {
    search: async (_keyword: string) => {
      spy?.searchCalls !== undefined && (spy.searchCalls += 1);
      return searchResults;
    },
    detail: async (id: number) => {
      spy?.detailCalls !== undefined && (spy.detailCalls += 1);
      return detailByCandidate[id] ?? [];
    },
  };
}

/** Build a TaskSandbox wired to a fake video provider + sim storage. assrt is NOT
 *  passed at construction — it goes to primeSubtitleSnapshot per-test. */
async function createSubtitleSandbox() {
  const provider = new FakeResourceProviderV2({ results: { title: [] } });
  const storage = new Storage115Simulator({ packs: {} });
  const stagingDirectoryId = await storage.createDirectory({ name: "staging", parentId: "root" });
  const targetSeasonDirectoryId = await storage.createDirectory({ name: "Season 1", parentId: "root" });
  const sandbox = new TaskSandbox({
    provider,
    storage,
    stagingDirectoryId,
    targetSeasonDirectoryIds: { 1: targetSeasonDirectoryId },
    need: ["S01E01"],
  });
  return { sandbox, stagingDirectoryId, targetSeasonDirectoryId };
}

describe("subtitle snapshot pre-warming + view", () => {
  it("primeSubtitleSnapshot pre-warms assrt candidates, viewSubtitleSnapshot renders them", async () => {
    const { sandbox } = await createSubtitleSandbox();
    const provider = makeAssrtProvider(
      [{ id: 713570, title: "绝命毒师 第二季 · Breaking.Bad.S02", lang: "英 简 双语" }],
      {},
    );

    await sandbox.primeSubtitleSnapshot("绝命毒师", provider);

    const snap = sandbox.viewSubtitleSnapshot();
    expect(snap.document).toContain("713570");
    expect(snap.document).toContain("绝命毒师 第二季");
    expect(snap.candidateCount).toBe(1);
  });

  it("viewSubtitleSnapshot before any pre-warm returns an empty doc", async () => {
    const { sandbox } = await createSubtitleSandbox();
    const snap = sandbox.viewSubtitleSnapshot();
    expect(snap.candidateCount).toBe(0);
    expect(snap.document).toMatch(/no subtitle|无字幕|empty|未预热/i);
  });

  it("viewSubtitleSnapshot is free + repeatable (no provider re-hit)", async () => {
    const { sandbox } = await createSubtitleSandbox();
    const spy = { searchCalls: 0, detailCalls: 0 };
    const provider = makeAssrtProvider([{ id: 1, title: "x", lang: "" }], {}, spy);

    await sandbox.primeSubtitleSnapshot("k", provider);
    const searchCallsAfterPrime = spy.searchCalls;

    sandbox.viewSubtitleSnapshot();
    sandbox.viewSubtitleSnapshot();
    expect(spy.searchCalls).toBe(searchCallsAfterPrime); // view never re-hits search
  });
});

describe("transferSubtitle", () => {
  it("resolves the candidate's detail filelist and lands each file via storage.transferSubtitleUrl", async () => {
    const { sandbox } = await createSubtitleSandbox();
    const file = { filename: "Breaking.Bad.S02E01.ass", url: "http://file0.assrt.net/onthefly/713570/-/1/a.ass?api=1" };
    const provider = makeAssrtProvider(
      [{ id: 713570, title: "BB S02", lang: "英 简 双语" }],
      { 713570: [file] },
    );
    await sandbox.primeSubtitleSnapshot("BB", provider);

    const result = await sandbox.transferSubtitle({ candidateId: 713570 });

    expect(result.status).toBe("succeeded");
    expect(result.landedFilenames).toEqual(["Breaking.Bad.S02E01.ass"]);
  });

  it("throws when the candidate was not in the pre-warmed snapshot (no stale ids)", async () => {
    const { sandbox } = await createSubtitleSandbox();
    const provider = makeAssrtProvider([{ id: 1, title: "x", lang: "" }], {});
    await sandbox.primeSubtitleSnapshot("k", provider);

    await expect(sandbox.transferSubtitle({ candidateId: 999 })).rejects.toThrow(
      /not in.*subtitle.*snapshot|未.*预热/i,
    );
  });

  it("returns failed when the filelist is empty (detail miss)", async () => {
    const { sandbox } = await createSubtitleSandbox();
    const provider = makeAssrtProvider([{ id: 1, title: "x", lang: "" }], {}); // detail(1) -> []
    await sandbox.primeSubtitleSnapshot("k", provider);

    const result = await sandbox.transferSubtitle({ candidateId: 1 });
    expect(result.status).toBe("failed");
    expect(result.landedFilenames).toEqual([]);
  });

  it("partial success: lands the files that succeed, reports succeeded, surfaces the failure error", async () => {
    const provider = new FakeResourceProviderV2({ results: { title: [] } });
    const storage = new Storage115Simulator({ packs: {} });
    const stagingDirectoryId = await storage.createDirectory({ name: "staging", parentId: "root" });
    const targetSeasonDirectoryId = await storage.createDirectory({ name: "Season 1", parentId: "root" });
    const sandbox = new TaskSandbox({
      provider,
      storage,
      stagingDirectoryId,
      targetSeasonDirectoryIds: { 1: targetSeasonDirectoryId },
      need: ["S01E01"],
    });
    // Override the sim's subtitle landing: 1st file succeeds, 2nd fails.
    let call = 0;
    storage.transferSubtitleUrl = async (
      input: { url: string; filename: string; intoDirectoryId: string; workflowRunId: string },
    ): Promise<TransferAttemptResult> => {
      call += 1;
      if (call === 1) return { status: "succeeded", materializedFileIds: ["f1"] };
      return { status: "failed", materializedFileIds: [], providerMessage: "dead link" };
    };
    const files = [
      { filename: "Show.S01E01.ass", url: "http://file0.assrt.net/onthefly/1/-/1/a.ass?api=1" },
      { filename: "Show.S01E02.ass", url: "http://file0.assrt.net/onthefly/1/-/2/b.ass?api=1" },
    ];
    const assrtProvider = makeAssrtProvider([{ id: 500, title: "Show", lang: "简体" }], { 500: files });
    await sandbox.primeSubtitleSnapshot("Show", assrtProvider);

    const result = await sandbox.transferSubtitle({ candidateId: 500 });

    expect(result.status).toBe("succeeded"); // at least one landed
    expect(result.landedFilenames).toEqual(["Show.S01E01.ass"]); // only the one that landed
    expect(result.error).toBe("dead link"); // the failure's message surfaced
  });
});

describe("renameSubtitle", () => {
  it("renames a landed subtitle file in staging to a new name", async () => {
    const { sandbox } = await createSubtitleSandbox();
    const file = { filename: "Breaking.Bad.S02E01.SOMEGROUP.ass", url: "http://file0.assrt.net/onthefly/1/a.ass?api=1" };
    const provider = makeAssrtProvider([{ id: 500, title: "BB", lang: "英 简 双语" }], { 500: [file] });
    await sandbox.primeSubtitleSnapshot("BB", provider);
    const res = await sandbox.transferSubtitle({ candidateId: 500 });
    expect(res.status).toBe("succeeded");

    // Find the landed file's id via inspectStaging, then rename it.
    const staging = await sandbox.inspectStaging();
    const landed = staging.find((f) => f.path.endsWith("Breaking.Bad.S02E01.SOMEGROUP.ass"));
    expect(landed).toBeDefined();

    const out = await sandbox.renameSubtitle({ fileId: landed!.id, newName: "The.Video.S02E01.ass" });
    expect(out.renamed).toBe("The.Video.S02E01.ass");

    const after = await sandbox.inspectStaging();
    expect(after.some((f) => f.path.endsWith("The.Video.S02E01.ass"))).toBe(true);
    expect(after.some((f) => f.path.endsWith("Breaking.Bad.S02E01.SOMEGROUP.ass"))).toBe(false);
  });

  it("throws when the fileId is not in staging (scope guard)", async () => {
    const { sandbox } = await createSubtitleSandbox();
    await expect(sandbox.renameSubtitle({ fileId: "not-in-staging", newName: "x.ass" }))
      .rejects.toThrow(/not in.*staging|SANDBOX_FILE_NOT_IN_STAGING|未.*staging/i);
  });

  it("rejects a newName with path separators (rename is not a move)", async () => {
    const { sandbox } = await createSubtitleSandbox();
    const file = { filename: "Show.S01E01.ass", url: "http://file0.assrt.net/onthefly/1/a.ass?api=1" };
    const provider = makeAssrtProvider([{ id: 7, title: "Show", lang: "简体" }], { 7: [file] });
    await sandbox.primeSubtitleSnapshot("Show", provider);
    await sandbox.transferSubtitle({ candidateId: 7 });
    const landed = (await sandbox.inspectStaging()).find((f) => f.path.endsWith("Show.S01E01.ass"));

    await expect(sandbox.renameSubtitle({ fileId: landed!.id, newName: "sub/Show.S01E01.ass" }))
      .rejects.toThrow(/SANDBOX_INVALID_SUBTITLE_NAME|path separator/i);
  });

  it("rejects a newName that is not a subtitle extension (can't disguise a subtitle as a video)", async () => {
    const { sandbox } = await createSubtitleSandbox();
    const file = { filename: "Show.S01E01.ass", url: "http://file0.assrt.net/onthefly/1/a.ass?api=1" };
    const provider = makeAssrtProvider([{ id: 8, title: "Show", lang: "简体" }], { 8: [file] });
    await sandbox.primeSubtitleSnapshot("Show", provider);
    await sandbox.transferSubtitle({ candidateId: 8 });
    const landed = (await sandbox.inspectStaging()).find((f) => f.path.endsWith("Show.S01E01.ass"));

    await expect(sandbox.renameSubtitle({ fileId: landed!.id, newName: "Show.S01E01.mkv" }))
      .rejects.toThrow(/SANDBOX_INVALID_SUBTITLE_NAME|subtitle extension/i);
  });

  it("rejects renaming a non-subtitle file (only subtitles may be renamed)", async () => {
    const provider = new FakeResourceProviderV2({
      results: { title: [{ id: "vid", title: "Show S01E01" }] },
    });
    const storage = new Storage115Simulator({
      packs: { vid: { files: [{ path: "Show.S01E01.mkv", sizeBytes: 900_000_000 }] } },
      linkKinds: { vid: "pan115" },
    });
    const stagingDirectoryId = await storage.createDirectory({ name: "staging", parentId: "root" });
    const targetSeasonDirectoryId = await storage.createDirectory({ name: "Season 1", parentId: "root" });
    const sandbox = new TaskSandbox({
      provider,
      storage,
      stagingDirectoryId,
      targetSeasonDirectoryIds: { 1: targetSeasonDirectoryId },
      need: ["S01E01"],
    });
    const snap = await sandbox.searchResources("title");
    await sandbox.transferCandidate({ snapshotId: snap.snapshot!.id, candidateId: "vid" });
    const video = (await sandbox.inspectStaging()).find((f) => f.path.endsWith("Show.S01E01.mkv"));
    expect(video).toBeDefined();

    await expect(sandbox.renameSubtitle({ fileId: video!.id, newName: "Show.S01E01.ass" }))
      .rejects.toThrow(/SANDBOX_NOT_A_SUBTITLE|not a subtitle/i);
  });
});

describe("buildSandboxToolSet renameSubtitle registration", () => {
  it("registers renameSubtitle only when options.subtitle is true", () => {
    const provider = new FakeResourceProviderV2({ results: { title: [] } });
    const storage = new Storage115Simulator({ packs: {} });
    const sandbox = new TaskSandbox({ provider, storage, stagingDirectoryId: "s", need: ["S01E01"] });
    expect("renameSubtitle" in buildSandboxToolSet(sandbox)).toBe(false);
    expect("renameSubtitle" in buildSandboxToolSet(sandbox, { subtitle: true })).toBe(true);
  });
});

describe("buildSandboxToolSet subtitle tool registration", () => {
  it("does NOT include viewSubtitleSnapshot/transferSubtitle by default", () => {
    const provider = new FakeResourceProviderV2({ results: { title: [] } });
    const storage = new Storage115Simulator({ packs: {} });
    const sandbox = new TaskSandbox({
      provider,
      storage,
      stagingDirectoryId: "s",
      need: ["S01E01"],
    });
    const tools = buildSandboxToolSet(sandbox);
    expect("viewSubtitleSnapshot" in tools).toBe(false);
    expect("transferSubtitle" in tools).toBe(false);
  });

  it("includes viewSubtitleSnapshot/transferSubtitle when options.subtitle is true", () => {
    const provider = new FakeResourceProviderV2({ results: { title: [] } });
    const storage = new Storage115Simulator({ packs: {} });
    const sandbox = new TaskSandbox({
      provider,
      storage,
      stagingDirectoryId: "s",
      need: ["S01E01"],
    });
    const tools = buildSandboxToolSet(sandbox, { subtitle: true });
    expect("viewSubtitleSnapshot" in tools).toBe(true);
    expect("transferSubtitle" in tools).toBe(true);
  });
});

describe("subtitle snapshot evidence + failure bounding", () => {
  it("viewSubtitleSnapshot renders vote score + release site so the agent can pick the community favorite", async () => {
    const { sandbox } = await createSubtitleSandbox();
    const provider = makeAssrtProvider(
      [{ id: 2, title: "BB S02", lang: "简", voteScore: 50, releaseSite: "YYeTs", uploadTime: "2023-05-01 12:00:00" }],
      {},
    );
    await sandbox.primeSubtitleSnapshot("BB", provider);
    const snap = sandbox.viewSubtitleSnapshot();
    expect(snap.document).toContain("★50");
    expect(snap.document).toContain("YYeTs");
  });

  it("aborts after 3 consecutive landing failures instead of hammering the whole filelist (115 budget guard)", async () => {
    const provider = new FakeResourceProviderV2({ results: { title: [] } });
    class AlwaysFailingStorage extends Storage115Simulator {
      calls = 0;
      override async transferSubtitleUrl(): Promise<TransferAttemptResult> {
        this.calls += 1;
        return { status: "failed", materializedFileIds: [], providerMessage: "dead link" };
      }
    }
    const storage = new AlwaysFailingStorage({ packs: {} });
    const stagingDirectoryId = await storage.createDirectory({ name: "staging", parentId: "root" });
    const sandbox = new TaskSandbox({ provider, storage, stagingDirectoryId, targetSeasonDirectoryIds: {}, need: [] });
    const files = Array.from({ length: 10 }, (_, i) => ({ filename: `E${i}.ass`, url: `http://x/${i}.ass` }));
    const assrt = makeAssrtProvider([{ id: 7, title: "t", lang: "" }], { 7: files });
    await sandbox.primeSubtitleSnapshot("t", assrt);

    const result = await sandbox.transferSubtitle({ candidateId: 7 });

    expect(result.status).toBe("failed");
    expect(storage.calls).toBe(3);
    expect(result.error).toMatch(/连续|consecutive/i);
  });

  it("a success in between resets the consecutive-failure counter", async () => {
    const provider = new FakeResourceProviderV2({ results: { title: [] } });
    class FlakyStorage extends Storage115Simulator {
      calls = 0;
      override async transferSubtitleUrl(input: { url: string; filename: string; intoDirectoryId: string; workflowRunId: string }): Promise<TransferAttemptResult> {
        this.calls += 1;
        // fail, fail, succeed, fail, fail, succeed, ... — never 3 in a row
        if (this.calls % 3 === 0) return super.transferSubtitleUrl(input);
        return { status: "failed", materializedFileIds: [], providerMessage: "flaky" };
      }
    }
    const storage = new FlakyStorage({ packs: {} });
    const stagingDirectoryId = await storage.createDirectory({ name: "staging", parentId: "root" });
    const sandbox = new TaskSandbox({ provider, storage, stagingDirectoryId, targetSeasonDirectoryIds: {}, need: [] });
    const files = Array.from({ length: 6 }, (_, i) => ({ filename: `E${i}.ass`, url: `http://x/${i}.ass` }));
    const assrt = makeAssrtProvider([{ id: 8, title: "t", lang: "" }], { 8: files });
    await sandbox.primeSubtitleSnapshot("t", assrt);

    const result = await sandbox.transferSubtitle({ candidateId: 8 });

    expect(result.status).toBe("succeeded");
    expect(storage.calls).toBe(6); // all 6 attempted — counter reset by the successes
    expect(result.landedFilenames).toEqual(["E2.ass", "E5.ass"]);
  });
});
