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

describe("Pan123StorageExecutor.transferSubtitleUrl(s) — 逐文件 resolve→立即 submit 流水线、以目录为准认领(真机 2026-09-22:assrt 直链约 5 分钟过期、多资源 submit 静默失败)", () => {
  const SUB_URL = (i: number) => `http://file1.assrt.net/onthefly/661796/-/${i}/Show.S01E0${i}.ass?_=1&-=x&api=1`;
  const SUB_NAME = (i: number) => `Show.S01E0${i}.ass`;
  const files = (n: number) => Array.from({ length: n }, (_, i) => ({ url: SUB_URL(i + 1), filename: SUB_NAME(i + 1) }));
  /** Package file i as the claim listing shows it once it has landed. */
  const landed = (i: number) => file(`L${i}`, SUB_NAME(i), 1);
  const subOpts = { subtitleTaskPollMaxPolls: 3, subtitleTaskPollIntervalMs: 0, subtitleResolveRetryDelayMs: 0 };
  const auth = (why = "token dead") => new Pan123AuthError(`PAN123_AUTH_FAILED: ${why}`);
  const resolveFailure = (text = "解析失败") => new Error(`PAN123_OFFLINE_RESOLVE_FAILED: ${text} (err_code=3)`);
  const run = (executor: Pan123StorageExecutor, n: number) =>
    executor.transferSubtitleUrls({ files: files(n), directoryId: SCOPE, workflowRunId: "run-1" });

  type ResolveResult = Awaited<ReturnType<Pan123Client["resolveOffline"]>>;
  type TaskRow = Awaited<ReturnType<Pan123Client["listOfflineTasks"]>>[number];
  const row = (taskId: string, status: number, progress = 100, name = "sub"): TaskRow => ({ taskId, name, status, progress, size: 1 });

  /** Deviations from the happy path. Any hook may throw; resolve/submit/poll
   *  returning undefined fall through to the default answer. */
  interface Script {
    before?: Pan123Item[];
    after?: Pan123Item[] | (() => Pan123Item[]);
    resolve?: (url: string, call: number) => ResolveResult | undefined;
    submit?: (resourceId: string, call: number) => string | undefined;
    poll?: (ids: string[], call: number) => TaskRow[] | undefined;
    remove?: (ids: string[]) => void;
  }

  /** fakeClient wired for the pipeline: every client call and every sleep appends
   *  to ONE shared `log`. Defaults: resolveOffline → res-<k>, k numbering the
   *  DISTINCT urls in first-seen order (a retry of a url gets the same id);
   *  submitOffline → task-<n> (n = submit call #); every polled task is status 2;
   *  listFiles call #1 = the BEFORE snapshot, every later call = the claim listing. */
  function harness(script: Script = {}, extra: Partial<Pan123StorageExecutorOptions> = {}) {
    const log: string[] = [];
    const resourceIds = new Map<string, string>();
    const calls = { resolve: 0, submit: 0, poll: 0, list: 0 };
    const client = fakeClient({
      listFiles: vi.fn<Pan123Client["listFiles"]>(async () => {
        calls.list += 1;
        if (calls.list === 1) {
          log.push("list:before");
          return script.before ?? [];
        }
        log.push("list:claim");
        return typeof script.after === "function" ? script.after() : (script.after ?? []);
      }),
      resolveOffline: vi.fn<Pan123Client["resolveOffline"]>(async (url) => {
        calls.resolve += 1;
        log.push(`resolve:${url}`);
        if (!resourceIds.has(url)) {
          resourceIds.set(url, `res-${resourceIds.size + 1}`);
        }
        return script.resolve?.(url, calls.resolve) ?? { resourceId: resourceIds.get(url)!, fileIds: ["f"] };
      }),
      submitOffline: vi.fn<Pan123Client["submitOffline"]>(async (input) => {
        calls.submit += 1;
        log.push(`submit:${input.resourceId}`);
        return script.submit?.(input.resourceId, calls.submit) ?? `task-${calls.submit}`;
      }),
      listOfflineTasks: vi.fn<Pan123Client["listOfflineTasks"]>(async (ids) => {
        calls.poll += 1;
        log.push(`poll:${ids.join(",")}`);
        return script.poll?.(ids, calls.poll) ?? ids.map((id) => row(id, 2));
      }),
      deleteOfflineTasks: vi.fn<Pan123Client["deleteOfflineTasks"]>(async (ids) => {
        log.push(`delete:${ids.join(",")}`);
        script.remove?.(ids);
      }),
    });
    const sleep = vi.fn<(ms: number) => Promise<void>>(async (ms) => {
      log.push(`sleep:${ms}`);
    });
    const executor = makeExecutor(client, [SCOPE], { ...subOpts, sleep, ...extra });
    return { client, executor, log, sleep };
  }

  it("pipelines each file — resolve → IMMEDIATE submit → next — then 1 poll round, 1 claim listing, 1 delete; ids/candidateIds in input order", async () => {
    const { client, executor, log } = harness({ after: [landed(1), landed(2), landed(3)] });

    const attempts = await run(executor, 3);

    expect(log).toEqual([
      "list:before",
      `resolve:${SUB_URL(1)}`,
      "submit:res-1",
      `resolve:${SUB_URL(2)}`,
      "submit:res-2",
      `resolve:${SUB_URL(3)}`,
      "submit:res-3",
      "poll:task-1,task-2,task-3",
      "list:claim",
      "delete:task-1,task-2,task-3",
    ]);
    expect(client.submitOffline).toHaveBeenNthCalledWith(1, { resourceId: "res-1", fileIds: ["f"], uploadDirId: SCOPE });
    expect(attempts.map((a) => a.status)).toEqual(["succeeded", "succeeded", "succeeded"]);
    expect(attempts.map((a) => a.materializedFileIds)).toEqual([["L1"], ["L2"], ["L3"]]);
    expect(attempts.map((a) => a.providerMessage)).toEqual(["", "", ""]);
    expect(attempts.map((a) => a.id)).toEqual(["run-1_subtitle_1", "run-1_subtitle_2", "run-1_subtitle_3"]);
    expect(attempts.map((a) => a.candidateId)).toEqual([1, 2, 3].map((i) => `subtitle:${SUB_NAME(i)}`));
    expect(client.listFiles).toHaveBeenCalledTimes(2);
    expect(client.deleteOfflineTasks).toHaveBeenCalledWith(["task-1", "task-2", "task-3"]);
  });

  it("costs 1 before-list + per file 1 resolve + 1 submit, then 1 poll round + 1 claim-list + 1 delete when all land on the first poll (N=3)", async () => {
    const { client, executor } = harness({ after: [landed(1), landed(2), landed(3)] });

    await run(executor, 3);

    expect(client.listFiles).toHaveBeenCalledTimes(2);
    expect(client.resolveOffline).toHaveBeenCalledTimes(3);
    expect(client.submitOffline).toHaveBeenCalledTimes(3);
    expect(client.listOfflineTasks).toHaveBeenCalledTimes(1);
    expect(client.deleteOfflineTasks).toHaveBeenCalledTimes(1);
    expect(client.getOfflineTask).not.toHaveBeenCalled();
  });

  it("claims by the RESOLVED name when it differs from the assrt filename (123 lands under the url's decoded path segment)", async () => {
    const { executor } = harness({
      after: [file("L9", "Show.S01E01 (1).ass", 1)],
      resolve: () => ({ resourceId: "res-1", fileIds: ["f"], resolvedName: "Show.S01E01 (1).ass" }),
    });

    const [a] = await run(executor, 1);

    expect(a).toMatchObject({ status: "succeeded", materializedFileIds: ["L9"], materializedNames: ["Show.S01E01 (1).ass"] });
  });

  it("rejects path-y and duplicate filenames at the boundary with ZERO client calls for them; the valid file proceeds", async () => {
    const { client, executor, log } = harness({ after: [file("L1", "ok.ass", 1)] });

    const attempts = await executor.transferSubtitleUrls({
      files: [
        { url: "http://x/a", filename: "sub/evil.ass" },
        { url: "http://x/b", filename: "ok.ass" },
        { url: "http://x/c", filename: "ok.ass" },
      ],
      directoryId: SCOPE,
      workflowRunId: "run-1",
    });

    expect(attempts[0]).toMatchObject({ status: "failed", candidateId: "subtitle:invalid_name_1" });
    expect(attempts[0]!.providerMessage).toMatch(/^SUBTITLE_INVALID_FILENAME/);
    expect(attempts[1]).toMatchObject({ status: "succeeded", materializedFileIds: ["L1"] });
    expect(attempts[2]!.status).toBe("failed");
    expect(attempts[2]!.providerMessage).toMatch(/^SUBTITLE_DUPLICATE_FILENAME/);
    expect(log.filter((entry) => entry.startsWith("resolve:"))).toEqual(["resolve:http://x/b"]);
    expect(client.submitOffline).toHaveBeenCalledTimes(1);
  });

  it("an all-invalid package returns without touching the client", async () => {
    const { executor, log } = harness();

    const attempts = await executor.transferSubtitleUrls({
      files: [
        { url: "http://x/a", filename: "a/b.ass" },
        { url: "http://x/b", filename: "c\\d.ass" },
      ],
      directoryId: SCOPE,
      workflowRunId: "run-1",
    });

    expect(attempts.map((a) => a.status)).toEqual(["failed", "failed"]);
    expect(log).toEqual([]);
  });

  it("retries a non-auth resolve failure ONCE after subtitleResolveRetryDelayMs (some err_code=3 are transient assrt 503s), and the retried file lands", async () => {
    let tries = 0;
    const { executor, log } = harness(
      {
        after: [landed(1)],
        resolve: () => {
          tries += 1;
          if (tries === 1) {
            throw resolveFailure();
          }
          return undefined;
        },
      },
      { subtitleResolveRetryDelayMs: 13 },
    );

    const [a] = await run(executor, 1);

    expect(log.slice(0, 5)).toEqual(["list:before", `resolve:${SUB_URL(1)}`, "sleep:13", `resolve:${SUB_URL(1)}`, "submit:res-1"]);
    expect(a).toMatchObject({ status: "succeeded", materializedFileIds: ["L1"], providerMessage: "" });
  });

  it("defaults subtitleResolveRetryDelayMs to 2 s", async () => {
    let tries = 0;
    const h = harness({
      after: [landed(1)],
      resolve: () => {
        tries += 1;
        if (tries === 1) {
          throw resolveFailure();
        }
        return undefined;
      },
    });
    const executor = makeExecutor(h.client, [SCOPE], { sleep: h.sleep, subtitleTaskPollIntervalMs: 0 });

    await run(executor, 1);

    expect(h.log.slice(0, 4)).toEqual(["list:before", `resolve:${SUB_URL(1)}`, "sleep:2000", `resolve:${SUB_URL(1)}`]);
  });

  it("a file whose resolve fails twice is failed with the provider text and never submitted; the others land", async () => {
    let fileTwoTries = 0;
    const { client, executor, log } = harness({
      after: [landed(1), landed(3)],
      resolve: (url) => {
        if (url !== SUB_URL(2)) {
          return undefined;
        }
        fileTwoTries += 1;
        throw fileTwoTries === 1 ? resolveFailure() : resolveFailure("解析失败：暂不支持 TransferEncoding: chunked 链接");
      },
    });

    const attempts = await run(executor, 3);

    expect(attempts.map((a) => a.status)).toEqual(["succeeded", "failed", "succeeded"]);
    expect(attempts[1]!.providerMessage).toBe("PAN123_OFFLINE_RESOLVE_FAILED: 解析失败：暂不支持 TransferEncoding: chunked 链接 (err_code=3)");
    expect(client.resolveOffline).toHaveBeenCalledTimes(4);
    expect(log.filter((entry) => entry.startsWith("submit:"))).toEqual(["submit:res-1", "submit:res-3"]);
  });

  it("aborts after 3 consecutive files fail to resolve (each tried twice): the rest are SUBTITLE_NOT_SUBMITTED; with no task created there is no poll/claim/delete", async () => {
    const { client, executor } = harness({
      resolve: () => {
        throw resolveFailure();
      },
    });

    const attempts = await run(executor, 6);

    expect(client.resolveOffline).toHaveBeenCalledTimes(6); // 3 files × (try + 1 retry)
    for (const a of attempts.slice(0, 3)) {
      expect(a).toMatchObject({ status: "failed", providerMessage: "PAN123_OFFLINE_RESOLVE_FAILED: 解析失败 (err_code=3)" });
    }
    for (const a of attempts.slice(3)) {
      expect(a).toMatchObject({
        status: "failed",
        providerMessage:
          "SUBTITLE_NOT_SUBMITTED: aborted after 3 consecutive files failed to submit (last: PAN123_OFFLINE_RESOLVE_FAILED: 解析失败 (err_code=3))",
      });
    }
    expect(client.submitOffline).not.toHaveBeenCalled();
    expect(client.listOfflineTasks).not.toHaveBeenCalled();
    expect(client.listFiles).toHaveBeenCalledTimes(1); // the before snapshot only
    expect(client.deleteOfflineTasks).not.toHaveBeenCalled();
  });

  it("a created task resets the consecutive-failure count (2 dead, 1 submitted, 2 dead, 1 submitted → no abort)", async () => {
    const dead = new Set([SUB_URL(1), SUB_URL(2), SUB_URL(4), SUB_URL(5)]);
    const { client, executor } = harness({
      after: [landed(3), landed(6)],
      resolve: (url) => {
        if (dead.has(url)) {
          throw resolveFailure();
        }
        return undefined;
      },
    });

    const attempts = await run(executor, 6);

    expect(attempts.map((a) => a.status)).toEqual(["failed", "failed", "succeeded", "failed", "failed", "succeeded"]);
    expect(client.resolveOffline).toHaveBeenCalledTimes(10);
  });

  // A non-member's offline quota is tiny (the settings copy says so): once it is gone,
  // EVERY submit fails. Without this abort the batch spent the whole 210 s window
  // resolving and submitting into a wall, and the agent was told "package too big".
  it("aborts after 3 consecutive SUBMIT failures too (quota gone): no further resolves, and the real cause reaches the agent via last:", async () => {
    const quota = "PAN123_OFFLINE_SUBMIT_FAILED: 云下载配额不足，请升级VIP (err_code=41006)";
    const { client, executor } = harness({
      submit: () => {
        throw new Error(quota);
      },
    });

    const attempts = await run(executor, 6);

    expect(client.resolveOffline).toHaveBeenCalledTimes(3);
    expect(client.submitOffline).toHaveBeenCalledTimes(3);
    expect(attempts.slice(0, 3).map((a) => a.providerMessage)).toEqual([quota, quota, quota]);
    for (const a of attempts.slice(3)) {
      expect(a).toMatchObject({
        status: "failed",
        providerMessage: `SUBTITLE_NOT_SUBMITTED: aborted after 3 consecutive files failed to submit (last: ${quota})`,
      });
    }
    expect(client.listOfflineTasks).not.toHaveBeenCalled();
    expect(client.deleteOfflineTasks).not.toHaveBeenCalled();
  });

  it("ONE counter for files that never got a task: resolve-dead, submit-refused, resolve-dead in a row abort; a resolve that succeeds does NOT reset it, only a created task does", async () => {
    const { client, executor } = harness({
      resolve: (url) => {
        if (url === SUB_URL(1) || url === SUB_URL(3)) {
          throw resolveFailure();
        }
        return undefined;
      },
      submit: () => {
        throw new Error("PAN123_OFFLINE_SUBMIT_FAILED: 云下载配额不足 (err_code=41006)");
      },
    });

    const attempts = await run(executor, 5);

    expect(client.submitOffline).toHaveBeenCalledTimes(1); // file 2 only
    expect(attempts.slice(3).map((a) => a.providerMessage)).toEqual([
      "SUBTITLE_NOT_SUBMITTED: aborted after 3 consecutive files failed to submit (last: PAN123_OFFLINE_RESOLVE_FAILED: 解析失败 (err_code=3))",
      "SUBTITLE_NOT_SUBMITTED: aborted after 3 consecutive files failed to submit (last: PAN123_OFFLINE_RESOLVE_FAILED: 解析失败 (err_code=3))",
    ]);
  });

  it("a submit failure fails that file with PAN123_OFFLINE_SUBMIT_FAILED (never doubled when the client already says so); the siblings are polled and land", async () => {
    const { executor, log } = harness({
      after: [landed(1), landed(4)],
      submit: (resourceId) => {
        if (resourceId === "res-2") {
          throw new Error("PAN123_OFFLINE_SUBMIT_FAILED: 云下载配额不足，请升级VIP (err_code=41006)");
        }
        if (resourceId === "res-3") {
          throw new Error("PAN123_FAILED(/v2/offline_download/task/submit): code=500 服务繁忙");
        }
        return undefined;
      },
    });

    const attempts = await run(executor, 4);

    expect(attempts.map((a) => a.status)).toEqual(["succeeded", "failed", "failed", "succeeded"]);
    expect(attempts[1]!.providerMessage).toBe("PAN123_OFFLINE_SUBMIT_FAILED: 云下载配额不足，请升级VIP (err_code=41006)");
    expect(attempts[2]!.providerMessage).toBe(
      "PAN123_OFFLINE_SUBMIT_FAILED: PAN123_FAILED(/v2/offline_download/task/submit): code=500 服务繁忙",
    );
    expect(log).toContain("poll:task-1,task-4");
    expect(log.at(-1)).toBe("delete:task-1,task-4");
  });

  it("stops submitting once subtitleSubmitWindowMs has passed since the batch started (assrt links die ~5 min after detail(); 123 fetches at SUBMIT time) — later files are never resolved", async () => {
    let clock = 5_000_000;
    const { executor, log } = harness(
      {
        after: [landed(1), landed(2), landed(3)],
        resolve: () => {
          clock += 80_000; // one resolve = 80 s on this fake clock
          return undefined;
        },
      },
      { now: () => clock, subtitleSubmitWindowMs: 210_000 },
    );

    const attempts = await run(executor, 5);

    expect(attempts.map((a) => a.status)).toEqual(["succeeded", "succeeded", "succeeded", "failed", "failed"]);
    const expired = "SUBTITLE_NOT_SUBMITTED: 字幕直链约 5 分钟过期,整包太大,有效期内只提交了前 3 个;本文件未尝试";
    expect(attempts[3]!.providerMessage).toBe(expired);
    expect(attempts[4]!.providerMessage).toBe(expired);
    expect(log.filter((entry) => entry.startsWith("resolve:"))).toEqual([1, 2, 3].map((i) => `resolve:${SUB_URL(i)}`));
  });

  it("defaults subtitleSubmitWindowMs to exactly 210 s (live 2026-09-22: links alive at 4 min, dead at 6 min); a file starting AT 210 000 ms is still tried, one at 210 001 ms is not", async () => {
    let clock = 0;
    const steps = [210_000, 1];
    const { executor, log } = harness(
      {
        resolve: (_url, call) => {
          clock += steps[call - 1] ?? 0;
          return undefined;
        },
      },
      { now: () => clock },
    );

    const attempts = await run(executor, 3);

    expect(log.filter((entry) => entry.startsWith("resolve:"))).toEqual([1, 2].map((i) => `resolve:${SUB_URL(i)}`));
    expect(attempts[2]!.providerMessage).toBe(
      "SUBTITLE_NOT_SUBMITTED: 字幕直链约 5 分钟过期,整包太大,有效期内只提交了前 2 个;本文件未尝试",
    );
  });

  // "Package too big" is only true when something WAS submitted. With nothing submitted
  // the window ran out on slow failures (e.g. resolves timing out twice each), and the
  // last one's text is the only actionable fact.
  // The window only gates a file's START; its resolve (two 60 s timeouts + the retry
  // delay, worst case) can still run past the link's life. Checked again right before
  // the submit, against the longest time a link was observed alive (4 min).
  it("a file that STARTED in the window but finished resolving past subtitleLinkLifetimeMs (default 240 s) is not submitted", async () => {
    let clock = 0;
    const { client, executor } = harness(
      {
        resolve: () => {
          clock += 250_000; // one slow resolve: starts at 0, ends at 250 s
          return undefined;
        },
      },
      { now: () => clock },
    );

    const [a] = await run(executor, 1);

    expect(client.submitOffline).not.toHaveBeenCalled();
    expect(a).toMatchObject({
      status: "failed",
      providerMessage: "SUBTITLE_NOT_SUBMITTED: 字幕直链约 5 分钟过期,本文件解析完成时已超过 240 秒,提交也会落空;本文件未提交",
    });
    expect(client.listOfflineTasks).not.toHaveBeenCalled();
    expect(client.deleteOfflineTasks).not.toHaveBeenCalled();
  });

  it("the link-lifetime check is exact: a resolve ending AT 240 000 ms still submits, one at 240 001 ms does not", async () => {
    for (const [end, submits] of [[240_000, 1], [240_001, 0]] as const) {
      let clock = 0;
      const { client, executor } = harness(
        {
          after: [landed(1)],
          resolve: () => {
            clock = end;
            return undefined;
          },
        },
        { now: () => clock },
      );
      await run(executor, 1);
      expect(client.submitOffline, `resolve ending at ${end}`).toHaveBeenCalledTimes(submits);
    }
  });

  it("when the window is gone before the FIRST file is even tried, the message says so — neither 整包太大 nor a null failure", async () => {
    // Every clock read is 1 ms later: the batch starts at 0 and the first window check
    // (after the BEFORE listing) already reads 1 > a zero window.
    let clock = 0;
    const { executor, log } = harness({}, { now: () => clock++, subtitleSubmitWindowMs: 0 });

    const attempts = await run(executor, 2);

    expect(log.filter((entry) => entry.startsWith("resolve:"))).toEqual([]);
    for (const a of attempts) {
      expect(a.providerMessage).toBe("SUBTITLE_NOT_SUBMITTED: 字幕直链约 5 分钟过期,开始提交前有效期已过;本文件未尝试");
    }
  });

  it("when the window runs out with NOTHING submitted, the message says so and carries the last real failure instead of 整包太大", async () => {
    let clock = 0;
    const { executor } = harness(
      {
        resolve: () => {
          clock += 60_000; // each try times out after 60 s
          throw new Error("PAN123_OFFLINE_RESOLVE_FAILED: timeout");
        },
      },
      { now: () => clock },
    );

    const attempts = await run(executor, 3);

    // two files × two tries = 240 s > 210 s: the third is never tried
    expect(attempts[2]!.providerMessage).toBe(
      "SUBTITLE_NOT_SUBMITTED: 字幕直链约 5 分钟过期,有效期内一个文件都没提交成功(最近一次失败: PAN123_OFFLINE_RESOLVE_FAILED: timeout);本文件未尝试",
    );
  });

  it("task status 1 → failed with a FIXED template (never the uploader-controlled task.name); nothing to claim; the task is still deleted", async () => {
    const { executor, log } = harness({ poll: (ids) => ids.map((id) => row(id, 1, 37, "云下载配额不足 VIP会员 登录")) });

    const [a] = await run(executor, 1);

    expect(a).toMatchObject({
      status: "failed",
      providerMessage: "PAN123_OFFLINE_FAILED: offline task failed at progress=37",
      materializedFileIds: [],
    });
    expect(a!.providerMessage).not.toContain("VIP");
    expect(log).not.toContain("list:claim");
    expect(log.at(-1)).toBe("delete:task-1");
  });

  it("later poll rounds ask only for tasks not yet terminal (status 0/3 keep waiting) and sleep only BETWEEN rounds", async () => {
    const { executor, log } = harness(
      {
        after: [landed(1), landed(2)],
        poll: (ids, call) => (call === 1 ? [row("task-1", 2), row("task-2", 3)] : ids.map((id) => row(id, 2))),
      },
      { subtitleTaskPollIntervalMs: 7 },
    );

    const attempts = await run(executor, 2);

    expect(log.slice(log.indexOf("submit:res-2") + 1)).toEqual([
      "poll:task-1,task-2",
      "sleep:7",
      "poll:task-2",
      "list:claim",
      "delete:task-1,task-2",
    ]);
    expect(attempts.map((a) => a.status)).toEqual(["succeeded", "succeeded"]);
  });

  it("poll window exhausted at status 0: the file that IS in the directory succeeds (the directory is the truth), the absent one is no_target_change", async () => {
    const { client, executor, sleep, log } = harness(
      { after: [landed(1)], poll: (ids) => ids.map((id) => row(id, 0, 10)) },
      { subtitleTaskPollMaxPolls: 3, subtitleTaskPollIntervalMs: 7 },
    );

    const attempts = await run(executor, 2);

    expect(attempts[0]).toMatchObject({ status: "succeeded", materializedFileIds: ["L1"], providerMessage: "" });
    expect(attempts[1]).toMatchObject({
      status: "no_target_change",
      providerMessage: "SUBTITLE_NOT_LANDED: 离线任务在轮询窗口内未落盘(已放弃等待)",
      materializedFileIds: [],
    });
    expect(client.listOfflineTasks).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.filter(([ms]) => ms === 7)).toHaveLength(2);
    expect(log.at(-1)).toBe("delete:task-1,task-2");
  });

  it("a task never seen in task/list still succeeds when its file is in the directory", async () => {
    const { client, executor } = harness({ after: [landed(1)], poll: () => [] });

    const [a] = await run(executor, 1);

    expect(a).toMatchObject({ status: "succeeded", materializedFileIds: ["L1"] });
    expect(client.listOfflineTasks).toHaveBeenCalledTimes(3); // never terminal → the whole window
  });

  it("status 2 but the file is not in the directory → no_target_change (the task row is not the truth)", async () => {
    const { executor } = harness({ after: [] });

    const [a] = await run(executor, 1);

    expect(a).toMatchObject({
      status: "no_target_change",
      providerMessage: "SUBTITLE_NOT_LANDED: 任务报告完成但文件不在目标目录",
      materializedFileIds: [],
    });
  });

  it("never claims a file that was there BEFORE (a stale same-named leftover cannot fake a success), but does claim a NEW same-named one", async () => {
    const stale = file("OLD", SUB_NAME(1), 1);

    const [a] = await run(harness({ before: [stale], after: [stale] }).executor, 1);
    const [b] = await run(harness({ before: [stale], after: [stale, file("NEW", SUB_NAME(1), 1)] }).executor, 1);

    expect(a).toMatchObject({ status: "no_target_change", materializedFileIds: [] });
    expect(b).toMatchObject({ status: "succeeded", materializedFileIds: ["NEW"] });
  });

  // 123 never overwrites: re-landing a name that is already in the directory arrives as
  // name(1).ext (真机 2026-09-21 probe 2). A rerun of a package cut short by the window
  // hits exactly this — the file DID land, under the twin name, and must be claimed
  // (a stale original is still never claimed: it is in the BEFORE snapshot).
  it("claims 123's numbered twin (Show.S01E01(1).ass) when the plain name was already there BEFORE", async () => {
    const stale = file("OLD", SUB_NAME(1), 1);
    const { executor } = harness({ before: [stale], after: [stale, file("TWIN", "Show.S01E01(1).ass", 1)] });

    const [a] = await run(executor, 1);

    // The attempt names what REALLY landed: the agent reads it back, and "Show.S01E01.ass"
    // (the stale one) is not what this batch produced.
    expect(a).toMatchObject({ status: "succeeded", materializedFileIds: ["TWIN"], materializedNames: ["Show.S01E01(1).ass"], providerMessage: "" });
  });

  it("only 123's numbered form counts as a twin: Show.S01E01(a).ass / Show.S01E01().ass are not claimed", async () => {
    const stale = file("OLD", SUB_NAME(1), 1);
    for (const name of ["Show.S01E01(a).ass", "Show.S01E01().ass", "Show.S01E01 (1).ass"]) {
      const [a] = await run(harness({ before: [stale], after: [stale, file("X", name, 1)] }).executor, 1);
      expect(a, name).toMatchObject({ status: "no_target_change", materializedFileIds: [] });
    }
  });

  it("an exact assrt filename outranks another task's twin match (tiers run in order across all tasks)", async () => {
    const { executor } = harness({
      after: [file("F", "c(1).ass", 1)],
      resolve: (url) => ({ resourceId: url, fileIds: ["f"], resolvedName: url === "http://x/1" ? "zzz.ass" : "c.ass" }),
    });

    const attempts = await executor.transferSubtitleUrls({
      files: [
        { url: "http://x/1", filename: "c(1).ass" }, // exact assrt filename match
        { url: "http://x/2", filename: "other.ass" }, // lands as c.ass → its twin is c(1).ass
      ],
      directoryId: SCOPE,
      workflowRunId: "run-1",
    });

    expect(attempts.map((a) => a.status)).toEqual(["succeeded", "no_target_change"]);
    expect(attempts[0]!.materializedFileIds).toEqual(["F"]);
  });

  it("a twin claim never crosses stems: Show.S01E01(1).ass is not claimed for Show.S01E02.ass", async () => {
    const { executor } = harness({ after: [file("TWIN", "Show.S01E01(1).ass", 1)] });

    const attempts = await executor.transferSubtitleUrls({
      files: [{ url: SUB_URL(2), filename: SUB_NAME(2) }],
      directoryId: SCOPE,
      workflowRunId: "run-1",
    });

    expect(attempts[0]).toMatchObject({ status: "no_target_change", materializedFileIds: [] });
  });

  it("exact names are claimed before any fallback: a task's filename fallback cannot take another task's exact landing name", async () => {
    const { executor } = harness({
      after: [file("Y", "y.ass", 1)],
      resolve: (url) => ({ resourceId: url, fileIds: ["f"], resolvedName: url === "http://x/1" ? "x.ass" : "y.ass" }),
    });

    const attempts = await executor.transferSubtitleUrls({
      files: [
        { url: "http://x/1", filename: "y.ass" }, // lands as x.ass; its assrt name is y.ass
        { url: "http://x/2", filename: "z.ass" }, // lands as y.ass
      ],
      directoryId: SCOPE,
      workflowRunId: "run-1",
    });

    expect(attempts.map((a) => a.status)).toEqual(["no_target_change", "succeeded"]);
    expect(attempts[1]!.materializedFileIds).toEqual(["Y"]);
  });

  it("claims ONE-TO-ONE: two package files resolving to the same landing name cannot both claim the single new file", async () => {
    const { executor } = harness({
      after: [file("N1", "Show.ass", 1)],
      resolve: (url) => ({ resourceId: url, fileIds: ["f"], resolvedName: "Show.ass" }),
    });

    const attempts = await executor.transferSubtitleUrls({
      files: [
        { url: "http://x/a", filename: "a.ass" },
        { url: "http://x/b", filename: "b.ass" },
      ],
      directoryId: SCOPE,
      workflowRunId: "run-1",
    });

    expect(attempts.map((a) => a.status)).toEqual(["succeeded", "no_target_change"]);
    expect(attempts.flatMap((a) => a.materializedFileIds)).toEqual(["N1"]);
  });

  it("tolerates a non-auth poll error: one failed round, then a good one, still lands", async () => {
    const { client, executor } = harness({
      after: [landed(1)],
      poll: (_ids, call) => {
        if (call === 1) {
          throw new Error("PAN123_FAILED(/offline_download/task/list): code=500");
        }
        return undefined;
      },
    });

    const [a] = await run(executor, 1);

    expect(a!.status).toBe("succeeded");
    expect(client.listOfflineTasks).toHaveBeenCalledTimes(2);
  });

  it("a good poll round resets the poll-error count (2 errors, ok, 2 errors, done → 6 rounds, not stopped at 4)", async () => {
    const { client, executor } = harness(
      {
        after: [landed(1)],
        poll: (ids, call) => {
          if ([1, 2, 4, 5].includes(call)) {
            throw new Error("PAN123_FAILED(/offline_download/task/list): code=500");
          }
          return ids.map((id) => row(id, call === 3 ? 0 : 2));
        },
      },
      { subtitleTaskPollMaxPolls: 8 },
    );

    const [a] = await run(executor, 1);

    expect(a!.status).toBe("succeeded");
    expect(client.listOfflineTasks).toHaveBeenCalledTimes(6);
  });

  it("stops polling after 3 consecutive non-auth poll errors WITHOUT throwing; the claim still runs and the task is still deleted", async () => {
    const { client, executor, log } = harness(
      {
        after: [landed(1)],
        poll: () => {
          throw new Error("PAN123_FAILED(/offline_download/task/list): code=500");
        },
      },
      { subtitleTaskPollMaxPolls: 8 },
    );

    const [a] = await run(executor, 1);

    expect(client.listOfflineTasks).toHaveBeenCalledTimes(3);
    expect(a).toMatchObject({ status: "succeeded", materializedFileIds: ["L1"] });
    expect(log.at(-1)).toBe("delete:task-1");
  });

  // Files land 6–12 s after their OWN submit (真机 2026-09-22). Three quick poll errors
  // end the poll within seconds of the last submit; claiming at once would report the
  // tail as not landed and the cleanup would then cancel it.
  it("after abandoning the poll it still waits out a 15 s landing grace since the LAST submit before the claim listing", async () => {
    const clock = 1_000_000;
    const { executor, log } = harness(
      {
        after: [landed(1)],
        poll: () => {
          throw new Error("PAN123_FAILED(/offline_download/task/list): code=500");
        },
      },
      { now: () => clock, subtitleTaskPollMaxPolls: 8 },
    );

    await run(executor, 1);

    expect(log.slice(-4)).toEqual(["poll:task-1", "sleep:15000", "list:claim", "delete:task-1"]);
  });

  it("the grace counts from the LAST submit, not the batch start: 6 s after it → sleeps the remaining 9 s", async () => {
    let clock = 1_000_000;
    const { executor, log } = harness(
      {
        after: [landed(1), landed(2)],
        resolve: () => {
          clock += 12_000; // each resolve takes 12 s → last submit at +24 s
          return undefined;
        },
        poll: () => {
          clock += 2_000; // three failed polls → +6 s after the last submit
          throw new Error("PAN123_FAILED(/offline_download/task/list): code=500");
        },
      },
      { now: () => clock, subtitleTaskPollMaxPolls: 8 },
    );

    await run(executor, 2);

    expect(log.filter((entry) => entry.startsWith("sleep:") && entry !== "sleep:0")).toEqual(["sleep:9000"]);
  });

  it("a clock that steps BACK never stretches the grace past 15 s", async () => {
    let clock = 5_000_000;
    const { executor, log } = harness(
      {
        after: [landed(1)],
        poll: (_ids, call) => {
          if (call === 1) clock -= 3_600_000; // NTP step back by an hour
          throw new Error("PAN123_FAILED(/offline_download/task/list): code=500");
        },
      },
      { now: () => clock, subtitleTaskPollMaxPolls: 8 },
    );

    await run(executor, 1);

    expect(log.filter((entry) => entry.startsWith("sleep:") && entry !== "sleep:0")).toEqual(["sleep:15000"]);
  });

  it("no extra wait when the grace has already passed while polling failed", async () => {
    let clock = 1_000_000;
    const { executor, log } = harness(
      {
        after: [landed(1)],
        poll: () => {
          clock += 6_000;
          throw new Error("PAN123_FAILED(/offline_download/task/list): code=500");
        },
      },
      { now: () => clock, subtitleTaskPollMaxPolls: 8 },
    );

    await run(executor, 1);

    expect(log.filter((entry) => entry === "sleep:15000")).toEqual([]);
    expect(log.slice(-3)).toEqual(["poll:task-1", "list:claim", "delete:task-1"]);
  });

  it("a non-auth failure of the claim listing marks every claimable file no_target_change with the error (no throw); a status-1 file keeps its own failure; tasks are still deleted", async () => {
    const { executor, log } = harness({
      poll: (ids) => ids.map((id) => row(id, id === "task-1" ? 1 : 2, 5)),
      after: () => {
        throw new Error("PAN123_FAILED(/b/api/file/list/new): code=500 busy");
      },
    });

    const attempts = await run(executor, 3);

    expect(attempts[0]).toMatchObject({ status: "failed", providerMessage: "PAN123_OFFLINE_FAILED: offline task failed at progress=5" });
    for (const a of attempts.slice(1)) {
      expect(a).toMatchObject({
        status: "no_target_change",
        providerMessage: "SUBTITLE_NOT_LANDED: 认领时列目录失败: PAN123_FAILED(/b/api/file/list/new): code=500 busy",
        materializedFileIds: [],
      });
    }
    expect(log.at(-1)).toBe("delete:task-1,task-2,task-3");
  });

  it("a non-auth deleteOfflineTasks failure is swallowed (a late subtitle landing is staging junk), attempts unchanged", async () => {
    const { executor } = harness({
      after: [landed(1)],
      remove: () => {
        throw new Error("PAN123_FAILED(/offline_download/task/delete): code=500");
      },
    });

    const [a] = await run(executor, 1);

    expect(a).toMatchObject({ status: "succeeded", materializedFileIds: ["L1"] });
  });

  it("Pan123AuthError from resolve is rethrown at once — never retried, never softened; nothing created, nothing deleted", async () => {
    const { client, executor } = harness({
      resolve: () => {
        throw auth();
      },
    });

    await expect(run(executor, 2)).rejects.toBeInstanceOf(Pan123AuthError);
    expect(client.resolveOffline).toHaveBeenCalledTimes(1);
    expect(client.deleteOfflineTasks).not.toHaveBeenCalled();
  });

  it.each<{ via: string; n: number; script: Script }>([
    {
      via: "a later file's resolve",
      n: 2,
      script: {
        resolve: (url) => {
          if (url === SUB_URL(2)) {
            throw auth();
          }
          return undefined;
        },
      },
    },
    {
      via: "a later file's submit",
      n: 2,
      script: {
        submit: (_resourceId, call) => {
          if (call === 2) {
            throw auth();
          }
          return undefined;
        },
      },
    },
    {
      via: "the RETRY of a later file's resolve (first try failed non-auth)",
      n: 2,
      script: {
        resolve: (url, call) => {
          if (url === SUB_URL(2)) {
            throw call === 2 ? resolveFailure() : auth();
          }
          return undefined;
        },
      },
    },
    {
      via: "the poll",
      n: 1,
      script: {
        poll: () => {
          throw auth();
        },
      },
    },
    {
      via: "the claim listing",
      n: 1,
      script: {
        after: () => {
          throw auth();
        },
      },
    },
  ])("Pan123AuthError from $via propagates AND the task already created is still deleted", async ({ n, script }) => {
    const { executor, log } = harness(script);

    await expect(run(executor, n)).rejects.toBeInstanceOf(Pan123AuthError);
    expect(log.at(-1)).toBe("delete:task-1");
  });

  it("Pan123AuthError from the cleanup delete itself propagates when everything else succeeded", async () => {
    const { executor } = harness({
      after: [landed(1)],
      remove: () => {
        throw auth("from delete");
      },
    });

    const error = await run(executor, 1).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Pan123AuthError);
    expect((error as Error).message).toContain("from delete");
  });

  it("a cleanup-delete Pan123AuthError never masks the error the main flow already threw", async () => {
    const { executor } = harness({
      poll: () => {
        throw auth("from poll");
      },
      remove: () => {
        throw auth("from delete");
      },
    });

    const error = await run(executor, 1).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Pan123AuthError);
    expect((error as Error).message).toContain("from poll");
  });

  it("refuses a target directory outside the write scope before any client call", async () => {
    const { executor, log } = harness();

    await expect(
      executor.transferSubtitleUrls({ files: files(1), directoryId: "elsewhere", workflowRunId: "run-1" }),
    ).rejects.toThrow("WRITE_SCOPE_VIOLATION");
    expect(log).toEqual([]);
  });

  it("shares the attempt counter with transfer(): a video transfer then a subtitle batch never collide on id", async () => {
    let n = 0;
    // listFiles calls: video before(1), video after(2), subtitle before(3), subtitle claim(4)
    const listFiles = vi.fn<Pan123Client["listFiles"]>(async () => (++n <= 3 ? [] : [landed(1)]));
    const executor = makeExecutor(fakeClient({ listFiles }), [SCOPE], { ...subOpts, transferSettlePollAttempts: 1 });

    const video = await executor.transfer({ workflowRunId: "run-1", directoryId: SCOPE, candidate: candidate() });
    const [sub] = await run(executor, 1);

    expect(video.id).toBe("run-1_transfer_1");
    expect(sub).toMatchObject({ id: "run-1_subtitle_2", status: "succeeded" });
  });

  it("transferSubtitleUrl (single) delegates to the batch and returns its one attempt", async () => {
    const { executor, log } = harness({ after: [landed(1)] });

    const a = await executor.transferSubtitleUrl({ url: SUB_URL(1), filename: SUB_NAME(1), directoryId: SCOPE, workflowRunId: "run-1" });

    expect(a).toMatchObject({ id: "run-1_subtitle_1", candidateId: `subtitle:${SUB_NAME(1)}`, status: "succeeded", materializedFileIds: ["L1"] });
    expect(log).toEqual(["list:before", `resolve:${SUB_URL(1)}`, "submit:res-1", "poll:task-1", "list:claim", "delete:task-1"]);
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
