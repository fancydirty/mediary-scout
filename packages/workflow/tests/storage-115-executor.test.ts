import { describe, expect, it } from "vitest";
import {
  createProtectedStorage115Executor,
  Pan115ApiGuard,
  Pan115RiskControlError,
  Storage115Executor,
  type Pan115ActionResult,
  type Pan115DirectoryInfo,
  type Pan115Item,
  type Pan115StorageApi,
  type ResourceCandidate,
} from "../src/index.js";

describe("Storage115Executor", () => {
  it("refuses to create a protected live executor without a configured write scope", () => {
    expect(() =>
      createProtectedStorage115Executor({
        api: new FakePan115Api(),
        env: {},
        apiGuardOptions: { minDelayMs: 0 },
      }),
    ).toThrow("MEDIA_TRACK_115_WRITE_SCOPE_REQUIRED");
  });

  it("uses the configured 115 test root as the default write scope", async () => {
    const api = new FakePan115Api({
      shareFiles: {
        abc123: [
          {
            fid: "file_1",
            n: "Show.S01E01.mkv",
            s: "1000000000",
          },
        ],
      },
      directoryInfo: {
        season_1: seasonPathInfo("test_root", "season_1"),
        outside_season: seasonPathInfo("other_root", "outside_season"),
      },
    });
    const executor = createProtectedStorage115Executor({
      api,
      env: {
        MEDIA_TRACK_115_TEST_ROOT_CID: "test_root",
      },
      apiGuardOptions: { minDelayMs: 0 },
    });

    await expect(
      executor.transfer({
        workflowRunId: "run_1",
        directoryId: "outside_season",
        candidate: candidateFixture({
          type: "115",
          providerPayload: {
            url: "https://115.com/s/abc123?password=pw",
            rawType: "115",
          },
        }),
      }),
    ).rejects.toThrow("WRITE_SCOPE_VIOLATION");

    await expect(
      executor.transfer({
        workflowRunId: "run_1",
        directoryId: "season_1",
        candidate: candidateFixture({
          type: "115",
          providerPayload: {
            url: "https://115.com/s/abc123?password=pw",
            rawType: "115",
          },
        }),
      }),
    ).resolves.toMatchObject({ status: "succeeded" });
    expect(api.receivedShares).toEqual([
      {
        shareCode: "abc123",
        receiveCode: "pw",
        directoryId: "season_1",
      },
    ]);
  });

  it("marks configured 115 library roots and the test root as protected flatten targets", async () => {
    const executor = createProtectedStorage115Executor({
      api: new FakePan115Api(),
      env: {
        MEDIA_TRACK_115_TEST_ROOT_CID: "test_root",
        CLAWD_MEDIA_ROOT_CID: "media_root",
        TV_SHOWS_CID: "tv_root",
      },
      apiGuardOptions: { minDelayMs: 0 },
    });

    await expect(executor.flattenDirectory("test_root")).rejects.toThrow(
      "SAFETY_VIOLATION: refusing to flatten protected directory cid=test_root",
    );
    await expect(executor.flattenDirectory("tv_root")).rejects.toThrow(
      "SAFETY_VIOLATION: refusing to flatten protected directory cid=tv_root",
    );
  });

  it("refuses recursive listing of protected root/parent/category directories", async () => {
    const executor = createProtectedStorage115Executor({
      api: new FakePan115Api(),
      env: {
        MEDIA_TRACK_115_TEST_ROOT_CID: "test_root",
        CLAWD_MEDIA_ROOT_CID: "media_root",
        TV_SHOWS_CID: "tv_root",
      },
      apiGuardOptions: { minDelayMs: 0 },
    });

    await expect(executor.listVideoFiles("test_root")).rejects.toThrow(
      "SAFETY_VIOLATION: refusing to recursively list videos in protected directory cid=test_root",
    );
    await expect(executor.listVideoFiles("tv_root")).rejects.toThrow("SAFETY_VIOLATION");
    await expect(executor.listTree({ directoryId: "media_root" })).rejects.toThrow("SAFETY_VIOLATION");
    // The 115 root cid "0" is always protected.
    await expect(executor.listUnparsedVideoFiles("0")).rejects.toThrow("SAFETY_VIOLATION");
  });

  it("transfers a selected 115 candidate and verifies newly materialized video files", async () => {
    const api = new FakePan115Api({
      shareFiles: {
        abc123: [
          {
            fid: "file_1",
            n: "Show.S01E01.mkv",
            s: "1000000000",
          },
        ],
      },
    });
    const executor = new Storage115Executor({ api });

    const attempt = await executor.transfer({
      workflowRunId: "run_1",
      directoryId: "123",
      candidate: candidateFixture({
        type: "115",
        providerPayload: {
          url: "https://115.com/s/abc123?password=pw",
          rawType: "115",
        },
      }),
    });

    expect(api.receivedShares).toEqual([
      {
        shareCode: "abc123",
        receiveCode: "pw",
        directoryId: "123",
      },
    ]);
    expect(attempt).toMatchObject({
      // Run-scoped id so it can't collide across runs/process restarts on the
      // global transfer_attempts.id primary key.
      id: "run_1_transfer_1",
      workflowRunId: "run_1",
      candidateId: "candidate_1",
      status: "succeeded",
      providerMessage: "",
      materializedFileIds: ["file_1"],
    });
    await expect(executor.listVideoFiles("123")).resolves.toEqual([
      {
        id: "file_1",
        storageDirectoryId: "123",
        name: "Show.S01E01.mkv",
        sizeBytes: 1_000_000_000,
        episodeCode: "S01E01",
        providerFileId: "file_1",
      },
    ]);
  });

  it("lists video files by media extension, not by episode wildcard", async () => {
    // A movie file has no SxxExx/第N集 code but is still a real video. Detection
    // must key off the media extension; the episode code is optional metadata.
    const api = new FakePan115Api({
      directories: {
        movie_dir: [
          { fid: "movie_v", n: "奥本海默 (2023).mkv", s: "28000000000" },
          { fid: "ep_v", n: "Show.S01E03.mkv", s: "1000000000" },
          { fid: "note_f", n: "readme.txt", s: "1024" },
        ],
      },
    });
    const executor = new Storage115Executor({ api });

    const files = await executor.listVideoFiles("movie_dir");

    expect(files).toEqual([
      {
        id: "movie_v",
        storageDirectoryId: "movie_dir",
        name: "奥本海默 (2023).mkv",
        sizeBytes: 28_000_000_000,
        episodeCode: null,
        providerFileId: "movie_v",
      },
      {
        id: "ep_v",
        storageDirectoryId: "movie_dir",
        name: "Show.S01E03.mkv",
        sizeBytes: 1_000_000_000,
        episodeCode: "S01E03",
        providerFileId: "ep_v",
      },
    ]);
  });

  it("records duplicate 115 transfers as no target change", async () => {
    const api = new FakePan115Api({
      receiveShareResults: {
        abc123: {
          ok: false,
          message: "资源已转存过(可能在其他目录)，目标目录未新增文件",
          alreadyTransferred: true,
        },
      },
    });
    const executor = new Storage115Executor({ api });

    const attempt = await executor.transfer({
      workflowRunId: "run_1",
      directoryId: "123",
      candidate: candidateFixture({
        type: "115",
        providerPayload: {
          url: "https://115.com/s/abc123?password=pw",
          rawType: "115",
        },
      }),
    });

    expect(attempt).toMatchObject({
      candidateId: "candidate_1",
      status: "no_target_change",
      providerMessage: "资源已转存过(可能在其他目录)，目标目录未新增文件",
      materializedFileIds: [],
    });
  });

  it("removes an ephemeral sub-directory (e.g. staging) via 115 delete", async () => {
    const api = new FakePan115Api();
    const executor = new Storage115Executor({ api, writeScopeDirectoryIds: [] });

    const result = await executor.removeDirectory("staging_run_movie_p1");

    expect(result).toEqual({ removed: true });
    expect(api.deletes).toEqual([{ fileIds: ["staging_run_movie_p1"] }]);
  });

  it("refuses to remove a protected/root directory", async () => {
    const api = new FakePan115Api();
    const executor = new Storage115Executor({ api, protectedDirectoryIds: ["tv_root"] });

    await expect(executor.removeDirectory("tv_root")).rejects.toThrow("SAFETY_VIOLATION");
    expect(api.deletes).toEqual([]);
  });

  it("adds magnet candidates as offline tasks through 115", async () => {
    const api = new FakePan115Api();
    const executor = new Storage115Executor({ api, offlineMaterializeAttempts: 0 });

    const attempt = await executor.transfer({
      workflowRunId: "run_1",
      directoryId: "123",
      candidate: candidateFixture({
        type: "magnet",
        providerPayload: {
          url: "magnet:?xt=urn:btih:abcdef",
          rawType: "magnet",
        },
      }),
    });

    expect(api.offlineTasks).toEqual([
      {
        url: "magnet:?xt=urn:btih:abcdef",
        directoryId: "123",
      },
    ]);
    expect(attempt).toMatchObject({
      status: "no_target_change",
      providerMessage: "offline task accepted; no target video materialized yet",
      materializedFileIds: [],
    });
  });

  it("briefly confirms an offline task's 秒传 before judging it materialized", async () => {
    const api = new FakePan115Api();
    // A 秒传 hit (115 already has the resource cached) reflects a beat after the
    // task is accepted — the video appears on the second list. The short
    // confirmation window catches it without waiting on a real download.
    let graceWaits = 0;
    const executor = new Storage115Executor({
      api,
      apiGuardOptions: { minDelayMs: 0 },
      offlineMaterializeAttempts: 3,
      offlineMaterializePollMs: 25,
      sleep: async () => {
        graceWaits += 1;
        if (graceWaits === 2) {
          api.directories["123"] = [
            { fid: "magnet_v", n: "Movie.2023.2160p.mkv", s: "8000000000" },
          ];
        }
      },
    });

    await executor.transfer({
      workflowRunId: "run_magnet",
      directoryId: "123",
      candidate: candidateFixture({
        type: "magnet",
        providerPayload: {
          url: "magnet:?xt=urn:btih:abcdef",
          rawType: "magnet",
        },
      }),
    });

    // It confirmed across the short window — did not give up on the first
    // (empty) check, and stopped as soon as the 秒传'd video appeared.
    expect(graceWaits).toBe(2);
    // The video is now in the staging tree, so the workflow's subsequent
    // listTree scan finds it (a movie file has no episode code, so the probe is
    // extension-based, not episode-based).
    const tree = await executor.listTree({ directoryId: "123" });
    expect(tree.map((file) => file.path)).toContain("Movie.2023.2160p.mkv");
    // It 秒传'd, so the queued task is real — do NOT cancel it.
    expect(api.removedOfflineHashes).toEqual([]);
  });

  it("cancels a non-秒传 offline task so it does not drain the quota", async () => {
    const api = new FakePan115Api();
    // Nothing materializes in the grace window → 115 has no cached copy → the
    // queued download is junk and must be canceled by its info_hash.
    const executor = new Storage115Executor({ api, offlineMaterializeAttempts: 0 });

    const attempt = await executor.transfer({
      workflowRunId: "run_junk",
      directoryId: "123",
      candidate: candidateFixture({
        type: "magnet",
        providerPayload: {
          url: "magnet:?xt=urn:btih:57E6D442793C87D7F81EECC675AB4EB3B4925BD3&dn=junk",
          rawType: "magnet",
        },
      }),
    });

    expect(attempt.status).toBe("no_target_change");
    expect(api.removedOfflineHashes).toEqual([
      "57e6d442793c87d7f81eecc675ab4eb3b4925bd3",
    ]);
  });

  it("does NOT cancel an offline task 115 refused as a duplicate (任务已存在)", async () => {
    const api = new FakePan115Api();
    // 115 rejecting a duplicate ("任务已存在") is anti-spam, not a junk resource —
    // it may be a prior good task we must not kill.
    api.addOfflineTask = async (input) => {
      api.offlineTasks.push({ ...input });
      return { ok: true, alreadyTransferred: true, message: "任务已存在" };
    };
    const executor = new Storage115Executor({ api, offlineMaterializeAttempts: 0 });

    const attempt = await executor.transfer({
      workflowRunId: "run_dup",
      directoryId: "123",
      candidate: candidateFixture({
        type: "magnet",
        providerPayload: {
          url: "magnet:?xt=urn:btih:57E6D442793C87D7F81EECC675AB4EB3B4925BD3",
          rawType: "magnet",
        },
      }),
    });

    expect(attempt.status).toBe("no_target_change");
    expect(api.removedOfflineHashes).toEqual([]);
  });

  it("rejects flattening protected directories", async () => {
    const executor = new Storage115Executor({
      api: new FakePan115Api(),
      protectedDirectoryIds: ["0", "tv_root"],
    });

    await expect(executor.flattenDirectory("tv_root")).rejects.toThrow(
      "SAFETY_VIOLATION: refusing to flatten protected directory cid=tv_root",
    );
  });

  it("moves nested videos to a safe season leaf and removes empty child folders", async () => {
    const api = new FakePan115Api({
      directories: {
        season_1: [
          {
            cid: "nested_1",
            n: "Pack",
            fc: "0",
          },
        ],
        nested_1: [
          {
            fid: "nested_file_1",
            n: "Show.S01E02.mkv",
            s: "2000000000",
          },
        ],
      },
      directoryInfo: {
        season_1: {
          state: true,
          path: [
            { cid: "0", name: "root" },
            { cid: "tv_root", name: "TV Shows" },
            { cid: "show_1", name: "Show" },
            { cid: "season_1", name: "Season 1" },
          ],
        },
      },
    });
    const executor = new Storage115Executor({ api, protectedDirectoryIds: ["0", "tv_root"] });

    const result = await executor.flattenDirectory("season_1");

    expect(api.moves).toEqual([
      {
        fileIds: ["nested_file_1"],
        targetDirectoryId: "season_1",
      },
    ]);
    expect(api.deletes).toEqual([
      {
        fileIds: ["nested_1"],
      },
    ]);
    expect(result).toEqual({
      moved: ["nested_file_1"],
      removed: ["nested_1"],
    });
  });

  it("allows transfers when the target directory is inside the configured write scope", async () => {
    const api = new FakePan115Api({
      shareFiles: {
        abc123: [
          {
            fid: "file_1",
            n: "Show.S01E01.mkv",
            s: "1000000000",
          },
        ],
      },
      directoryInfo: {
        season_1: seasonPathInfo("test_root", "season_1"),
      },
    });
    const executor = new Storage115Executor({ api, writeScopeDirectoryIds: ["test_root"] });

    const attempt = await executor.transfer({
      workflowRunId: "run_1",
      directoryId: "season_1",
      candidate: candidateFixture({
        type: "115",
        providerPayload: {
          url: "https://115.com/s/abc123?password=pw",
          rawType: "115",
        },
      }),
    });

    expect(attempt.status).toBe("succeeded");
    expect(api.receivedShares).toHaveLength(1);
  });

  it("rejects transfers outside the configured write scope before touching the target", async () => {
    const api = new FakePan115Api({
      shareFiles: {
        abc123: [
          {
            fid: "file_1",
            n: "Show.S01E01.mkv",
            s: "1000000000",
          },
        ],
      },
      directoryInfo: {
        outside_season: seasonPathInfo("other_root", "outside_season"),
      },
    });
    const executor = new Storage115Executor({ api, writeScopeDirectoryIds: ["test_root"] });

    await expect(
      executor.transfer({
        workflowRunId: "run_1",
        directoryId: "outside_season",
        candidate: candidateFixture({
          type: "115",
          providerPayload: {
            url: "https://115.com/s/abc123?password=pw",
            rawType: "115",
          },
        }),
      }),
    ).rejects.toThrow("WRITE_SCOPE_VIOLATION");
    expect(api.listCalls).toEqual([]);
    expect(api.receivedShares).toEqual([]);
  });

  it("rejects delete operations outside the configured write scope", async () => {
    const api = new FakePan115Api({
      directoryInfo: {
        outside_season: seasonPathInfo("other_root", "outside_season"),
      },
    });
    const executor = new Storage115Executor({ api, writeScopeDirectoryIds: ["test_root"] });

    await expect(
      executor.deleteFiles({
        directoryId: "outside_season",
        fileIds: ["file_1"],
      }),
    ).rejects.toThrow("WRITE_SCOPE_VIOLATION");
    expect(api.deletes).toEqual([]);
  });

  it("deletes only file ids verified inside the target directory", async () => {
    const api = new FakePan115Api({
      directories: {
        season_1: [
          {
            fid: "file_1",
            n: "Show.S01E01.mkv",
            s: "1000000000",
          },
        ],
      },
      directoryInfo: {
        season_1: seasonPathInfo("test_root", "season_1"),
      },
    });
    const executor = new Storage115Executor({ api, writeScopeDirectoryIds: ["test_root"] });

    await expect(
      executor.deleteFiles({
        directoryId: "season_1",
        fileIds: ["file_1"],
      }),
    ).resolves.toEqual({ deleted: ["file_1"] });
    expect(api.deletes).toEqual([{ fileIds: ["file_1"] }]);
  });

  it("rejects delete file ids that were not verified in the target directory", async () => {
    const api = new FakePan115Api({
      directories: {
        season_1: [
          {
            fid: "file_1",
            n: "Show.S01E01.mkv",
            s: "1000000000",
          },
        ],
      },
      directoryInfo: {
        season_1: seasonPathInfo("test_root", "season_1"),
      },
    });
    const executor = new Storage115Executor({ api, writeScopeDirectoryIds: ["test_root"] });

    await expect(
      executor.deleteFiles({
        directoryId: "season_1",
        fileIds: ["file_2"],
      }),
    ).rejects.toThrow("SAFETY_VIOLATION: refusing to delete unverified file ids");
    expect(api.deletes).toEqual([]);
  });

  it("allows creating folders only under the configured write scope", async () => {
    const api = new FakePan115Api({
      directoryInfo: {
        outside_parent: seasonPathInfo("other_root", "outside_parent"),
      },
    });
    const executor = new Storage115Executor({ api, writeScopeDirectoryIds: ["test_root"] });

    await expect(
      executor.createDirectory({
        name: "media-track-smoke",
        parentId: "outside_parent",
      }),
    ).rejects.toThrow("WRITE_SCOPE_VIOLATION");

    await expect(
      executor.createDirectory({
        name: "media-track-smoke",
        parentId: "test_root",
      }),
    ).resolves.toContain("test_root_media-track-smoke");
  });

  it("spaces 115 API calls through the configured guard", async () => {
    const api = new FakePan115Api({
      shareFiles: {
        abc123: [
          {
            fid: "file_1",
            n: "Show.S01E01.mkv",
            s: "1000000000",
          },
        ],
      },
    });
    let now = 0;
    const sleeps: number[] = [];
    const guard = new Pan115ApiGuard({
      minDelayMs: 750,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });
    const executor = new Storage115Executor({ api, apiGuard: guard });

    await executor.transfer({
      workflowRunId: "run_1",
      directoryId: "123",
      candidate: candidateFixture({
        type: "115",
        providerPayload: {
          url: "https://115.com/s/abc123?password=pw",
          rawType: "115",
        },
      }),
    });

    expect(api.listCalls).toEqual(["123", "123"]);
    expect(api.receivedShares).toHaveLength(1);
    expect(sleeps).toEqual([750, 750]);
  });

  it("opens a circuit breaker when 115 returns a risk-control signal", async () => {
    const api = new FakePan115Api({
      receiveShareResults: {
        abc123: {
          ok: false,
          message: "请求过于频繁，请稍后再试",
          code: 429,
        },
      },
    });
    const events: string[] = [];
    const guard = new Pan115ApiGuard({
      onEvent: (event) => events.push(event.kind),
    });
    const executor = new Storage115Executor({ api, apiGuard: guard });

    await expect(
      executor.transfer({
        workflowRunId: "run_1",
        directoryId: "123",
        candidate: candidateFixture({
          type: "115",
          providerPayload: {
            url: "https://115.com/s/abc123?password=pw",
            rawType: "115",
          },
        }),
      }),
    ).rejects.toBeInstanceOf(Pan115RiskControlError);

    await expect(executor.listVideoFiles("123")).rejects.toThrow("circuit breaker open");
    expect(api.listCalls).toEqual(["123"]);
    expect(events).toContain("risk_detected");
    expect(events).toContain("circuit_open");
  });

  it("stops before exceeding the configured 115 API call budget", async () => {
    const api = new FakePan115Api({
      shareFiles: {
        abc123: [
          {
            fid: "file_1",
            n: "Show.S01E01.mkv",
            s: "1000000000",
          },
        ],
      },
    });
    const guard = new Pan115ApiGuard({ maxCallsPerOperation: 2 });
    const executor = new Storage115Executor({ api, apiGuard: guard });

    await expect(
      executor.transfer({
        workflowRunId: "run_1",
        directoryId: "123",
        candidate: candidateFixture({
          type: "115",
          providerPayload: {
            url: "https://115.com/s/abc123?password=pw",
            rawType: "115",
          },
        }),
      }),
    ).rejects.toThrow("API call budget exhausted");
    expect(api.listCalls).toEqual(["123"]);
    expect(api.receivedShares).toHaveLength(1);
  });

  it("reads guard budget overrides from the environment", async () => {
    const api = new FakePan115Api({
      directories: { season_1: [] },
      directoryInfo: {
        season_1: seasonPathInfo("test_root", "season_1"),
      },
    });
    const executor = createProtectedStorage115Executor({
      api,
      env: {
        MEDIA_TRACK_115_TEST_ROOT_CID: "test_root",
        MEDIA_TRACK_115_MAX_API_CALLS: "2",
        MEDIA_TRACK_115_MIN_DELAY_MS: "1",
      },
    });

    await executor.listVideoFiles("season_1");
    await executor.listVideoFiles("season_1");
    await expect(executor.listVideoFiles("season_1")).rejects.toThrow(
      "maxCallsPerOperation=2",
    );
  });

  it("rejects malformed guard budget environment values", () => {
    expect(() =>
      createProtectedStorage115Executor({
        api: new FakePan115Api(),
        env: {
          MEDIA_TRACK_115_TEST_ROOT_CID: "test_root",
          MEDIA_TRACK_115_MAX_API_CALLS: "many",
        },
      }),
    ).toThrow("MEDIA_TRACK_115_GUARD_OPTION_INVALID");
  });

  it("stops scanning when a list response is too large for the guard policy", async () => {
    const api = new FakePan115Api({
      directories: {
        big: Array.from({ length: 231 }, (_, index) => ({
          fid: `file_${index}`,
          n: `NonVideo.${index}.txt`,
          s: "100",
        })),
      },
    });
    const guard = new Pan115ApiGuard({ maxListItemsPerResponse: 230 });
    const executor = new Storage115Executor({ api, apiGuard: guard });

    await expect(executor.listVideoFiles("big")).rejects.toThrow(
      "listItems returned 231 items, above maxListItemsPerResponse=230",
    );
    await expect(executor.listVideoFiles("big")).rejects.toThrow("circuit breaker open");
    expect(api.listCalls).toEqual(["big"]);
  });
});

