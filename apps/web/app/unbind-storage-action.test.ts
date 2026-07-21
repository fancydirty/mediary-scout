import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  InMemoryWorkflowRepository,
  type PersistWorkflowRunSnapshotInput,
  type UpsertConnectedStorageInput,
} from "@media-track/workflow";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

const prevDemo = process.env.MEDIA_TRACK_DEMO_MODE;
const prevMultiUser = process.env.MEDIA_TRACK_MULTI_USER;
const prevPan115 = process.env.PAN115_COOKIE;

function pan115Drive(over: Partial<UpsertConnectedStorageInput> = {}): UpsertConnectedStorageInput {
  return {
    id: "cs_100000001",
    accountId: "acct_default",
    provider: "pan115",
    providerUid: "100000001",
    label: "主115",
    payload: { cookie: "UID=100000001_A; CID=c; SEID=s" },
    rootCid: "r",
    moviesCid: "m",
    tvCid: "t",
    animeCid: "a",
    createdAt: "2026-06-20T00:00:00.000Z",
    ...over,
  };
}

function quarkDrive(): UpsertConnectedStorageInput {
  return {
    id: "cs_quark_x",
    accountId: "acct_default",
    provider: "quark",
    providerUid: "quark_uid_x",
    label: "夸克",
    payload: { cookie: "quark_cookie" },
    rootCid: "r",
    moviesCid: "m",
    tvCid: "t",
    animeCid: "a",
    createdAt: "2026-06-20T00:00:00.000Z",
  };
}

function activeRunOn(storageId: string): PersistWorkflowRunSnapshotInput {
  return {
    accountId: "acct_default",
    connectedStorageId: storageId,
    title: {
      id: "t1",
      tmdbId: 1,
      type: "tv",
      title: "Show",
      originalTitle: "Show",
      year: 2026,
      aliases: [],
      posterPath: null,
    },
    season: {
      id: "t1_s1",
      mediaTitleId: "t1",
      seasonNumber: 1,
      status: "active",
      qualityPreference: "1080p",
      storageDirectoryId: "d",
      totalEpisodes: 10,
      latestAiredEpisode: 1,
      latestAiredSource: "metadata",
    },
    workflowRun: {
      id: "run_active",
      kind: "type2_init",
      status: "running",
      trackedSeasonId: "t1_s1",
      startedAt: "2026-07-21T00:00:00.000Z",
      finishedAt: null,
      auditEvents: [],
    },
    episodes: [],
    resourceSnapshots: [],
    decisions: [],
    transferAttempts: [],
    notifications: [],
  };
}

describe("unbindStorageAction (B4)", () => {
  let repo: InMemoryWorkflowRepository;
  let actions: typeof import("./actions");

  beforeEach(async () => {
    delete process.env.MEDIA_TRACK_DEMO_MODE;
    delete process.env.MEDIA_TRACK_MULTI_USER;
    delete process.env.PAN115_COOKIE;
    repo = new InMemoryWorkflowRepository();
    vi.resetModules();
    vi.doMock("../lib/workflow-runtime", async () => {
      const actual = await vi.importActual<typeof import("../lib/workflow-runtime")>(
        "../lib/workflow-runtime",
      );
      return {
        ...actual,
        getWorkflowRepository: () => repo,
        requireAuthenticatedAccountId: async () => "acct_default",
      };
    });
    actions = await import("./actions");
  });

  afterEach(() => {
    vi.doUnmock("../lib/workflow-runtime");
    vi.resetModules();
    if (prevDemo !== undefined) process.env.MEDIA_TRACK_DEMO_MODE = prevDemo;
    else delete process.env.MEDIA_TRACK_DEMO_MODE;
    if (prevMultiUser !== undefined) process.env.MEDIA_TRACK_MULTI_USER = prevMultiUser;
    else delete process.env.MEDIA_TRACK_MULTI_USER;
    if (prevPan115 !== undefined) process.env.PAN115_COOKIE = prevPan115;
    else delete process.env.PAN115_COOKIE;
  });

  it("unbind pan115 clears pan115.cookie setting + matching env mirror", async () => {
    await repo.upsertConnectedStorage(pan115Drive());
    await repo.setSetting("pan115.cookie", "UID=100000001_A; CID=c; SEID=s");
    await repo.setSetting("pan115.cookieMeta", JSON.stringify({ userName: "alice" }));
    process.env.PAN115_COOKIE = "UID=100000001_A; CID=c; SEID=s";

    const result = await actions.unbindStorageAction("cs_100000001");
    expect(result.ok).toBe(true);
    expect(await repo.listConnectedStorages("acct_default")).toEqual([]);
    expect(await repo.getSetting("pan115.cookie")).toBeNull();
    expect(await repo.getSetting("pan115.cookieMeta")).toBeNull();
    expect(process.env.PAN115_COOKIE).toBeUndefined();
  });

  it("unbind refuses when the drive has active runs", async () => {
    await repo.upsertConnectedStorage(pan115Drive());
    await repo.setSetting("pan115.cookie", "UID=100000001_A; CID=c");
    await repo.saveWorkflowRunSnapshot(activeRunOn("cs_100000001"));

    const result = await actions.unbindStorageAction("cs_100000001");
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/获取任务/);
    expect((await repo.listConnectedStorages("acct_default")).map((d) => d.id)).toEqual([
      "cs_100000001",
    ]);
    expect(await repo.getSetting("pan115.cookie")).toBe("UID=100000001_A; CID=c");
  });

  it("unbind quark does not clear pan115.cookie", async () => {
    await repo.upsertConnectedStorage(quarkDrive());
    await repo.upsertConnectedStorage(pan115Drive());
    await repo.setSetting("pan115.cookie", "UID=100000001_A; CID=c");
    process.env.PAN115_COOKIE = "UID=100000001_A; CID=c";

    const result = await actions.unbindStorageAction("cs_quark_x");
    expect(result.ok).toBe(true);
    expect((await repo.listConnectedStorages("acct_default")).map((d) => d.id)).toEqual([
      "cs_100000001",
    ]);
    expect(await repo.getSetting("pan115.cookie")).toBe("UID=100000001_A; CID=c");
    expect(process.env.PAN115_COOKIE).toBe("UID=100000001_A; CID=c");
  });
});
