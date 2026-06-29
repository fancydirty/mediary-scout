import { describe, expect, it, vi } from "vitest";
import type { ResourceCandidate, ResourceType } from "./domain.js";
import { GuangYaAuthError } from "./guangya-client.js";
import type { GuangYaStorageClient, GuangYaStorageItem } from "./guangya-storage-executor.js";
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

  it("provisions the connect-time category tree at the 光鸭 root (parentId='')", async () => {
    // 光鸭's ROOT directory id is the empty string "": get_file_list/create_dir with
    // parentId:"" operate on root (confirmed live). connectGuangYa →
    // provisionCategoryDirs calls createDirectory({ name, parentId: "" }) to make the
    // root category folder. With an EMPTY write scope (connect-time provisioning),
    // "" must be accepted as the valid root parent, not throw on empty.
    const fs = new Map<string, GuangYaStorageItem[]>();
    fs.set("", []);
    let nextId = 1;
    const listFiles = vi.fn<GuangYaStorageClient["listFiles"]>(async (parentId: string) => {
      return fs.get(parentId) ?? [];
    });
    const createDir = vi.fn<GuangYaStorageClient["createDir"]>(async (parentId, dirName) => {
      const id = `dir-${nextId++}`;
      fs.set(id, []);
      const items = fs.get(parentId) ?? [];
      items.push({ fileId: id, parentId, fileName: dirName, fileSize: 0, resType: 2 });
      fs.set(parentId, items);
      return id;
    });
    const client = fakeClient({ listFiles, createDir });
    // Connect-time: empty write scope (dev/provisioning).
    const executor = new GuangYaStorageExecutor({ client, writeScopeDirectoryIds: [] });

    // find-or-create the root category folder AT root ("").
    const rootId = await executor.createDirectory({ name: "Mediary Scout", parentId: "" });
    expect(rootId).toBe("dir-1");
    expect(createDir).toHaveBeenCalledWith("", "Mediary Scout");

    // then create a child under that returned id — also succeeds.
    const moviesId = await executor.createDirectory({ name: "Movies", parentId: rootId });
    expect(moviesId).toBe("dir-2");
    expect(createDir).toHaveBeenCalledWith(rootId, "Movies");
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

  it("authorizes removeDirectory of an offline-created subdir discovered under an in-scope dir (movie flatten clean-up)", async () => {
    // A movie magnet offline-downloads as a WRAPPER subdir the SERVER created (NOT via
    // createDirectory) directly under the in-scope movie dir. flattenMovie lifts the video
    // out, then removeDirectory(wrapper) to clear the residue. The wrapper is provably under
    // an in-scope parent (discovered by listing it) — derived scope must authorize its
    // removal, exactly like a createDirectory'd dir. Regression: WRITE_SCOPE_VIOLATION here
    // left empty wrapper dirs + non-video junk behind on 光鸭 movies (TV is clean because
    // discardStaging removes the createDirectory'd staging dir wholesale).
    const MOVIE = "movie-dir";
    const wrapperId = "wrapper-1";
    const fs = new Map<string, GuangYaStorageItem[]>();
    fs.set(MOVIE, [{ fileId: wrapperId, parentId: MOVIE, fileName: "Oppenheimer.2023.1080p", fileSize: 0, resType: 2 }]);
    fs.set(wrapperId, []);
    const deleteFiles = vi.fn<GuangYaStorageClient["deleteFiles"]>(async () => {});
    const listFiles = vi.fn<GuangYaStorageClient["listFiles"]>(async (p: string) => fs.get(p) ?? []);
    const executor = new GuangYaStorageExecutor({
      client: fakeClient({ listFiles, deleteFiles }),
      writeScopeDirectoryIds: [MOVIE],
    });

    const subdirs = await executor.listSubdirectories({ directoryId: MOVIE });
    expect(subdirs.map((d) => d.id)).toContain(wrapperId);

    await expect(executor.removeDirectory(wrapperId)).resolves.toEqual({ removed: true });
    expect(deleteFiles).toHaveBeenCalledWith([wrapperId]);
  });

  it("does NOT authorize removal of children discovered by listing an OUT-of-scope dir", async () => {
    // Listing is a read and may target dirs outside the write scope; discovering a child
    // there must NOT make it writable. Only listing an IN-scope dir extends derived scope.
    const fs = new Map<string, GuangYaStorageItem[]>();
    fs.set("elsewhere", [{ fileId: "stranger", parentId: "elsewhere", fileName: "x", fileSize: 0, resType: 2 }]);
    fs.set("stranger", []);
    const listFiles = vi.fn<GuangYaStorageClient["listFiles"]>(async (p: string) => fs.get(p) ?? []);
    const executor = new GuangYaStorageExecutor({
      client: fakeClient({ listFiles }),
      writeScopeDirectoryIds: [SCOPE],
    });
    await executor.listSubdirectories({ directoryId: "elsewhere" });
    await expect(executor.removeDirectory("stranger")).rejects.toThrow(/WRITE_SCOPE_VIOLATION/);
  });

  it("authorizes writes into runtime-created NESTED dirs (derived scope), still refuses unknown ids", async () => {
    // The real workflow provisions the dir chain TOP-DOWN from a scope root via
    // createDirectory before any write, then transfers/moves into the NESTED leaf —
    // never into a scope root. Flat-membership wrongly throws here; derived-scope must pass.
    const TV_SCOPE = "tv-scope";
    // In-memory FS: each dir id -> its child items. New dirs created lazily.
    const fs = new Map<string, GuangYaStorageItem[]>();
    fs.set(TV_SCOPE, []);
    let nextId = 1;
    const stagingFiles: GuangYaStorageItem[] = [];
    const listFiles = vi.fn<GuangYaStorageClient["listFiles"]>(async (parentId: string) => {
      return fs.get(parentId) ?? [];
    });
    const createDir = vi.fn<GuangYaStorageClient["createDir"]>(async (parentId: string, dirName: string) => {
      const id = `dir-${nextId++}`;
      fs.set(id, []);
      const items = fs.get(parentId) ?? [];
      items.push({ fileId: id, parentId, fileName: dirName, fileSize: 0, resType: 2 });
      fs.set(parentId, items);
      return id;
    });
    const moveFiles = vi.fn<GuangYaStorageClient["moveFiles"]>(async () => {});
    const client = fakeClient({ listFiles, createDir, moveFiles });

    const executor = new GuangYaStorageExecutor({
      client,
      writeScopeDirectoryIds: [TV_SCOPE],
    });

    // Provision chain TOP-DOWN from the scope root.
    const showId = await executor.createDirectory({ name: "Show", parentId: TV_SCOPE });
    // Nested 2 levels under TV — flat membership would throw WRITE_SCOPE_VIOLATION here.
    const stagingId = await executor.createDirectory({ name: "staging", parentId: showId });
    const seasonId = await executor.createDirectory({ name: "Season 01", parentId: showId });

    // transfer into the nested staging dir succeeds (no WRITE_SCOPE_VIOLATION).
    // Staging listing: empty on the before-snapshot, one new video on the after-snapshot
    // (simulating the offline download landing). Other dirs read from the in-memory fs.
    let stagingListCalls = 0;
    listFiles.mockImplementation(async (parentId: string) => {
      if (parentId === stagingId) {
        stagingListCalls += 1;
        return stagingListCalls === 1 ? [] : stagingFiles;
      }
      return fs.get(parentId) ?? [];
    });
    stagingFiles.push({
      fileId: "ep1",
      parentId: stagingId,
      fileName: "ep1.mkv",
      fileSize: 50 * 1024 * 1024,
      resType: 1,
    });
    const attempt = await executor.transfer({
      workflowRunId: "run-1",
      directoryId: stagingId,
      candidate: candidate(),
    });
    expect(attempt.status).toBe("succeeded");
    expect(attempt.materializedFileIds).toEqual(["ep1"]);

    // moveFiles into the created Season dir under showId succeeds.
    const moved = await executor.moveFiles({ fileIds: ["ep1"], targetDirectoryId: seasonId });
    expect(moved.moved).toEqual(["ep1"]);

    // A totally-unknown id (never created under scope) is still refused.
    await expect(
      executor.transfer({
        workflowRunId: "run-2",
        directoryId: "totally-unknown-id",
        candidate: candidate(),
      }),
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
