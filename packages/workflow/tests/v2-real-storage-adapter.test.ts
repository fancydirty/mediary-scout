import { describe, expect, it } from "vitest";
import { RealStorageV2 } from "../src/acquisition-v2/real-storage-adapter.js";
import { CandidateRegistry } from "../src/acquisition-v2/candidate-registry.js";
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
    episodeHints: [],
    qualityHints: [],
    providerPayload: { url: "https://115.com/s/abc", receiveCode: "pw" },
  };
}

/** Minimal StorageExecutor that records calls and returns canned data. */
class RecordingExecutor implements StorageExecutor {
  transfers: Array<{ workflowRunId: string; directoryId: string; candidateId: string }> = [];
  deletes: Array<{ directoryId: string; fileIds: string[] }> = [];
  removed: string[] = [];
  constructor(private readonly opts: { status?: TransferAttempt["status"]; tree?: PackageTreeFile[]; removeOk?: boolean } = {}) {}

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
      providerMessage: "",
      materializedFileIds: ["f1", "f2"],
    };
  }
  async listTree(): Promise<PackageTreeFile[]> {
    return this.opts.tree ?? [{ path: "Pack/Show - 01.mkv", providerFileId: "f1", sizeBytes: 9 }];
  }
  async listSubdirectories(): Promise<Array<{ id: string; path: string }>> {
    return [{ id: "wrap", path: "Pack" }];
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
  async flattenDirectory(): Promise<{ moved: string[]; removed: string[] }> {
    return { moved: [], removed: [] };
  }
}

function adapter(executor: StorageExecutor, registry = new CandidateRegistry()) {
  return { storage: new RealStorageV2({ executor, registry, workflowRunId: "run-7" }), registry };
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

  it("maps no_target_change to a failed attempt (nothing usable landed)", async () => {
    const executor = new RecordingExecutor({ status: "no_target_change" });
    const { storage, registry } = adapter(executor);
    registry.record(candidate("cand"));

    const result = await storage.transferCandidate({ candidateId: "cand", intoDirectoryId: "staging" });
    expect(result.status).toBe("failed");
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

  it("classifies candidate link kind from the recorded url (115 share / magnet / unknown)", async () => {
    const { storage, registry } = adapter(new RecordingExecutor());
    registry.record({ ...candidate("share"), providerPayload: { url: "https://115cdn.com/s/abc?password=x" } });
    registry.record({ ...candidate("share2"), providerPayload: { url: "https://115.com/s/def" } });
    registry.record({ ...candidate("mag"), providerPayload: { url: "magnet:?xt=urn:btih:deadbeef" } });
    registry.record({ ...candidate("weird"), providerPayload: { url: "https://pan.quark.cn/s/zzz" } });

    expect(storage.candidateLinkKind("share")).toBe("pan115");
    expect(storage.candidateLinkKind("share2")).toBe("pan115");
    expect(storage.candidateLinkKind("mag")).toBe("magnet");
    expect(storage.candidateLinkKind("weird")).toBe("unknown"); // non-115 share host
    expect(storage.candidateLinkKind("ghost")).toBe("unknown"); // never recorded
  });
});
