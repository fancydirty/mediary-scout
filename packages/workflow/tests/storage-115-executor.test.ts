import { describe, expect, it } from "vitest";
import {
  createBootstrapPan115CookieStorageExecutor,
  createProtectedStorage115Executor,
  infoHashFromMagnet,
  Pan115ApiGuard,
  Pan115AuthError,
  Pan115RiskControlError,
  PAN115_TRANSFER_RESERVE_CALLS,
  Storage115Executor,
  type Pan115ActionResult,
  type Pan115DirectoryInfo,
  type Pan115Item,
  type Pan115OfflineTask,
  type Pan115StorageApi,
  type ResourceCandidate,
} from "../src/index.js";

describe("infoHashFromMagnet", () => {
  it("reads a 40-char hex btih, lowercased", () => {
    const hex = "ABCDEF0123456789ABCDEF0123456789ABCDEF01";
    expect(infoHashFromMagnet(`magnet:?xt=urn:btih:${hex}&dn=x`)).toBe(hex.toLowerCase());
  });

  it("decodes a 32-char base32 btih to hex so base32 magnets are cancellable", () => {
    // 32 'A's = 20 zero bytes = 40 hex zeros; 32 '7's = 20 0xFF bytes = 40 'f's.
    expect(infoHashFromMagnet("magnet:?xt=urn:btih:" + "A".repeat(32))).toBe("0".repeat(40));
    expect(infoHashFromMagnet("magnet:?xt=urn:btih:" + "7".repeat(32))).toBe("f".repeat(40));
  });

  it("returns null for non-magnet or malformed links", () => {
    expect(infoHashFromMagnet("https://115.com/s/abc")).toBeNull();
    expect(infoHashFromMagnet("magnet:?xt=urn:btih:tooshort")).toBeNull();
  });
});

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

  it("createBootstrapPan115CookieStorageExecutor does NOT require a write scope (escapes the provisioning catch-22)", () => {
    // The protected factory throws on empty scope; the bootstrap variant must not,
    // so connect-time provisionCategoryDirs can create the media tree under root.
    expect(() => createBootstrapPan115CookieStorageExecutor({ cookie: "UID=1_abc" })).not.toThrow();
    expect(createBootstrapPan115CookieStorageExecutor({ cookie: "UID=1_abc" })).toBeInstanceOf(Storage115Executor);
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

  it("the DEFAULT 秒传 window reaches past the old 2-poll span (a ~late-landing 秒传 is still caught)", async () => {
    // A real-115 survey measured live 秒传s landing at up to ~4.3s — past the old
    // 2×2s window. The default must now span ~8s (4 polls) or ~20% of good magnets
    // would be mis-judged dead. Here the video only appears on the 3rd grace wait,
    // which the old default (2) would have missed and cancelled.
    const api = new FakePan115Api();
    let graceWaits = 0;
    const executor = new Storage115Executor({
      api,
      apiGuardOptions: { minDelayMs: 0 },
      // NB: offlineMaterializeAttempts intentionally NOT set — exercise the default.
      offlineMaterializePollMs: 1,
      sleep: async () => {
        graceWaits += 1;
        if (graceWaits === 3) {
          api.directories["123"] = [{ fid: "late_v", n: "Movie.2160p.mkv", s: "9000000000" }];
        }
      },
    });

    const attempt = await executor.transfer({
      workflowRunId: "run_late_miaochuan",
      directoryId: "123",
      candidate: candidateFixture({ type: "magnet", providerPayload: { url: "magnet:?xt=urn:btih:abcdef", rawType: "magnet" } }),
    });

    expect(attempt.status).toBe("succeeded");
    expect(attempt.materializedFileIds).toEqual(["late_v"]);
    expect(api.removedOfflineHashes).toEqual([]); // caught in time → not cancelled
  });

  it("lists nested subdirectories recursively (the flatten wrapper-dir source)", async () => {
    const api = new FakePan115Api({
      directories: {
        staging: [{ isDirectory: true, cid: "wrap", n: "[Grp] Show S01" }],
        wrap: [
          { isDirectory: true, cid: "inner", n: "Extras" },
          { fid: "f1", n: "Show - 01.mkv", s: "9" },
        ],
        inner: [{ fid: "f2", n: "NCOP.mkv", s: "1" }],
      },
    });
    const executor = new Storage115Executor({ api });

    const subdirs = await executor.listSubdirectories({ directoryId: "staging" });

    expect(subdirs).toEqual([
      { id: "wrap", path: "[Grp] Show S01" },
      { id: "inner", path: "[Grp] Show S01/Extras" },
    ]);
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

  it("does not cancel an offline task 115 reports as a 秒传 via statusText 下载成功, percentDone stuck at 0 (file listing lags)", async () => {
    const hash = "57e6d442793c87d7f81eecc675ab4eb3b4925bd3";
    // REAL 115 shape (measured on the test root): a 秒传 reports statusText
    // "下载成功" while percentDone STAYS 0 the whole time — the file is merely slow
    // to list. A percentDone>=100 check would NEVER recognize it and would cancel
    // this good 秒传; reading statusText prevents that.
    const api = new FakePan115Api({
      offlineTaskList: [
        { infoHash: hash, name: "Movie", percentDone: 0, status: 1, statusText: "下载成功", url: "" },
      ],
    });
    const executor = new Storage115Executor({
      api,
      offlineMaterializeAttempts: 2,
      offlineMaterializePollMs: 1,
      sleep: async () => {},
    });

    const attempt = await executor.transfer({
      workflowRunId: "run_slow_miaochuan",
      directoryId: "123",
      candidate: candidateFixture({
        type: "magnet",
        providerPayload: { url: `magnet:?xt=urn:btih:${hash.toUpperCase()}`, rawType: "magnet" },
      }),
    });

    expect(attempt.status).toBe("no_target_change");
    expect(api.removedOfflineHashes).toEqual([]); // the 秒传 was kept (NOT cancelled)
    expect(api.listOfflineTasksCalls).toBeGreaterThan(0); // status was actually read
    // The attempt carries the ALIVE signal so the dead-link recorder (#15) never
    // poisons this confirmed-but-lagging 秒传.
    expect(attempt.providerMessage).toMatch(/下载成功|秒传 confirmed/);
  });

  it("cancels an offline task stuck 等待中 (no cache, percentDone 0 — the dead-magnet signature)", async () => {
    const hash = "57e6d442793c87d7f81eecc675ab4eb3b4925bd3";
    // REAL dead/no-cache shape: 115 accepts the magnet but the task sits at
    // statusText "等待中" with percentDone 0 forever. We never wait on a real
    // download, so it is dead-for-us → cancel it.
    const api = new FakePan115Api({
      offlineTaskList: [
        { infoHash: hash, name: "Movie", percentDone: 0, status: 1, statusText: "等待中", url: "" },
      ],
    });
    const executor = new Storage115Executor({
      api,
      offlineMaterializeAttempts: 2,
      offlineMaterializePollMs: 1,
      sleep: async () => {},
    });

    const attempt = await executor.transfer({
      workflowRunId: "run_stuck_waiting",
      directoryId: "123",
      candidate: candidateFixture({
        type: "magnet",
        providerPayload: { url: `magnet:?xt=urn:btih:${hash}`, rawType: "magnet" },
      }),
    });

    expect(attempt.status).toBe("no_target_change");
    expect(api.removedOfflineHashes).toEqual([hash]); // stuck 等待中 → cancelled
  });

  it("flags an unresolvable magnet (offline-task name == infohash → no metadata, fake/dead)", async () => {
    const hash = "57e6d442793c87d7f81eecc675ab4eb3b4925bd3";
    // 115 accepted a fake/non-existent magnet but resolved NO metadata, so it shows
    // the raw infohash as the task name. Measured on the real test root.
    const api = new FakePan115Api({
      offlineTaskList: [{ infoHash: hash, name: hash, percentDone: 0, status: 1, statusText: "等待中", url: "" }],
    });
    const executor = new Storage115Executor({ api, offlineMaterializeAttempts: 2, offlineMaterializePollMs: 1, sleep: async () => {} });

    const attempt = await executor.transfer({
      workflowRunId: "run_unresolved",
      directoryId: "123",
      candidate: candidateFixture({ type: "magnet", providerPayload: { url: `magnet:?xt=urn:btih:${hash}`, rawType: "magnet" } }),
    });

    expect(attempt.status).toBe("no_target_change");
    expect(api.removedOfflineHashes).toEqual([hash]); // still cancelled (frees quota)
    // The attempt carries the signal the dead-link recorder uses to pick a longer TTL.
    expect(attempt.providerMessage).toMatch(/name == infohash/);
  });

  it("cancels an offline task that task status shows still downloading (not 秒传)", async () => {
    const hash = "57e6d442793c87d7f81eecc675ab4eb3b4925bd3";
    const api = new FakePan115Api({
      offlineTaskList: [
        { infoHash: hash, name: "Movie", percentDone: 12, status: 2, statusText: "下载中", url: "" },
      ],
    });
    const executor = new Storage115Executor({
      api,
      offlineMaterializeAttempts: 2,
      offlineMaterializePollMs: 1,
      sleep: async () => {},
    });

    const attempt = await executor.transfer({
      workflowRunId: "run_real_dl",
      directoryId: "123",
      candidate: candidateFixture({
        type: "magnet",
        providerPayload: { url: `magnet:?xt=urn:btih:${hash}`, rawType: "magnet" },
      }),
    });

    expect(attempt.status).toBe("no_target_change");
    expect(api.removedOfflineHashes).toEqual([hash]); // in-flight download → cancelled
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

  it("caps recursive video collection so a deep tree can't fan out unbounded listItems", async () => {
    // A pathological chain deeper than the cap (6): a video sits beyond the
    // limit and must NOT be collected, and the walk must NOT keep issuing
    // listItems past it — otherwise a corrupt/adversarial tree could trip 风控.
    const api = new FakePan115Api({
      directories: {
        deep_root: [
          { fid: "v_shallow", n: "Show.S01E01.mkv", s: "1000000000" },
          { cid: "lvl2", n: "L2", fc: "0" },
        ],
        lvl2: [{ cid: "lvl3", n: "L3", fc: "0" }],
        lvl3: [{ cid: "lvl4", n: "L4", fc: "0" }],
        lvl4: [{ cid: "lvl5", n: "L5", fc: "0" }],
        lvl5: [{ cid: "lvl6", n: "L6", fc: "0" }],
        lvl6: [{ cid: "lvl7", n: "L7", fc: "0" }],
        lvl7: [{ fid: "v_deep", n: "Show.S01E09.mkv", s: "1000000000" }],
      },
      directoryInfo: {
        deep_root: {
          state: true,
          path: [
            { cid: "0", name: "root" },
            { cid: "tv_root", name: "TV Shows" },
            { cid: "deep_root", name: "Season 1" },
          ],
        },
      },
    });
    const executor = new Storage115Executor({ api, protectedDirectoryIds: ["0", "tv_root"] });

    const videos = await executor.listVideoFiles("deep_root");

    // The shallow video is collected; the one beyond the depth cap is not.
    expect(videos.map((video) => video.name)).toContain("Show.S01E01.mkv");
    expect(videos.map((video) => video.name)).not.toContain("Show.S01E09.mkv");
    // The walk stopped at the cap — it never listed the directory past it.
    expect(api.listCalls).not.toContain("lvl7");
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

  it("deletes a subtitle (non-video) file — cleanup must verify against ALL files, not just videos (光鸭 e2e 2026-07-02 暴露的跨盘缺陷)", async () => {
    const api = new FakePan115Api({
      directories: {
        season_1: [
          {
            fid: "sub_1",
            n: "多余字幕.srt",
            s: "88753",
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
        fileIds: ["sub_1"],
      }),
    ).resolves.toEqual({ deleted: ["sub_1"] });
    expect(api.deletes).toEqual([{ fileIds: ["sub_1"] }]);
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

describe("115 factories wire the transfer reserve (收尾永远有额度)", () => {
  it("createProtectedStorage115Executor: transfers stop at hard − PAN115_TRANSFER_RESERVE_CALLS, listings continue", async () => {
    const api = new FakePan115Api({
      directories: { season_1: [] },
      directoryInfo: { season_1: seasonPathInfo("test_root", "season_1") },
    });
    const executor = createProtectedStorage115Executor({
      api,
      env: {
        MEDIA_TRACK_115_TEST_ROOT_CID: "test_root",
        MEDIA_TRACK_115_MAX_API_CALLS: "44", // transfer cutoff = 44 − 40 = 4
        MEDIA_TRACK_115_MIN_DELAY_MS: "1",
      },
    });
    expect(executor.apiCallBudget()).toBe(44);
    expect(executor.apiTransferCallBudget()).toBe(4);
    for (let i = 0; i < 4; i += 1) {
      await executor.listVideoFiles("season_1");
    }
    // transfer(): the refusal lands on the transfer line BEFORE any preparatory call
    // (no write-scope check, no before-listing) — nothing is received.
    await expect(
      executor.transfer({
        workflowRunId: "run_1",
        directoryId: "season_1",
        candidate: candidateFixture({
          type: "115",
          providerPayload: { url: "https://115.com/s/abc123?password=pw", rawType: "115" },
        }),
      }),
    ).rejects.toThrow(/transfer budget exhausted before receiveShare/);
    expect(api.receivedShares).toHaveLength(0);
    await executor.listVideoFiles("season_1"); // still allowed (wrap-up class)
  });

  it("createBootstrapPan115CookieStorageExecutor carries the same reserve (kept in sync)", () => {
    const executor = createBootstrapPan115CookieStorageExecutor({ cookie: "UID=1_abc" });
    expect(executor.apiCallBudget()).toBe(300);
    expect(executor.apiTransferCallBudget()).toBe(300 - PAN115_TRANSFER_RESERVE_CALLS);
  });

  it("an explicit apiGuardOptions.transferReserveCalls overrides the factory default", () => {
    const api = new FakePan115Api({ directories: { season_1: [] } });
    const executor = createProtectedStorage115Executor({
      api,
      env: { MEDIA_TRACK_115_TEST_ROOT_CID: "test_root" },
      apiGuardOptions: { minDelayMs: 0, transferReserveCalls: 0 },
    });
    expect(executor.apiTransferCallBudget()).toBe(executor.apiCallBudget());
  });

  it("transfer() fails fast ON the transfer line — no write-scope check, no before-snapshot listing is wasted", async () => {
    const api = new FakePan115Api({ directories: { season_1: [] } });
    const guard = new Pan115ApiGuard({ minDelayMs: 0, maxCallsPerOperation: 10, transferReserveCalls: 6 });
    const executor = new Storage115Executor({ api, apiGuard: guard });
    for (let i = 0; i < 4; i += 1) {
      await executor.listVideoFiles("season_1"); // reaches the transfer line (10 − 6 = 4)
    }

    await expect(
      executor.transfer({
        workflowRunId: "run_1",
        directoryId: "season_1",
        candidate: candidateFixture({
          type: "115",
          providerPayload: { url: "https://115.com/s/abc123?password=pw", rawType: "115" },
        }),
      }),
    ).rejects.toThrow(/transfer budget exhausted before receiveShare/);
    expect(api.listCalls).toHaveLength(4); // the 4 listVideoFiles only — no before-snapshot
    expect(api.receivedShares).toEqual([]);
    expect(guard.callsSpent()).toBe(4); // the refusal itself costs nothing
  });
});

describe("Storage115Executor.transferSubtitleUrl", () => {
  it("createProtectedStorage115Executor passes the subtitle window options through (tuning must not be silently ignored)", async () => {
    // Target a staging SUBDIR inside the write scope — the scope root itself is
    // (correctly) protected from recursive listing.
    const api = new FakePan115Api({
      directories: { sub_stage: [] },
      directoryInfo: { sub_stage: seasonPathInfo("test_root", "sub_stage") },
    });
    let listCalls = 0;
    api.addOfflineTask = async () => ({ ok: true, message: "accepted" });
    const origList = api.listItems.bind(api);
    api.listItems = async (input) => {
      listCalls += 1;
      // Listing #1 is the BEFORE-snapshot; the tuned window (1) polls exactly once
      // (listing #2). Landing on listing #3 is inside the DEFAULT window (8) but
      // outside the tuned one — if the factory drops the tuning, this sees succeeded.
      if (listCalls === 3) {
        api.directories["sub_stage"] = [{ fid: "late_sub", n: "Tuned.S01E01.ass", s: "40KB" }];
      }
      return origList(input);
    };
    const executor = createProtectedStorage115Executor({
      api,
      env: { MEDIA_TRACK_115_TEST_ROOT_CID: "test_root" },
      apiGuardOptions: { minDelayMs: 0 },
      subtitleMaterializeAttempts: 1,
      subtitleMaterializePollMs: 1,
      sleep: async () => {},
    });

    const attempt = await executor.transferSubtitleUrl!({
      url: "http://file0.assrt.net/onthefly/1/Tuned.S01E01.ass",
      filename: "Tuned.S01E01.ass",
      directoryId: "sub_stage",
      workflowRunId: "run-test",
    });

    expect(attempt.status).toBe("no_target_change");
  });

  it("uses a subtitle-specific materialization window wider than the video default (live e2e: real assrt landings took ~60s, video window is 4x2s)", async () => {
    const api = new FakePan115Api({ directories: { stage: [] } });
    let listCalls = 0;
    api.addOfflineTask = async () => ({ ok: true, message: "accepted" });
    const origList = api.listItems.bind(api);
    api.listItems = async (input) => {
      listCalls += 1;
      // The file materializes only on the 6th listing — beyond the video window
      // (4 attempts) but inside the subtitle window.
      if (listCalls === 6) {
        api.directories["stage"] = [{ fid: "late_sub", n: "Late.S01E01.ass", s: "40KB" }];
      }
      return origList(input);
    };
    const executor = new Storage115Executor({ api, sleep: async () => {} });

    const attempt = await executor.transferSubtitleUrl!({
      url: "http://file0.assrt.net/onthefly/1/Late.S01E01.ass",
      filename: "Late.S01E01.ass",
      directoryId: "stage",
      workflowRunId: "run-test",
    });

    expect(attempt.status).toBe("succeeded");
    expect(attempt.materializedFileIds).toEqual(["late_sub"]);
  });

  it("does NOT claim a pre-existing same-named file — only a file that APPEARS after submission counts", async () => {
    const api = new FakePan115Api({
      directories: { stage: [{ fid: "old_leftover", n: "Show.S01E01.ass", s: "1KB" }] },
    });
    api.addOfflineTask = async () => ({ ok: true, message: "accepted" }); // lands nothing new
    const executor = new Storage115Executor({
      api,
      subtitleMaterializeAttempts: 1,
      subtitleMaterializePollMs: 1,
      sleep: async () => {},
    });

    const attempt = await executor.transferSubtitleUrl!({
      url: "http://file0.assrt.net/onthefly/1/Show.S01E01.ass",
      filename: "Show.S01E01.ass",
      directoryId: "stage",
      workflowRunId: "run-test",
    });

    expect(attempt.status).toBe("no_target_change");
    expect(attempt.materializedFileIds).toEqual([]);
  });

  it("guard-rejected invalid filenames consume attempt numbers — ids never collide", async () => {
    const api = new FakePan115Api({ directories: { stage: [] } });
    const executor = new Storage115Executor({ api });

    const a = await executor.transferSubtitleUrl!({ url: "http://x/a.ass", filename: "a/b.ass", directoryId: "stage", workflowRunId: "run-test" });
    const b = await executor.transferSubtitleUrl!({ url: "http://x/c.ass", filename: "c\\d.ass", directoryId: "stage", workflowRunId: "run-test" });

    expect(a.status).toBe("failed");
    expect(b.status).toBe("failed");
    expect(a.id).not.toBe(b.id);
    expect(a.candidateId).not.toBe(b.candidateId);
    expect(a.candidateId).not.toContain("/"); // raw filename kept OUT of the id
  });

  it("rejects a filename containing path separators at the boundary (zero API calls)", async () => {
    const api = new FakePan115Api({ directories: { stage: [] } });
    let offlineCalls = 0;
    api.addOfflineTask = async () => {
      offlineCalls += 1;
      return { ok: true, message: "accepted" };
    };
    const executor = new Storage115Executor({ api });

    const attempt = await executor.transferSubtitleUrl!({
      url: "http://file0.assrt.net/onthefly/1/evil.ass",
      filename: "subdir/evil.ass",
      directoryId: "stage",
      workflowRunId: "run-test",
    });

    expect(attempt.status).toBe("failed");
    expect(attempt.providerMessage).toMatch(/path separator|路径分隔/i);
    expect(attempt.materializedFileIds).toEqual([]);
    expect(offlineCalls).toBe(0);
  });

  it("submits an offline task with the subtitle url, then confirms landing via listTree by filename", async () => {
    const api = new FakePan115Api({
      directories: { stage: [] },
    });
    const SUBTITLE_FILENAME = "Breaking.Bad.S02E01.ass";
    api.addOfflineTask = async (input) => {
      api.directories[input.directoryId] = [
        ...(api.directories[input.directoryId] ?? []),
        { fid: `sub_${input.url.slice(-6)}`, n: SUBTITLE_FILENAME, s: "718KB" },
      ];
      return { ok: true, message: "offline task accepted" };
    };
    const executor = new Storage115Executor({ api });

    const attempt = await executor.transferSubtitleUrl!({
      url: "http://file0.assrt.net/onthefly/713570/-/1/Breaking.Bad.S02E01.ass?api=1",
      filename: SUBTITLE_FILENAME,
      directoryId: "stage",
      workflowRunId: "run-test",
    });

    expect(attempt.status).toBe("succeeded");
    expect(attempt.materializedFileIds.length).toBe(1);
    expect(attempt.providerMessage).toBe("");
  });

  it("reports failed when addOfflineTask returns ok:false (e.g. dead link)", async () => {
    const api = new FakePan115Api({ directories: { stage: [] } });
    api.addOfflineTask = async () => ({ ok: false, message: "invalid url" });
    const executor = new Storage115Executor({ api });

    const attempt = await executor.transferSubtitleUrl!({
      url: "http://file0.assrt.net/dead.zip",
      filename: "dead.ass",
      directoryId: "stage",
      workflowRunId: "run-test",
    });

    expect(attempt.status).toBe("failed");
    expect(attempt.providerMessage).toContain("invalid url");
    expect(attempt.materializedFileIds).toEqual([]);
  });

  it("reports no_target_change when the file never appears in listTree", async () => {
    const api = new FakePan115Api({ directories: { stage: [] } });
    api.addOfflineTask = async () => ({ ok: true, message: "accepted" });
    const executor = new Storage115Executor({
      api,
      subtitleMaterializeAttempts: 1,
      subtitleMaterializePollMs: 1,
      sleep: async () => {},
    });

    const attempt = await executor.transferSubtitleUrl!({
      url: "http://file0.assrt.net/onthefly/slow.ass",
      filename: "slow.ass",
      directoryId: "stage",
      workflowRunId: "run-test",
    });

    expect(attempt.status).toBe("no_target_change");
    expect(attempt.materializedFileIds).toEqual([]);
  });

  it("best-effort cancels the in-flight offline task on no_target_change (frees quota, prevents late drop)", async () => {
    const SUBTITLE_URL = "http://file0.assrt.net/onthefly/never-lands.ass";
    const api = new FakePan115Api({
      directories: { stage: [] },
      offlineTaskList: [
        { infoHash: "hash-abc", name: "never-lands.ass", percentDone: 0, status: 1, statusText: "downloading", url: SUBTITLE_URL },
      ],
    });
    api.addOfflineTask = async () => ({ ok: true, message: "accepted" });
    const executor = new Storage115Executor({
      api,
      subtitleMaterializeAttempts: 1,
      subtitleMaterializePollMs: 1,
      sleep: async () => {},
    });

    const attempt = await executor.transferSubtitleUrl!({
      url: SUBTITLE_URL,
      filename: "never-lands.ass",
      directoryId: "stage",
      workflowRunId: "run-test",
    });

    expect(attempt.status).toBe("no_target_change");
    expect(api.removedOfflineHashes).toContain("hash-abc"); // the queued task was cancelled by its infoHash
  });

  it("assigns DISTINCT attempt ids across a succeed-then-fail sequence on one executor (no transfer_attempts PK collision)", async () => {
    // A multi-file subtitle package loops transferSubtitleUrl per file on the SAME
    // executor instance. A succeeded call followed by a failed call must NOT reuse
    // the same attempt id — otherwise both attempts collide on the transfer_attempts
    // primary key and the run's single-transaction persist rolls back, losing the
    // video's obtained marks (a subtitle failure blocking the video).
    const api = new FakePan115Api({ directories: { stage: [] } });
    let call = 0;
    api.addOfflineTask = async (input) => {
      call += 1;
      if (call === 1) {
        api.directories[input.directoryId] = [
          ...(api.directories[input.directoryId] ?? []),
          { fid: "sub_ok", n: "Show.S01E01.ass", s: "700KB" },
        ];
        return { ok: true, message: "offline task accepted" };
      }
      return { ok: false, message: "invalid url" };
    };
    const executor = new Storage115Executor({ api });

    const first = await executor.transferSubtitleUrl!({
      url: "http://file0.assrt.net/onthefly/1/Show.S01E01.ass",
      filename: "Show.S01E01.ass",
      directoryId: "stage",
      workflowRunId: "run-collide",
    });
    const second = await executor.transferSubtitleUrl!({
      url: "http://file0.assrt.net/dead.ass",
      filename: "Show.S01E02.ass",
      directoryId: "stage",
      workflowRunId: "run-collide",
    });

    expect(first.status).toBe("succeeded");
    expect(second.status).toBe("failed");
    expect(first.id).not.toBe(second.id); // distinct ids — no PK collision
  });
});

describe("Storage115Executor.transferSubtitleUrls (整包一次:1 校验 + 1 快照 + N 提交 + 每轮 1 次深 1 轮询 + 1 次批量取消)", () => {
  function subtitleFiles(n: number): Array<{ url: string; filename: string }> {
    return Array.from({ length: n }, (_, i) => ({
      url: `http://file0.assrt.net/onthefly/1/Show.S01E${String(i + 1).padStart(2, "0")}.srt`,
      filename: `Show.S01E${String(i + 1).padStart(2, "0")}.srt`,
    }));
  }

  it("a 3-file package that lands on the first poll costs exactly 1 + 3 + 1 calls (was 3 × (1 + 1 + 1) per-file)", async () => {
    const api = new FakePan115Api({ directories: { stage: [] } });
    api.addOfflineTask = async (input) => {
      const name = input.url.split("/").pop()!;
      api.directories[input.directoryId] = [...(api.directories[input.directoryId] ?? []), { fid: `fid_${name}`, n: name, s: "40KB" }];
      return { ok: true, message: "accepted" };
    };
    const guard = new Pan115ApiGuard({ minDelayMs: 0 });
    const executor = new Storage115Executor({ api, apiGuard: guard, sleep: async () => {} });

    const attempts = await executor.transferSubtitleUrls({ files: subtitleFiles(3), directoryId: "stage", workflowRunId: "run-b" });

    expect(attempts.map((a) => a.status)).toEqual(["succeeded", "succeeded", "succeeded"]);
    expect(attempts.map((a) => a.materializedFileIds)).toEqual([["fid_Show.S01E01.srt"], ["fid_Show.S01E02.srt"], ["fid_Show.S01E03.srt"]]);
    expect(attempts.map((a) => a.candidateId)).toEqual(["subtitle:Show.S01E01.srt", "subtitle:Show.S01E02.srt", "subtitle:Show.S01E03.srt"]);
    expect(new Set(attempts.map((a) => a.id)).size).toBe(3);
    expect(guard.callsSpent()).toBe(5); // before-listing 1 + addOfflineTask 3 + one poll 1
    expect(api.listCalls).toEqual(["stage", "stage"]); // depth 1: the staging dir only, never its subdirs
  });

  it("polls the staging dir at depth 1 — subdirectories (video packs) are never listed", async () => {
    const api = new FakePan115Api({
      directories: { stage: [{ isDirectory: true, cid: "pack_1", n: "Q-Show-2026" }], pack_1: [] },
    });
    api.addOfflineTask = async () => ({ ok: true, message: "accepted" });
    const executor = new Storage115Executor({ api, subtitleMaterializeAttempts: 2, subtitleMaterializePollMs: 1, sleep: async () => {} });

    await executor.transferSubtitleUrls({ files: subtitleFiles(1), directoryId: "stage", workflowRunId: "run-b" });

    expect(api.listCalls.every((cid) => cid === "stage")).toBe(true);
  });

  it("keeps polling while files keep landing, and gives up after `subtitleMaterializeAttempts` idle polls", async () => {
    const api = new FakePan115Api({ directories: { stage: [] } });
    api.addOfflineTask = async () => ({ ok: true, message: "accepted" });
    let listCalls = 0;
    const orig = api.listItems.bind(api);
    api.listItems = async (input) => {
      listCalls += 1;
      // listing 1 = before; E01 lands on poll 3 (listing 4), E02 on poll 5 (listing 6); E03–E06 never.
      if (listCalls === 4) api.directories["stage"] = [{ fid: "f1", n: "Show.S01E01.srt", s: "1KB" }];
      if (listCalls === 6) api.directories["stage"] = [...api.directories["stage"]!, { fid: "f2", n: "Show.S01E02.srt", s: "1KB" }];
      return orig(input);
    };
    const guard = new Pan115ApiGuard({ minDelayMs: 0 });
    const executor = new Storage115Executor({ api, apiGuard: guard, subtitleMaterializeAttempts: 3, subtitleMaterializePollMs: 1, sleep: async () => {} });

    const attempts = await executor.transferSubtitleUrls({ files: subtitleFiles(6), directoryId: "stage", workflowRunId: "run-b" });

    expect(attempts.filter((a) => a.status === "succeeded")).toHaveLength(2);
    expect(attempts.filter((a) => a.status === "no_target_change")).toHaveLength(4);
    // polls: 1,2 idle(2) → 3 lands (idle reset) → 4 idle → 5 lands (reset) → 6,7,8 idle(3) → stop.
    // 6 files keep the cap (attempts 3 + files 6 = 9) OUT of reach, so ONLY the idle rule can end this loop.
    expect(listCalls).toBe(1 + 8);
    // before 1 + submit 6 + polls 8 + cancel listOfflineTasks 1 (no unambiguous match → no task_del)
    expect(guard.callsSpent()).toBe(16);
  });

  it("caps total polls at attempts + files even when landings trickle forever", async () => {
    const api = new FakePan115Api({ directories: { stage: [] } });
    api.addOfflineTask = async () => ({ ok: true, message: "accepted" });
    let listCalls = 0;
    const orig = api.listItems.bind(api);
    api.listItems = async (input) => {
      listCalls += 1;
      // One file lands on every ODD poll (1, 3, 5, …) — the idle counter never
      // reaches 2, so ONLY the cap can stop this loop.
      const poll = listCalls - 1; // listing 1 is the before-snapshot
      if (poll >= 1 && poll % 2 === 1) {
        const n = (poll + 1) / 2;
        api.directories["stage"] = [...(api.directories["stage"] ?? []), { fid: `f${n}`, n: `Show.S01E${String(n).padStart(2, "0")}.srt`, s: "1KB" }];
      }
      return orig(input);
    };
    const executor = new Storage115Executor({ api, subtitleMaterializeAttempts: 2, subtitleMaterializePollMs: 1, sleep: async () => {} });

    const attempts = await executor.transferSubtitleUrls({ files: subtitleFiles(10), directoryId: "stage", workflowRunId: "run-b" });

    expect(listCalls).toBe(1 + 2 + 10); // before + (attempts + files) polls
    expect(attempts.filter((a) => a.status === "succeeded")).toHaveLength(6); // polls 1,3,5,7,9,11 landed one each
    expect(attempts.filter((a) => a.status === "no_target_change")).toHaveLength(4);
  });

  it("batch-cancels every unlanded file's queued task in ONE task_del (only unambiguous url matches), after ONE task_lists read", async () => {
    const files = subtitleFiles(4);
    const api = new FakePan115Api({
      directories: { stage: [] },
      offlineTaskList: [
        { infoHash: "h1", name: "a", percentDone: 0, status: 1, statusText: "downloading", url: files[0]!.url },
        { infoHash: "h2", name: "b", percentDone: 0, status: 1, statusText: "downloading", url: files[1]!.url },
        { infoHash: "h2dup", name: "b-stale", percentDone: 0, status: 1, statusText: "downloading", url: files[1]!.url }, // ambiguous → skipped
        // files[2] has no task row → skipped; files[3] lands → not cancelled
      ],
    });
    api.addOfflineTask = async (input) => {
      if (input.url === files[3]!.url) api.directories["stage"] = [{ fid: "f4", n: files[3]!.filename, s: "1KB" }];
      return { ok: true, message: "accepted" };
    };
    const executor = new Storage115Executor({ api, subtitleMaterializeAttempts: 1, subtitleMaterializePollMs: 1, sleep: async () => {} });

    const attempts = await executor.transferSubtitleUrls({ files, directoryId: "stage", workflowRunId: "run-b" });

    expect(attempts.map((a) => a.status)).toEqual(["no_target_change", "no_target_change", "no_target_change", "succeeded"]);
    expect(api.listOfflineTasksCalls).toBe(1);
    expect(api.removedOfflineHashes).toEqual(["h1"]);
    expect(attempts[0]!.providerMessage).toBe("subtitle offline task accepted but file did not materialize in window");
  });

  it("invalid (path-y) and duplicate filenames fail at the boundary without API calls and without disturbing the others", async () => {
    const api = new FakePan115Api({ directories: { stage: [] } });
    api.addOfflineTask = async (input) => {
      api.offlineTasks.push({ ...input }); // the override replaces the fake's own bookkeeping
      const name = input.url.split("/").pop()!;
      api.directories[input.directoryId] = [...(api.directories[input.directoryId] ?? []), { fid: `fid_${name}`, n: name, s: "1KB" }];
      return { ok: true, message: "accepted" };
    };
    const executor = new Storage115Executor({ api, sleep: async () => {} });

    const attempts = await executor.transferSubtitleUrls({
      files: [
        { url: "http://x/evil.srt", filename: "sub/evil.srt" },
        { url: "http://x/Show.S01E01.srt", filename: "Show.S01E01.srt" },
        { url: "http://x/dup/Show.S01E01.srt", filename: "Show.S01E01.srt" },
      ],
      directoryId: "stage",
      workflowRunId: "run-b",
    });

    expect(attempts[0]!.status).toBe("failed");
    expect(attempts[0]!.providerMessage).toMatch(/SUBTITLE_INVALID_FILENAME/);
    expect(attempts[0]!.candidateId).not.toContain("/");
    expect(attempts[1]!.status).toBe("succeeded");
    expect(attempts[2]!.status).toBe("failed");
    expect(attempts[2]!.providerMessage).toMatch(/SUBTITLE_DUPLICATE_FILENAME/);
    expect(api.offlineTasks.map((t) => t.url)).toEqual(["http://x/Show.S01E01.srt"]); // exactly one submission
    expect(new Set(attempts.map((a) => a.id)).size).toBe(3);
  });

  it("an all-invalid package returns without touching the API at all", async () => {
    const api = new FakePan115Api({ directories: { stage: [] } });
    const guard = new Pan115ApiGuard({ minDelayMs: 0 });
    const executor = new Storage115Executor({ api, apiGuard: guard });

    const attempts = await executor.transferSubtitleUrls({ files: [{ url: "http://x/a", filename: "a/b.srt" }], directoryId: "stage", workflowRunId: "run-b" });

    expect(attempts).toHaveLength(1);
    expect(guard.callsSpent()).toBe(0);
  });

  it("stops submitting after 3 consecutive addOfflineTask rejections; the rest are failed as SUBTITLE_NOT_SUBMITTED", async () => {
    const api = new FakePan115Api({ directories: { stage: [] } });
    let submissions = 0;
    api.addOfflineTask = async () => {
      submissions += 1;
      return { ok: false, message: "云下载配额不足" };
    };
    const executor = new Storage115Executor({ api, subtitleMaterializeAttempts: 1, subtitleMaterializePollMs: 1, sleep: async () => {} });

    const attempts = await executor.transferSubtitleUrls({ files: subtitleFiles(6), directoryId: "stage", workflowRunId: "run-b" });

    expect(submissions).toBe(3);
    expect(attempts.slice(0, 3).map((a) => a.providerMessage)).toEqual(["云下载配额不足", "云下载配额不足", "云下载配额不足"]);
    expect(attempts.slice(3).every((a) => a.status === "failed" && /SUBTITLE_NOT_SUBMITTED.*云下载配额不足/.test(a.providerMessage))).toBe(true);
    expect(api.listOfflineTasksCalls).toBe(0); // nothing was submitted → nothing to cancel
  });

  it("a success resets the rejection counter (mixed flakiness still submits everything)", async () => {
    const api = new FakePan115Api({ directories: { stage: [] } });
    let submissions = 0;
    api.addOfflineTask = async () => {
      submissions += 1;
      return submissions % 3 === 0 ? { ok: true, message: "accepted" } : { ok: false, message: "flaky" };
    };
    const executor = new Storage115Executor({ api, subtitleMaterializeAttempts: 1, subtitleMaterializePollMs: 1, sleep: async () => {} });

    await executor.transferSubtitleUrls({ files: subtitleFiles(6), directoryId: "stage", workflowRunId: "run-b" });

    expect(submissions).toBe(6);
  });

  it("refuses up front, with ZERO API calls, a package that cannot land before the transfer line (SUBTITLE_BUDGET_INSUFFICIENT)", async () => {
    const api = new FakePan115Api({ directories: { stage: [] } });
    // hard 20, reserve 10 → transfer line 10; 3 files with 8-poll patience need 2 + 3 + 8 = 13 > 10.
    const guard = new Pan115ApiGuard({ minDelayMs: 0, maxCallsPerOperation: 20, transferReserveCalls: 10 });
    const executor = new Storage115Executor({ api, apiGuard: guard, subtitleMaterializeAttempts: 8, subtitleMaterializePollMs: 1, sleep: async () => {} });

    const attempts = await executor.transferSubtitleUrls({ files: subtitleFiles(3), directoryId: "stage", workflowRunId: "run-b" });

    expect(attempts.map((a) => a.status)).toEqual(["failed", "failed", "failed"]);
    expect(attempts[0]!.providerMessage).toMatch(/SUBTITLE_BUDGET_INSUFFICIENT.*3-file.*~13 115 calls.*only 10 remain/);
    expect(guard.callsSpent()).toBe(0);
    expect(api.listCalls).toEqual([]);
    expect(api.offlineTasks).toEqual([]);
    expect(new Set(attempts.map((a) => a.id)).size).toBe(3); // numbers still consumed
  });

  it("a circuit-breaker refusal (115 风控) mid-submission stops submitting at once; the rest are SUBTITLE_NOT_SUBMITTED and the landing poll fails closed", async () => {
    const api = new FakePan115Api({ directories: { stage: [] } });
    let submissions = 0;
    api.addOfflineTask = async (input) => {
      api.offlineTasks.push({ ...input });
      submissions += 1;
      // The 3rd submission answers with a risk-control signal → the guard opens its circuit and throws.
      return submissions === 3 ? { ok: false, message: "请求过于频繁" } : { ok: true, message: "accepted" };
    };
    const guard = new Pan115ApiGuard({ minDelayMs: 0 });
    const executor = new Storage115Executor({ api, apiGuard: guard, subtitleMaterializeAttempts: 2, subtitleMaterializePollMs: 1, sleep: async () => {} });

    const attempts = await executor.transferSubtitleUrls({ files: subtitleFiles(5), directoryId: "stage", workflowRunId: "run-b" });

    expect(submissions).toBe(3); // files 4 and 5 were never submitted
    expect(attempts.map((a) => a.status)).toEqual(["no_target_change", "no_target_change", "failed", "failed", "failed"]);
    expect(attempts.slice(2).every((a) => /^SUBTITLE_NOT_SUBMITTED: .*PAN115_RATE_LIMIT/.test(a.providerMessage))).toBe(true);
    expect(attempts[0]!.providerMessage).toMatch(/subtitle landing poll failed: PAN115_RATE_LIMIT: circuit breaker open/);
    expect(guard.callsSpent()).toBe(4); // before 1 + 3 submissions; polls and cleanup refused by the open circuit
    expect(api.listOfflineTasksCalls).toBe(0);
  });

  it("polling stops at the transfer budget line instead of eating the wrap-up reserve (backstop: graceful miss, not a throw)", async () => {
    const api = new FakePan115Api({ directories: { stage: [] } });
    api.addOfflineTask = async () => ({ ok: true, message: "accepted" });
    let listCalls = 0;
    const orig = api.listItems.bind(api);
    api.listItems = async (input) => {
      listCalls += 1;
      // listing 1 = before; E01 lands on poll 1 (listing 2), E02 on poll 3 (listing 4); E03 never.
      if (listCalls === 2) api.directories["stage"] = [{ fid: "f1", n: "Show.S01E01.srt", s: "1KB" }];
      if (listCalls === 4) api.directories["stage"] = [...api.directories["stage"]!, { fid: "f2", n: "Show.S01E02.srt", s: "1KB" }];
      return orig(input);
    };
    // hard 12, reserve 4 → transfer line 8. Pre-flight: 2 + 3 + 2 = 7 ≤ 8 → proceeds.
    // before (1) + submits (2..4) + polls 5,6,7,8 → the budget stop fires right after the
    // 4th poll; idle patience (2) never fires because E01/E02 keep landing.
    const guard = new Pan115ApiGuard({ minDelayMs: 0, maxCallsPerOperation: 12, transferReserveCalls: 4 });
    let sleeps = 0;
    const executor = new Storage115Executor({
      api,
      apiGuard: guard,
      subtitleMaterializeAttempts: 2,
      subtitleMaterializePollMs: 1,
      sleep: async () => {
        sleeps += 1;
      },
    });

    const attempts = await executor.transferSubtitleUrls({ files: subtitleFiles(3), directoryId: "stage", workflowRunId: "run-b" });

    expect(attempts.map((a) => a.status)).toEqual(["succeeded", "succeeded", "no_target_change"]);
    expect(attempts[2]!.providerMessage).toMatch(/wrap-up reserve/);
    expect(listCalls).toBe(1 + 4); // before + 4 polls, none in the reserve
    expect(sleeps).toBe(3); // polls − 1: the loop never sleeps after the poll that hits the line
    expect(guard.callsSpent()).toBe(9); // + the cleanup task_lists read (wrap-up class, allowed under hard 12)
  });

  it("the write-scope check is ONE getDirectoryInfo for the whole package, not one per file", async () => {
    const api = new FakePan115Api({
      directories: { sub_stage: [] },
      directoryInfo: { sub_stage: seasonPathInfo("test_root", "sub_stage") },
    });
    let directoryInfoCalls = 0;
    const origInfo = api.getDirectoryInfo.bind(api);
    api.getDirectoryInfo = async (input) => {
      directoryInfoCalls += 1;
      return origInfo(input);
    };
    api.addOfflineTask = async (input) => {
      api.offlineTasks.push({ ...input });
      const name = input.url.split("/").pop()!;
      api.directories[input.directoryId] = [...(api.directories[input.directoryId] ?? []), { fid: `fid_${name}`, n: name, s: "1KB" }];
      return { ok: true, message: "accepted" };
    };
    const executor = createProtectedStorage115Executor({
      api,
      env: { MEDIA_TRACK_115_TEST_ROOT_CID: "test_root" },
      apiGuardOptions: { minDelayMs: 0 },
      subtitleMaterializeAttempts: 2,
      subtitleMaterializePollMs: 1,
      sleep: async () => {},
    });

    const attempts = await executor.transferSubtitleUrls({ files: subtitleFiles(4), directoryId: "sub_stage", workflowRunId: "run-b" });

    expect(attempts.every((a) => a.status === "succeeded")).toBe(true);
    expect(directoryInfoCalls).toBe(1); // the scope check, once — NOT once per file
    expect(executor.apiCallCount()).toBe(7); // scope 1 + before 1 + submits 4 + one poll 1
  });

  it("clamps the reported headroom at 0 — a package asked for past the line never prints a negative remainder", async () => {
    const api = new FakePan115Api({ directories: { stage: [] } });
    // hard 10, reserve 6 → transfer line 4; 6 listings (wrap-up class) push callsSpent PAST it.
    const guard = new Pan115ApiGuard({ minDelayMs: 0, maxCallsPerOperation: 10, transferReserveCalls: 6 });
    const executor = new Storage115Executor({ api, apiGuard: guard, subtitleMaterializeAttempts: 1, subtitleMaterializePollMs: 1, sleep: async () => {} });
    for (let i = 0; i < 6; i += 1) {
      await executor.listVideoFiles("stage");
    }

    const attempts = await executor.transferSubtitleUrls({ files: subtitleFiles(1), directoryId: "stage", workflowRunId: "run-b" });

    expect(attempts[0]!.status).toBe("failed");
    expect(attempts[0]!.providerMessage).toMatch(/SUBTITLE_BUDGET_INSUFFICIENT/);
    expect(attempts[0]!.providerMessage).toMatch(/only 0 remain/); // not "-2"
    expect(guard.callsSpent()).toBe(6); // refused before any further call
    expect(api.listCalls).toHaveLength(6);
  });

  it("cancels one task ONCE when several package files share a url (deduped infoHashes)", async () => {
    const SHARED_URL = "http://file0.assrt.net/onthefly/1/pack.srt";
    const api = new FakePan115Api({
      directories: { stage: [] },
      offlineTaskList: [
        { infoHash: "h1", name: "pack", percentDone: 0, status: 1, statusText: "downloading", url: SHARED_URL },
      ],
    });
    api.addOfflineTask = async () => ({ ok: true, message: "accepted" }); // lands nothing
    const executor = new Storage115Executor({ api, subtitleMaterializeAttempts: 1, subtitleMaterializePollMs: 1, sleep: async () => {} });

    const attempts = await executor.transferSubtitleUrls({
      files: [
        { url: SHARED_URL, filename: "Show.S01E01.srt" },
        { url: SHARED_URL, filename: "Show.S01E02.srt" },
      ],
      directoryId: "stage",
      workflowRunId: "run-b",
    });

    expect(attempts.map((a) => a.status)).toEqual(["no_target_change", "no_target_change"]);
    expect(api.listOfflineTasksCalls).toBe(1);
    expect(api.removedOfflineHashes).toEqual(["h1"]); // ONE hash, not ["h1","h1"]
  });

  it("acceptance: a 22-file package that lands promptly costs ≤ 40 calls (the per-file path spent 260)", async () => {
    const files = subtitleFiles(22);
    const api = new FakePan115Api({ directories: { stage: [] } });
    api.addOfflineTask = async () => ({ ok: true, message: "accepted" });
    let listCalls = 0;
    const orig = api.listItems.bind(api);
    api.listItems = async (input) => {
      listCalls += 1;
      const poll = listCalls - 1; // listing 1 is the before-snapshot
      if (poll >= 1) {
        // 8 files land per poll → all 22 are in by poll 3.
        api.directories["stage"] = files
          .slice(0, Math.min(8 * poll, files.length))
          .map((file, index) => ({ fid: `fid_${index + 1}`, n: file.filename, s: "40KB" }));
      }
      return orig(input);
    };
    const guard = new Pan115ApiGuard({ minDelayMs: 0 });
    const executor = new Storage115Executor({ api, apiGuard: guard, sleep: async () => {} });

    const attempts = await executor.transferSubtitleUrls({ files, directoryId: "stage", workflowRunId: "run-b" });

    expect(attempts.filter((a) => a.status === "succeeded")).toHaveLength(22);
    expect(listCalls).toBe(1 + 3); // before + 3 polls (8 + 8 + 6 landings)
    expect(guard.callsSpent()).toBe(26); // before 1 + submits 22 + polls 3; nothing left to cancel
    expect(guard.callsSpent()).toBeLessThanOrEqual(40);
  });

  it("acceptance: a 22-file package where 12 files never land still costs ≤ 60 calls (full idle window + one batch cancel)", async () => {
    const files = subtitleFiles(22);
    const api = new FakePan115Api({ directories: { stage: [] }, offlineTaskList: [] });
    api.addOfflineTask = async () => ({ ok: true, message: "accepted" });
    let listCalls = 0;
    const orig = api.listItems.bind(api);
    api.listItems = async (input) => {
      listCalls += 1;
      // Only the FIRST poll lands anything: 10 of 22. The other 12 never appear.
      if (listCalls === 2) {
        api.directories["stage"] = files
          .slice(0, 10)
          .map((file, index) => ({ fid: `fid_${index + 1}`, n: file.filename, s: "40KB" }));
      }
      return orig(input);
    };
    const guard = new Pan115ApiGuard({ minDelayMs: 0 });
    const executor = new Storage115Executor({ api, apiGuard: guard, subtitleMaterializeAttempts: 8, subtitleMaterializePollMs: 1, sleep: async () => {} });

    const attempts = await executor.transferSubtitleUrls({ files, directoryId: "stage", workflowRunId: "run-b" });

    expect(attempts.filter((a) => a.status === "succeeded")).toHaveLength(10);
    expect(attempts.filter((a) => a.status === "no_target_change")).toHaveLength(12);
    // poll 1 lands 10 (idle reset) → polls 2–9 idle → idle hits 8 at poll 9 → stop
    // (the cap, attempts 8 + files 22 = 30, is never reached).
    expect(listCalls).toBe(1 + 9);
    expect(guard.callsSpent()).toBe(33); // before 1 + submits 22 + polls 9 + task_lists 1 (empty list → no task_del)
    expect(guard.callsSpent()).toBeLessThanOrEqual(60);
  });

  it("transferSubtitleUrl (single) delegates to the batch — same attempt shape, one number per call", async () => {
    const api = new FakePan115Api({ directories: { stage: [] } });
    api.addOfflineTask = async (input) => {
      api.directories[input.directoryId] = [{ fid: "sub_1", n: "Show.S01E01.srt", s: "1KB" }];
      return { ok: true, message: "accepted" };
    };
    const executor = new Storage115Executor({ api, sleep: async () => {} });

    const single = await executor.transferSubtitleUrl!({ url: "http://x/Show.S01E01.srt", filename: "Show.S01E01.srt", directoryId: "stage", workflowRunId: "run-s" });
    const next = await executor.transferSubtitleUrls({ files: [{ url: "http://x/Show.S01E02.srt", filename: "Show.S01E02.srt" }], directoryId: "stage", workflowRunId: "run-s" });

    expect(single).toMatchObject({ id: "run-s_subtitle_1", candidateId: "subtitle:Show.S01E01.srt", status: "succeeded", materializedFileIds: ["sub_1"] });
    expect(next[0]!.id).toBe("run-s_subtitle_2");
  });

  // A dead cookie is NOT a landing miss: it must ride out of the package the same
  // way transfer() lets it out, so the worker can freeze the drive instead of the
  // agent reading 22 fake "did not materialize" lines and hunting another source.
  it("a dead cookie during submission propagates as Pan115AuthError (not a per-file rejection)", async () => {
    const api = new FakePan115Api({ directories: { stage: [] } });
    let submits = 0;
    api.addOfflineTask = async () => {
      submits += 1;
      if (submits >= 2) {
        throw new Pan115AuthError("PAN115_AUTH_FAILED: cookie dead", 990001);
      }
      return { ok: true, message: "accepted" };
    };
    const executor = new Storage115Executor({ api, sleep: async () => {} });

    await expect(
      executor.transferSubtitleUrls({ files: subtitleFiles(3), directoryId: "stage", workflowRunId: "run-b" }),
    ).rejects.toBeInstanceOf(Pan115AuthError);
    // No cancel sweep either: the same dead cookie would refuse task_lists anyway.
    expect(api.listOfflineTasksCalls).toBe(0);
  });

  it("a dead cookie during the landing poll propagates as Pan115AuthError (not no_target_change)", async () => {
    const api = new FakePan115Api({ directories: { stage: [] } });
    api.addOfflineTask = async () => ({ ok: true, message: "accepted" });
    let listings = 0;
    const orig = api.listItems.bind(api);
    api.listItems = async (input) => {
      listings += 1;
      // listing 1 = the before-snapshot; the cookie dies on the first poll.
      if (listings >= 2) {
        throw new Pan115AuthError("PAN115_AUTH_FAILED: cookie dead", 990001);
      }
      return orig(input);
    };
    const executor = new Storage115Executor({ api, sleep: async () => {} });

    await expect(
      executor.transferSubtitleUrls({ files: subtitleFiles(2), directoryId: "stage", workflowRunId: "run-b" }),
    ).rejects.toBeInstanceOf(Pan115AuthError);
  });

  it("a dead cookie during cleanup propagates too (best-effort cancel ≠ swallow a dead credential)", async () => {
    const api = new FakePan115Api({ directories: { stage: [] } });
    api.addOfflineTask = async () => ({ ok: true, message: "accepted" }); // accepted, never lands
    api.listOfflineTasks = async () => {
      throw new Pan115AuthError("PAN115_AUTH_FAILED: cookie dead", 990001);
    };
    const executor = new Storage115Executor({
      api,
      subtitleMaterializeAttempts: 1,
      subtitleMaterializePollMs: 1,
      sleep: async () => {},
    });

    await expect(
      executor.transferSubtitleUrls({ files: subtitleFiles(1), directoryId: "stage", workflowRunId: "run-b" }),
    ).rejects.toBeInstanceOf(Pan115AuthError);
  });
});

class FakePan115Api implements Pan115StorageApi {
  readonly directories: Record<string, Pan115Item[]>;
  readonly shareFiles: Record<string, Pan115Item[]>;
  readonly receiveShareResults: Record<string, Pan115ActionResult>;
  readonly directoryInfo: Record<string, Pan115DirectoryInfo>;
  readonly receivedShares: Array<{ shareCode: string; receiveCode: string; directoryId: string }> = [];
  readonly offlineTasks: Array<{ url: string; directoryId: string }> = [];
  readonly offlineTaskList: Pan115OfflineTask[];
  listOfflineTasksCalls = 0;
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
    offlineTaskList?: Pan115OfflineTask[];
  } = {}) {
    this.directories = cloneDirectories(input.directories ?? {});
    this.shareFiles = cloneDirectories(input.shareFiles ?? {});
    this.receiveShareResults = { ...(input.receiveShareResults ?? {}) };
    this.directoryInfo = { ...(input.directoryInfo ?? {}) };
    this.offlineTaskList = [...(input.offlineTaskList ?? [])];
  }

  async listOfflineTasks(): Promise<Pan115OfflineTask[]> {
    this.listOfflineTasksCalls += 1;
    return [...this.offlineTaskList];
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
