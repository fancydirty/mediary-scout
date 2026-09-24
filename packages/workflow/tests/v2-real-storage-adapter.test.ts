import { describe, expect, it } from "vitest";
import { RealStorageV2 } from "../src/acquisition-v2/real-storage-adapter.js";
import { CandidateRegistry } from "../src/acquisition-v2/candidate-registry.js";
import { GuangYaAuthError } from "../src/guangya-client.js";
import { Pan115AuthError } from "../src/pan115-cookie-client.js";
import type { StorageExecutor, UnparsedVideoFile } from "../src/ports.js";
import type { PackageTreeFile, ResourceCandidate, TransferAttempt, VerifiedFile } from "../src/domain.js";

function candidate(id: string): ResourceCandidate {
  return {
    id,
    snapshotId: "snap",
    index: 0,
    title: "Show 全集",
    type: "115",
    source: "pansou",
    providerPayload: { url: "https://115.com/s/abc", receiveCode: "pw" },
  };
}

/** Minimal StorageExecutor that records calls and returns canned data. */
class RecordingExecutor implements StorageExecutor {
  transfers: Array<{ workflowRunId: string; directoryId: string; candidateId: string }> = [];
  deletes: Array<{ directoryId: string; fileIds: string[] }> = [];
  removed: string[] = [];
  subtitleSingleCalls: string[] = [];
  subtitleBatchCalls: Array<{ files: string[]; directoryId: string; workflowRunId: string }> = [];
  /** Present only when opts.subtitleBatch — TS optional METHODS can't be made
   *  per-instance, so it's a property the constructor installs (115 has it, 光鸭 doesn't). */
  transferSubtitleUrls?: (input: { files: Array<{ url: string; filename: string }>; directoryId: string; workflowRunId: string }) => Promise<TransferAttempt[]>;
  constructor(private readonly opts: { status?: TransferAttempt["status"]; message?: string; tree?: PackageTreeFile[]; removeOk?: boolean; subtitleBatch?: boolean; subtitleFail?: (filename: string) => string | null } = {}) {
    if (opts.subtitleBatch) {
      this.transferSubtitleUrls = async (input) => {
        this.subtitleBatchCalls.push({ files: input.files.map((f) => f.filename), directoryId: input.directoryId, workflowRunId: input.workflowRunId });
        return input.files.map((file, index) => {
          const failure = this.opts.subtitleFail?.(file.filename) ?? null;
          return {
            id: `${input.workflowRunId}_subtitle_${index + 1}`,
            workflowRunId: input.workflowRunId,
            candidateId: `subtitle:${file.filename}`,
            status: failure === null ? ("succeeded" as const) : ("no_target_change" as const),
            providerMessage: failure ?? "",
            materializedFileIds: failure === null ? [`sub_${file.filename}`] : [],
          };
        });
      };
    }
  }