class FakePan115Api implements Pan115StorageApi {
  readonly directories: Record<string, Pan115Item[]>;
  readonly shareFiles: Record<string, Pan115Item[]>;
  readonly receiveShareResults: Record<string, Pan115ActionResult>;
  readonly directoryInfo: Record<string, Pan115DirectoryInfo>;
  readonly receivedShares: Array<{ shareCode: string; receiveCode: string; directoryId: string }> = [];
  readonly offlineTasks: Array<{ url: string; directoryId: string }> = [];
  readonly removedOfflineHashes: string[] = [];
  readonly moves: Array<{ fileIds: string[]; targetDirectoryId: string }> = [];
  readonly deletes: Array<{ fileIds: string[] }> = [];
  readonly renames: Array<{ fileId: string; newName: string }> = [];
  readonly listCalls: string[] = [];
  private nextFolder = 1;

  constructor(input: {
    directories?: Record<string, Pan115Item[]>;
    shareFiles?: Record<string, Pan115Item[]>;
    receiveShareResults?: Record<string, Pan115ActionResult>;
    directoryInfo?: Record<string, Pan115DirectoryInfo>;
  } = {}) {
    this.directories = cloneDirectories(input.directories ?? {});
    this.shareFiles = cloneDirectories(input.shareFiles ?? {});
    this.receiveShareResults = { ...(input.receiveShareResults ?? {}) };
    this.directoryInfo = { ...(input.directoryInfo ?? {}) };
  }

