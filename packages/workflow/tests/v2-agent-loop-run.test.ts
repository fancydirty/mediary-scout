import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { runAcquisitionAgent } from "../src/acquisition-v2/agent-loop.js";
import { AgentContentFilterError } from "../src/agent-error.js";
import { isTransientAcquisitionError } from "../src/acquisition-v2/transient-error.js";
import { TaskSandbox } from "../src/acquisition-v2/sandbox.js";
import { FakeResourceProviderV2 } from "../src/acquisition-v2/fake-provider.js";
import { Storage115Simulator } from "../src/acquisition-v2/storage-115-simulator.js";

const USAGE = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
} as const;

/** A model scripted by a queue of step outputs: each is either a tool call or
 *  final text. The AI SDK feeds tool results back between steps automatically. */
function scriptedModel(steps: Array<{ tool: string; input: unknown } | { text: string }>) {
  let i = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => {
      const step = steps[i++]!;
      if ("text" in step) {
        return { content: [{ type: "text" as const, text: step.text }], finishReason: { unified: "stop" as const, raw: "stop" as const }, usage: USAGE, warnings: [] };
      }
      return {
        content: [{ type: "tool-call" as const, toolCallId: `c${i}`, toolName: step.tool, input: JSON.stringify(step.input) }],
        finishReason: { unified: "tool-calls" as const, raw: "tool-calls" as const },
        usage: USAGE,
        warnings: [],
      };
    },
  });
}

async function setup(need: string[]) {
  const provider = new FakeResourceProviderV2({
    results: { "lycoris recoil": [{ id: "full_pack", title: "Lycoris Recoil S01 全集" }] },
  });
  const storage = new Storage115Simulator({
    packs: { full_pack: { files: [{ path: "[Grp] LR/LR - 01.mkv", sizeBytes: 100 }] } },
  });
  const stagingDirectoryId = await storage.createDirectory({ name: "staging", parentId: "root" });
  const targetSeasonDirectoryId = await storage.createDirectory({ name: "Season 1", parentId: "root" });
  const sandbox = new TaskSandbox({ provider, storage, stagingDirectoryId, targetSeasonDirectoryIds: { 1: targetSeasonDirectoryId }, need });
  return { sandbox, storage, targetSeasonDirectoryId };
}