  async createDirectory(input: { name: string; parentId: string }): Promise<string> {
    return `dir_${input.name}`;
  }
  async transfer(input: { workflowRunId: string; directoryId: string; candidate: ResourceCandidate }): Promise<TransferAttempt> {
    this.transfers.push({ workflowRunId: input.workflowRunId, directoryId: input.directoryId, candidateId: input.candidate.id });
    return {
      id: "att_1",
      workflowRunId: input.workflowRunId,
      candidateId: input.candidate.id,
      status: this.opts.status ?? "succeeded",
      providerMessage: this.opts.message ?? "",
      materializedFileIds: this.opts.status && this.opts.status !== "succeeded" ? [] : ["f1", "f2"],
    };
  }
  async listTree(): Promise<PackageTreeFile[]> {
    return this.opts.tree ?? [{ path: "Pack/Show - 01.mkv", providerFileId: "f1", sizeBytes: 9 }];
  }
  async listSubdirectories(): Promise<Array<{ id: string; path: string }>> {
    return [{ id: "wrap", path: "Pack" }];
  }
  async listChildDirectories(): Promise<Array<{ id: string; name: string }>> {
    return [{ id: "wrap", name: "Pack" }];
  }
  async moveFiles(input: { fileIds: string[]; targetDirectoryId: string }): Promise<{ moved: string[] }> {
    return { moved: input.fileIds };
  }
  async deleteFiles(input: { directoryId: string; fileIds: string[] }): Promise<{ deleted: string[] }> {
    this.deletes.push(input);
    return { deleted: input.fileIds };
  }
  async removeDirectory(directoryId: string): Promise<{ removed: boolean }> {
    if (this.opts.removeOk ?? true) this.removed.push(directoryId);
    return { removed: this.opts.removeOk ?? true };
  }
  async listVideoFiles(): Promise<VerifiedFile[]> {
    return [];
  }
  async listUnparsedVideoFiles(): Promise<UnparsedVideoFile[]> {
    return [];
  }
  async renameFile(): Promise<void> {}
  async transferSubtitleUrl(input: { url: string; filename: string; directoryId: string; workflowRunId: string }): Promise<TransferAttempt> {
    this.subtitleSingleCalls.push(input.filename);
    const failure = this.opts.subtitleFail?.(input.filename) ?? null;
    return {
      id: `${input.workflowRunId}_subtitle_${this.subtitleSingleCalls.length}`,
      workflowRunId: input.workflowRunId,
      candidateId: `subtitle:${input.filename}`,
      status: failure === null ? "succeeded" : "failed",
      providerMessage: failure ?? "",
      materializedFileIds: failure === null ? [`sub_${input.filename}`] : [],
    };
  }
  async flattenDirectory(): Promise<{ moved: string[]; removed: string[] }> {
    return { moved: [], removed: [] };
  }
}

class FakeDeadLinkStore {
  recorded: Array<{ key: string; kind: string; reason: string; permanent: boolean; ttlMs?: number }> = [];
  async recordDeadLink(input: { key: string; kind: "pan115" | "magnet"; reason: string; permanent: boolean; ttlMs?: number }): Promise<void> {
    this.recorded.push({ key: input.key, kind: input.kind, reason: input.reason, permanent: input.permanent, ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }) });
  }
  async listDeadLinkKeys(): Promise<string[]> {
    return this.recorded.map((r) => r.key);
  }
}

function adapter(executor: StorageExecutor, registry = new CandidateRegistry(), deadLinkStore?: FakeDeadLinkStore) {
  return {
    storage: new RealStorageV2({ executor, registry, workflowRunId: "run-7", ...(deadLinkStore ? { deadLinkStore } : {}) }),
    registry,
  };
}

