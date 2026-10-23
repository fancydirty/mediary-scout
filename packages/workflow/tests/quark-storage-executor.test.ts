import { describe, expect, it } from "vitest";
import { QuarkStorageExecutor, UC_PROFILE } from "../src/index.js";
import type { ResourceCandidate } from "../src/index.js";

/**
 * A fake QuarkCookieClient: an in-memory tree of dirs/files keyed by fid, plus a
 * scripted share for transfer. Records the call sequence so transfer's
 * token→detail→save→poll order can be asserted.
 */
interface FakeFile {
  fid: string;
  file_name: string;
  dir: boolean;
  size: number;
  pdir_fid: string;
}

function makeFakeClient(opts?: {
  share?: { items: Array<{ fid: string; share_fid_token: string; file_name: string; dir: boolean; size: number }> };
  shareTokenError?: Error;
}) {
  const files = new Map<string, FakeFile>();
  const calls: string[] = [];
  let nextId = 1;
  // seed the write-scope root + a staging dir under it
  files.set("ROOT", { fid: "ROOT", file_name: "media-track", dir: true, size: 0, pdir_fid: "0" });
  files.set("STAGE", { fid: "STAGE", file_name: "Movie (2020)", dir: true, size: 0, pdir_fid: "ROOT" });

  const client = {
    async listItems({ directoryId }: { directoryId: string }) {
      calls.push(`listItems:${directoryId}`);
      return [...files.values()]
        .filter((f) => f.pdir_fid === directoryId)
        .map((f) => ({ fid: f.fid, file_name: f.file_name, dir: f.dir, size: f.size }));
    },
    async getFileInfo(fid: string) {
      const f = files.get(fid);
      if (!f) throw new Error(`no such fid ${fid}`);
      return { fid: f.fid, file_name: f.file_name, pdir_fid: f.pdir_fid, dir: f.dir };
    },
    async createFolder({ name, parentId }: { name: string; parentId: string }) {
      const fid = `dir_${nextId++}`;
      files.set(fid, { fid, file_name: name, dir: true, size: 0, pdir_fid: parentId });
      return fid;
    },
    async getShareToken() {
      calls.push("getShareToken");
      if (opts?.shareTokenError) throw opts.shareTokenError;
      return "STOKEN";
    },
    async listShareDetail() {
      calls.push("listShareDetail");
      return opts?.share?.items ?? [];
    },
    async saveShare({ to_pdir_fid }: { to_pdir_fid: string }) {
      calls.push(`saveShare:${to_pdir_fid}`);
      // materialize the share's files into the destination dir
      for (const item of opts?.share?.items ?? []) {
        files.set(item.fid, {
          fid: item.fid,
          file_name: item.file_name,
          dir: item.dir,
          size: item.size,
          pdir_fid: to_pdir_fid,
        });
      }
      return "TASK1";
    },
    async pollTask() {
      calls.push("pollTask");
      return true;
    },
    async deleteFiles(fids: string[]) {
      calls.push(`deleteFiles:${fids.join(",")}`);
      for (const fid of fids) files.delete(fid);
    },
    async moveFiles({ fids, to }: { fids: string[]; to: string }) {
      calls.push(`moveFiles:${fids.join(",")}->${to}`);
      for (const fid of fids) {
        const f = files.get(fid);
        if (f) f.pdir_fid = to;
      }
    },
    async renameFile({ fid, name }: { fid: string; name: string }) {
      calls.push(`renameFile:${fid}=${name}`);
      const f = files.get(fid);
      if (f) f.file_name = name;
    },
  };
  return { client, files, calls };
}

function quarkExecutor(client: unknown, files?: Map<string, FakeFile>) {
  return new QuarkStorageExecutor({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: client as any,
    writeScopeDirectoryIds: ["ROOT"],
    minVideoSizeBytes: 1,
  });
}

function shareCandidate(url: string, password = ""): ResourceCandidate {
  return {
    id: "cand_1",
    snapshotId: "snap_1",
    index: 0,
    title: "Movie 2020",
    type: "manual",
    source: "pansou",
    providerPayload: { url, password },
  };
}

