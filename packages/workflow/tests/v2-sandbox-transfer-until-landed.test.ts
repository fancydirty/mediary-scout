import { describe, expect, it } from "vitest";
import { TaskSandbox } from "../src/acquisition-v2/sandbox.js";
import { FakeResourceProviderV2 } from "../src/acquisition-v2/fake-provider.js";
import { Storage115Simulator } from "../src/acquisition-v2/storage-115-simulator.js";

/**
 * The movie-only `transferUntilLanded` tool (2026-06-15, user-designed):
 * iterate an AGENT-ORDERED list of candidates the agent judged to be the SAME
 * target film (best → next-best), stopping at the FIRST that 秒传-lands; the rest
 * are abandoned. 115 share links ONLY — only a 115 share fails LOUD, so the
 * iterate-on-failure logic is sound; a magnet's success is only knowable by the
 * landing point, so magnets are rejected (the agent uses transferCandidate +
 * observe for those). Candidate SELECTION stays the agent's (the wildcard search
 * returns unrelated works — 葫芦小金刚 under "抓娃娃" — so the system must never
 * iterate the raw result set). TV/anime never gets this tool.
 */
async function movieSetup(options: {
  results: Array<{ id: string; title: string }>;
  packs?: Record<string, { files: Array<{ path: string; sizeBytes: number }> }>;
  linkKinds?: Record<string, "pan115" | "magnet">;
  failureMessages?: Record<string, string>;
}) {
  const provider = new FakeResourceProviderV2({
    results: { oppenheimer: options.results.map((r) => ({ ...r })) },
  });
  const storage = new Storage115Simulator({
    ...(options.packs ? { packs: options.packs } : {}),
    ...(options.linkKinds ? { linkKinds: options.linkKinds } : {}),
    ...(options.failureMessages ? { failureMessages: options.failureMessages } : {}),
  });
  const movieDir = await storage.createDirectory({ name: "奥本海默 (2023)", parentId: "root" });
  const sandbox = new TaskSandbox({
    provider,
    storage,
    stagingDirectoryId: movieDir,
    targetMovieDirectoryId: movieDir,
    need: ["MOVIE"],
  });
  return { sandbox, storage, movieDir };
}

