import { describe, expect, it } from "vitest";
import {
  FakeResourceProvider,
  FakeStorageExecutor,
  formatDriveSpaceSummary,
  GuangYaClient,
  InMemoryWorkflowRepository,
  Pan115CookieClient,
  Pan123Client,
  QuarkCookieClient,
  resolveWorkerDeps,
  sortDrivesByOrder,
  TianyiClient,
  UC_PROFILE,
  type AcquisitionDriveContext,
} from "../src/index.js";

describe("drive space querying across all six brands + cache + summary formatting", () => {
  it("Pan115CookieClient.getSpace parses /user/space all_total.size and all_use.size", async () => {
    let calledUrl = "";
    const client = new Pan115CookieClient({
      cookie: "UID=103164004_A1_1; CID=a; SEID=b",
      fetchJson: async (url) => {
        calledUrl = url;
        return {
          state: true,
          data: {
            all_total: { size: 43996571238400, size_format: "40.01TB" },
            all_remain: { size: 23166891805517, size_format: "21.07TB" },
            all_use: { size: 20829679432883, size_format: "18.94TB" },
          },
        };
      },
    });
    const space = await client.getSpace();
    expect(calledUrl).toBe("https://webapi.115.com/user/space");
    expect(space).toEqual({
      totalBytes: 43996571238400,
      usedBytes: 20829679432883,
    });
  });

  it("QuarkCookieClient.getSpace parses /1/clouddrive/member for both 夸克 (over-quota) and UC", async () => {
    const quarkClient = new QuarkCookieClient({
      cookie: "__uid=u1; __pus=p1",
      fetchJson: async () => ({
        status: 200,
        code: 0,
        data: {
          total_capacity: 10737418240,
          use_capacity: 1479851127848,
        },
      }),
    });
    const quarkSpace = await quarkClient.getSpace();
    expect(quarkSpace).toEqual({
      totalBytes: 10737418240,
      usedBytes: 1479851127848,
    });
    expect(quarkSpace!.totalBytes - quarkSpace!.usedBytes).toBeLessThan(0);

    let ucUrl = "";
    const ucClient = new QuarkCookieClient({
      cookie: "__uid=u2; __pus=p2",
      profile: UC_PROFILE,
      fetchJson: async (url) => {
        ucUrl = url;
        return {
          status: 200,
          code: 0,
          data: {
            total_capacity: 6597069766656,
            use_capacity: 660807580105,
          },
        };
      },
    });
    const ucSpace = await ucClient.getSpace();
    expect(ucUrl).toContain("https://pc-api.uc.cn/1/clouddrive/member?pr=UCBrowser");
    expect(ucSpace).toEqual({
      totalBytes: 6597069766656,
      usedBytes: 660807580105,
    });
  });

  it("GuangYaClient.getSpace posts to /assets/v1/get_assets", async () => {
    let calledUrl = "";
    const client = new GuangYaClient({
      accessToken: "at",
      refreshToken: "rt",
      deviceId: "did1",
      fetchImpl: (async (url: string) => {
        calledUrl = url;
        return new Response(
          JSON.stringify({
            code: 0,
            msg: "success",
            data: {
              totalSpaceSize: 549755813888000,
              usedSpaceSize: 762947115439,
            },
          }),
          { status: 200 },
        );
      }) as typeof fetch,
    });
    const space = await client.getSpace();
    expect(calledUrl).toBe("https://api.guangyapan.com/assets/v1/get_assets");
    expect(space).toEqual({
      totalBytes: 549755813888000,
      usedBytes: 762947115439,
    });
  });

  it("Pan123Client.getSpace queries signed /b/api/user/info", async () => {
    let calledUrl = "";
    const client = new Pan123Client({
      token: "tok",
      fetchImpl: async (url) => {
        calledUrl = url;
        return {
          status: 200,
          text: JSON.stringify({
            code: 0,
            message: "ok",
            data: {
              SpacePermanent: 23708219473920,
              SpaceUsed: 2184282204627,
            },
          }),
        };
      },
    });
    const space = await client.getSpace();
    expect(calledUrl).toContain("https://yun.123pan.com/b/api/user/info?");
    expect(space).toEqual({
      totalBytes: 23708219473920,
      usedBytes: 2184282204627,
    });
  });

  it("TianyiClient.getSpace queries /api/open/user/getUserInfo.action and preserves negative available space", async () => {
    let calledUrl = "";
    const client = new TianyiClient({
      sessionKey: "sk",
      accessToken: "at",
      refreshToken: "rt",
      fetchImpl: async (url) => {
        calledUrl = url;
        return {
          status: 200,
          text: JSON.stringify({
            res_code: 0,
            capacity: 32212254720,
            available: -44152877229,
          }),
        };
      },
    });
    const space = await client.getSpace();
    expect(calledUrl).toContain("https://cloud.189.cn/api/open/user/getUserInfo.action?");
    expect(space).toEqual({
      totalBytes: 32212254720,
      usedBytes: 32212254720 - -44152877229,
    });
  });

  it("formatDriveSpaceSummary formats normal, over-quota (negative remaining), and unknown states", () => {
    const normal = formatDriveSpaceSummary({
      totalBytes: 40 * 1024 ** 4,
      usedBytes: 19 * 1024 ** 4,
    });
    expect(normal.overQuota).toBe(false);
    expect(normal.badgeText).toBe("剩余 21.00 TB / 40.00 TB");
    expect(normal.agentText).toBe("剩余 21.00 TB（总额 40.00 TB）");

    const overQuota = formatDriveSpaceSummary({
      totalBytes: 10 * 1024 ** 3,
      usedBytes: 1378 * 1024 ** 3,
    });
    expect(overQuota.overQuota).toBe(true);
    expect(overQuota.remainingBytes).toBeLessThan(0);
    expect(overQuota.badgeText).toContain("已超额");
    expect(overQuota.agentText).toContain("禁止写入");

    const unknown = formatDriveSpaceSummary(null);
    expect(unknown.overQuota).toBe(false);
    expect(unknown.remainingBytes).toBeNull();
    expect(unknown.badgeText).toBe("容量未知");
  });

  it("stores and retrieves drive_space_cache entries in repository", async () => {
    const repo = new InMemoryWorkflowRepository();
    expect(await repo.getDriveSpaceCache("cs_1")).toBeNull();
    await repo.upsertDriveSpaceCache({
      storageId: "cs_1",
      totalBytes: 1000,
      usedBytes: 400,
      probedAt: "2026-10-27T12:00:00.000Z",
    });
    expect(await repo.getDriveSpaceCache("cs_1")).toEqual({
      storageId: "cs_1",
      totalBytes: 1000,
      usedBytes: 400,
      probedAt: "2026-10-27T12:00:00.000Z",
    });

    // Non-finite numbers must not overwrite valid cached entries.
    await repo.upsertDriveSpaceCache({
      storageId: "cs_1",
      totalBytes: Number.NaN,
      usedBytes: 400,
      probedAt: "2026-10-27T12:05:00.000Z",
    });
    expect(await repo.getDriveSpaceCache("cs_1")).toEqual({
      storageId: "cs_1",
      totalBytes: 1000,
      usedBytes: 400,
      probedAt: "2026-10-27T12:00:00.000Z",
    });
  });

  it("rejects null or empty-string metrics instead of coercing them to 0", async () => {
    const pan115 = new Pan115CookieClient({
      cookie: "UID=103164004_A1_1; CID=a; SEID=b",
      fetchJson: async () => ({
        state: true,
        data: { all_total: { size: 1000 }, all_use: { size: null } },
      }),
    });
    expect(await pan115.getSpace()).toBeNull();

    const quark = new QuarkCookieClient({
      cookie: "__uid=u1; __pus=p1",
      fetchJson: async () => ({
        status: 200,
        code: 0,
        data: { total_capacity: 1000, use_capacity: "" },
      }),
    });
    expect(await quark.getSpace()).toBeNull();
  });

  it("sortDrivesByOrder orders drives by user preference and falls back to createdAt for unlisted drives", () => {
    const drives = [
      { id: "cs_115", createdAt: "2026-06-01T00:00:00.000Z" },
      { id: "cs_quark", createdAt: "2026-06-02T00:00:00.000Z" },
      { id: "cs_123", createdAt: "2026-06-03T00:00:00.000Z" },
      { id: "cs_uc", createdAt: "2026-06-04T00:00:00.000Z" },
    ];
    expect(sortDrivesByOrder(drives, ["cs_123", "cs_115"]).map((d) => d.id)).toEqual([
      "cs_123",
      "cs_115",
      "cs_quark",
      "cs_uc",
    ]);
    expect(sortDrivesByOrder(drives, []).map((d) => d.id)).toEqual([
      "cs_115",
      "cs_quark",
      "cs_123",
      "cs_uc",
    ]);
  });

  it("resolveWorkerDeps threads the resolved multi-drive contexts through to callers", async () => {
    const fakeExec = new FakeStorageExecutor({ transferOutcomes: {} });
    const fakeProvider = new FakeResourceProvider({ keywordResults: {} });
    const mockDrives: AcquisitionDriveContext[] = [
      {
        storageId: "cs_115",
        provider: "pan115",
        label: "115 网盘",
        storage: fakeExec,
        parents: { tv: "tv_115", anime: "anime_115", movies: "mov_115" },
        space: { totalBytes: 40 * 1024 ** 4, usedBytes: 19 * 1024 ** 4 },
      },
      {
        storageId: "cs_123",
        provider: "pan123",
        label: "123网盘",
        storage: fakeExec,
        parents: { tv: "tv_123", anime: "anime_123", movies: "mov_123" },
        space: { totalBytes: 20 * 1024 ** 4, usedBytes: 2 * 1024 ** 4 },
      },
    ];
    const resolved = await resolveWorkerDeps(
      async () => ({ drives: mockDrives }),
      "acct_default",
      "cs_115",
      {
        storage: fakeExec,
        resourceProvider: fakeProvider,
        model: {} as never,
      },
    );
    expect(resolved.drives).toEqual(mockDrives);
  });
});
