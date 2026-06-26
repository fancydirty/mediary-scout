import { describe, expect, it, vi } from "vitest";
import type { ResourceCandidate, ResourceType } from "./domain.js";
import { GuangYaAuthError } from "./guangya-client.js";
import type { GuangYaStorageClient } from "./guangya-storage-executor.js";
import { GuangYaStorageExecutor } from "./guangya-storage-executor.js";

/** Minimal in-memory fake of the structural client the executor depends on. */
function fakeClient(overrides: Partial<GuangYaStorageClient> = {}): GuangYaStorageClient {
  return {
    listFiles: vi.fn(async () => []),
    createDir: vi.fn(async () => "new-dir"),
    renameFile: vi.fn(async () => {}),
    deleteFiles: vi.fn(async () => {}),
    moveFiles: vi.fn(async () => {}),
    resolveRes: vi.fn(async () => ({ resType: 1 })),
    createTask: vi.fn(async () => "task-1"),
    listTask: vi.fn(async () => [{ taskId: "task-1", status: 2, progress: 100, fileId: "" }]),
    ...overrides,
  };
}

function candidate(overrides: Partial<ResourceCandidate> = {}): ResourceCandidate {
  return {
    id: "cand-1",
    snapshotId: "snap-1",
    index: 0,
    title: "Some Movie",
    type: "magnet" as ResourceType,
    source: "test",
    episodeHints: [],
    qualityHints: [],
    providerPayload: { url: "magnet:?xt=urn:btih:deadbeef" },
    ...overrides,
  };
}

const SCOPE = "scope-dir";

describe("GuangYaStorageExecutor.transfer", () => {
  it("offline-downloads a magnet, requests only video subfile indexes, reports succeeded", async () => {
    const listFiles = vi
      .fn<GuangYaStorageClient["listFiles"]>()
      // first call: before-snapshot (empty)
      .mockResolvedValueOnce([])
      // second call: after-snapshot (one new video)
      .mockResolvedValueOnce([
        { fileId: "v1", parentId: SCOPE, fileName: "movie.mkv", fileSize: 50 * 1024 * 1024, resType: 1 },
      ]);
    const resolveRes = vi.fn(async () => ({
      resType: 2,
      btResInfo: {
        infoHash: "deadbeef",
        fileName: "Some.Movie.2024",
        subfiles: [
          { fileName: "movie.mkv", fileIndex: 0, fileSize: 50 * 1024 * 1024 },
          { fileName: "poster.jpg", fileIndex: 1, fileSize: 1024 },
        ],
      },
    }));
    const createTask = vi.fn<GuangYaStorageClient["createTask"]>(async () => "task-9");
    const client = fakeClient({ listFiles, resolveRes, createTask });
    const executor = new GuangYaStorageExecutor({ client, writeScopeDirectoryIds: [SCOPE] });

    const attempt = await executor.transfer({
      workflowRunId: "run-1",
      directoryId: SCOPE,
      candidate: candidate(),
    });

    expect(createTask).toHaveBeenCalledTimes(1);
    expect(createTask.mock.calls[0]![0]).toMatchObject({
      parentId: SCOPE,
      fileIndexes: [0],
    });
    expect(attempt.status).toBe("succeeded");
    expect(attempt.materializedFileIds).toEqual(["v1"]);
    expect(attempt.id).toBe("run-1_transfer_1");
  });

  it("fails LOUD on a non-magnet share link (GUANGYA_ONLY_MAGNET)", async () => {
    const client = fakeClient();
    const executor = new GuangYaStorageExecutor({ client, writeScopeDirectoryIds: [SCOPE] });
    await expect(
      executor.transfer({
        workflowRunId: "run-1",
        directoryId: SCOPE,
        candidate: candidate({
          type: "quark" as ResourceType,
          providerPayload: { url: "https://www.guangyapan.com/s/abc" },
        }),
      }),
    ).rejects.toThrow(/GUANGYA_ONLY_MAGNET/);
    expect(client.createTask).not.toHaveBeenCalled();
  });

  it("returns failed (not throw) when resolveRes throws on a dead magnet", async () => {
    const resolveRes = vi.fn(async () => {
      throw new Error("dead magnet: resolve_res empty");
    });
    const client = fakeClient({ resolveRes });
    const executor = new GuangYaStorageExecutor({ client, writeScopeDirectoryIds: [SCOPE] });

    const attempt = await executor.transfer({
      workflowRunId: "run-1",
      directoryId: SCOPE,
      candidate: candidate(),
    });

    expect(attempt.status).toBe("failed");
    expect(attempt.providerMessage).toMatch(/dead magnet/);
    expect(attempt.materializedFileIds).toEqual([]);
  });

  it("propagates (rejects) when the client throws an auth error", async () => {
    const resolveRes = vi.fn(async () => {
      throw new GuangYaAuthError("GUANGYA_AUTH_FAILED: 401 after refresh");
    });
    const client = fakeClient({ resolveRes });
    const executor = new GuangYaStorageExecutor({ client, writeScopeDirectoryIds: [SCOPE] });
    await expect(
      executor.transfer({ workflowRunId: "run-1", directoryId: SCOPE, candidate: candidate() }),
    ).rejects.toThrow(GuangYaAuthError);
  });
});