describe("RealStorageV2 — StorageExecutor → StorageV2 adapter", () => {
  it("transfers a registry candidate via the executor with the run id and maps success", async () => {
    const executor = new RecordingExecutor();
    const { storage, registry } = adapter(executor);
    registry.record(candidate("cand"));

    const result = await storage.transferCandidate({ candidateId: "cand", intoDirectoryId: "staging" });

    expect(result.status).toBe("succeeded");
    expect(result.materializedFileIds).toEqual(["f1", "f2"]);
    expect(executor.transfers).toEqual([{ workflowRunId: "run-7", directoryId: "staging", candidateId: "cand" }]);
  });

  it("maps no_target_change to a failed attempt AND surfaces the noTargetChange flag", async () => {
    const executor = new RecordingExecutor({ status: "no_target_change" });
    const { storage, registry } = adapter(executor);
    registry.record(candidate("cand"));

    const result = await storage.transferCandidate({ candidateId: "cand", intoDirectoryId: "staging" });
    expect(result.status).toBe("failed");
    // the flag lets brand-agnostic callers (transferUntilLanded) tell a silent-late
    // async copy (123's settle window — possible FALSE miss) from a loud dead link
    expect(result.noTargetChange).toBe(true);
  });

  it("surfaces the executor's providerMessage on a failed transfer (so the agent sees WHY)", async () => {
    const executor = new RecordingExecutor({ status: "failed", message: "云下载配额不足，请升级VIP获得赠送配额或购买云下载配额！" });
    const { storage, registry } = adapter(executor);
    registry.record(candidate("cand"));

    const result = await storage.transferCandidate({ candidateId: "cand", intoDirectoryId: "staging" });
    expect(result.status).toBe("failed");
    expect(result.providerMessage).toBe("云下载配额不足，请升级VIP获得赠送配额或购买云下载配额！");
    expect(result.noTargetChange).toBeUndefined(); // a loud failure is NOT an ntc
  });

  it("fails loud when the candidate id was never observed (not in the registry)", async () => {
    const { storage } = adapter(new RecordingExecutor());
    await expect(storage.transferCandidate({ candidateId: "ghost", intoDirectoryId: "staging" })).rejects.toThrow(
      /CANDIDATE_NOT_REGISTERED/,
    );
  });

  it("maps listTree to SimTreeFile with id=providerFileId and extension-based isVideo/isSubtitle", async () => {
    const executor = new RecordingExecutor({
      tree: [
        { path: "Pack/Show - 01.mkv", providerFileId: "f1", sizeBytes: 9 },
        { path: "Pack/Show - 01.ass", providerFileId: "f2", sizeBytes: 2 },
        { path: "Pack/cover.jpg", providerFileId: "f3", sizeBytes: 1 },
      ],
    });
    const { storage } = adapter(executor);

    const tree = await storage.listTree({ directoryId: "staging" });
    expect(tree).toEqual([
      { id: "f1", path: "Pack/Show - 01.mkv", sizeBytes: 9, isVideo: true, isSubtitle: false },
      { id: "f2", path: "Pack/Show - 01.ass", sizeBytes: 2, isVideo: false, isSubtitle: true },
      { id: "f3", path: "Pack/cover.jpg", sizeBytes: 1, isVideo: false, isSubtitle: false },
    ]);
  });

  it("maps removeDirectory boolean to the removed-id list", async () => {
    const executor = new RecordingExecutor({ removeOk: true });
    const { storage } = adapter(executor);
    const result = await storage.removeDirectory({ directoryId: "wrap" });
    expect(result.removed).toEqual(["wrap"]);
    expect(executor.removed).toEqual(["wrap"]);
  });

  it("scopes deleteFiles to the named directory", async () => {
    const executor = new RecordingExecutor();
    const { storage } = adapter(executor);
    await storage.deleteFiles({ directoryId: "season", fileIds: ["f1"] });
    expect(executor.deletes).toEqual([{ directoryId: "season", fileIds: ["f1"] }]);
  });

  it("classifies candidate link kind from the recorded url (fail-loud share brand / magnet / unknown)", async () => {
    const { storage, registry } = adapter(new RecordingExecutor());
    // every 转存分享 brand (fail-loud) → "share"
    registry.record({ ...candidate("s115"), providerPayload: { url: "https://115cdn.com/s/abc?password=x" } });
    registry.record({ ...candidate("s115b"), providerPayload: { url: "https://115.com/s/def" } });
    registry.record({ ...candidate("squark"), type: "quark", providerPayload: { url: "https://pan.quark.cn/s/zzz?passcode=ab12" } });
    registry.record({ ...candidate("stianyi"), type: "tianyi", providerPayload: { url: "https://cloud.189.cn/t/QzUnmqBvYr2q?accessCode=x8fd" } });
    registry.record({ ...candidate("stianyi_web"), type: "tianyi", providerPayload: { url: "https://cloud.189.cn/web/share?code=AbCd12&pwd=1234" } });
    registry.record({ ...candidate("s123"), type: "123", providerPayload: { url: "https://www.123pan.com/s/abc-1?pwd=x8fd" } });
    registry.record({ ...candidate("s123_mirror"), type: "123", providerPayload: { url: "https://123684.com/s/Kd9-TvBq?password=1234" } });
    // 光鸭分享链 fails loud too (201 分享已失效 / GUANGYA_SHARE_EMPTY come back at once).
    registry.record({ ...candidate("sguangya"), type: "guangya", providerPayload: { url: "https://www.guangyapan.com/s/1947864096514232347_amtV6IXLP9l33m6z" } });
    // silent-fail magnet and unrecognized hosts stay out
    registry.record({ ...candidate("mag"), type: "magnet", providerPayload: { url: "magnet:?xt=urn:btih:deadbeef" } });
    registry.record({ ...candidate("weird"), providerPayload: { url: "https://pan.baidu.com/s/1abcDEF" } });

    for (const id of ["s115", "s115b", "squark", "stianyi", "stianyi_web", "s123", "s123_mirror", "sguangya"]) {
      expect(storage.candidateLinkKind(id)).toBe("share");
    }
    expect(storage.candidateLinkKind("mag")).toBe("magnet");
    expect(storage.candidateLinkKind("weird")).toBe("unknown"); // unrecognized share host
    expect(storage.candidateLinkKind("ghost")).toBe("unknown"); // never recorded
  });

  describe("dead-link recording (#15)", () => {
    it("records a 115 share that failed loud with a death message", async () => {
      const store = new FakeDeadLinkStore();
      const executor = new RecordingExecutor({ status: "failed", message: "链接已过期" });
      const { storage, registry } = adapter(executor, new CandidateRegistry(), store);
      registry.record({ ...candidate("share"), providerPayload: { url: "https://115cdn.com/s/sww96353nl6?password=g876" } });

      await storage.transferCandidate({ candidateId: "share", intoDirectoryId: "staging" });

      expect(store.recorded).toEqual([{ key: "115:sww96353nl6", kind: "pan115", reason: "链接已过期", permanent: true }]);
    });

    it("records a magnet that did NOT 秒传 (no_target_change), keyed by infohash", async () => {
      const store = new FakeDeadLinkStore();
      const executor = new RecordingExecutor({ status: "no_target_change", message: "no target materialized" });
      const { storage, registry } = adapter(executor, new CandidateRegistry(), store);
      registry.record({ ...candidate("mag"), type: "magnet", providerPayload: { url: "magnet:?xt=urn:btih:edef9b0fc91c9ccdf5b3e43f6cc5278160e81dd5" } });

      await storage.transferCandidate({ candidateId: "mag", intoDirectoryId: "staging" });

      expect(store.recorded).toEqual([
        // a magnet is SOFT (permanent: false) — it may resurrect (see deadLinkKey).
        { key: "magnet:edef9b0fc91c9ccdf5b3e43f6cc5278160e81dd5", kind: "magnet", reason: "no target materialized", permanent: false },
      ]);
    });

    it("gives an unresolvable magnet (name == infohash) a longer soft TTL (90 days)", async () => {
      const store = new FakeDeadLinkStore();
      const executor = new RecordingExecutor({ status: "no_target_change", message: "offline task unresolved (name == infohash); likely fake/dead" });
      const { storage, registry } = adapter(executor, new CandidateRegistry(), store);
      registry.record({ ...candidate("mag"), type: "magnet", providerPayload: { url: "magnet:?xt=urn:btih:edef9b0fc91c9ccdf5b3e43f6cc5278160e81dd5" } });

      await storage.transferCandidate({ candidateId: "mag", intoDirectoryId: "staging" });

      expect(store.recorded[0]).toMatchObject({ kind: "magnet", permanent: false, ttlMs: 90 * 24 * 60 * 60 * 1000 });
    });

    it("does NOT record a 任务已存在 magnet (prior good task) nor a successful transfer", async () => {
      const store = new FakeDeadLinkStore();
      const dup = new RecordingExecutor({ status: "no_target_change", message: "任务已存在，请勿输入重复的链接地址" });
      const a = adapter(dup, new CandidateRegistry(), store);
      a.registry.record({ ...candidate("mag"), type: "magnet", providerPayload: { url: "magnet:?xt=urn:btih:edef9b0fc91c9ccdf5b3e43f6cc5278160e81dd5" } });
      await a.storage.transferCandidate({ candidateId: "mag", intoDirectoryId: "staging" });

      const ok = new RecordingExecutor({ status: "succeeded" });
      const b = adapter(ok, new CandidateRegistry(), store);
      b.registry.record(candidate("share"));
      await b.storage.transferCandidate({ candidateId: "share", intoDirectoryId: "staging" });

      expect(store.recorded).toEqual([]);
    });
  });
});