describe("runAcquisitionAgent — the real AI SDK tool-loop over the sandbox", () => {
  it("resumes once after a content-filter interruption and lets a landed movie finish", async () => {
    const storage = new Storage115Simulator({
      packs: { movie: { files: [{ path: "Wrapper/movie.mkv", sizeBytes: 100 }] } },
    });
    const movieDirectoryId = await storage.createDirectory({ name: "Movie (2026)", parentId: "root" });
    const sandbox = new TaskSandbox({
      provider: new FakeResourceProviderV2({ results: {} }),
      storage,
      stagingDirectoryId: movieDirectoryId,
      targetMovieDirectoryId: movieDirectoryId,
      need: ["MOVIE"],
    });
    await storage.transferCandidate({ candidateId: "movie", intoDirectoryId: movieDirectoryId });

    let calls = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            content: [{ type: "tool-call" as const, toolCallId: "inspect-before-filter", toolName: "inspectStaging", input: "{}" }],
            finishReason: { unified: "tool-calls" as const, raw: "tool-calls" as const },
            usage: USAGE,
            warnings: [],
          };
        }
        if (calls === 2) {
          return {
            content: [{ type: "text" as const, text: "" }],
            finishReason: { unified: "content-filter" as const, raw: "content-filter" as const },
            usage: USAGE,
            warnings: [],
          };
        }
        const steps = [
          { tool: "flattenMovie", input: {} },
          { tool: "markObtained", input: { codes: ["MOVIE"] } },
          { tool: "finish", input: {} },
        ] as const;
        const step = steps[calls - 3];
        if (step) {
          return {
            content: [{ type: "tool-call" as const, toolCallId: `recovery-${calls}`, toolName: step.tool, input: JSON.stringify(step.input) }],
            finishReason: { unified: "tool-calls" as const, raw: "tool-calls" as const },
            usage: USAGE,
            warnings: [],
          };
        }
        return { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" as const }, usage: USAGE, warnings: [] };
      },
    });

    const result = await runAcquisitionAgent({
      sandbox,
      model,
      system: "You acquire media into the scoped sandbox.",
      prompt: "Ensure MOVIE is obtained.",
      movie: true,
      maxSteps: 10,
    });

    expect(result.coverage.coverageMet).toBe(true);
    expect((await storage.listTree({ directoryId: movieDirectoryId })).map((file) => file.path)).toEqual(["movie.mkv"]);
    expect(calls).toBe(5);
  });

  it("keeps subtitle rename available during movie recovery before flatten and finish", async () => {
    const storage = new Storage115Simulator({
      packs: {
        movie: {
          files: [{ path: "Wrapper/movie.mkv", sizeBytes: 100 }],
        },
      },
    });
    const movieDirectoryId = await storage.createDirectory({ name: "Movie (2026)", parentId: "root" });
    await storage.transferCandidate({ candidateId: "movie", intoDirectoryId: movieDirectoryId });
    await storage.transferSubtitleUrls({
      files: [{ url: "https://subtitle.test/landed.ass", filename: "landed.ass" }],
      intoDirectoryId: movieDirectoryId,
    });
    const subtitle = (await storage.listTree({ directoryId: movieDirectoryId })).find((file) => file.isSubtitle)!;
    const sandbox = new TaskSandbox({
      provider: new FakeResourceProviderV2({ results: {} }),
      storage,
      stagingDirectoryId: movieDirectoryId,
      targetMovieDirectoryId: movieDirectoryId,
      need: ["MOVIE"],
    });

    let calls = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            content: [{ type: "tool-call" as const, toolCallId: "inspect-before-filter", toolName: "inspectStaging", input: "{}" }],
            finishReason: { unified: "tool-calls" as const, raw: "tool-calls" as const },
            usage: USAGE,
            warnings: [],
          };
        }
        if (calls === 2) {
          return {
            content: [{ type: "text" as const, text: "" }],
            finishReason: { unified: "content-filter" as const, raw: "content-filter" as const },
            usage: USAGE,
            warnings: [],
          };
        }
        const steps = [
          { tool: "readSkill", input: { section: "movie" } },
          { tool: "inspectStaging", input: {} },
          { tool: "renameSubtitle", input: { renames: [{ fileId: subtitle.id, newName: "movie.ass" }] } },
          { tool: "flattenMovie", input: {} },
          { tool: "markObtained", input: { codes: ["MOVIE"] } },
          { tool: "finish", input: {} },
        ] as const;
        const step = steps[calls - 3];
        if (step) {
          return {
            content: [{ type: "tool-call" as const, toolCallId: `recovery-subtitle-${calls}`, toolName: step.tool, input: JSON.stringify(step.input) }],
            finishReason: { unified: "tool-calls" as const, raw: "tool-calls" as const },
            usage: USAGE,
            warnings: [],
          };
        }
        return { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" as const }, usage: USAGE, warnings: [] };
      },
    });

    const result = await runAcquisitionAgent({
      sandbox,
      model,
      system: "You acquire media into the scoped sandbox.",
      prompt: "Ensure MOVIE is obtained.",
      movie: true,
      subtitle: true,
      maxSteps: 20,
    });

    expect(result.coverage.coverageMet).toBe(true);
    expect((await storage.listTree({ directoryId: movieDirectoryId })).map((file) => file.path).sort()).toEqual(["movie.ass", "movie.mkv"]);
  });

  it("recovers a TV run by moving the episode and discarding staging before finish", async () => {
    const storage = new Storage115Simulator({
      packs: { episode: { files: [{ path: "Wrapper/Show - 01.mkv", sizeBytes: 100 }] } },
    });
    const stagingDirectoryId = await storage.createDirectory({ name: "staging", parentId: "root" });
    const seasonDirectoryId = await storage.createDirectory({ name: "Season 1", parentId: "root" });
    await storage.transferCandidate({ candidateId: "episode", intoDirectoryId: stagingDirectoryId });
    const stagingFileId = (await storage.listTree({ directoryId: stagingDirectoryId }))[0]!.id;
    const sandbox = new TaskSandbox({
      provider: new FakeResourceProviderV2({ results: {} }),
      storage,
      stagingDirectoryId,
      targetSeasonDirectoryIds: { 1: seasonDirectoryId },
      need: ["S01E01"],
    });

    let calls = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            content: [{ type: "tool-call" as const, toolCallId: "inspect-before-filter", toolName: "inspectStaging", input: "{}" }],
            finishReason: { unified: "tool-calls" as const, raw: "tool-calls" as const },
            usage: USAGE,
            warnings: [],
          };
        }
        if (calls === 2) {
          return {
            content: [{ type: "text" as const, text: "" }],
            finishReason: { unified: "content-filter" as const, raw: "content-filter" as const },
            usage: USAGE,
            warnings: [],
          };
        }
        const steps = [
          { tool: "readSkill", input: { section: "tv" } },
          { tool: "inspectStaging", input: {} },
          { tool: "moveToSeason", input: { moves: [{ season: 1, fileIds: [stagingFileId] }] } },
          { tool: "markObtained", input: { codes: ["S01E01"] } },
          { tool: "discardStaging", input: {} },
          { tool: "finish", input: {} },
        ] as const;
        const step = steps[calls - 3];
        if (step) {
          return {
            content: [{ type: "tool-call" as const, toolCallId: `recovery-tv-${calls}`, toolName: step.tool, input: JSON.stringify(step.input) }],
            finishReason: { unified: "tool-calls" as const, raw: "tool-calls" as const },
            usage: USAGE,
            warnings: [],
          };
        }
        return { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" as const }, usage: USAGE, warnings: [] };
      },
    });

    const result = await runAcquisitionAgent({
      sandbox,
      model,
      system: "You acquire media into the scoped sandbox.",
      prompt: "Acquire S01E01.",
      maxSteps: 20,
    });

    expect(result.coverage.coverageMet).toBe(true);
    expect((await storage.listTree({ directoryId: seasonDirectoryId })).map((file) => file.path)).toEqual(["Show - 01.mkv"]);
    await expect(storage.listTree({ directoryId: stagingDirectoryId })).rejects.toThrow("SIM_DIR_NOT_FOUND");
  });

  it("does not start recovery when the first turn consumed the whole step budget", async () => {
    const { sandbox, storage } = await setup(["S01E01"]);
    // Something already landed in staging → the finish-only recovery path applies.
    await storage.transferCandidate({ candidateId: "full_pack", intoDirectoryId: (sandbox as any).stagingDirectoryId });
    let calls = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        calls += 1;
        return {
          content: [{ type: "text" as const, text: "" }],
          finishReason: { unified: "content-filter" as const, raw: "content-filter" as const },
          usage: USAGE,
          warnings: [],
        };
      },
    });

    const result = await runAcquisitionAgent({
      sandbox,
      model,
      system: "You acquire media into the scoped sandbox.",
      prompt: "Ensure S01E01 is obtained.",
      maxSteps: 1,
    });

    expect(result.coverage.coverageMet).toBe(false);
    expect(calls).toBe(1);
  });

  it("does not retry a second content-filter interruption", async () => {
    const { sandbox, storage } = await setup(["S01E01"]);
    await storage.transferCandidate({ candidateId: "full_pack", intoDirectoryId: (sandbox as any).stagingDirectoryId });
    let calls = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        calls += 1;
        return {
          content: [{ type: "text" as const, text: "" }],
          finishReason: { unified: "content-filter" as const, raw: "content-filter" as const },
          usage: USAGE,
          warnings: [],
        };
      },
    });

    const result = await runAcquisitionAgent({
      sandbox,
      model,
      system: "You acquire media into the scoped sandbox.",
      prompt: "Ensure S01E01 is obtained.",
      maxSteps: 4,
    });

    expect(result.coverage.coverageMet).toBe(false);
    expect(calls).toBe(2);
    expect(result.steps).toBe(2);
  });

  it("a content-filter stop before anything was transferred fails loud as a model interruption, not no-coverage (《出入平安》)", async () => {
    const { sandbox } = await setup(["S01E01"]);
    let calls = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            content: [{ type: "tool-call" as const, toolCallId: "look", toolName: "inspectStaging", input: "{}" }],
            finishReason: { unified: "tool-calls" as const, raw: "tool-calls" as const },
            usage: USAGE,
            warnings: [],
          };
        }
        return {
          content: [{ type: "text" as const, text: "" }],
          finishReason: { unified: "content-filter" as const, raw: "content-filter" as const },
          usage: USAGE,
          warnings: [],
        };
      },
    });
    const run = runAcquisitionAgent({
      sandbox,
      model,
      system: "You acquire media into the scoped sandbox.",
      prompt: "Ensure S01E01 is obtained.",
      maxSteps: 10,
    });
    await expect(run).rejects.toBeInstanceOf(AgentContentFilterError);
    await expect(run).rejects.toThrow(/内容审查/);
    // No finish-only recovery turn was spent: the model was called exactly twice.
    expect(calls).toBe(2);
    // Not a network blip: the queue must not auto-retry the same censoring model.
    const err = await run.catch((e: unknown) => e);
    expect(isTransientAcquisitionError(err)).toBe(false);
  });

  it("a transfer attempt counts as evidence even if staging is empty afterwards → recovery still runs", async () => {
    const { sandbox, storage } = await setup(["S01E01"]);
    const snap = await sandbox.searchResources("lycoris recoil");
    let calls = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            // A harmless observation step before the interruption (the test is about the
            // transfer evidence, not about what this first step does).
            content: [{ type: "tool-call" as const, toolCallId: "t", toolName: "inspectStaging", input: "{}" }],
            finishReason: { unified: "tool-calls" as const, raw: "tool-calls" as const },
            usage: USAGE,
            warnings: [],
          };
        }
        if (calls === 2) {
          return {
            content: [{ type: "text" as const, text: "" }],
            finishReason: { unified: "content-filter" as const, raw: "content-filter" as const },
            usage: USAGE,
            warnings: [],
          };
        }
        return { content: [{ type: "text" as const, text: "done" }], finishReason: { unified: "stop" as const, raw: "stop" as const }, usage: USAGE, warnings: [] };
      },
    });
    await sandbox.transferCandidate({ snapshotId: snap.snapshot!.id, candidateId: snap.snapshot!.candidates[0]!.id });
    // Empty staging again: the ONLY remaining evidence is that a transfer was attempted.
    const staging = (sandbox as any).stagingDirectoryId as string;
    await storage.deleteFiles({ directoryId: staging, fileIds: (await storage.listTree({ directoryId: staging })).map((f) => f.id) });
    expect(await storage.listTree({ directoryId: staging })).toEqual([]);
    const result = await runAcquisitionAgent({
      sandbox,
      model,
      system: "s",
      prompt: "Ensure S01E01 is obtained.",
      maxSteps: 10,
    });
    expect(calls).toBe(3); // recovery turn ran
    expect(result.coverage.coverageMet).toBe(false);
  });

  it("drives a full search→transfer→extract→mark→finish loop and reads honest coverage", async () => {
    const { sandbox, storage, targetSeasonDirectoryId } = await setup(["S01E01"]);

    // A statically-scripted model can't read ids that the loop discovers at
    // runtime, so we pre-roll the storage into the post-extract state to learn
    // the real season file id, then let the model drive a fresh sandbox over
    // that same storage (inspect → mark → finish).
    const search = await sandbox.searchResources("lycoris recoil");
    const transfer = await sandbox.transferCandidate({ snapshotId: search.snapshot!.id, candidateId: "full_pack" });
    const stagingFileId = transfer.staging[0]!.id;
    await sandbox.moveToSeason({ moves: [{ season: 1, fileIds: [stagingFileId] }] });
    // Now a fresh sandbox over the SAME storage state, driven purely by the model.
    const liveSandbox = new TaskSandbox({
      provider: new FakeResourceProviderV2({ results: {} }),
      storage,
      stagingDirectoryId: (await storage.listSubdirectories({ directoryId: "root" })).find((d) => d.path === "staging")!.id,
      targetSeasonDirectoryIds: { 1: targetSeasonDirectoryId },
      need: ["S01E01"],
    });

    const model = scriptedModel([
      { tool: "inspectTargetDir", input: {} },
      { tool: "markObtained", input: { codes: ["S01E01"] } },
      { tool: "finish", input: {} },
      { text: "Covered S01E01 from the existing season file." },
    ]);

    const result = await runAcquisitionAgent({
      sandbox: liveSandbox,
      model,
      system: "You acquire media into the scoped sandbox.",
      prompt: "Ensure S01E01 is obtained.",
      maxSteps: 10,
    });

    expect(result.coverage.coverageMet).toBe(true);
    expect(result.coverage.obtained).toEqual(["S01E01"]);
    // finish is TERMINAL (mechanical stop): the loop ends AT the finish step, so
    // the scripted closing free-text turn ("Covered") is never reached — coverage
    // comes from the sandbox, not the model's prose. (复联4 live: finish ×3 tail.)
    expect(result.text).toBe("");
    expect(result.steps).toBeGreaterThanOrEqual(3);
  });

  it("stops the loop early on a systemic transfer block (account quota) instead of grinding every candidate", async () => {
    // The provider has many real 115 shares for the film, but the account's 云下载
    // quota is exhausted: EVERY transfer fails with the same systemic message. The
    // 心灵奇旅 incident ground through 13 of these. The loop must stop after the first.
    const provider = new FakeResourceProviderV2({
      results: {
        soul: Array.from({ length: 8 }, (_, i) => ({ id: `cand_${i}`, title: `心灵奇旅 ${i}` })),
      },
    });
    const failureMessages: Record<string, string> = {};
    for (let i = 0; i < 8; i++) failureMessages[`cand_${i}`] = "云下载配额不足，请升级VIP获得赠送配额或购买云下载配额！";
    const storage = new Storage115Simulator({ failureMessages });
    const stagingDirectoryId = await storage.createDirectory({ name: "staging", parentId: "root" });
    const targetSeasonDirectoryId = await storage.createDirectory({ name: "Season 1", parentId: "root" });
    const sandbox = new TaskSandbox({ provider, storage, stagingDirectoryId, targetSeasonDirectoryIds: { 1: targetSeasonDirectoryId }, need: ["S01E01"] });
    const search = await sandbox.searchResources("soul");
    const snapshotId = search.snapshot!.id;

    // A relentless agent that would otherwise transfer all 8 candidates one by one.
    const model = scriptedModel(
      Array.from({ length: 8 }, (_, i) => ({ tool: "transferCandidate", input: { snapshotId, candidateId: `cand_${i}` } })),
    );

    const result = await runAcquisitionAgent({
      sandbox,
      model,
      system: "You acquire media into the scoped sandbox.",
      prompt: "Ensure S01E01 is obtained.",
      maxSteps: 20,
    });

    // The systemic-block stop fired after the FIRST failed transfer — not all 8.
    expect(result.steps).toBeLessThanOrEqual(2);
    expect(result.coverage.coverageMet).toBe(false);
  });

  it("the cage still bites inside the loop: a refused tool call comes back as error evidence, not a crash", async () => {
    const { sandbox } = await setup(["S01E01"]);
    const model = scriptedModel([
      // A transfer bound to a snapshot never observed in THIS task is refused by
      // the cage; the refusal returns as {error} evidence, the loop does not crash.
      { tool: "transferCandidate", input: { snapshotId: "snap_never_seen", candidateId: "x" } },
      { text: "That candidate was not from a snapshot I searched; stopping." },
    ]);

    const result = await runAcquisitionAgent({
      sandbox,
      model,
      system: "You acquire media into the scoped sandbox.",
      prompt: "Ensure S01E01 is obtained.",
      maxSteps: 10,
    });

    // The loop completed (no throw); coverage honestly unmet.
    expect(result.coverage.coverageMet).toBe(false);
    expect(result.coverage.missing).toEqual(["S01E01"]);
  });

  it("病1: 成功 reportNoCoverage 后循环立即收束 — 不再有后续步（攻壳 2.5min 尾巴重放）", async () => {
    const { sandbox } = await setup(["S01E01"]);
    // 先真搜一次，让 §9 证据护栏放行 no-coverage 上报。
    await sandbox.searchResources("lycoris recoil");
    // 攻壳式脚本：报告无覆盖后，模型还想 readSkill、二次上报、finish——都不应该发生。
    const model = scriptedModel([
      { tool: "reportNoCoverage", input: { reason: "提供方无该作品资源" } },
      { tool: "readSkill", input: { section: "无覆盖上报" } },
      { tool: "reportNoCoverage", input: { reason: "再次确认无资源" } },
      { tool: "finish", input: {} },
      { text: "done" },
    ]);
    const result = await runAcquisitionAgent({
      sandbox,
      model,
      system: "You acquire media into the scoped sandbox.",
      prompt: "Ensure S01E01 is obtained.",
      maxSteps: 20,
    });
    // 报告成功的那一步就是最后一步。
    expect(result.steps).toBe(1);
    expect(result.coverage.coverageMet).toBe(false);
  });

  it("病1: 无搜索证据的 reportNoCoverage 被拒（{error}）→ 循环继续", async () => {
    const { sandbox } = await setup(["S01E01"]);
    // 不预搜——§9 护栏会 throw，asEvidence 转成 {error} 返回。
    const model = scriptedModel([
      { tool: "reportNoCoverage", input: { reason: "premature" } },
      { text: "guard refused my report; stopping." },
    ]);
    const result = await runAcquisitionAgent({
      sandbox,
      model,
      system: "You acquire media into the scoped sandbox.",
      prompt: "Ensure S01E01 is obtained.",
      maxSteps: 10,
    });
    // 第 1 步被拒后模型还能走到第 2 步输出文本（循环没被 stop 砍断）。
    expect(result.steps).toBe(2);
    expect(result.text).toMatch(/stopping/);
  });
});