describe("TaskSandbox — transferUntilLanded (movie-only, 115-only, agent-ordered, stop-at-first-landed)", () => {
  it("burns through dead 115 shares in the given order and stops at the first that lands", async () => {
    const { sandbox } = await movieSetup({
      results: [
        { id: "dead_1", title: "奥本海默 黑盒A" },
        { id: "dead_2", title: "奥本海默 黑盒B" },
        { id: "live", title: "奥本海默 黑盒C" },
        { id: "after", title: "奥本海默 黑盒D" },
      ],
      packs: {
        live: { files: [{ path: "奥本海默 (2023)/Oppenheimer.2023.2160p.mkv", sizeBytes: 9000 }] },
        after: { files: [{ path: "wrong/After.mkv", sizeBytes: 1 }] },
      },
      linkKinds: { dead_1: "pan115", dead_2: "pan115", live: "pan115", after: "pan115" },
    });
    await sandbox.searchResources("oppenheimer");

    const result = await sandbox.transferUntilLanded({ candidateIds: ["dead_1", "dead_2", "live", "after"] });

    expect(result.attempts.map((a) => a.status)).toEqual(["failed", "failed", "succeeded"]); // never reached "after"
    expect(result.transferredCandidateId).toBe("live");
    expect(result.landed.some((f) => f.isVideo)).toBe(true);
  });

  it("rejects a magnet candidate — only 115 shares fail loud, so only they may be iterated", async () => {
    const { sandbox } = await movieSetup({
      results: [{ id: "mag", title: "奥本海默 magnet" }],
      packs: { mag: { files: [{ path: "x.mkv", sizeBytes: 1 }] } },
      linkKinds: { mag: "magnet" },
    });
    await sandbox.searchResources("oppenheimer");
    await expect(sandbox.transferUntilLanded({ candidateIds: ["mag"] })).rejects.toThrow(/115|pan115/i);
  });

  it("refuses once coverage is already met", async () => {
    const { sandbox } = await movieSetup({
      results: [{ id: "live", title: "奥本海默" }],
      packs: { live: { files: [{ path: "m.mkv", sizeBytes: 1 }] } },
      linkKinds: { live: "pan115" },
    });
    await sandbox.searchResources("oppenheimer");
    await sandbox.markObtained({ codes: ["MOVIE"] });
    await expect(sandbox.transferUntilLanded({ candidateIds: ["live"] })).rejects.toThrow(/coverage/i);
  });

  it("refuses a candidate never observed in this task", async () => {
    const { sandbox } = await movieSetup({
      results: [{ id: "live", title: "奥本海默" }],
      packs: { live: { files: [{ path: "m.mkv", sizeBytes: 1 }] } },
      linkKinds: { live: "pan115" },
    });
    await sandbox.searchResources("oppenheimer");
    await expect(sandbox.transferUntilLanded({ candidateIds: ["live", "ghost"] })).rejects.toThrow(/observ|snapshot/i);
  });

  it("is movie-only — a TV-scoped task refuses it", async () => {
    const provider = new FakeResourceProviderV2({
      results: { oppenheimer: [{ id: "live", title: "x" }] },
    });
    const storage = new Storage115Simulator({
      packs: { live: { files: [{ path: "m.mkv", sizeBytes: 1 }] } },
      linkKinds: { live: "pan115" },
    });
    const staging = await storage.createDirectory({ name: "staging", parentId: "root" });
    const seasonDir = await storage.createDirectory({ name: "Season 1", parentId: "root" });
    const sandbox = new TaskSandbox({
      provider,
      storage,
      stagingDirectoryId: staging,
      targetSeasonDirectoryIds: { 1: seasonDir },
      need: ["S01E01"],
    });
    await sandbox.searchResources("oppenheimer");
    await expect(sandbox.transferUntilLanded({ candidateIds: ["live"] })).rejects.toThrow(/movie/i);
  });

  it("carries each attempt's providerMessage back to the agent", async () => {
    const { sandbox } = await movieSetup({
      results: [
        { id: "dead_1", title: "奥本海默 A" },
        { id: "live", title: "奥本海默 B" },
      ],
      packs: { live: { files: [{ path: "奥本海默 (2023)/Oppenheimer.mkv", sizeBytes: 9000 }] } },
      linkKinds: { dead_1: "pan115", live: "pan115" },
      failureMessages: { dead_1: "链接已过期" },
    });
    await sandbox.searchResources("oppenheimer");
    const result = await sandbox.transferUntilLanded({ candidateIds: ["dead_1", "live"] });
    expect(result.attempts).toEqual([
      { candidateId: "dead_1", status: "failed", providerMessage: "链接已过期" },
      { candidateId: "live", status: "succeeded" },
    ]);
  });

  it("STOPS at the first systemic block — does NOT burn the rest of the ranked list", async () => {
    const { sandbox } = await movieSetup({
      results: [
        { id: "c1", title: "奥本海默 A" },
        { id: "c2", title: "奥本海默 B" },
        { id: "c3", title: "奥本海默 C" },
      ],
      // All three are real 115 shares for the film, but the account's quota is
      // exhausted — every transfer fails with the same systemic message. Grinding
      // all three is the wasted-transfer the 心灵奇旅 incident is about.
      packs: { c3: { files: [{ path: "奥本海默 (2023)/o.mkv", sizeBytes: 1 }] } },
      linkKinds: { c1: "pan115", c2: "pan115", c3: "pan115" },
      failureMessages: {
        c1: "云下载配额不足，请升级VIP获得赠送配额或购买云下载配额！",
        c2: "云下载配额不足，请升级VIP获得赠送配额或购买云下载配额！",
        c3: "云下载配额不足，请升级VIP获得赠送配额或购买云下载配额！",
      },
    });
    await sandbox.searchResources("oppenheimer");

    const result = await sandbox.transferUntilLanded({ candidateIds: ["c1", "c2", "c3"] });

    // It stopped after the FIRST attempt (one quota failure ⇒ all will fail).
    expect(result.attempts).toHaveLength(1);
    expect(result.transferredCandidateId).toBeNull();
    expect(result.systemicBlock).toEqual({ reason: "云下载配额不足，请升级VIP获得赠送配额或购买云下载配额！" });
  });

  it("when every candidate is a dead link, returns no landing (not an exception)", async () => {
    const { sandbox } = await movieSetup({
      results: [
        { id: "dead_1", title: "奥本海默 A" },
        { id: "dead_2", title: "奥本海默 B" },
      ],
      linkKinds: { dead_1: "pan115", dead_2: "pan115" },
    });
    await sandbox.searchResources("oppenheimer");
    const result = await sandbox.transferUntilLanded({ candidateIds: ["dead_1", "dead_2"] });
    expect(result.transferredCandidateId).toBeNull();
    expect(result.attempts.map((a) => a.status)).toEqual(["failed", "failed"]);
    expect(result.landed.some((f) => f.isVideo)).toBe(false);
  });
});