describe("GuangYaStorageExecutor.createDirectory", () => {
  it("find-or-create reuses an existing same-name resType===2 folder (createDir not called)", async () => {
    const listFiles = vi.fn(async () => [
      { fileId: "existing", parentId: SCOPE, fileName: "Inception", fileSize: 0, resType: 2 },
      { fileId: "afile", parentId: SCOPE, fileName: "Inception", fileSize: 100, resType: 1 },
    ]);
    const createDir = vi.fn(async () => "should-not-be-called");
    const client = fakeClient({ listFiles, createDir });
    const executor = new GuangYaStorageExecutor({ client, writeScopeDirectoryIds: [SCOPE] });

    const id = await executor.createDirectory({ name: "Inception", parentId: SCOPE });
    expect(id).toBe("existing");
    expect(createDir).not.toHaveBeenCalled();
  });

  it("creates a new folder when none matches", async () => {
    const listFiles = vi.fn(async () => []);
    const createDir = vi.fn(async () => "fresh-dir");
    const client = fakeClient({ listFiles, createDir });
    const executor = new GuangYaStorageExecutor({ client, writeScopeDirectoryIds: [SCOPE] });
    const id = await executor.createDirectory({ name: "Inception", parentId: SCOPE });
    expect(id).toBe("fresh-dir");
    expect(createDir).toHaveBeenCalledTimes(1);
  });
});

describe("GuangYaStorageExecutor write-scope guard", () => {
  it("refuses transfer to an id not in scope (WRITE_SCOPE_VIOLATION)", async () => {
    const client = fakeClient();
    const executor = new GuangYaStorageExecutor({ client, writeScopeDirectoryIds: [SCOPE] });
    await expect(
      executor.transfer({ workflowRunId: "run-1", directoryId: "elsewhere", candidate: candidate() }),
    ).rejects.toThrow(/WRITE_SCOPE_VIOLATION/);
  });

  it("refuses createDirectory under an out-of-scope parent (WRITE_SCOPE_VIOLATION)", async () => {
    const client = fakeClient();
    const executor = new GuangYaStorageExecutor({ client, writeScopeDirectoryIds: [SCOPE] });
    await expect(
      executor.createDirectory({ name: "x", parentId: "elsewhere" }),
    ).rejects.toThrow(/WRITE_SCOPE_VIOLATION/);
  });
});

describe("GuangYaStorageExecutor item-adapter", () => {
  it("listVideoFiles filters by video extension (mirrors quark: extension is the video signal)", async () => {
    const listFiles = vi.fn(async (parentId: string) => {
      if (parentId === SCOPE) {
        return [
          { fileId: "big", parentId: SCOPE, fileName: "ep.mkv", fileSize: 50 * 1024 * 1024, resType: 1 },
          { fileId: "vid2", parentId: SCOPE, fileName: "ep2.mp4", fileSize: 30 * 1024 * 1024, resType: 1 },
          { fileId: "notvid", parentId: SCOPE, fileName: "readme.txt", fileSize: 50 * 1024 * 1024, resType: 1 },
        ];
      }
      return [];
    });
    const client = fakeClient({ listFiles });
    const executor = new GuangYaStorageExecutor({ client, writeScopeDirectoryIds: [SCOPE] });
    const videos = await executor.listVideoFiles(SCOPE);
    expect(videos.map((v) => v.id).sort()).toEqual(["big", "vid2"]);
    expect(videos.find((v) => v.id === "notvid")).toBeUndefined();
  });

  it("listChildDirectories returns only resType===2 entries", async () => {
    const listFiles = vi.fn(async () => [
      { fileId: "d1", parentId: SCOPE, fileName: "Season 1", fileSize: 0, resType: 2 },
      { fileId: "f1", parentId: SCOPE, fileName: "ep.mkv", fileSize: 100, resType: 1 },
      { fileId: "d2", parentId: SCOPE, fileName: "Season 2", fileSize: 0, resType: 2 },
    ]);
    const client = fakeClient({ listFiles });
    const executor = new GuangYaStorageExecutor({ client, writeScopeDirectoryIds: [SCOPE] });
    const dirs = await executor.listChildDirectories(SCOPE);
    expect(dirs).toEqual([
      { id: "d1", name: "Season 1" },
      { id: "d2", name: "Season 2" },
    ]);
  });
});
