import { describe, expect, it, vi } from "vitest";
import type { ResourceCandidate, ResourceType } from "./domain.js";
import { Pan123AuthError } from "./pan123-client.js";
import type { Pan123Client, Pan123Item } from "./pan123-client.js";
import type { Pan123StorageExecutorOptions } from "./pan123-storage-executor.js";
import { parsePan123ShareUrl, Pan123StorageExecutor } from "./pan123-storage-executor.js";

/** The slice of Pan123Client the executor drives. Fakes must match the REAL
 *  method signatures (read from pan123-client.ts, not guessed): saveShare takes
 *  shareKey/sharePwd/targetParentId and returns {ok,message}; moveFiles takes
 *  {fileIds,targetParentId}; deletion is `trash` (not batchDelete). */
type Pan123ClientShape = Pick<
  Pan123Client,
  | "listFiles"
  | "createFolder"
  | "saveShare"
  | "resolveOffline"
  | "submitOffline"
  | "submitOfflineResources"
  | "listOfflineTasks"
  | "getOfflineTask"
  | "deleteOfflineTasks"
  | "renameFile"
  | "trash"
  | "moveFiles"
>;

function fakeClient(overrides: Partial<Pan123ClientShape> = {}): Pan123ClientShape {
  return {
    listFiles: vi.fn<Pan123Client["listFiles"]>(async () => []),
    createFolder: vi.fn<Pan123Client["createFolder"]>(async () => "newdir123"),
    saveShare: vi.fn<Pan123Client["saveShare"]>(async () => ({ ok: true, message: "" })),
    resolveOffline: vi.fn<Pan123Client["resolveOffline"]>(async () => ({
      resourceId: "9007199254740993001",
      fileIds: ["9007199254740993002"],
    })),
    submitOffline: vi.fn<Pan123Client["submitOffline"]>(async () => "9007199254740993003"),
    submitOfflineResources: vi.fn<Pan123Client["submitOfflineResources"]>(async (input) =>
      input.resources.map((r, i) => ({ resourceId: r.resourceId, taskId: `task-${i + 1}`, error: null })),
    ),
    listOfflineTasks: vi.fn<Pan123Client["listOfflineTasks"]>(async (ids) =>
      ids.map((taskId) => ({ taskId, name: "sub", status: 2, progress: 100, size: 1 })),
    ),
    getOfflineTask: vi.fn<Pan123Client["getOfflineTask"]>(async (taskId) => ({
      taskId,
      name: "Some.Show.mkv",
      status: 2,
      progress: 100,
      size: 100,
    })),
    deleteOfflineTasks: vi.fn<Pan123Client["deleteOfflineTasks"]>(async () => {}),
    renameFile: vi.fn<Pan123Client["renameFile"]>(async () => {}),
    trash: vi.fn<Pan123Client["trash"]>(async () => {}),
    moveFiles: vi.fn<Pan123Client["moveFiles"]>(async () => {}),
    ...overrides,
  };
}

function makeExecutor(
  client: Pan123ClientShape,
  writeScopeDirectoryIds: string[] = [SCOPE],
  extra: Partial<Pan123StorageExecutorOptions> = {},
): Pan123StorageExecutor {
  return new Pan123StorageExecutor({
    client: client as unknown as Pan123Client,
    writeScopeDirectoryIds,
    // 默认注入 no-op sleep,让走 settle-poll 的用例(no_target_change 等)不真睡 8×2.5s。
    sleep: async () => {},
    ...extra,
  });
}

/** ⚠️ bigint lesson (Task 1): fake items use STRING ids — an 18-digit int64 as a
 *  bare JS number literal is silently rounded before the stub even sees it. */
function folder(id: string, name: string): Pan123Item {
  return { id, name, size: 0, etag: "", isFolder: true };
}

function file(id: string, name: string, size = 50 * 1024 * 1024): Pan123Item {
  return { id, name, size, etag: "", isFolder: false };
}

function candidate(overrides: Partial<ResourceCandidate> = {}): ResourceCandidate {
  return {
    id: "cand-1",
    snapshotId: "snap-1",
    index: 0,
    title: "Some Show",
    type: "manual" as ResourceType,
    source: "test",
    providerPayload: { url: "https://www.123pan.com/s/abc-1?pwd=x8fd" },
    ...overrides,
  };
}

const SCOPE = "scope-dir";

describe("parsePan123ShareUrl", () => {
  it("parses the 123pan.com/s/<key> form with a pwd query", () => {
    expect(parsePan123ShareUrl("https://www.123pan.com/s/abc-1?pwd=x8fd")).toEqual({
      shareKey: "abc-1",
      sharePwd: "x8fd",
    });
    expect(parsePan123ShareUrl("https://www.123pan.com/s/abc-1")).toEqual({
      shareKey: "abc-1",
      sharePwd: "",
    });
  });

  it("matches the mirror domains (123684/123865/123912.com/cn) and accepts `password`", () => {
    expect(parsePan123ShareUrl("https://123684.com/s/Kd9-TvBq?password=1234")).toEqual({
      shareKey: "Kd9-TvBq",
      sharePwd: "1234",
    });
    expect(parsePan123ShareUrl("https://www.123912.cn/s/Zz_00?pwd=abcd")).toEqual({
      shareKey: "Zz_00",
      sharePwd: "abcd",
    });
  });

  it("strips the URL fragment before parsing the access code", () => {
    expect(parsePan123ShareUrl("https://www.123pan.com/s/abc-1?pwd=x8fd#frag")).toEqual({
      shareKey: "abc-1",
      sharePwd: "x8fd",
    });
  });

  it("returns null for a non-123 url", () => {
    expect(parsePan123ShareUrl("https://pan.quark.cn/s/abc123")).toBeNull();
  });
});

