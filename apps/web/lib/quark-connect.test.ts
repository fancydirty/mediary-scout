import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Bind-level tests for 夸克 cookie paste (C10). Real connectQuarkCookie against
 * in-memory SQLite; only QuarkCookieClient is stubbed (no network). Proves the
 * live probe runs BEFORE bind so a dead cookie never lands in connected_storages.
 */

let quarkClientConstructions = 0;

class FakeQuarkCookieClient {
  private readonly cookie: string;
  constructor(opts: { cookie: string }) {
    quarkClientConstructions++;
    this.cookie = opts.cookie;
  }
  async listItems(_input: { directoryId: string }) {
    if (this.cookie.includes("DEAD")) {
      throw new Error("QUARK_AUTH_FAILED: cookie dead");
    }
    return [];
  }
}

const prevPg = process.env.MEDIA_TRACK_POSTGRES_URL;
const prevMultiUser = process.env.MEDIA_TRACK_MULTI_USER;

const LIVE_COOKIE = "__uid=quark_uid_live; __kps=abc";
const DEAD_COOKIE = "__uid=quark_uid_dead; __kps=DEAD";

const boot = async (opts: { failProvision?: boolean } = {}) => {
  process.env.MEDIA_TRACK_SQLITE_PATH = ":memory:";
  delete process.env.MEDIA_TRACK_POSTGRES_URL;
  delete process.env.MEDIA_TRACK_MULTI_USER;
  quarkClientConstructions = 0;
  vi.resetModules();
  vi.doMock("@media-track/workflow", async () => {
    const actual = await vi.importActual<typeof import("@media-track/workflow")>("@media-track/workflow");
    return {
      ...actual,
      QuarkCookieClient: FakeQuarkCookieClient,
      ...(opts.failProvision
        ? {
            createExecutorForBrand: () => {
              throw new Error("PROVISION_BOOM: no network in test");
            },
          }
        : {}),
    };
  });
  return import("./workflow-runtime");
};

afterEach(() => {
  vi.doUnmock("@media-track/workflow");
  delete process.env.MEDIA_TRACK_SQLITE_PATH;
  if (prevPg !== undefined) process.env.MEDIA_TRACK_POSTGRES_URL = prevPg;
  if (prevMultiUser !== undefined) process.env.MEDIA_TRACK_MULTI_USER = prevMultiUser;
  vi.resetModules();
});

describe("connectQuarkCookie (C10 live-check before bind)", () => {
  it("dead cookie → friendly error, nothing stored", async () => {
    const rt = await boot();
    await expect(rt.connectQuarkCookie(DEAD_COOKIE)).rejects.toThrow(/无法用该 cookie 连接夸克/);
    expect(await rt.getWorkflowRepository().listConnectedStorages("acct_default")).toEqual([]);
    expect(quarkClientConstructions).toBeGreaterThan(0);
  });

  it("live cookie → binds with providerUid from __uid", async () => {
    const rt = await boot({ failProvision: true });
    const { providerUid } = await rt.connectQuarkCookie(`  ${LIVE_COOKIE}  `);
    expect(providerUid).toBe("quark_uid_live");
    const drives = await rt.getWorkflowRepository().listConnectedStorages("acct_default");
    expect(drives).toHaveLength(1);
    expect(drives[0]?.provider).toBe("quark");
    expect(drives[0]?.providerUid).toBe("quark_uid_live");
    expect((drives[0]?.payload as { cookie?: string }).cookie).toContain("__uid=quark_uid_live");
  });

  it("unparseable cookie → error without network probe", async () => {
    const rt = await boot();
    await expect(rt.connectQuarkCookie("not-a-cookie")).rejects.toThrow(/无法从该 cookie 解析/);
    expect(quarkClientConstructions).toBe(0);
  });

  it("cross-account bind rejected", async () => {
    const rt = await boot();
    const repo = rt.getWorkflowRepository();
    await repo.createAccount({
      id: "acct_other",
      username: "other",
      passwordHash: "x",
      groupId: null,
      isOwner: false,
      createdAt: "2026-07-01T00:00:00.000Z",
    });
    await repo.upsertConnectedStorage({
      id: "cs_quark_taken",
      accountId: "acct_other",
      provider: "quark",
      providerUid: "quark_uid_live",
      label: null,
      payload: { cookie: LIVE_COOKIE },
      rootCid: "0",
      moviesCid: null,
      tvCid: null,
      animeCid: null,
      createdAt: "2026-07-01T00:00:00.000Z",
    });
    await expect(rt.connectQuarkCookie(LIVE_COOKIE)).rejects.toBeInstanceOf(rt.StorageOwnedByOtherAccountError);
  });
});