describe("RealStorageV2.transferSubtitleUrls — batch-first, per-file fallback with the consecutive-failure abort", () => {
  const files = (n: number) => Array.from({ length: n }, (_, i) => ({ url: `http://x/${i}.srt`, filename: `E${i}.srt` }));

  it("uses the executor's batch method when present: ONE call with every file, results in order, run id from the adapter", async () => {
    const executor = new RecordingExecutor({ subtitleBatch: true, subtitleFail: (name) => (name === "E1.srt" ? "did not materialize" : null) });
    const { storage } = adapter(executor);

    const results = await storage.transferSubtitleUrls({ files: files(3), intoDirectoryId: "staging" });

    expect(executor.subtitleBatchCalls).toEqual([{ files: ["E0.srt", "E1.srt", "E2.srt"], directoryId: "staging", workflowRunId: "run-7" }]);
    expect(executor.subtitleSingleCalls).toEqual([]);
    expect(results.map((r) => [r.filename, r.status])).toEqual([["E0.srt", "succeeded"], ["E1.srt", "failed"], ["E2.srt", "succeeded"]]);
    expect(results[1]!.providerMessage).toBe("did not materialize");
    expect(results[0]!.materializedFileIds).toEqual(["sub_E0.srt"]);
  });

  it("carries the name a file ACTUALLY landed under (executor's materializedNames) as landedFilename; absent when the executor does not know it", async () => {
    const executor = new RecordingExecutor({ subtitleBatch: true });
    const batch = executor.transferSubtitleUrls!;
    executor.transferSubtitleUrls = async (input) =>
      (await batch(input)).map((attempt, index) => (index === 0 ? { ...attempt, materializedNames: ["E0(1).srt"] } : attempt));
    const { storage } = adapter(executor);

    const results = await storage.transferSubtitleUrls({ files: files(2), intoDirectoryId: "staging" });

    expect(results[0]).toMatchObject({ filename: "E0.srt", landedFilename: "E0(1).srt", status: "succeeded" });
    expect("landedFilename" in results[1]!).toBe(false);
  });

  it("fails loud when the executor's batch drops a file instead of marking it failed (arity contract)", async () => {
    class DroppingBatch extends RecordingExecutor {
      constructor() {
        super({ subtitleBatch: true });
        const batch = this.transferSubtitleUrls!;
        this.transferSubtitleUrls = async (input) => (await batch(input)).slice(0, 1);
      }
    }
    const { storage } = adapter(new DroppingBatch());

    await expect(storage.transferSubtitleUrls({ files: files(3), intoDirectoryId: "staging" })).rejects.toThrow(
      "REAL_STORAGE_SUBTITLE_BATCH_ARITY",
    );
  });

  it("maps a batch-level THROW to every file failing softly (same shape as the per-file fallback's thrown error)", async () => {
    class ThrowingBatch extends RecordingExecutor {
      constructor() {
        super({ subtitleBatch: true });
        this.transferSubtitleUrls = async () => {
          throw new Error("WRITE_SCOPE_VIOLATION: nope");
        };
      }
    }
    const { storage } = adapter(new ThrowingBatch());

    const results = await storage.transferSubtitleUrls({ files: files(3), intoDirectoryId: "staging" });

    expect(results.map((r) => [r.filename, r.status])).toEqual([
      ["E0.srt", "failed"],
      ["E1.srt", "failed"],
      ["E2.srt", "failed"],
    ]);
    expect(results.every((r) => r.providerMessage === "WRITE_SCOPE_VIOLATION: nope")).toBe(true);
    expect(results.every((r) => r.materializedFileIds.length === 0)).toBe(true);
    expect(storage.attempts()).toEqual([]);
  });

  // The contrast with the WRITE_SCOPE_VIOLATION test above: a scope violation IS a
  // landing problem (soften it), a dead cookie is NOT — it must reach the worker's
  // drive-freeze path untouched instead of becoming N fake "failed" files.
  it("brand auth errors are NOT softened on the batch path (dead cookie ≠ landing miss)", async () => {
    class AuthFailingBatch extends RecordingExecutor {
      constructor() {
        super({ subtitleBatch: true });
        this.transferSubtitleUrls = async () => {
          throw new Pan115AuthError("PAN115_AUTH_FAILED: cookie dead", 990001);
        };
      }
    }
    const { storage } = adapter(new AuthFailingBatch());

    await expect(storage.transferSubtitleUrls({ files: files(3), intoDirectoryId: "staging" })).rejects.toBeInstanceOf(
      Pan115AuthError,
    );
  });

  it("brand auth errors are NOT softened on the per-file fallback (and stop the loop at once)", async () => {
    class AuthFailingSingle extends RecordingExecutor {
      override async transferSubtitleUrl(input: { url: string; filename: string; directoryId: string; workflowRunId: string }) {
        this.subtitleSingleCalls.push(input.filename);
        if (this.subtitleSingleCalls.length >= 2) {
          throw new GuangYaAuthError("GUANGYA_AUTH_FAILED: token dead");
        }
        return {
          id: `${input.workflowRunId}_subtitle_${this.subtitleSingleCalls.length}`,
          workflowRunId: input.workflowRunId,
          candidateId: `subtitle:${input.filename}`,
          status: "succeeded" as const,
          providerMessage: "",
          materializedFileIds: [`sub_${input.filename}`],
        };
      }
    }
    const executor = new AuthFailingSingle();
    const { storage } = adapter(executor);

    await expect(storage.transferSubtitleUrls({ files: files(3), intoDirectoryId: "staging" })).rejects.toBeInstanceOf(
      GuangYaAuthError,
    );
    expect(executor.subtitleSingleCalls).toHaveLength(2); // no third attempt on a dead token
  });

  it("falls back to the per-file method when the executor has no batch (光鸭 today)", async () => {
    const executor = new RecordingExecutor();
    const { storage } = adapter(executor);

    const results = await storage.transferSubtitleUrls({ files: files(2), intoDirectoryId: "staging" });

    expect(executor.subtitleSingleCalls).toEqual(["E0.srt", "E1.srt"]);
    expect(results.every((r) => r.status === "succeeded")).toBe(true);
  });

  it("per-file fallback aborts after 3 consecutive failures instead of hammering the whole filelist (每次失败都烧真 API)", async () => {
    const executor = new RecordingExecutor({ subtitleFail: () => "dead link" });
    const { storage } = adapter(executor);

    const results = await storage.transferSubtitleUrls({ files: files(10), intoDirectoryId: "staging" });

    expect(executor.subtitleSingleCalls).toHaveLength(3);
    expect(results.slice(0, 3).map((r) => r.providerMessage)).toEqual(["dead link", "dead link", "dead link"]);
    expect(results.slice(3).every((r) => r.status === "failed")).toBe(true);
    expect(results[9]!.providerMessage).toMatch(/已连续 3 个字幕文件落盘失败,提前中止\(剩余 7 个未尝试\).*最后错误: dead link/);
  });

  it("per-file fallback: when the 3rd consecutive failure IS the last file nothing was skipped — its own message stands", async () => {
    const executor = new RecordingExecutor({ subtitleFail: () => "dead link" });
    const { storage } = adapter(executor);

    const results = await storage.transferSubtitleUrls({ files: files(3), intoDirectoryId: "staging" });

    expect(executor.subtitleSingleCalls).toHaveLength(3);
    expect(results[2]!.providerMessage).toBe("dead link"); // no "剩余 0 个未尝试" lie
  });

  it("per-file fallback: a success in between resets the counter (mixed flakiness still lands everything)", async () => {
    let n = 0;
    const executor = new RecordingExecutor({ subtitleFail: () => (++n % 3 === 0 ? null : "flaky") });
    const { storage } = adapter(executor);

    const results = await storage.transferSubtitleUrls({ files: files(6), intoDirectoryId: "staging" });

    expect(executor.subtitleSingleCalls).toHaveLength(6);
    expect(results.filter((r) => r.status === "succeeded").map((r) => r.filename)).toEqual(["E2.srt", "E5.srt"]);
  });

  it("per-file fallback treats a thrown executor error as that file's failure (counts toward the abort)", async () => {
    class Throwing extends RecordingExecutor {
      override async transferSubtitleUrl(): Promise<TransferAttempt> {
        throw new Error("PAN115_LIST_ITEMS_FAILED: boom");
      }
    }
    const { storage } = adapter(new Throwing());

    const results = await storage.transferSubtitleUrls({ files: files(4), intoDirectoryId: "staging" });

    expect(results.slice(0, 3).every((r) => r.status === "failed" && r.providerMessage === "PAN115_LIST_ITEMS_FAILED: boom")).toBe(true);
    expect(results[3]!.providerMessage).toMatch(/已连续 3 个/);
  });

  it("records the VIDEO attempt but never subtitle attempts into attempts() (snapshot-persistence invariant)", async () => {
    for (const subtitleBatch of [true, false]) {
      const { storage, registry } = adapter(new RecordingExecutor({ subtitleBatch }));
      registry.record(candidate("cand"));
      await storage.transferCandidate({ candidateId: "cand", intoDirectoryId: "staging" });

      await storage.transferSubtitleUrls({ files: files(2), intoDirectoryId: "staging" });

      const attempts = storage.attempts();
      expect(attempts).toHaveLength(1);
      expect(attempts[0]!.candidateId).toBe("cand");
      expect(attempts.some((a) => a.candidateId.startsWith("subtitle:"))).toBe(false);
    }
  });

  it("throws REAL_STORAGE_NO_SUBTITLE_SUPPORT when the executor has neither method", async () => {
    class NoSubtitles extends RecordingExecutor {
      constructor() {
        super();
        // @ts-expect-error — simulate a brand without the capability
        this.transferSubtitleUrl = undefined;
      }
    }
    const { storage } = adapter(new NoSubtitles());
    await expect(storage.transferSubtitleUrls({ files: files(1), intoDirectoryId: "staging" })).rejects.toThrow("REAL_STORAGE_NO_SUBTITLE_SUPPORT");
  });
});