  async createFolder(input: { name: string; parentId: string }): Promise<string> {
    const id = `${input.parentId}_${input.name}_${this.nextFolder}`;
    this.nextFolder += 1;
    this.directories[id] = [];
    return id;
  }

  async listItems(input: { directoryId: string }): Promise<Pan115Item[]> {
    this.listCalls.push(input.directoryId);
    return [...(this.directories[input.directoryId] ?? [])];
  }

  async getDirectoryInfo(input: { directoryId: string }): Promise<Pan115DirectoryInfo | null> {
    return this.directoryInfo[input.directoryId] ?? {
      state: true,
      path: [
        { cid: "0", name: "root" },
        { cid: input.directoryId, name: "Season 1" },
      ],
    };
  }

  async receiveShare(input: {
    shareCode: string;
    receiveCode: string;
    directoryId: string;
  }): Promise<Pan115ActionResult> {
    this.receivedShares.push({ ...input });
    const configuredResult = this.receiveShareResults[input.shareCode];
    if (configuredResult) {
      return configuredResult;
    }
    const files = this.shareFiles[input.shareCode] ?? [];
    this.directories[input.directoryId] = [...(this.directories[input.directoryId] ?? []), ...files];
    return { ok: true, message: "" };
  }

  async addOfflineTask(input: { url: string; directoryId: string }): Promise<Pan115ActionResult> {
    this.offlineTasks.push({ ...input });
    return { ok: true, message: "offline task accepted" };
  }