describe("QuarkStorageExecutor", () => {
  it("transfer runs token→detail→save→poll and reports the materialized file", async () => {
    const { client, calls } = makeFakeClient({
      share: { items: [{ fid: "shared_mkv", share_fid_token: "t1", file_name: "Movie.2020.1080p.mkv", dir: false, size: 5_000_000_000 }] },
    });
    const exec = quarkExecutor(client);

    const attempt = await exec.transfer({
      workflowRunId: "run_1",
      directoryId: "STAGE",
      candidate: shareCandidate("https://pan.quark.cn/s/abc123", "pw"),
    });

    expect(calls).toEqual(
      expect.arrayContaining(["getShareToken", "listShareDetail", "saveShare:STAGE", "pollTask"]),
    );
    // order: token before detail before save before poll
    expect(calls.indexOf("getShareToken")).toBeLessThan(calls.indexOf("listShareDetail"));
    expect(calls.indexOf("listShareDetail")).toBeLessThan(calls.indexOf("saveShare:STAGE"));
    expect(calls.indexOf("saveShare:STAGE")).toBeLessThan(calls.indexOf("pollTask"));
    expect(attempt.status).toBe("succeeded");
    expect(attempt.materializedFileIds).toEqual(["shared_mkv"]);
    expect(attempt.workflowRunId).toBe("run_1");
    expect(attempt.candidateId).toBe("cand_1");
  });

  it("transfer fails loud (status failed) on a dead share, never silent success", async () => {
    const { client } = makeFakeClient({ shareTokenError: new Error("QUARK_SHARE_TOKEN_FAILED: code=41006 分享不存在") });
    const exec = quarkExecutor(client);

    const attempt = await exec.transfer({
      workflowRunId: "run_1",
      directoryId: "STAGE",
      candidate: shareCandidate("https://pan.quark.cn/s/dead"),
    });

    expect(attempt.status).toBe("failed");
    expect(attempt.providerMessage).toContain("分享不存在");
    expect(attempt.materializedFileIds).toEqual([]);
  });

  it("transfer THROWS QUARK_NO_MAGNET for a magnet candidate", async () => {
    const { client } = makeFakeClient();
    const exec = quarkExecutor(client);
    const magnet: ResourceCandidate = { ...shareCandidate("magnet:?xt=urn:btih:deadbeef"), type: "magnet" };

    await expect(
      exec.transfer({ workflowRunId: "run_1", directoryId: "STAGE", candidate: magnet }),
    ).rejects.toThrow("QUARK_NO_MAGNET");
  });

  it("listVideoFiles filters to videos and parses episode codes", async () => {
    const { client, files } = makeFakeClient();
    files.set("v1", { fid: "v1", file_name: "Show.S01E03.1080p.mkv", dir: false, size: 2_000_000_000, pdir_fid: "STAGE" });
    files.set("v2", { fid: "v2", file_name: "poster.jpg", dir: false, size: 100, pdir_fid: "STAGE" });
    files.set("v3", { fid: "v3", file_name: "Movie.2020.mp4", dir: false, size: 3_000_000_000, pdir_fid: "STAGE" });
    const exec = quarkExecutor(client);

    const videos = await exec.listVideoFiles("STAGE");
    expect(videos.map((v) => v.name).sort()).toEqual(["Movie.2020.mp4", "Show.S01E03.1080p.mkv"]);
    const ep = videos.find((v) => v.name.includes("S01E03"));
    expect(ep?.episodeCode).toBe("S01E03");
    const movie = videos.find((v) => v.name.includes("Movie"));
    expect(movie?.episodeCode).toBeNull();
  });

  it("createDirectory is find-or-create (reuses a same-named dir)", async () => {
    const { client, files } = makeFakeClient();
    files.set("existing", { fid: "existing", file_name: "Season 1", dir: true, size: 0, pdir_fid: "ROOT" });
    const exec = quarkExecutor(client);

    await expect(exec.createDirectory({ name: "Season 1", parentId: "ROOT" })).resolves.toBe("existing");
    await expect(exec.createDirectory({ name: "Season 2", parentId: "ROOT" })).resolves.toMatch(/^dir_/);
  });

  it("removeDirectory refuses a write-scope root (safety)", async () => {
    const { client } = makeFakeClient();
    const exec = quarkExecutor(client);
    await expect(exec.removeDirectory("ROOT")).rejects.toThrow(/SAFETY_VIOLATION/);
  });

  it("write-scope guard walks pdir_fid up and rejects a dir outside scope", async () => {
    const { client, files } = makeFakeClient();
    // a dir whose ancestry never reaches ROOT
    files.set("OUT", { fid: "OUT", file_name: "elsewhere", dir: true, size: 0, pdir_fid: "0" });
    const exec = quarkExecutor(client);
    await expect(exec.moveFiles({ fileIds: ["x"], targetDirectoryId: "OUT" })).rejects.toThrow(
      /WRITE_SCOPE_VIOLATION/,
    );
  });

  it("moveFiles into an in-scope staging dir succeeds", async () => {
    const { client, files, calls } = makeFakeClient();
    files.set("f9", { fid: "f9", file_name: "x.mkv", dir: false, size: 9, pdir_fid: "ROOT" });
    const exec = quarkExecutor(client);
    await expect(exec.moveFiles({ fileIds: ["f9"], targetDirectoryId: "STAGE" })).resolves.toEqual({
      moved: ["f9"],
    });
    expect(calls).toContain("moveFiles:f9->STAGE");
  });
  it("deleteFiles deletes a subtitle (non-video) file inside the staging dir", async () => {
    const { client, files, calls } = makeFakeClient();
    files.set("sub1", { fid: "sub1", file_name: "多余字幕.srt", dir: false, size: 77944, pdir_fid: "STAGE" });
    const exec = quarkExecutor(client);
    await expect(exec.deleteFiles({ directoryId: "STAGE", fileIds: ["sub1"] })).resolves.toEqual({
      deleted: ["sub1"],
    });
    expect(calls).toContain("deleteFiles:sub1");
  });

  it("deleteFiles still refuses ids that are nowhere in the directory tree", async () => {
    const { client, files, calls } = makeFakeClient();
    files.set("sub1", { fid: "sub1", file_name: "多余字幕.srt", dir: false, size: 77944, pdir_fid: "STAGE" });
    const exec = quarkExecutor(client);
    await expect(exec.deleteFiles({ directoryId: "STAGE", fileIds: ["ghost"] })).rejects.toThrow(
      /SAFETY_VIOLATION/,
    );
    expect(calls.filter((c) => c.startsWith("deleteFiles:"))).toEqual([]);
  });
});

