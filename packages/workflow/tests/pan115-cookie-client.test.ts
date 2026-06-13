import { describe, expect, it } from "vitest";
import {
  createPan115CookieClientFromEnv,
  createProtectedPan115CookieStorageExecutorFromEnv,
  Pan115CookieClient,
  Storage115Executor,
} from "../src/index.js";

describe("Pan115CookieClient", () => {
  it("creates folders with the authenticated 115 web API", async () => {
    const requests: RecordedRequest[] = [];
    const client = new Pan115CookieClient({
      cookie: "UID=1;CID=2;SEID=3;KID=4",
      fetchJson: recordFetch(requests, {
        "https://webapi.115.com/files/add": {
          state: true,
          cid: "new_dir",
          cname: "Show",
        },
      }),
    });

    const directoryId = await client.createFolder({ name: "Show", parentId: "parent_1" });

    expect(directoryId).toBe("new_dir");
    expect(requests).toEqual([
      {
        url: "https://webapi.115.com/files/add",
        method: "POST",
        headers: expect.objectContaining({
          Cookie: "UID=1;CID=2;SEID=3;KID=4",
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        }),
        body: "pid=parent_1&cname=Show",
      },
    ]);
  });

  it("lists a bounded page of directory items", async () => {
    const requests: RecordedRequest[] = [];
    const client = new Pan115CookieClient({
      cookie: "cookie",
      listLimit: 2,
      fetchJson: recordFetch(requests, {
        "https://webapi.115.com/files?aid=1&cid=dir_1&o=user_ptime&asc=1&offset=0&show_dir=1&limit=2&snap=0&natsort=0&record_open_time=1&format=json&fc_mix=0": {
          state: true,
          cid: "dir_1",
          count: 2,
          offset: 0,
          data: [
            { cid: "child_dir", n: "Pack", fc: "0" },
            { fid: "file_1", n: "Show.S01E01.mkv", s: "1000000000" },
          ],
        },
      }),
    });

    const items = await client.listItems({ directoryId: "dir_1" });

    expect(items).toEqual([
      { cid: "child_dir", n: "Pack", fc: "0" },
      { fid: "file_1", n: "Show.S01E01.mkv", s: "1000000000" },
    ]);
    expect(requests.map((request) => request.method)).toEqual(["GET"]);
  });

  it("fails closed when a directory list would require pagination", async () => {
    const client = new Pan115CookieClient({
      cookie: "cookie",
      listLimit: 2,
      fetchJson: async () => ({
        state: true,
        cid: "dir_1",
        count: 3,
        offset: 0,
        data: [{ fid: "file_1", n: "a.mkv", s: "1" }],
      }),
    });

    await expect(client.listItems({ directoryId: "dir_1" })).rejects.toThrow(
      "PAN115_LIST_TOO_LARGE",
    );
  });

  it("maps directory info paths from category/get", async () => {
    const requests: RecordedRequest[] = [];
    const client = new Pan115CookieClient({
      cookie: "cookie",
      fetchJson: recordFetch(requests, {
        "https://webapi.115.com/category/get?cid=season_1": {
          state: true,
          paths: [
            { file_id: 0, file_name: "root" },
            { file_id: 100, file_name: "Media Track Test Root" },
            { file_id: 101, file_name: "Show" },
          ],
          file_id: 102,
          file_name: "Season 1",
        },
      }),
    });

    await expect(client.getDirectoryInfo({ directoryId: "season_1" })).resolves.toEqual({
      state: true,
      path: [
        { cid: "0", name: "root" },
        { cid: "100", name: "Media Track Test Root" },
        { cid: "101", name: "Show" },
        { cid: "102", name: "Season 1" },
      ],
    });
    expect(requests[0]?.method).toBe("GET");
  });

  it("appends the requested directory as path leaf when category/get omits its id", async () => {
    const requests: RecordedRequest[] = [];
    const client = new Pan115CookieClient({
      cookie: "cookie",
      fetchJson: recordFetch(requests, {
        "https://webapi.115.com/category/get?cid=season_1": {
          state: true,
          paths: [
            { file_id: 0, file_name: "根目录" },
            { file_id: 100, file_name: "test" },
            { file_id: 101, file_name: "翘楚 (2026)" },
          ],
          file_name: "Season 1",
        },
      }),
    });

    await expect(client.getDirectoryInfo({ directoryId: "season_1" })).resolves.toEqual({
      state: true,
      path: [
        { cid: "0", name: "根目录" },
        { cid: "100", name: "test" },
        { cid: "101", name: "翘楚 (2026)" },
        { cid: "season_1", name: "Season 1" },
      ],
    });
  });

  it("receives 115 share links into the target directory", async () => {
    const requests: RecordedRequest[] = [];
    const client = new Pan115CookieClient({
      cookie: "cookie",
      fetchJson: recordFetch(requests, {
        "https://115cdn.com/webapi/share/receive": {
          state: true,
          msg: "ok",
        },
      }),
    });

    await expect(
      client.receiveShare({
        shareCode: "abc123",
        receiveCode: "pw",
        directoryId: "season_1",
      }),
    ).resolves.toEqual({ ok: true, message: "ok" });
    expect(requests).toEqual([
      {
        url: "https://115cdn.com/webapi/share/receive",
        method: "POST",
        headers: expect.objectContaining({
          Cookie: "cookie",
          Referer: "https://115cdn.com/s/abc123?password=pw&",
        }),
        body: "share_code=abc123&receive_code=pw&cid=season_1",
      },
    ]);
  });

  it("moves and deletes file ids through form-encoded array parameters", async () => {
    const requests: RecordedRequest[] = [];
    const client = new Pan115CookieClient({
      cookie: "cookie",
      fetchJson: recordFetch(requests, {
        "https://webapi.115.com/files/move": { state: true },
        "https://webapi.115.com/rb/delete": { state: true },
      }),
    });

    await expect(
      client.moveItems({ fileIds: ["file_1", "file_2"], targetDirectoryId: "season_1" }),
    ).resolves.toEqual({ ok: true, message: "" });
    await expect(client.deleteItems({ fileIds: ["dir_1"] })).resolves.toEqual({
      ok: true,
      message: "",
    });

    expect(requests.map((request) => request.body)).toEqual([
      "pid=season_1&fid%5B0%5D=file_1&fid%5B1%5D=file_2",
      "fid%5B0%5D=dir_1",
    ]);
  });

  it("renames a file through files/batch_rename", async () => {
    const requests: RecordedRequest[] = [];
    const client = new Pan115CookieClient({
      cookie: "cookie",
      fetchJson: recordFetch(requests, {
        "https://webapi.115.com/files/batch_rename": { state: true },
      }),
    });

    await expect(
      client.renameFile({ fileId: "file_1", newName: "Show.S01E01.mkv" }),
    ).resolves.toEqual({ ok: true, message: "" });

    expect(requests[0]?.body).toBe("files_new_name%5Bfile_1%5D=Show.S01E01.mkv");
  });

  it("adds a magnet offline task via an RSA-encrypted lixianssp request", async () => {
    let capturedUrl = "";
    let capturedBody = "";
    const client = new Pan115CookieClient({
      cookie: "cookie",
      fetchJson: async (url, init) => {
        capturedUrl = url;
        capturedBody = String(init.body ?? "");
        return { state: true };
      },
    });

    const result = await client.addOfflineTask({
      url: "magnet:?xt=urn:btih:abcdef",
      directoryId: "season_1",
    });

    expect(result.ok).toBe(true);
    expect(capturedUrl).toBe("https://lixian.115.com/lixianssp/");
    // The body is the encrypted payload — never the raw magnet url or cid.
    expect(capturedBody.startsWith("data=")).toBe(true);
    expect(capturedBody).not.toContain("magnet");
    expect(capturedBody).not.toContain("season_1");
  });

  it("cancels offline tasks by info_hash via an RSA-encrypted lixianssp request", async () => {
    let capturedUrl = "";
    let capturedBody = "";
    const client = new Pan115CookieClient({
      cookie: "cookie",
      fetchJson: async (url, init) => {
        capturedUrl = url;
        capturedBody = String(init.body ?? "");
        return { state: true };
      },
    });

    const result = await client.removeOfflineTask({
      infoHashes: ["57e6d442793c87d7f81eecc675ab4eb3b4925bd3"],
    });

    expect(result.ok).toBe(true);
    expect(capturedUrl).toBe("https://lixian.115.com/lixianssp/");
    // The body is the encrypted payload — never the raw info_hash or ac.
    expect(capturedBody.startsWith("data=")).toBe(true);
    expect(capturedBody).not.toContain("57e6d442");
    expect(capturedBody).not.toContain("task_del");
  });

  it("lists offline tasks via the plain cookie-authed web endpoint", async () => {
    let capturedUrl = "";
    const client = new Pan115CookieClient({
      cookie: "cookie",
      fetchJson: async (url) => {
        capturedUrl = url;
        return {
          page: 1,
          count: 2,
          tasks: [
            {
              info_hash: "19dbce42e41c0e41236f4149c8b3e828ceb2dcff",
              name: "奥本海默.2023.4K.mp4",
              percentDone: 0,
              status: 1,
              status_text: "等待中",
              url: "magnet:?xt=urn:btih:19dbce42e41c0e41236f4149c8b3e828ceb2dcff",
            },
            {
              info_hash: "abc",
              name: "done.mkv",
              percentDone: 100,
              status: 2,
              status_text: "已完成",
              url: "magnet:?xt=urn:btih:abc",
            },
          ],
        };
      },
    });

    const tasks = await client.listOfflineTasks({ page: 1 });

    expect(capturedUrl).toContain("https://lixian.115.com/lixian/?");
    expect(capturedUrl).toContain("ac=task_lists");
    expect(tasks).toEqual([
      {
        infoHash: "19dbce42e41c0e41236f4149c8b3e828ceb2dcff",
        name: "奥本海默.2023.4K.mp4",
        percentDone: 0,
        status: 1,
        statusText: "等待中",
        url: "magnet:?xt=urn:btih:19dbce42e41c0e41236f4149c8b3e828ceb2dcff",
      },
      {
        infoHash: "abc",
        name: "done.mkv",
        percentDone: 100,
        status: 2,
        statusText: "已完成",
        url: "magnet:?xt=urn:btih:abc",
      },
    ]);
  });

  it("creates a client from PAN115_COOKIE", () => {
    expect(() => createPan115CookieClientFromEnv({})).toThrow("PAN115_COOKIE is required");
    expect(
      createPan115CookieClientFromEnv({
        PAN115_COOKIE: "UID=1;CID=2",
      }),
    ).toBeInstanceOf(Pan115CookieClient);
  });

  it("creates a protected storage executor from cookie and write-scope env", () => {
    expect(() =>
      createProtectedPan115CookieStorageExecutorFromEnv({
        env: {
          PAN115_COOKIE: "UID=1;CID=2",
        },
      }),
    ).toThrow("MEDIA_TRACK_115_WRITE_SCOPE_REQUIRED");

    expect(() =>
      createProtectedPan115CookieStorageExecutorFromEnv({
        env: {
          MEDIA_TRACK_115_TEST_ROOT_CID: "test_root",
        },
      }),
    ).toThrow("PAN115_COOKIE is required");

    expect(
      createProtectedPan115CookieStorageExecutorFromEnv({
        env: {
          PAN115_COOKIE: "UID=1;CID=2",
          MEDIA_TRACK_115_TEST_ROOT_CID: "test_root",
        },
        fetchJson: async () => ({ state: true, data: [] }),
      }),
    ).toBeInstanceOf(Storage115Executor);
  });
});

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function recordFetch(
  requests: RecordedRequest[],
  responses: Record<string, unknown>,
): (url: string, init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string }) => Promise<unknown> {
  return async (url, init) => {
    requests.push({
      url,
      method: init.method,
      headers: init.headers,
      body: init.body ?? "",
    });
    if (!(url in responses)) {
      throw new Error(`Unexpected URL ${url}`);
    }
    return responses[url];
  };
}