  async removeOfflineTask(input: { infoHashes: string[] }): Promise<Pan115ActionResult> {
    this.removedOfflineHashes.push(...input.infoHashes);
    return { ok: true, message: "" };
  }

  async moveItems(input: { fileIds: string[]; targetDirectoryId: string }): Promise<Pan115ActionResult> {
    this.moves.push({ fileIds: [...input.fileIds], targetDirectoryId: input.targetDirectoryId });
    const movedItems: Pan115Item[] = [];
    const wantedFileIds = new Set(input.fileIds);
    for (const [directoryId, items] of Object.entries(this.directories)) {
      const remaining: Pan115Item[] = [];
      for (const item of items) {
        const fileId = String(item.fid ?? item.file_id ?? item.id ?? "");
        if (wantedFileIds.has(fileId)) {
          movedItems.push(item);
        } else {
          remaining.push(item);
        }
      }
      this.directories[directoryId] = remaining;
    }
    this.directories[input.targetDirectoryId] = [
      ...(this.directories[input.targetDirectoryId] ?? []),
      ...movedItems,
    ];
    return { ok: true, message: "" };
  }

  async deleteItems(input: { fileIds: string[] }): Promise<Pan115ActionResult> {
    this.deletes.push({ fileIds: [...input.fileIds] });
    return { ok: true, message: "" };
  }

