import { describe, expect, it } from "vitest";
import { InMemoryWorkflowRepository, type UpsertConnectedStorageInput } from "../src/index.js";

function driveRow(accountId: string): UpsertConnectedStorageInput {
  return {
    id: "cs_100000001",
    accountId,
    provider: "pan115",
    providerUid: "100000001",
    label: "主115",
    payload: {},
    rootCid: "r",
    moviesCid: "m",
    tvCid: "t",
    animeCid: "a",
    createdAt: "2026-06-20T00:00:00.000Z",
  };
}

describe("upsertConnectedStorage refuses acct_unauthenticated (C2)", () => {
  it("throws and does not store a row for the sentinel account", async () => {
    const repo = new InMemoryWorkflowRepository();
    await expect(
      repo.upsertConnectedStorage({
        ...driveRow("acct_unauthenticated"),
        id: "cs_ghost",
        providerUid: "ghost",
      }),
    ).rejects.toThrow(/unauthenticated account/);
    expect(await repo.listConnectedStorages("acct_unauthenticated")).toEqual([]);
  });
});

describe("deleteConnectedStorage (InMemory)", () => {
  it("removes the drive row but keeps the account's other drives", async () => {
    const repo = new InMemoryWorkflowRepository();
    await repo.upsertConnectedStorage(driveRow("acct_default"));
    await repo.upsertConnectedStorage({ ...driveRow("acct_default"), id: "cs_quark_X", provider: "quark", providerUid: "X" });
    expect((await repo.listConnectedStorages("acct_default")).map((s) => s.id).sort()).toEqual(["cs_100000001", "cs_quark_X"]);

    await repo.deleteConnectedStorage("acct_default", "cs_100000001");
    expect((await repo.listConnectedStorages("acct_default")).map((s) => s.id)).toEqual(["cs_quark_X"]);
  });

  it("is fail-closed: does NOT delete a drive owned by a different account", async () => {
    const repo = new InMemoryWorkflowRepository();
    await repo.upsertConnectedStorage(driveRow("acct_alice"));
    await repo.deleteConnectedStorage("acct_bob", "cs_100000001"); // wrong account
    expect((await repo.listConnectedStorages("acct_alice")).map((s) => s.id)).toEqual(["cs_100000001"]);
  });

  it("re-binding the SAME physical drive (same uid → same cs_id) reconnects scoped data", async () => {
    const repo = new InMemoryWorkflowRepository();
    await repo.upsertConnectedStorage(driveRow("acct_default"));
    await repo.deleteConnectedStorage("acct_default", "cs_100000001");
    expect(await repo.listConnectedStorages("acct_default")).toEqual([]);
    await repo.upsertConnectedStorage(driveRow("acct_default"));
    expect((await repo.listConnectedStorages("acct_default")).map((s) => s.id)).toEqual(["cs_100000001"]);
  });
});

describe("tryUnbindConnectedStorage (InMemory)", () => {
  it("deletes when idle and returns the storage row", async () => {
    const repo = new InMemoryWorkflowRepository();
    await repo.upsertConnectedStorage(driveRow("acct_default"));
    const result = await repo.tryUnbindConnectedStorage("acct_default", "cs_100000001");
    expect(result).toEqual({
      ok: true,
      storage: expect.objectContaining({ id: "cs_100000001", provider: "pan115", providerUid: "100000001" }),
    });
    expect(await repo.listConnectedStorages("acct_default")).toEqual([]);
  });

  it("refuses when the drive has a running workflow", async () => {
    const repo = new InMemoryWorkflowRepository();
    await repo.upsertConnectedStorage(driveRow("acct_default"));
    await repo.saveWorkflowRunSnapshot({
      accountId: "acct_default",
      connectedStorageId: "cs_100000001",
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
        id: "run_1",
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
    });
    const result = await repo.tryUnbindConnectedStorage("acct_default", "cs_100000001");
    expect(result).toEqual({ ok: false, reason: "active_runs" });
    expect((await repo.listConnectedStorages("acct_default")).map((s) => s.id)).toEqual(["cs_100000001"]);
  });
});