describe("Pan123StorageExecutor.transfer", () => {
  it("saves a share into the scope dir and diffs landed videos (succeeded)", async () => {
    let landed = false;
    const listFiles = vi.fn<Pan123Client["listFiles"]>(async () =>
      landed ? [file("924511245739356595", "Show.S01E01.1080p.mkv")] : [],
    );
    const saveShare = vi.fn<Pan123Client["saveShare"]>(async () => {
      landed = true;
      return { ok: true, message: "" };
    });
    const client = fakeClient({ listFiles, saveShare });
    const executor = makeExecutor(client);

    const attempt = await executor.transfer({
      workflowRunId: "run-1",
      directoryId: SCOPE,
      candidate: candidate(),
    });

    expect(saveShare).toHaveBeenCalledWith({
      shareKey: "abc-1",
      sharePwd: "x8fd",
      targetParentId: SCOPE,
    });
    expect(attempt.status).toBe("succeeded");
    expect(attempt.materializedFileIds).toEqual(["924511245739356595"]);
    expect(attempt.id).toBe("run-1_transfer_1");
    expect(attempt.candidateId).toBe("cand-1");
  });

  it("offline-downloads a magnet, polls to success, and diffs the landed video", async () => {
    let landed = false;
    const listFiles = vi.fn<Pan123Client["listFiles"]>(async () =>
      landed ? [file("924511245739356595", "Show.S01E01.1080p.mkv")] : [],
    );
    const getOfflineTask = vi.fn<Pan123Client["getOfflineTask"]>(async (taskId) => {
      landed = true;
      return { taskId, name: "Show", status: 2, progress: 100, size: 123 };
    });
    const client = fakeClient({ listFiles, getOfflineTask });
    const executor = makeExecutor(client);
    const url = "magnet:?xt=urn:btih:deadbeef";

    const attempt = await executor.transfer({
      workflowRunId: "run-1",
      directoryId: SCOPE,
      candidate: candidate({ type: "magnet" as ResourceType, providerPayload: { url } }),
    });

    expect(client.resolveOffline).toHaveBeenCalledWith(url);
    expect(client.submitOffline).toHaveBeenCalledWith({
      resourceId: "9007199254740993001",
      fileIds: ["9007199254740993002"],
      uploadDirId: SCOPE,
    });
    expect(client.deleteOfflineTasks).toHaveBeenCalledWith(["9007199254740993003"]);
    expect(client.saveShare).not.toHaveBeenCalled();
    expect(attempt.status).toBe("succeeded");
    expect(attempt.materializedFileIds).toEqual(["924511245739356595"]);
  });

  it("routes ed2k through native offline even when candidate.type is manual", async () => {
    const client = fakeClient();
    const executor = makeExecutor(client);
    const url = "ed2k://|file|x.mkv|123|ABC|/";

    await executor.transfer({
      workflowRunId: "run-1",
      directoryId: SCOPE,
      candidate: candidate({ providerPayload: { url } }),
    });

    expect(client.resolveOffline).toHaveBeenCalledWith(url);
    expect(client.saveShare).not.toHaveBeenCalled();
  });

  it("reports a failed offline task loudly and deletes its terminal task row", async () => {
    const getOfflineTask = vi.fn<Pan123Client["getOfflineTask"]>(async (taskId) => ({
      taskId,
      name: "dead magnet",
      status: 1,
      progress: 17,
      size: 0,
    }));
    const client = fakeClient({ getOfflineTask });
    const executor = makeExecutor(client);

    const attempt = await executor.transfer({
      workflowRunId: "run-1",
      directoryId: SCOPE,
      candidate: candidate({
        type: "magnet" as ResourceType,
        providerPayload: { url: "magnet:?xt=urn:btih:deadbeef" },
      }),
    });

    expect(attempt.status).toBe("failed");
    expect(attempt.providerMessage).toMatch(/PAN123_OFFLINE_FAILED.*progress=17/);
    // The provider-controlled task name must NOT leak into the message (VIP/会员
    // in torrent names would trip the systemic-block classifier).
    expect(attempt.providerMessage).not.toContain("dead magnet");
    expect(client.deleteOfflineTasks).toHaveBeenCalledWith(["9007199254740993003"]);
  });

  it("reports a running task as no_target_change and deletes it before moving on", async () => {
    const getOfflineTask = vi.fn<Pan123Client["getOfflineTask"]>(async (taskId) => ({
      taskId,
      name: "slow magnet",
      status: 0,
      progress: 5,
      size: 100,
    }));
    const client = fakeClient({ getOfflineTask });
    const executor = makeExecutor(client, [SCOPE], { offlineTaskPollMaxPolls: 2 });

    const attempt = await executor.transfer({
      workflowRunId: "run-1",
      directoryId: SCOPE,
      candidate: candidate({
        type: "magnet" as ResourceType,
        providerPayload: { url: "magnet:?xt=urn:btih:slow" },
      }),
    });

    expect(attempt.status).toBe("no_target_change");
    expect(attempt.providerMessage).toMatch(/离线任务完成但目标目录未出现新视频/);
    expect(getOfflineTask).toHaveBeenCalledTimes(2);
    expect(client.deleteOfflineTasks).toHaveBeenCalledWith(["9007199254740993003"]);
  });

  it("deletes the offline task even when polling raises", async () => {
    const getOfflineTask = vi.fn<Pan123Client["getOfflineTask"]>(async () => {
      throw new Error("temporary task-list failure");
    });
    const client = fakeClient({ getOfflineTask });
    const executor = makeExecutor(client);

    const attempt = await executor.transfer({
      workflowRunId: "run-1",
      directoryId: SCOPE,
      candidate: candidate({
        type: "magnet" as ResourceType,
        providerPayload: { url: "magnet:?xt=urn:btih:poll-error" },
      }),
    });

    expect(attempt.status).toBe("failed");
    expect(attempt.providerMessage).toContain("temporary task-list failure");
    expect(client.deleteOfflineTasks).toHaveBeenCalledWith(["9007199254740993003"]);
  });

  it("surfaces cleanup failure after retrying task deletion", async () => {
    const deleteOfflineTasks = vi.fn<Pan123Client["deleteOfflineTasks"]>(async () => {
      throw new Error("delete unavailable");
    });
    const client = fakeClient({ deleteOfflineTasks });
    const executor = makeExecutor(client);

    const attempt = await executor.transfer({
      workflowRunId: "run-1",
      directoryId: SCOPE,
      candidate: candidate({
        type: "magnet" as ResourceType,
        providerPayload: { url: "magnet:?xt=urn:btih:cleanup-error" },
      }),
    });

    expect(attempt.status).toBe("failed");
    expect(attempt.providerMessage).toMatch(/PAN123_OFFLINE_CLEANUP_FAILED/);
    expect(deleteOfflineTasks).toHaveBeenCalledTimes(3);
  });

  it("reports failed (not throw) with the provider message for a dead/empty share", async () => {
    const saveShare = vi.fn<Pan123Client["saveShare"]>(async () => ({
      ok: false,
      message: "分享为空 / 已失效(share empty / dead)",
    }));
    const client = fakeClient({ saveShare });
    const executor = makeExecutor(client);

    const attempt = await executor.transfer({
      workflowRunId: "run-1",
      directoryId: SCOPE,
      candidate: candidate(),
    });

    expect(attempt.status).toBe("failed");
    expect(attempt.providerMessage).toMatch(/失效/);
    expect(attempt.materializedFileIds).toEqual([]);
  });

  it("reports failed when saveShare returns ok:false with an EMPTY message (never reclassified as success/no_target_change)", async () => {
    const saveShare = vi.fn<Pan123Client["saveShare"]>(async () => ({ ok: false, message: "" }));
    const client = fakeClient({ saveShare });
    const executor = makeExecutor(client);

    const attempt = await executor.transfer({
      workflowRunId: "run-1",
      directoryId: SCOPE,
      candidate: candidate(),
    });

    expect(attempt.status).toBe("failed");
    expect(attempt.providerMessage).not.toBe("");
  });

  it("reports failed on an unparseable share url without touching the client", async () => {
    const client = fakeClient();
    const executor = makeExecutor(client);

    const attempt = await executor.transfer({
      workflowRunId: "run-1",
      directoryId: SCOPE,
      candidate: candidate({ providerPayload: { url: "https://example.com/not-a-share" } }),
    });

    expect(attempt.status).toBe("failed");
    expect(attempt.providerMessage).toMatch(/PAN123_TRANSFER_FAILED/);
    expect(client.saveShare).not.toHaveBeenCalled();
  });

  it("propagates Pan123AuthError so the worker can freeze the drive (never absorbed)", async () => {
    const saveShare = vi.fn<Pan123Client["saveShare"]>(async () => {
      throw new Pan123AuthError("PAN123_AUTH_FAILED: token dead");
    });
    const client = fakeClient({ saveShare });
    const executor = makeExecutor(client);

    await expect(
      executor.transfer({ workflowRunId: "run-1", directoryId: SCOPE, candidate: candidate() }),
    ).rejects.toThrow(Pan123AuthError);
  });

  it("bounded settle-poll: waits for the async copy to land, then reports succeeded (copy/async is server-side async)", async () => {
    // /file/copy/async returns before the copy finishes queuing (saveShare is
    // fire-copy, unlike tianyi's poll-to-done). A single immediate re-list would
    // miss a big transfer still in the queue → false no_target_change ("lands
    // nothing" 老伤). Poll the target dir (probe: 8×2.5s) until videos appear.
    let lists = 0;
    const listFiles = vi.fn<Pan123Client["listFiles"]>(async () => {
      lists += 1;
      // #1 before-list empty; #2/#3 after-list empty (still queuing); #4 landed.
      return lists >= 4 ? [file("924511245739356595", "Show.S01E01.mkv")] : [];
    });
    const saveShare = vi.fn<Pan123Client["saveShare"]>(async () => ({ ok: true, message: "" }));
    const sleeps: number[] = [];
    const executor = makeExecutor(fakeClient({ listFiles, saveShare }), [SCOPE], {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    const attempt = await executor.transfer({
      workflowRunId: "run-1",
      directoryId: SCOPE,
      candidate: candidate(),
    });

    expect(attempt.status).toBe("succeeded");
    expect(attempt.materializedFileIds).toEqual(["924511245739356595"]);
    expect(sleeps.length).toBeGreaterThanOrEqual(2); // waited across the empty reads
    expect(sleeps.every((ms) => ms === 2500)).toBe(true); // default interval aligns with the probe
  });

  it("settle-poll exhausts and reports no_target_change when nothing ever lands (sleeps attempts-1 times)", async () => {
    const listFiles = vi.fn<Pan123Client["listFiles"]>(async () => []); // never lands
    const saveShare = vi.fn<Pan123Client["saveShare"]>(async () => ({ ok: true, message: "" }));
    const sleeps: number[] = [];
    const executor = makeExecutor(fakeClient({ listFiles, saveShare }), [SCOPE], {
      transferSettlePollAttempts: 4,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    const attempt = await executor.transfer({
      workflowRunId: "run-1",
      directoryId: SCOPE,
      candidate: candidate(),
    });

    expect(attempt.status).toBe("no_target_change");
    expect(attempt.materializedFileIds).toEqual([]);
    expect(sleeps.length).toBe(3); // attempts-1: sleep BETWEEN reads only, not after the last
  });

  it("diffs against a NON-empty before set: materializedFileIds carries only the newly landed id", async () => {
    // before was always empty in the other cases; verify the !before.has filter
    // excludes a pre-existing video and reports only the new one.
    let landed = false;
    const listFiles = vi.fn<Pan123Client["listFiles"]>(async () =>
      landed
        ? [file("old-1", "Show.S01E01.mkv"), file("new-1", "Show.S01E02.mkv")]
        : [file("old-1", "Show.S01E01.mkv")],
    );
    const saveShare = vi.fn<Pan123Client["saveShare"]>(async () => {
      landed = true;
      return { ok: true, message: "" };
    });
    const executor = makeExecutor(fakeClient({ listFiles, saveShare }));

    const attempt = await executor.transfer({
      workflowRunId: "run-1",
      directoryId: SCOPE,
      candidate: candidate(),
    });

    expect(attempt.status).toBe("succeeded");
    expect(attempt.materializedFileIds).toEqual(["new-1"]); // NOT old-1
  });

  it("providerPayload.password overrides the URL-parsed sharePwd; empty diff = no_target_change", async () => {
    const saveShare = vi.fn<Pan123Client["saveShare"]>(async () => ({ ok: true, message: "" }));
    const client = fakeClient({ saveShare });
    const executor = makeExecutor(client);

    const attempt = await executor.transfer({
      workflowRunId: "run-1",
      directoryId: SCOPE,
      candidate: candidate({
        providerPayload: { url: "https://www.123pan.com/s/abc-1?pwd=urlcode", password: "override1" },
      }),
    });

    expect(saveShare).toHaveBeenCalledWith(expect.objectContaining({ sharePwd: "override1" }));
    expect(attempt.status).toBe("no_target_change");
    expect(attempt.providerMessage).toMatch(/未出现新视频/);
  });
});

describe("Pan123StorageExecutor.transferSubtitleUrl(s) — assrt http 直链走 123 原生离线(真机 2026-09-21:单条 resolve、任务无 fileId、落目录根)", () => {
  const SUB_URL = (i: number) => `http://file1.assrt.net/onthefly/661796/-/${i}/Show.S01E0${i}.ass?_=1&-=x&api=1`;
  const SUB_NAME = (i: number) => `Show.S01E0${i}.ass`;
  const files = (n: number) => Array.from({ length: n }, (_, i) => ({ url: SUB_URL(i + 1), filename: SUB_NAME(i + 1) }));
  const subOpts = { subtitleTaskPollMaxPolls: 3, subtitleTaskPollIntervalMs: 0, subtitleResolveGapMs: 0 };

  it("lands a 3-file package: 1 before-list + 3 resolves + 1 submit + poll + 1 claim-list + 1 delete; ids/candidateIds in input order", async () => {
    let rn = 0;
    const resolveOffline = vi.fn<Pan123Client["resolveOffline"]>(async () => ({ resourceId: `res-${++rn}`, fileIds: ["f"] }));
    let listCalls = 0;
    const listFiles = vi.fn<Pan123Client["listFiles"]>(async () => {
      listCalls += 1;
      // 1st = before snapshot (empty); 2nd = claim (all three landed at the dir ROOT)
      return listCalls === 1 ? [] : [file("L1", SUB_NAME(1), 1), file("L2", SUB_NAME(2), 1), file("L3", SUB_NAME(3), 1)];
    });
    const client = fakeClient({ resolveOffline, listFiles });
    const executor = makeExecutor(client, [SCOPE], subOpts);

    const attempts = await executor.transferSubtitleUrls({ files: files(3), directoryId: SCOPE, workflowRunId: "run-1" });

    expect(attempts.map((a) => a.status)).toEqual(["succeeded", "succeeded", "succeeded"]);
    expect(attempts.map((a) => a.materializedFileIds)).toEqual([["L1"], ["L2"], ["L3"]]);
    expect(attempts.map((a) => a.id)).toEqual(["run-1_subtitle_1", "run-1_subtitle_2", "run-1_subtitle_3"]);
    expect(attempts.map((a) => a.candidateId)).toEqual([`subtitle:${SUB_NAME(1)}`, `subtitle:${SUB_NAME(2)}`, `subtitle:${SUB_NAME(3)}`]);
    expect(resolveOffline).toHaveBeenCalledTimes(3); // one url per resolve — 123 hard constraint
    expect(client.submitOfflineResources).toHaveBeenCalledTimes(1);
    expect((client.submitOfflineResources as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({ uploadDirId: SCOPE });
    expect(client.listOfflineTasks).toHaveBeenCalledTimes(1); // all terminal on the first poll
    expect(listFiles).toHaveBeenCalledTimes(2); // before + claim
    expect(client.deleteOfflineTasks).toHaveBeenCalledWith(["task-1", "task-2", "task-3"]);
  });

  it("claims by the RESOLVED name when it differs from the assrt filename (123 lands under the url's decoded path segment)", async () => {
    const resolveOffline = vi.fn<Pan123Client["resolveOffline"]>(async () => ({ resourceId: "r1", fileIds: ["f"], resolvedName: "Show.S01E01 (1).ass" }));
    let n = 0;
    const listFiles = vi.fn<Pan123Client["listFiles"]>(async () => (++n === 1 ? [] : [file("L9", "Show.S01E01 (1).ass", 1)]));
    const executor = makeExecutor(fakeClient({ resolveOffline, listFiles }), [SCOPE], subOpts);

    const [a] = await executor.transferSubtitleUrls({ files: files(1), directoryId: SCOPE, workflowRunId: "run-1" });

    expect(a!.status).toBe("succeeded");
    expect(a!.materializedFileIds).toEqual(["L9"]);
  });

  it("rejects path-y and duplicate filenames at the boundary with ZERO client calls for them; others proceed", async () => {
    let n = 0;
    const listFiles = vi.fn<Pan123Client["listFiles"]>(async () => (++n === 1 ? [] : [file("L1", "ok.ass", 1)]));
    const client = fakeClient({ listFiles });
    const executor = makeExecutor(client, [SCOPE], subOpts);

    const attempts = await executor.transferSubtitleUrls({
      files: [
        { url: "http://x/a", filename: "sub/evil.ass" },
        { url: "http://x/b", filename: "ok.ass" },
        { url: "http://x/c", filename: "ok.ass" },
      ],
      directoryId: SCOPE,
      workflowRunId: "run-1",
    });

    expect(attempts[0]!.status).toBe("failed");
    expect(attempts[0]!.providerMessage).toMatch(/SUBTITLE_INVALID_FILENAME/);
    expect(attempts[0]!.candidateId).toBe("subtitle:invalid_name_1");
    expect(attempts[1]!.status).toBe("succeeded");
    expect(attempts[2]!.status).toBe("failed");
    expect(attempts[2]!.providerMessage).toMatch(/SUBTITLE_DUPLICATE_FILENAME/);
    expect(client.resolveOffline).toHaveBeenCalledTimes(1);
  });

  it("an all-invalid package returns without touching the client", async () => {
    const client = fakeClient();
    const executor = makeExecutor(client, [SCOPE], subOpts);
    const attempts = await executor.transferSubtitleUrls({ files: [{ url: "http://x/a", filename: "a/b.ass" }], directoryId: SCOPE, workflowRunId: "run-1" });
    expect(attempts).toHaveLength(1);
    expect(client.listFiles).not.toHaveBeenCalled();
    expect(client.resolveOffline).not.toHaveBeenCalled();
  });

  it("a resolve rejection (e.g. 「暂不支持 TransferEncoding: chunked」) fails THAT file with the provider text; the rest land", async () => {
    let call = 0;
    const resolveOffline = vi.fn<Pan123Client["resolveOffline"]>(async () => {
      call += 1;
      if (call === 2) throw new Error("PAN123_OFFLINE_RESOLVE_FAILED: 解析失败：暂不支持 TransferEncoding: chunked 链接 (err_code=3)");
      return { resourceId: `r${call}`, fileIds: ["f"] };
    });
    let n = 0;
    const listFiles = vi.fn<Pan123Client["listFiles"]>(async () => (++n === 1 ? [] : [file("L1", SUB_NAME(1), 1), file("L3", SUB_NAME(3), 1)]));
    const client = fakeClient({ resolveOffline, listFiles });
    const executor = makeExecutor(client, [SCOPE], subOpts);

    const attempts = await executor.transferSubtitleUrls({ files: files(3), directoryId: SCOPE, workflowRunId: "run-1" });

    expect(attempts.map((a) => a.status)).toEqual(["succeeded", "failed", "succeeded"]);
    expect(attempts[1]!.providerMessage).toMatch(/TransferEncoding: chunked/);
    const submitted = (client.submitOfflineResources as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { resources: Array<{ resourceId: string }> };
    expect(submitted.resources.map((r) => r.resourceId)).toEqual(["r1", "r3"]); // the failed one is not submitted
  });

  it("stops resolving after 3 consecutive resolve failures; the rest are SUBTITLE_NOT_SUBMITTED and nothing is submitted", async () => {
    const resolveOffline = vi.fn<Pan123Client["resolveOffline"]>(async () => { throw new Error("PAN123_OFFLINE_RESOLVE_FAILED: empty response"); });
    const client = fakeClient({ resolveOffline });
    const executor = makeExecutor(client, [SCOPE], subOpts);

    const attempts = await executor.transferSubtitleUrls({ files: files(6), directoryId: SCOPE, workflowRunId: "run-1" });

    expect(resolveOffline).toHaveBeenCalledTimes(3);
    expect(attempts.slice(0, 3).every((a) => a.status === "failed" && /empty response/.test(a.providerMessage))).toBe(true);
    expect(attempts.slice(3).every((a) => a.status === "failed" && /^SUBTITLE_NOT_SUBMITTED: aborted after 3 consecutive resolve failures/.test(a.providerMessage))).toBe(true);
    expect(client.submitOfflineResources).not.toHaveBeenCalled();
    expect(client.listOfflineTasks).not.toHaveBeenCalled();
    expect(client.deleteOfflineTasks).not.toHaveBeenCalled();
  });

  it("a per-resource submit rejection fails that file (PAN123_OFFLINE_SUBMIT_FAILED prefix) and its task is not polled", async () => {
    const submitOfflineResources = vi.fn<Pan123Client["submitOfflineResources"]>(async (input) =>
      input.resources.map((r, i) => (i === 0 ? { resourceId: r.resourceId, taskId: null, error: "云下载配额不足，请升级VIP (err_code=41006)" } : { resourceId: r.resourceId, taskId: `task-${i}`, error: null })),
    );
    let n = 0;
    const listFiles = vi.fn<Pan123Client["listFiles"]>(async () => (++n === 1 ? [] : [file("L2", SUB_NAME(2), 1)]));
    const client = fakeClient({ submitOfflineResources, listFiles });
    const executor = makeExecutor(client, [SCOPE], subOpts);

    const attempts = await executor.transferSubtitleUrls({ files: files(2), directoryId: SCOPE, workflowRunId: "run-1" });

    expect(attempts[0]!.status).toBe("failed");
    expect(attempts[0]!.providerMessage).toBe("PAN123_OFFLINE_SUBMIT_FAILED: 云下载配额不足，请升级VIP (err_code=41006)");
    expect(attempts[1]!.status).toBe("succeeded");
    expect(client.listOfflineTasks).toHaveBeenCalledWith(["task-1"]);
    expect(client.deleteOfflineTasks).toHaveBeenCalledWith(["task-1"]);
  });

  it("falls back to per-resource submitOffline when the multi-resource submit THROWS (batch form unverified live)", async () => {
    const submitOfflineResources = vi.fn<Pan123Client["submitOfflineResources"]>(async () => { throw new Error("PAN123_FAILED(/v2/offline_download/task/submit): code=400 The ResourceList field is required"); });
    const submitOffline = vi.fn<Pan123Client["submitOffline"]>(async (input) => `single-${input.resourceId}`);
    let rn = 0;
    const resolveOffline = vi.fn<Pan123Client["resolveOffline"]>(async () => ({ resourceId: `r${++rn}`, fileIds: ["f"] }));
    let n = 0;
    const listFiles = vi.fn<Pan123Client["listFiles"]>(async () => (++n === 1 ? [] : [file("L1", SUB_NAME(1), 1), file("L2", SUB_NAME(2), 1)]));
    const client = fakeClient({ submitOfflineResources, submitOffline, resolveOffline, listFiles });
    const executor = makeExecutor(client, [SCOPE], subOpts);

    const attempts = await executor.transferSubtitleUrls({ files: files(2), directoryId: SCOPE, workflowRunId: "run-1" });

    expect(submitOffline).toHaveBeenCalledTimes(2);
    expect(attempts.every((a) => a.status === "succeeded")).toBe(true);
    expect(client.listOfflineTasks).toHaveBeenCalledWith(["single-r1", "single-r2"]);
  });

  it("task status 1 → failed with a FIXED template (never the uploader-controlled task.name)", async () => {
    const listOfflineTasks = vi.fn<Pan123Client["listOfflineTasks"]>(async (ids) => ids.map((taskId) => ({ taskId, name: "云下载配额不足 VIP会员 登录", status: 1, progress: 37, size: 1 })));
    const client = fakeClient({ listOfflineTasks });
    const executor = makeExecutor(client, [SCOPE], subOpts);

    const [a] = await executor.transferSubtitleUrls({ files: files(1), directoryId: SCOPE, workflowRunId: "run-1" });

    expect(a!.status).toBe("failed");
    expect(a!.providerMessage).toBe("PAN123_OFFLINE_FAILED: offline task failed at progress=37");
    expect(a!.providerMessage).not.toContain("VIP");
    expect(client.deleteOfflineTasks).toHaveBeenCalledWith(["task-1"]);
  });

  it("poll window exhausted (status stays 0) → no_target_change, task deleted, sleeps polls−1 times", async () => {
    const listOfflineTasks = vi.fn<Pan123Client["listOfflineTasks"]>(async (ids) => ids.map((taskId) => ({ taskId, name: "s", status: 0, progress: 10, size: 1 })));
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
    const client = fakeClient({ listOfflineTasks });
    const executor = makeExecutor(client, [SCOPE], { ...subOpts, subtitleTaskPollMaxPolls: 3, subtitleTaskPollIntervalMs: 7, sleep });

    const [a] = await executor.transferSubtitleUrls({ files: files(1), directoryId: SCOPE, workflowRunId: "run-1" });

    expect(a!.status).toBe("no_target_change");
    expect(a!.providerMessage).toMatch(/SUBTITLE_NOT_LANDED.*轮询窗口/);
    expect(listOfflineTasks).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.filter((c) => c[0] === 7)).toHaveLength(2);
    expect(client.deleteOfflineTasks).toHaveBeenCalledWith(["task-1"]);
    expect(client.listFiles).toHaveBeenCalledTimes(1); // before only — nothing to claim
  });

  it("status 2 but the name is not in the directory → no_target_change (never trust the task row over the directory)", async () => {
    const listFiles = vi.fn<Pan123Client["listFiles"]>(async () => []);
    const executor = makeExecutor(fakeClient({ listFiles }), [SCOPE], subOpts);
    const [a] = await executor.transferSubtitleUrls({ files: files(1), directoryId: SCOPE, workflowRunId: "run-1" });
    expect(a!.status).toBe("no_target_change");
    expect(a!.providerMessage).toMatch(/SUBTITLE_NOT_LANDED.*不在目标目录/);
  });

  it("a PRE-EXISTING same-named file is not claimed (before/after diff), so a stale leftover cannot fake a success", async () => {
    const listFiles = vi.fn<Pan123Client["listFiles"]>(async () => [file("OLD", SUB_NAME(1), 1)]); // same before and after
    const executor = makeExecutor(fakeClient({ listFiles }), [SCOPE], subOpts);
    const [a] = await executor.transferSubtitleUrls({ files: files(1), directoryId: SCOPE, workflowRunId: "run-1" });
    expect(a!.status).toBe("no_target_change");
    expect(a!.materializedFileIds).toEqual([]);
  });

  it("deleteOfflineTasks failure is swallowed (subtitles are soft; a late landing is staging junk), attempts unchanged", async () => {
    const deleteOfflineTasks = vi.fn<Pan123Client["deleteOfflineTasks"]>(async () => { throw new Error("PAN123_FAILED(/offline_download/task/delete): code=500"); });
    let n = 0;
    const listFiles = vi.fn<Pan123Client["listFiles"]>(async () => (++n === 1 ? [] : [file("L1", SUB_NAME(1), 1)]));
    const executor = makeExecutor(fakeClient({ deleteOfflineTasks, listFiles }), [SCOPE], subOpts);
    const [a] = await executor.transferSubtitleUrls({ files: files(1), directoryId: SCOPE, workflowRunId: "run-1" });
    expect(a!.status).toBe("succeeded");
  });

  it("Pan123AuthError propagates from resolve, from the poll, and from the claim listing (never softened)", async () => {
    const auth = () => new Pan123AuthError("PAN123_AUTH_FAILED: token dead");
    const viaResolve = makeExecutor(fakeClient({ resolveOffline: vi.fn(async () => { throw auth(); }) }), [SCOPE], subOpts);
    await expect(viaResolve.transferSubtitleUrls({ files: files(1), directoryId: SCOPE, workflowRunId: "r" })).rejects.toBeInstanceOf(Pan123AuthError);
    const viaPoll = makeExecutor(fakeClient({ listOfflineTasks: vi.fn(async () => { throw auth(); }) }), [SCOPE], subOpts);
    await expect(viaPoll.transferSubtitleUrls({ files: files(1), directoryId: SCOPE, workflowRunId: "r" })).rejects.toBeInstanceOf(Pan123AuthError);
    let n = 0;
    const viaClaim = makeExecutor(fakeClient({ listFiles: vi.fn(async () => { if (++n === 2) throw auth(); return []; }) }), [SCOPE], subOpts);
    await expect(viaClaim.transferSubtitleUrls({ files: files(1), directoryId: SCOPE, workflowRunId: "r" })).rejects.toBeInstanceOf(Pan123AuthError);
  });

  it("refuses a target directory outside the write scope before any client call", async () => {
    const client = fakeClient();
    const executor = makeExecutor(client, [SCOPE], subOpts);
    await expect(executor.transferSubtitleUrls({ files: files(1), directoryId: "elsewhere", workflowRunId: "r" })).rejects.toThrow("WRITE_SCOPE_VIOLATION");
    expect(client.listFiles).not.toHaveBeenCalled();
  });

  it("shares the attempt counter with transfer(): a video transfer then a subtitle batch never collide on id", async () => {
    let n = 0;
    // listFiles calls: video before(1), video after(2), subtitle before(3), subtitle claim(4)
    const listFiles = vi.fn<Pan123Client["listFiles"]>(async () => (++n <= 3 ? [] : [file("L1", SUB_NAME(1), 1)]));
    const client = fakeClient({ listFiles });
    const executor = makeExecutor(client, [SCOPE], { ...subOpts, transferSettlePollAttempts: 1 });
    const video = await executor.transfer({ workflowRunId: "run-1", directoryId: SCOPE, candidate: candidate() });
    const [sub] = await executor.transferSubtitleUrls({ files: files(1), directoryId: SCOPE, workflowRunId: "run-1" });
    expect(video.id).toBe("run-1_transfer_1");
    expect(sub!.id).toBe("run-1_subtitle_2");
  });

  it("transferSubtitleUrl (single) delegates to the batch and returns the one attempt", async () => {
    let n = 0;
    const listFiles = vi.fn<Pan123Client["listFiles"]>(async () => (++n === 1 ? [] : [file("L1", SUB_NAME(1), 1)]));
    const executor = makeExecutor(fakeClient({ listFiles }), [SCOPE], subOpts);
    const a = await executor.transferSubtitleUrl({ url: SUB_URL(1), filename: SUB_NAME(1), directoryId: SCOPE, workflowRunId: "run-1" });
    expect(a).toMatchObject({ id: "run-1_subtitle_1", candidateId: `subtitle:${SUB_NAME(1)}`, status: "succeeded", materializedFileIds: ["L1"] });
  });

  it("paces resolves with subtitleResolveGapMs between them (not before the first)", async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
    let n = 0;
    const listFiles = vi.fn<Pan123Client["listFiles"]>(async () => (++n === 1 ? [] : [file("L1", SUB_NAME(1), 1), file("L2", SUB_NAME(2), 1), file("L3", SUB_NAME(3), 1)]));
    const executor = makeExecutor(fakeClient({ listFiles }), [SCOPE], { ...subOpts, subtitleResolveGapMs: 11, sleep });
    await executor.transferSubtitleUrls({ files: files(3), directoryId: SCOPE, workflowRunId: "run-1" });
    expect(sleep.mock.calls.filter((c) => c[0] === 11)).toHaveLength(2);
  });
});

describe("Pan123StorageExecutor.createDirectory", () => {
  it("find-or-create reuses a same-name folder and registers it in derived scope", async () => {
    // A same-name FILE must not match — only isFolder items count.
    const listFiles = vi.fn<Pan123Client["listFiles"]>(async () => [
      file("afile", "TV"),
      folder("exist", "TV"),
    ]);
    const client = fakeClient({ listFiles });
    const executor = makeExecutor(client, ["root"]);

    await expect(executor.createDirectory({ name: "TV", parentId: "root" })).resolves.toBe("exist");
    expect(client.createFolder).not.toHaveBeenCalled();
    // derived: a subsequent write into "exist" must now pass the scope guard
    await expect(
      executor.renameFile({ directoryId: "exist", fileId: "f1", newName: "x.mkv" }),
    ).resolves.toBeUndefined();
    expect(client.renameFile).toHaveBeenCalledWith({ fileId: "f1", name: "x.mkv" });
  });

  it("creates a new folder when none matches and authorizes writes into it", async () => {
    const createFolder = vi.fn<Pan123Client["createFolder"]>(async () => "fresh-dir");
    const client = fakeClient({ createFolder });
    const executor = makeExecutor(client, ["root"]);

    await expect(executor.createDirectory({ name: "Movies", parentId: "root" })).resolves.toBe("fresh-dir");
    expect(createFolder).toHaveBeenCalledWith({ name: "Movies", parentId: "root" });

    // derived scope covers the CREATE branch too. The port only hands ids; 123's
    // moveFiles takes a bare fileIds[] + targetParentId.
    const moved = await executor.moveFiles({ fileIds: ["f1"], targetDirectoryId: "fresh-dir" });
    expect(moved).toEqual({ moved: ["f1"] });
    expect(client.moveFiles).toHaveBeenCalledWith({ fileIds: ["f1"], targetParentId: "fresh-dir" });
  });

  it("refuses createDirectory under an out-of-scope parent (WRITE_SCOPE_VIOLATION)", async () => {
    const client = fakeClient();
    const executor = makeExecutor(client);
    await expect(executor.createDirectory({ name: "x", parentId: "elsewhere" })).rejects.toThrow(
      /WRITE_SCOPE_VIOLATION/,
    );
  });
});

describe("Pan123StorageExecutor write-scope guard (derived scope)", () => {
  it("refuses transfer into an id not in scope, before any client call", async () => {
    const client = fakeClient();
    const executor = makeExecutor(client);
    await expect(
      executor.transfer({ workflowRunId: "run-1", directoryId: "elsewhere", candidate: candidate() }),
    ).rejects.toThrow(/WRITE_SCOPE_VIOLATION/);
    expect(client.saveShare).not.toHaveBeenCalled();
    expect(client.listFiles).not.toHaveBeenCalled();
  });

  it("authorizes removeDirectory of a server-created subdir discovered under an in-scope dir (PR#58)", async () => {
    // SHARE_SAVE materializes wrapper dirs SERVER-SIDE (not via createDirectory).
    // Discovering one by listing its in-scope parent must make it removable, or
    // movie-flatten cleanup leaves empty wrappers behind.
    const MOVIE = "movie-dir";
    const wrapperId = "wrapper-1";
    const fs = new Map<string, Pan123Item[]>();
    fs.set(MOVIE, [folder(wrapperId, "Oppenheimer.2023.1080p")]);
    fs.set(wrapperId, []);
    const listFiles = vi.fn<Pan123Client["listFiles"]>(async (dirId) => fs.get(dirId ?? "") ?? []);
    const trash = vi.fn<Pan123Client["trash"]>(async () => {});
    const executor = makeExecutor(fakeClient({ listFiles, trash }), [MOVIE]);

    const subdirs = await executor.listSubdirectories({ directoryId: MOVIE });
    expect(subdirs.map((d) => d.id)).toContain(wrapperId);

    await expect(executor.removeDirectory(wrapperId)).resolves.toEqual({ removed: true });
    // Folder delete MUST carry isFolder:true; name is unknown at this call site — sent name-less.
    expect(trash).toHaveBeenCalledWith([{ id: wrapperId, isFolder: true }]);
  });

  it("authorizes createDirectory under a show folder REUSED via listChildDirectories (production 莉可丽丝 bug)", async () => {
    // Real production failure 2026-07-23: a legacy show folder (`莉可丽丝 (2022)`)
    // already existed on the 123 drive from an earlier run. ensureMediaLibraryDirectory
    // found it via listChildDirectories(anime_cid) and returned its id — but
    // listChildDirectories never registered it in derived scope, so the follow-up
    // createDirectory(Season 01, parentId=showId) died with WRITE_SCOPE_VIOLATION.
    const fs = new Map<string, Pan123Item[]>();
    fs.set(SCOPE, [folder("existing-show", "莉可丽丝 (2022)")]);
    fs.set("existing-show", []);
    const listFiles = vi.fn<Pan123Client["listFiles"]>(async (dirId) => fs.get(dirId ?? "") ?? []);
    const executor = makeExecutor(fakeClient({ listFiles }));

    const children = await executor.listChildDirectories(SCOPE);
    expect(children).toEqual([{ id: "existing-show", name: "莉可丽丝 (2022)" }]);

    await expect(
      executor.createDirectory({ name: "Season 01", parentId: "existing-show" }),
    ).resolves.toBe("newdir123");
  });

  it("does NOT widen scope via listChildDirectories on an OUT-of-scope dir (read ≠ write)", async () => {
    const fs = new Map<string, Pan123Item[]>();
    fs.set("elsewhere", [folder("stranger", "x")]);
    const listFiles = vi.fn<Pan123Client["listFiles"]>(async (dirId) => fs.get(dirId ?? "") ?? []);
    const executor = makeExecutor(fakeClient({ listFiles }));

    await executor.listChildDirectories("elsewhere");
    await expect(
      executor.createDirectory({ name: "Season 01", parentId: "stranger" }),
    ).rejects.toThrow(/WRITE_SCOPE_VIOLATION/);
  });

  it("does NOT widen scope by listing an OUT-of-scope dir (read ≠ write)", async () => {
    const fs = new Map<string, Pan123Item[]>();
    fs.set("elsewhere", [folder("stranger", "x")]);
    fs.set("stranger", []);
    const listFiles = vi.fn<Pan123Client["listFiles"]>(async (dirId) => fs.get(dirId ?? "") ?? []);
    const executor = makeExecutor(fakeClient({ listFiles }));

    await executor.listSubdirectories({ directoryId: "elsewhere" });
    await expect(executor.removeDirectory("stranger")).rejects.toThrow(/WRITE_SCOPE_VIOLATION/);
  });
});

describe("Pan123StorageExecutor.removeDirectory / recursive-list safety", () => {
  it("refuses to remove a write-scope root (SAFETY_VIOLATION)", async () => {
    const executor = makeExecutor(fakeClient());
    await expect(executor.removeDirectory(SCOPE)).rejects.toThrow(/SAFETY_VIOLATION/);
  });

  it("refuses to recursively list the 123 account root 0 even with an empty (dev) scope", async () => {
    const executor = makeExecutor(fakeClient(), []);
    await expect(executor.listVideoFiles("0")).rejects.toThrow(/SAFETY_VIOLATION/);
    await expect(executor.listTree({ directoryId: "0" })).rejects.toThrow(/SAFETY_VIOLATION/);
  });
});

describe("Pan123StorageExecutor.flattenDirectory", () => {
  it("moves large nested videos up (moveFiles fileIds) and trashes wrapper dirs left without large videos", async () => {
    const fs = new Map<string, Pan123Item[]>();
    fs.set(SCOPE, [folder("wrap", "Movie.2020.1080p"), folder("junk", "ads")]);
    fs.set("wrap", [file("v1", "Movie.2020.mkv"), file("nfo", "info.nfo", 100)]);
    fs.set("junk", [file("ad", "ad.txt", 100)]);
    const listFiles = vi.fn<Pan123Client["listFiles"]>(async (dirId) => fs.get(dirId ?? "") ?? []);
    const moveFiles = vi.fn<Pan123Client["moveFiles"]>(async ({ fileIds, targetParentId }) => {
      for (const id of fileIds) {
        for (const items of fs.values()) {
          const idx = items.findIndex((i) => i.id === id);
          if (idx >= 0) {
            const [moved] = items.splice(idx, 1);
            if (moved) {
              fs.get(targetParentId)?.push(moved);
            }
          }
        }
      }
    });
    const trash = vi.fn<Pan123Client["trash"]>(async () => {});
    const executor = makeExecutor(fakeClient({ listFiles, moveFiles, trash }));

    const result = await executor.flattenDirectory(SCOPE);

    expect(result.moved).toEqual(["v1"]);
    // videos are always isFolder:false — only fileIds ride along for 123's moveFiles.
    expect(moveFiles).toHaveBeenCalledWith({ fileIds: ["v1"], targetParentId: SCOPE });
    // "wrap" lost its only large video to the move; "junk" never had one — both go,
    // as FOLDER entries (isFolder:true + name from the flatten's own listing).
    expect(result.removed).toEqual(["wrap", "junk"]);
    expect(trash).toHaveBeenCalledWith([
      { id: "wrap", name: "Movie.2020.1080p", isFolder: true },
      { id: "junk", name: "ads", isFolder: true },
    ]);
  });

  it("fails loud when the trash call reports failure (no zombie wrappers masquerading as success)", async () => {
    const fs = new Map<string, Pan123Item[]>();
    fs.set(SCOPE, [folder("junk", "ads")]);
    fs.set("junk", []);
    const listFiles = vi.fn<Pan123Client["listFiles"]>(async (dirId) => fs.get(dirId ?? "") ?? []);
    const trash = vi.fn<Pan123Client["trash"]>(async () => {
      throw new Error("PAN123_FAILED(/file/trash): code=5000 ...");
    });
    const executor = makeExecutor(fakeClient({ listFiles, trash }));

    await expect(executor.flattenDirectory(SCOPE)).rejects.toThrow(/PAN123_FAILED/);
  });
});

describe("Pan123StorageExecutor.deleteFiles", () => {
  it("deletes a non-video file (subtitle) that the directory TREE contains — verify via listTree, not listVideoFiles", async () => {
    const listFiles = vi.fn<Pan123Client["listFiles"]>(async () => [file("sub1", "多余字幕.srt", 77944)]);
    const trash = vi.fn<Pan123Client["trash"]>(async () => {});
    const executor = makeExecutor(fakeClient({ listFiles, trash }));

    await expect(executor.deleteFiles({ directoryId: SCOPE, fileIds: ["sub1"] })).resolves.toEqual({
      deleted: ["sub1"],
    });
    // File entries: isFolder:false; the basename is free from the just-walked tree.
    expect(trash).toHaveBeenCalledWith([{ id: "sub1", name: "多余字幕.srt", isFolder: false }]);
  });

  it("refuses ids that are nowhere in the directory tree (SAFETY_VIOLATION)", async () => {
    const listFiles = vi.fn<Pan123Client["listFiles"]>(async () => [file("sub1", "多余字幕.srt", 77944)]);
    const client = fakeClient({ listFiles });
    const executor = makeExecutor(client);

    await expect(executor.deleteFiles({ directoryId: SCOPE, fileIds: ["ghost"] })).rejects.toThrow(
      /SAFETY_VIOLATION/,
    );
    expect(client.trash).not.toHaveBeenCalled();
  });
});

describe("Pan123StorageExecutor item adapter (isFolder/id/name/size)", () => {
  it("listVideoFiles recurses, filters by video extension and parses episode codes", async () => {
    const fs = new Map<string, Pan123Item[]>();
    fs.set(SCOPE, [
      file("v1", "Show.S01E03.1080p.mkv"),
      file("p1", "poster.jpg", 100),
      folder("d1", "Extras"),
    ]);
    fs.set("d1", [file("v2", "Movie.2020.mp4")]);
    const listFiles = vi.fn<Pan123Client["listFiles"]>(async (dirId) => fs.get(dirId ?? "") ?? []);
    const executor = makeExecutor(fakeClient({ listFiles }));

    const videos = await executor.listVideoFiles(SCOPE);

    expect(videos.map((v) => v.name).sort()).toEqual(["Movie.2020.mp4", "Show.S01E03.1080p.mkv"]);
    expect(videos.find((v) => v.id === "v1")?.episodeCode).toBe("S01E03");
    expect(videos.find((v) => v.id === "v2")?.episodeCode).toBeNull();
  });

  it("listUnparsedVideoFiles returns only videos lacking an episode code", async () => {
    const listFiles = vi.fn<Pan123Client["listFiles"]>(async () => [
      file("v1", "Show.S01E03.mkv"),
      file("v2", "神印王座之无名乱斗.mp4"),
    ]);
    const executor = makeExecutor(fakeClient({ listFiles }));

    const unparsed = await executor.listUnparsedVideoFiles(SCOPE);
    expect(unparsed.map((u) => u.providerFileId)).toEqual(["v2"]);
  });

  it("listChildDirectories returns only isFolder entries (one level)", async () => {
    const listFiles = vi.fn<Pan123Client["listFiles"]>(async () => [
      folder("d1", "Season 1"),
      file("f1", "ep.mkv"),
      folder("d2", "Season 2"),
    ]);
    const executor = makeExecutor(fakeClient({ listFiles }));

    await expect(executor.listChildDirectories(SCOPE)).resolves.toEqual([
      { id: "d1", name: "Season 1" },
      { id: "d2", name: "Season 2" },
    ]);
  });
});