  async renameFile(input: { fileId: string; newName: string }): Promise<Pan115ActionResult> {
    this.renames.push({ ...input });
    for (const items of Object.values(this.directories)) {
      for (const item of items) {
        const fileId = String(item.fid ?? item.file_id ?? item.id ?? "");
        if (fileId === input.fileId) {
          item.name = input.newName;
          item.n = input.newName;
        }
      }
    }
    return { ok: true, message: "" };
  }
}

function candidateFixture(input: {
  type: ResourceCandidate["type"];
  providerPayload: Record<string, unknown>;
}): ResourceCandidate {
  return {
    id: "candidate_1",
    snapshotId: "snapshot_1",
    index: 0,
    title: "Show S01E01",
    type: input.type,
    source: "pansou",
    episodeHints: ["S01E01"],
    qualityHints: ["4K"],
    providerPayload: input.providerPayload,
  };
}

function cloneDirectories(input: Record<string, Pan115Item[]>): Record<string, Pan115Item[]> {
  return Object.fromEntries(
    Object.entries(input).map(([directoryId, items]) => [
      directoryId,
      items.map((item) => ({ ...item })),
    ]),
  );
}

function seasonPathInfo(rootId: string, seasonId: string): Pan115DirectoryInfo {
  return {
    state: true,
    path: [
      { cid: "0", name: "root" },
      { cid: rootId, name: "Media Track Test Root" },
      { cid: "show_1", name: "Show" },
      { cid: seasonId, name: "Season 1" },
    ],
  };
}
