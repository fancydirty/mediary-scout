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

  it("fails LOUD on a share link of ANOTHER brand (夸克/115 cannot land on 光鸭)", async () => {
    const client = fakeClient();
    const executor = new GuangYaStorageExecutor({ client, writeScopeDirectoryIds: [SCOPE] });
    await expect(
      executor.transfer({
        workflowRunId: "run-1",
        directoryId: SCOPE,
        candidate: candidate({
          type: "quark" as ResourceType,
          providerPayload: { url: "https://pan.quark.cn/s/abc" },
        }),
      }),
    ).rejects.toThrow(/GUANGYA_UNSUPPORTED_LINK/);
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

  it("authorizes createDirectory under a show folder REUSED via listChildDirectories (#210 / pan123 #168)", async () => {
    // Same production shape as pan123 莉可丽丝 / issue #210: ensureMediaLibraryDirectory
    // reuses an existing show folder from listChildDirectories; without derived-scope
    // registration createDirectory(Season NN) dies with WRITE_SCOPE_VIOLATION.
    const fs = new Map<string, GuangYaStorageItem[]>();
    fs.set(SCOPE, [
      { fileId: "existing-show", parentId: SCOPE, fileName: "凡人修仙传 (2020)", fileSize: 0, resType: 2 },
    ]);
    fs.set("existing-show", []);
    const listFiles = vi.fn<GuangYaStorageClient["listFiles"]>(async (p: string) => fs.get(p) ?? []);
    const createDir = vi.fn<GuangYaStorageClient["createDir"]>(async () => "newdir123");
    const executor = new GuangYaStorageExecutor({
      client: fakeClient({ listFiles, createDir }),
      writeScopeDirectoryIds: [SCOPE],
    });

    const children = await executor.listChildDirectories(SCOPE);
    expect(children).toEqual([{ id: "existing-show", name: "凡人修仙传 (2020)" }]);

    await expect(
      executor.createDirectory({ name: "Season 01", parentId: "existing-show" }),
    ).resolves.toBe("newdir123");
  });

  it("does NOT widen scope via listChildDirectories on an OUT-of-scope dir (read ≠ write)", async () => {
    const fs = new Map<string, GuangYaStorageItem[]>();
    fs.set("elsewhere", [
      { fileId: "stranger", parentId: "elsewhere", fileName: "x", fileSize: 0, resType: 2 },
    ]);
    const listFiles = vi.fn<GuangYaStorageClient["listFiles"]>(async (p: string) => fs.get(p) ?? []);
    const executor = new GuangYaStorageExecutor({
      client: fakeClient({ listFiles }),
      writeScopeDirectoryIds: [SCOPE],
    });

    await executor.listChildDirectories("elsewhere");
    await expect(
      executor.createDirectory({ name: "Season 01", parentId: "stranger" }),
    ).rejects.toThrow(/WRITE_SCOPE_VIOLATION/);
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

describe("GuangYaStorageExecutor.transferSubtitleUrl", () => {
  const SUB_URL = "http://file1.assrt.net/download/715078/The.Matrix.1999.srt?_=1&-=abc&api=1";
  const SUB_NAME = "The.Matrix.1999.srt";

  it("lands a subtitle via create_task(newName) and reports the task's fileId (probe 2026-07-02: url tasks respect newName; status 2 carries fileId)", async () => {
    const createTask = vi.fn<GuangYaStorageClient["createTask"]>(async () => "task-sub");
    const listTask = vi.fn<GuangYaStorageClient["listTask"]>(async () => [
      { taskId: "task-sub", status: 2, progress: 100, fileId: "sub-file-1" },
    ]);
    const listFiles = vi.fn<GuangYaStorageClient["listFiles"]>(async () => [
      { fileId: "sub-file-1", parentId: SCOPE, fileName: SUB_NAME, fileSize: 88753, resType: 1 },
    ]);
    const client = fakeClient({ createTask, listTask, listFiles });
    const executor = new GuangYaStorageExecutor({ client, writeScopeDirectoryIds: [SCOPE] });

    const attempt = await executor.transferSubtitleUrl({
      url: SUB_URL,
      filename: SUB_NAME,
      directoryId: SCOPE,
      workflowRunId: "run-1",
    });

    expect(createTask).toHaveBeenCalledTimes(1);
    expect(createTask.mock.calls[0]![0]).toEqual({ url: SUB_URL, parentId: SCOPE, newName: SUB_NAME });
    expect(attempt.status).toBe("succeeded");
    expect(attempt.materializedFileIds).toEqual(["sub-file-1"]);
    expect(attempt.candidateId).toBe(`subtitle:${SUB_NAME}`);
    expect(attempt.id).toBe("run-1_subtitle_1");
  });

  it("rejects a path-y filename as a failed attempt without spending any API call", async () => {
    const client = fakeClient();
    const executor = new GuangYaStorageExecutor({ client, writeScopeDirectoryIds: [SCOPE] });

    const attempt = await executor.transferSubtitleUrl({
      url: SUB_URL,
      filename: "subdir/evil.ass",
      directoryId: SCOPE,
      workflowRunId: "run-1",
    });

    expect(attempt.status).toBe("failed");
    expect(attempt.candidateId).toBe("subtitle:invalid_name_1");
    expect(attempt.providerMessage).toMatch(/SUBTITLE_INVALID_FILENAME/);
    expect(client.createTask).not.toHaveBeenCalled();
    expect(client.listTask).not.toHaveBeenCalled();
  });

  it("reports no_target_change (not failed) when the task never completes within the poll cap — mirrors the 115 soft-miss semantics", async () => {
    const listTask = vi.fn<GuangYaStorageClient["listTask"]>(async () => [
      { taskId: "task-1", status: 1, progress: 10, fileId: "" },
    ]);
    const client = fakeClient({ listTask });
    const executor = new GuangYaStorageExecutor({
      client,
      writeScopeDirectoryIds: [SCOPE],
      subtitleTaskPollMaxPolls: 2,
      subtitleTaskPollIntervalMs: 0,
    });

    const attempt = await executor.transferSubtitleUrl({
      url: SUB_URL,
      filename: SUB_NAME,
      directoryId: SCOPE,
      workflowRunId: "run-1",
    });

    expect(attempt.status).toBe("no_target_change");
    expect(attempt.materializedFileIds).toEqual([]);
    expect(attempt.providerMessage).toMatch(/未.*落盘|落盘超时|not.*land/i);
  });

  it("reports failed (hard provider error) when create_task rejects the url", async () => {
    const createTask = vi.fn<GuangYaStorageClient["createTask"]>(async () => {
      throw new Error("GUANGYA_API_FAILED: /cloudcollection/v1/create_task status=400 msg=unsupported url");
    });
    const client = fakeClient({ createTask });
    const executor = new GuangYaStorageExecutor({ client, writeScopeDirectoryIds: [SCOPE] });

    const attempt = await executor.transferSubtitleUrl({
      url: SUB_URL,
      filename: SUB_NAME,
      directoryId: SCOPE,
      workflowRunId: "run-1",
    });

    expect(attempt.status).toBe("failed");
    expect(attempt.providerMessage).toMatch(/GUANGYA_API_FAILED/);
    expect(attempt.materializedFileIds).toEqual([]);
  });

  it("reports no_target_change when the task ends with a fileId that is NOT in the target directory (don't trust list_task blindly)", async () => {
    const listTask = vi.fn<GuangYaStorageClient["listTask"]>(async () => [
      { taskId: "task-1", status: 2, progress: 100, fileId: "sub-file-1" },
    ]);
    const listFiles = vi.fn<GuangYaStorageClient["listFiles"]>(async () => []);
    const client = fakeClient({ listTask, listFiles });
    const executor = new GuangYaStorageExecutor({ client, writeScopeDirectoryIds: [SCOPE] });

    const attempt = await executor.transferSubtitleUrl({
      url: SUB_URL,
      filename: SUB_NAME,
      directoryId: SCOPE,
      workflowRunId: "run-1",
    });

    expect(attempt.status).toBe("no_target_change");
    expect(attempt.materializedFileIds).toEqual([]);
  });

  it("propagates auth errors so the worker can freeze the drive", async () => {
    const createTask = vi.fn<GuangYaStorageClient["createTask"]>(async () => {
      throw new GuangYaAuthError("GUANGYA_AUTH_FAILED: 401 after refresh");
    });
    const client = fakeClient({ createTask });
    const executor = new GuangYaStorageExecutor({ client, writeScopeDirectoryIds: [SCOPE] });

    await expect(
      executor.transferSubtitleUrl({
        url: SUB_URL,
        filename: SUB_NAME,
        directoryId: SCOPE,
        workflowRunId: "run-1",
      }),
    ).rejects.toThrow(GuangYaAuthError);
  });

  it("refuses a target directory outside the write scope", async () => {
    const client = fakeClient();
    const executor = new GuangYaStorageExecutor({ client, writeScopeDirectoryIds: [SCOPE] });

    await expect(
      executor.transferSubtitleUrl({
        url: SUB_URL,
        filename: SUB_NAME,
        directoryId: "outside-dir",
        workflowRunId: "run-1",
      }),
    ).rejects.toThrow(/WRITE_SCOPE_VIOLATION/);
  });

  it("shares the transfer attempt counter with transfer() so ids never collide", async () => {
    const listFiles = vi
      .fn<GuangYaStorageClient["listFiles"]>()
      // transfer(): before + after snapshots (no video lands — counter still burns)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      // transferSubtitleUrl(): presence check finds the landed subtitle
      .mockResolvedValueOnce([
        { fileId: "sub-file-1", parentId: SCOPE, fileName: SUB_NAME, fileSize: 88753, resType: 1 },
      ]);
    const listTask = vi.fn<GuangYaStorageClient["listTask"]>(async () => [
      { taskId: "task-1", status: 2, progress: 100, fileId: "sub-file-1" },
    ]);
    const client = fakeClient({ listFiles, listTask });
    const executor = new GuangYaStorageExecutor({ client, writeScopeDirectoryIds: [SCOPE] });

    const video = await executor.transfer({
      workflowRunId: "run-1",
      directoryId: SCOPE,
      candidate: candidate(),
    });
    const subtitle = await executor.transferSubtitleUrl({
      url: SUB_URL,
      filename: SUB_NAME,
      directoryId: SCOPE,
      workflowRunId: "run-1",
    });

    expect(video.id).toBe("run-1_transfer_1");
    expect(subtitle.id).toBe("run-1_subtitle_2");
  });
});

describe("GuangYaStorageExecutor.deleteFiles — non-video cleanup (真机 e2e 2026-07-02 黑客帝国3)", () => {
  it("deletes a subtitle (non-video) file that the directory tree contains", async () => {
    const listFiles = vi.fn<GuangYaStorageClient["listFiles"]>(async () => [
      { fileId: "sub1", parentId: SCOPE, fileName: "多余字幕.srt", fileSize: 77944, resType: 1 },
    ]);
    const deleteFiles = vi.fn<GuangYaStorageClient["deleteFiles"]>(async () => {});
    const client = fakeClient({ listFiles, deleteFiles });
    const executor = new GuangYaStorageExecutor({ client, writeScopeDirectoryIds: [SCOPE] });

    await expect(executor.deleteFiles({ directoryId: SCOPE, fileIds: ["sub1"] })).resolves.toEqual({
      deleted: ["sub1"],
    });
    expect(deleteFiles).toHaveBeenCalledWith(["sub1"]);
  });

  it("still refuses ids that are nowhere in the directory tree", async () => {
    const listFiles = vi.fn<GuangYaStorageClient["listFiles"]>(async () => [
      { fileId: "sub1", parentId: SCOPE, fileName: "多余字幕.srt", fileSize: 77944, resType: 1 },
    ]);
    const client = fakeClient({ listFiles });
    const executor = new GuangYaStorageExecutor({ client, writeScopeDirectoryIds: [SCOPE] });

    await expect(executor.deleteFiles({ directoryId: SCOPE, fileIds: ["ghost"] })).rejects.toThrow(
      /SAFETY_VIOLATION/,
    );
    expect(client.deleteFiles).not.toHaveBeenCalled();
  });
});

describe("GuangYaStorageExecutor.transferSubtitleUrl poll window (真机 2026-07-02 搏击俱乐部: 视频级 60×3s 窗让 3 个卡死字幕任务静默烧 9 分钟)", () => {
  const SUB_URL = "http://file1.assrt.net/download/715078/The.Matrix.1999.srt?_=1&-=abc&api=1";
  const SUB_NAME = "The.Matrix.1999.srt";

  it("uses the SUBTITLE poll cap, not the video task cap", async () => {
    const listTask = vi.fn<GuangYaStorageClient["listTask"]>(async () => [
      { taskId: "task-1", status: 1, progress: 10, fileId: "" },
    ]);
    const client = fakeClient({ listTask });
    const executor = new GuangYaStorageExecutor({
      client,
      writeScopeDirectoryIds: [SCOPE],
      taskPollMaxPolls: 60,
      taskPollIntervalMs: 0,
      subtitleTaskPollMaxPolls: 2,
      subtitleTaskPollIntervalMs: 0,
    });

    const attempt = await executor.transferSubtitleUrl({
      url: SUB_URL,
      filename: SUB_NAME,
      directoryId: SCOPE,
      workflowRunId: "run-1",
    });

    expect(attempt.status).toBe("no_target_change");
    expect(listTask).toHaveBeenCalledTimes(2);
  });

  it("subtitle poll cap defaults to 16 (≈48s at 3s interval, mirroring the 115 subtitle window)", async () => {
    const listTask = vi.fn<GuangYaStorageClient["listTask"]>(async () => [
      { taskId: "task-1", status: 1, progress: 10, fileId: "" },
    ]);
    const client = fakeClient({ listTask });
    const executor = new GuangYaStorageExecutor({
      client,
      writeScopeDirectoryIds: [SCOPE],
      subtitleTaskPollIntervalMs: 0,
    });

    await executor.transferSubtitleUrl({
      url: SUB_URL,
      filename: SUB_NAME,
      directoryId: SCOPE,
      workflowRunId: "run-1",
    });

    expect(listTask).toHaveBeenCalledTimes(16);
  });

  it("video transfer() keeps its own (wider) poll cap untouched", async () => {
    const createTask = vi.fn<GuangYaStorageClient["createTask"]>(async () => "task-9");
    const listTask = vi.fn<GuangYaStorageClient["listTask"]>(async () => [
      { taskId: "task-9", status: 1, progress: 10, fileId: "" },
    ]);
    const listFiles = vi.fn<GuangYaStorageClient["listFiles"]>(async () => []);
    const client = fakeClient({ createTask, listTask, listFiles });
    const executor = new GuangYaStorageExecutor({
      client,
      writeScopeDirectoryIds: [SCOPE],
      taskPollMaxPolls: 5,
      taskPollIntervalMs: 0,
      subtitleTaskPollMaxPolls: 2,
      subtitleTaskPollIntervalMs: 0,
    });

    await executor.transfer({ workflowRunId: "run-1", directoryId: SCOPE, candidate: candidate() });

    expect(listTask).toHaveBeenCalledTimes(5);
  });
});

describe("GuangYaStorageExecutor.transfer — 光鸭分享链转存", () => {
  const SHARE = "https://www.guangyapan.com/s/1947711943535464528_adyMyMAqF4UM3vSl";
  const share = (url = SHARE) => candidate({ type: "guangya" as ResourceType, providerPayload: { url } });
  function shareClient(opts: {
    list?: GuangYaStorageItem[];
    token?: () => Promise<string>;
    statuses?: number[];
    after?: GuangYaStorageItem[];
  } = {}) {
    const statuses = [...(opts.statuses ?? [2])];
    const listFiles = vi
      .fn<GuangYaStorageClient["listFiles"]>()
      .mockResolvedValueOnce([])
      .mockResolvedValue(opts.after ?? [{ fileId: "landed-dir", parentId: SCOPE, fileName: "[沙]丘 (2021)", fileSize: 0, resType: 2 }]);
    const client = fakeClient({
      listFiles,
      getShareAccessToken: vi.fn(opts.token ?? (async () => "sat")),
      listShareFiles: vi.fn(async () => opts.list ?? [{ fileId: "sf1", parentId: "p", fileName: "[沙]丘 (2021)", fileSize: 0, resType: 2 }]),
      restoreShare: vi.fn(async () => "rt1"),
      getTaskStatus: vi.fn(async () => ({ status: statuses.shift() ?? 2 })),
    });
    return client as GuangYaStorageClient & Required<Pick<GuangYaStorageClient, "getShareAccessToken" | "listShareFiles" | "restoreShare" | "getTaskStatus">>;
  }

  it("token → list root → restore every root item into the staging dir → poll → succeeded with landed video ids", async () => {
    const client = shareClient({
      after: [{ fileId: "v9", parentId: SCOPE, fileName: "Dune.2021.2160p.mkv", fileSize: 92 * 1024 ** 3, resType: 1 }],
    });
    const executor = new GuangYaStorageExecutor({ client, writeScopeDirectoryIds: [SCOPE], taskPollIntervalMs: 0 });
    const attempt = await executor.transfer({ workflowRunId: "run-1", directoryId: SCOPE, candidate: share(`${SHARE}?pwd=ab`) });
    expect(client.getShareAccessToken).toHaveBeenCalledWith("1947711943535464528_adyMyMAqF4UM3vSl", "ab");
    expect(client.listShareFiles).toHaveBeenCalledWith("sat", "");
    expect(client.restoreShare).toHaveBeenCalledWith({ accessToken: "sat", fileIds: ["sf1"], parentId: SCOPE });
    expect(client.createTask).not.toHaveBeenCalled();
    expect(attempt.status).toBe("succeeded");
    expect(attempt.materializedFileIds).toEqual(["v9"]);
  });

  it("an unlistable share (summary+token ok, list empty — half the real PanSou links) is a LOUD failed attempt, no restore", async () => {
    const client = shareClient({ list: [] });
    const executor = new GuangYaStorageExecutor({ client, writeScopeDirectoryIds: [SCOPE], taskPollIntervalMs: 0 });
    const attempt = await executor.transfer({ workflowRunId: "run-1", directoryId: SCOPE, candidate: share() });
    expect(client.restoreShare).not.toHaveBeenCalled();
    expect(attempt.status).toBe("failed");
    expect(attempt.providerMessage).toMatch(/GUANGYA_SHARE_EMPTY/);
  });

  it("PanSou's password field wins over a code in the url", async () => {
    const client = shareClient({ after: [{ fileId: "v1", parentId: SCOPE, fileName: "a.mkv", fileSize: 5e8, resType: 1 }] });
    const executor = new GuangYaStorageExecutor({ client, writeScopeDirectoryIds: [SCOPE], taskPollIntervalMs: 0 });
    await executor.transfer({
      workflowRunId: "run-1",
      directoryId: SCOPE,
      candidate: candidate({ type: "guangya" as ResourceType, providerPayload: { url: `${SHARE}?pwd=old`, password: "fresh" } }),
    });
    expect(client.getShareAccessToken).toHaveBeenCalledWith("1947711943535464528_adyMyMAqF4UM3vSl", "fresh");
  });

  it("a dead share (token call rejects with the server msg) is a failed attempt carrying that msg", async () => {
    const client = shareClient({ token: async () => { throw new Error("GUANGYA_API_FAILED: /userres/v1/get_share_access_token status=200 msg=分享已失效"); } });
    const executor = new GuangYaStorageExecutor({ client, writeScopeDirectoryIds: [SCOPE], taskPollIntervalMs: 0 });
    const attempt = await executor.transfer({ workflowRunId: "run-1", directoryId: SCOPE, candidate: share() });
    expect(attempt.status).toBe("failed");
    expect(attempt.providerMessage).toContain("分享已失效");
  });

  it("a restore still running at the window's end is PENDING (no_target_change), not dead — so until-landed stops", async () => {
    const client = shareClient({ statuses: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1], after: [] });
    const executor = new GuangYaStorageExecutor({ client, writeScopeDirectoryIds: [SCOPE], taskPollIntervalMs: 0, taskPollMaxPolls: 3 });
    const attempt = await executor.transfer({ workflowRunId: "run-1", directoryId: SCOPE, candidate: share() });
    expect(attempt.status).toBe("no_target_change");
    expect(attempt.providerMessage).toMatch(/GUANGYA_RESTORE_TIMEOUT.*inspectStaging/);
  });

  it("restore COMPLETED but no new video (a zip-only share) is a settled failure — the next share gets tried", async () => {
    const client = shareClient({ after: [{ fileId: "z", parentId: SCOPE, fileName: "game.zip", fileSize: 5e8, resType: 1 }] });
    const executor = new GuangYaStorageExecutor({ client, writeScopeDirectoryIds: [SCOPE], taskPollIntervalMs: 0 });
    const attempt = await executor.transfer({ workflowRunId: "run-1", directoryId: SCOPE, candidate: share() });
    expect(attempt.status).toBe("failed");
    expect(attempt.providerMessage).toMatch(/GUANGYA_SHARE_NO_VIDEO/);
  });

  it("a polling error AFTER the restore was accepted is pending (no_target_change), not a dead share", async () => {
    const client = shareClient({ after: [] });
    client.getTaskStatus = vi.fn(async () => { throw new Error("fetch failed: ECONNRESET"); });
    const executor = new GuangYaStorageExecutor({ client, writeScopeDirectoryIds: [SCOPE], taskPollIntervalMs: 0 });
    const attempt = await executor.transfer({ workflowRunId: "run-1", directoryId: SCOPE, candidate: share() });
    expect(attempt.status).toBe("no_target_change");
    expect(attempt.providerMessage).toMatch(/GUANGYA_RESTORE_PENDING.*inspectStaging/);
  });

  it("a TRANSPORT error on the restore submit itself is pending (the server may have taken it)", async () => {
    const client = shareClient({ after: [] });
    client.restoreShare = vi.fn(async () => { throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }); });
    const executor = new GuangYaStorageExecutor({ client, writeScopeDirectoryIds: [SCOPE], taskPollIntervalMs: 0 });
    const attempt = await executor.transfer({ workflowRunId: "run-1", directoryId: SCOPE, candidate: share() });
    expect(attempt.status).toBe("no_target_change");
    expect(attempt.providerMessage).toMatch(/GUANGYA_RESTORE_PENDING/);
  });

  it("a business rejection of the submit (server answered) is a settled failure", async () => {
    const client = shareClient({ after: [] });
    client.restoreShare = vi.fn(async () => { throw new Error("GUANGYA_API_FAILED: /userres/v1/restore_share status=200 msg=参数错误"); });
    const executor = new GuangYaStorageExecutor({ client, writeScopeDirectoryIds: [SCOPE], taskPollIntervalMs: 0 });
    const attempt = await executor.transfer({ workflowRunId: "run-1", directoryId: SCOPE, candidate: share() });
    expect(attempt.status).toBe("failed");
  });

  it("a successful submit answer WITHOUT a taskId is a settled failure (nothing was accepted to land)", async () => {
    const client = shareClient({ after: [] });
    client.restoreShare = vi.fn(async () => { throw new Error("GUANGYA_RESTORE_SHARE_FAILED: response missing data.taskId"); });
    const executor = new GuangYaStorageExecutor({ client, writeScopeDirectoryIds: [SCOPE], taskPollIntervalMs: 0 });
    const attempt = await executor.transfer({ workflowRunId: "run-1", directoryId: SCOPE, candidate: share() });
    expect(attempt.status).toBe("failed");
    expect(attempt.providerMessage).toMatch(/GUANGYA_RESTORE_SHARE_FAILED/);
  });

  it("a failing landing reread after a submit is pending, never an exception", async () => {
    const client = shareClient();
    client.listFiles = vi.fn<GuangYaStorageClient["listFiles"]>().mockResolvedValueOnce([]).mockRejectedValue(new Error("fetch failed"));
    const executor = new GuangYaStorageExecutor({ client, writeScopeDirectoryIds: [SCOPE], taskPollIntervalMs: 0 });
    const attempt = await executor.transfer({ workflowRunId: "run-1", directoryId: SCOPE, candidate: share() });
    expect(attempt.status).toBe("no_target_change");
    expect(attempt.providerMessage).toMatch(/GUANGYA_RESTORE_PENDING.*回读/);
  });

  it("a PARTIAL landing of a still-running restore is succeeded but keeps the pending note", async () => {
    const client = shareClient({ statuses: [1, 1, 1], after: [{ fileId: "e1", parentId: SCOPE, fileName: "S01E01.mkv", fileSize: 5e8, resType: 1 }] });
    const executor = new GuangYaStorageExecutor({ client, writeScopeDirectoryIds: [SCOPE], taskPollIntervalMs: 0, taskPollMaxPolls: 3 });
    const attempt = await executor.transfer({ workflowRunId: "run-1", directoryId: SCOPE, candidate: share() });
    expect(attempt.status).toBe("succeeded");
    expect(attempt.materializedFileIds).toEqual(["e1"]);
    expect(attempt.providerMessage).toMatch(/GUANGYA_RESTORE_TIMEOUT.*inspectStaging/);
  });

  it("polls exactly taskPollMaxPolls times and does not sleep after the last one", async () => {
    const client = shareClient({ statuses: [1, 1, 1, 1], after: [] });
    const executor = new GuangYaStorageExecutor({ client, writeScopeDirectoryIds: [SCOPE], taskPollIntervalMs: 0, taskPollMaxPolls: 3 });
    await executor.transfer({ workflowRunId: "run-1", directoryId: SCOPE, candidate: share() });
    expect(client.getTaskStatus).toHaveBeenCalledTimes(3);
  });

  it("an explicit terminal task status after acceptance is still a real failure", async () => {
    const client = shareClient({ statuses: [3], after: [] });
    const executor = new GuangYaStorageExecutor({ client, writeScopeDirectoryIds: [SCOPE], taskPollIntervalMs: 0 });
    const attempt = await executor.transfer({ workflowRunId: "run-1", directoryId: SCOPE, candidate: share() });
    expect(attempt.status).toBe("failed");
    expect(attempt.providerMessage).toMatch(/GUANGYA_RESTORE_FAILED/);
  });

  it("an auth error is rethrown (freeze the drive), never absorbed into a failed attempt", async () => {
    const client = shareClient({ token: async () => { throw new GuangYaAuthError("GUANGYA_AUTH_FAILED: 401 after refresh"); } });
    const executor = new GuangYaStorageExecutor({ client, writeScopeDirectoryIds: [SCOPE], taskPollIntervalMs: 0 });
    await expect(executor.transfer({ workflowRunId: "run-1", directoryId: SCOPE, candidate: share() })).rejects.toBeInstanceOf(GuangYaAuthError);
  });

  it("the write-scope guard still applies to share transfers", async () => {
    const client = shareClient();
    const executor = new GuangYaStorageExecutor({ client, writeScopeDirectoryIds: [SCOPE], taskPollIntervalMs: 0 });
    await expect(executor.transfer({ workflowRunId: "run-1", directoryId: "elsewhere", candidate: share() })).rejects.toThrow(/WRITE_SCOPE|scope/i);
    expect(client.restoreShare).not.toHaveBeenCalled();
  });
});