describe("UC over the same executor (family profile)", () => {
  it("transfers a UC share URL and reports the materialized file", async () => {
    const { client, files, calls } = makeFakeClient({
      share: { items: [{ fid: "s1", share_fid_token: "t1", file_name: "Movie.2026.2160p.mkv", dir: false, size: 4e9 }] },
    });
    const exec = new QuarkStorageExecutor({
      client: client as never,
      profile: UC_PROFILE,
      writeScopeDirectoryIds: ["ROOT"],
    });
    const attempt = await exec.transfer({
      workflowRunId: "run_uc",
      directoryId: "STAGE",
      // The UC parser, not 夸克's — a quark-only regex would reject this outright.
      candidate: shareCandidate("https://drive.uc.cn/s/ad26437c945f4", ""),
    });

    expect(calls).toEqual(
      expect.arrayContaining(["getShareToken", "listShareDetail", "saveShare:STAGE", "pollTask"]),
    );
    expect(attempt.status).toBe("succeeded");
    expect(attempt.materializedFileIds).toHaveLength(1);
    expect(files.get(attempt.materializedFileIds[0]!)?.file_name).toBe("Movie.2026.2160p.mkv");
  });

  it("refuses a 夸克 share URL on a UC drive (wrong brand, not a silent partial)", async () => {
    const { client } = makeFakeClient();
    const exec = new QuarkStorageExecutor({
      client: client as never,
      profile: UC_PROFILE,
      writeScopeDirectoryIds: ["ROOT"],
    });

    const attempt = await exec.transfer({
      workflowRunId: "run_uc",
      directoryId: "STAGE",
      candidate: shareCandidate("https://pan.quark.cn/s/abc123", ""),
    });
    expect(attempt.status).toBe("failed");
    expect(attempt.providerMessage).toContain("UC_TRANSFER_FAILED");
  });

  it("throws UC_NO_MAGNET (not QUARK_NO_MAGNET) so the agent gets the right brand's reason", async () => {
    const { client } = makeFakeClient();
    const exec = new QuarkStorageExecutor({
      client: client as never,
      profile: UC_PROFILE,
      writeScopeDirectoryIds: ["ROOT"],
    });
    const magnet = {
      id: "m1",
      title: "Movie magnet",
      type: "magnet",
      providerPayload: { url: "magnet:?xt=urn:btih:abc" },
    } as unknown as ResourceCandidate;

    await expect(
      exec.transfer({ workflowRunId: "run_uc", directoryId: "STAGE", candidate: magnet }),
    ).rejects.toThrow("UC_NO_MAGNET");
  });
});

describe("createDirectory tolerates UC's eventually-consistent listing", () => {
  it("adopts the existing dir when createFolder rejects with 23008 同名冲突", async () => {
    // VERIFIED LIVE 2026-10-23: on UC a dir created moments ago may not appear in
    // the very next listItems, so the pre-list misses it and the create is
    // rejected. Without this, every fresh connect's category provisioning could
    // fail and leave the drive with no CIDs.
    const { client } = makeFakeClient();
    let listCalls = 0;
    const flaky = {
      ...client,
      async listItems(args: { directoryId: string }) {
        listCalls += 1;
        // First list: the dir is not there yet (stale read).
        if (listCalls === 1) return [];
        // Any later list: the server has settled and it IS there.
        return [{ fid: "SETTLED", file_name: "Season 1", dir: true, size: 0 }];
      },
      async createFolder() {
        throw new Error("UC_CREATE_FOLDER_FAILED: code=23008 file is doloading[同名冲突]");
      },
    };
    const exec = new QuarkStorageExecutor({
      client: flaky as never,
      profile: UC_PROFILE,
      writeScopeDirectoryIds: ["ROOT"],
      sleep: async () => {}, // no wall-clock wait for the settlement poll
    });

    await expect(exec.createDirectory({ name: "Season 1", parentId: "ROOT" })).resolves.toBe("SETTLED");
  });

  it("still fails loud on a NON-conflict create error (never swallows a real failure)", async () => {
    const { client } = makeFakeClient();
    const failing = {
      ...client,
      async listItems() {
        return [];
      },
      async createFolder() {
        throw new Error("UC_CREATE_FOLDER_FAILED: code=50000 internal error");
      },
    };
    const exec = new QuarkStorageExecutor({
      client: failing as never,
      profile: UC_PROFILE,
      writeScopeDirectoryIds: ["ROOT"],
      sleep: async () => {},
    });

    await expect(exec.createDirectory({ name: "Season 1", parentId: "ROOT" })).rejects.toThrow(/50000/);
  });
});