describe("RealStorageV2 — 光鸭 share dead-links are recorded softly", () => {
  it("a proven-dead 光鸭 share is recorded with the 14-day soft TTL; a pending timeout is not", async () => {
    const recorded: Array<Record<string, unknown>> = [];
    const deadLinkStore = { recordDeadLink: async (input: Record<string, unknown>) => { recorded.push(input); }, listDeadLinkKeys: async () => [] };
    const { CandidateRegistry } = await import("../src/acquisition-v2/candidate-registry.js");
    const { RealStorageV2 } = await import("../src/acquisition-v2/real-storage-adapter.js");
    const { GUANGYA_DEAD_LINK_TTL_MS } = await import("../src/acquisition-v2/dead-links.js");
    const registry = new CandidateRegistry();
    const url = "https://www.guangyapan.com/s/1945376531793305622_aeWnPia0Twth-NLu";
    registry.record({ id: "dead", snapshotId: "s", index: 0, title: "t", type: "guangya", source: "pansou", providerPayload: { url } });
    registry.record({ id: "slow", snapshotId: "s", index: 1, title: "t", type: "guangya", source: "pansou", providerPayload: { url: `${url}2` } });
    const outcomes: Record<string, { status: string; providerMessage: string }> = {
      dead: { status: "failed", providerMessage: "GUANGYA_API_FAILED: /userres/v1/get_share_access_token status=200 msg=分享已失效" },
      slow: { status: "no_target_change", providerMessage: "GUANGYA_RESTORE_TIMEOUT: 转存任务 t 在 60 次轮询内未完成" },
    };
    const executor = {
      transfer: async ({ candidate }: { candidate: { id: string } }) => ({ id: "a", workflowRunId: "r", candidateId: candidate.id, materializedFileIds: [], ...outcomes[candidate.id]! }),
      listTree: async () => [],
    } as never;
    const storage = new RealStorageV2({ executor, registry, workflowRunId: "r", deadLinkStore: deadLinkStore as never });
    await storage.transferCandidate({ candidateId: "dead", intoDirectoryId: "d" });
    await storage.transferCandidate({ candidateId: "slow", intoDirectoryId: "d" });
    expect(recorded).toEqual([
      expect.objectContaining({ key: "guangya:1945376531793305622_aeWnPia0Twth-NLu", kind: "guangya", permanent: false, ttlMs: GUANGYA_DEAD_LINK_TTL_MS }),
    ]);
  });
});
