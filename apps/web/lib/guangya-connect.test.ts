import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Bind-level regression tests for the 光鸭 connect flow. Locks the behavior that
 * Refactors 2+3 changed and must preserve: credential extraction + the
 * deviceId-pinning-on-rebind that is now threaded through
 * bindTokenConnectedStorage. Exercises the REAL connectGuangYa against an
 * in-memory SQLite repo (mirrors tianyi-connect.test.ts), stubbing ONLY the
 * network:
 *   - GuangYaClient.validateToken() → a fixed providerUid (no HTTP).
 *   - createExecutorForBrand → throws, so the insert-branch directory provision
 *     needs no network AND we exercise the best-effort contract (the connection
 *     still stores, with null CIDs).
 * `generateGuangYaDeviceId` stays REAL so the insert test proves a fresh device id
 * is minted. The load-bearing assertions:
 *   - INSERT mints a FRESH deviceId into payload; row id `cs_guangya_<uidSuffix>`,
 *     tokens trimmed, CIDs null (provision threw), no throw.
 *   - REFRESH reuses the EXISTING pinned deviceId (风控: a rebind must NOT look
 *     like a new device) and keeps the resolved CIDs + createdAt.
 *   - cross-account bind → StorageOwnedByOtherAccountError, other row untouched.
 */

const PROVIDER_UID = "guangya-sub-0001";

/** Stub for @media-track/workflow's GuangYaClient — no network. connectGuangYa
 *  constructs it with the token blob and calls validateToken() for the sub. */
class FakeGuangYaClient {
  constructor(readonly options: unknown) {}
  async validateToken(): Promise<string> {
    return PROVIDER_UID;
  }
}

const prevPg = process.env.MEDIA_TRACK_POSTGRES_URL;
const prevMultiUser = process.env.MEDIA_TRACK_MULTI_USER;

/** Boot workflow-runtime against a fresh :memory: SQLite repo with the network
 *  login client + executor factory stubbed (no HTTP anywhere). */
const boot = async () => {
  process.env.MEDIA_TRACK_SQLITE_PATH = ":memory:";
  delete process.env.MEDIA_TRACK_POSTGRES_URL;
  delete process.env.MEDIA_TRACK_MULTI_USER; // single-user → getCurrentAccountId() = acct_default
  vi.resetModules();
  vi.doMock("@media-track/workflow", async () => {
    const actual = await vi.importActual<typeof import("@media-track/workflow")>("@media-track/workflow");
    return {
      ...actual,
      GuangYaClient: FakeGuangYaClient,
      // insert-branch provision must not touch the network; throwing exercises the
      // best-effort contract (row stored with null CIDs).
      createExecutorForBrand: () => {
        throw new Error("PROVISION_BOOM: no network in test");
      },
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

describe("connectGuangYa (bind)", () => {
  it("INSERT (fresh uid): stores cs_guangya_<uid> with trimmed tokens + a freshly-minted deviceId; provision threw → null CIDs, no throw", async () => {
    const rt = await boot();
    const repository = rt.getWorkflowRepository();

    // Surrounding whitespace also locks connect-time trimming.
    const { providerUid } = await rt.connectGuangYa("  AT-live  ", "  RT-live  ");
    expect(providerUid).toBe(PROVIDER_UID);

    const stored = await repository.findConnectedStorageByUid("guangya", PROVIDER_UID);
    expect(stored).not.toBeNull();
    // uid non-alphanumerics (the hyphens) are stripped from the id suffix.
    expect(stored!.id).toBe("cs_guangya_guangyasub0001");
    expect(stored!.provider).toBe("guangya");
    expect(stored!.label).toBeNull();

    const payload = stored!.payload as Record<string, unknown>;
    expect(payload.accessToken).toBe("AT-live"); // trimmed
    expect(payload.refreshToken).toBe("RT-live"); // trimmed
    // A device id was freshly generated (non-empty) and baked into the blob.
    expect(typeof payload.deviceId).toBe("string");
    expect((payload.deviceId as string).length).toBeGreaterThan(0);
    // Durable connectedAt lives under meta.
    expect((payload.meta as Record<string, unknown>).connectedAt).toEqual(expect.any(String));

    // Provision threw (no network) → CIDs null, but the connection still landed.
    expect(stored!.rootCid).toBeNull();
    expect(stored!.moviesCid).toBeNull();
    expect(stored!.tvCid).toBeNull();
    expect(stored!.animeCid).toBeNull();
  });

  it("REFRESH (same account, uid already connected): reuses the existing pinned deviceId + keeps resolved CIDs/createdAt", async () => {
    const rt = await boot();
    const repository = rt.getWorkflowRepository();
    // Seed an existing 光鸭 drive owned by the current (default) account with a KNOWN
    // deviceId + resolved CIDs.
    await repository.upsertConnectedStorage({
      id: "cs_guangya_seed",
      accountId: "acct_default",
      provider: "guangya",
      providerUid: PROVIDER_UID,
      label: "旧标签",
      payload: {
        accessToken: "OLD-AT",
        refreshToken: "OLD-RT",
        deviceId: "PINNED_DEV",
        meta: { connectedAt: "2020-01-01T00:00:00.000Z" },
      },
      rootCid: "root-1",
      moviesCid: "movies-1",
      tvCid: "tv-1",
      animeCid: "anime-1",
      createdAt: "2020-01-01T00:00:00.000Z",
    });

    const { providerUid } = await rt.connectGuangYa("AT-new", "RT-new");
    expect(providerUid).toBe(PROVIDER_UID);

    const stored = (await repository.listConnectedStorages("acct_default")).find((s) => s.provider === "guangya");
    expect(stored).toBeDefined();
    const payload = stored!.payload as Record<string, unknown>;

    // 风控 load-bearing: a rebind reuses the pinned device, does NOT mint a new one.
    expect(payload.deviceId).toBe("PINNED_DEV");
    // Fresh tokens replaced the old blob.
    expect(payload.accessToken).toBe("AT-new");
    expect(payload.refreshToken).toBe("RT-new");
    // Refresh keeps the row's id, resolved CIDs, and createdAt.
    expect(stored!.id).toBe("cs_guangya_seed");
    expect(stored!.rootCid).toBe("root-1");
    expect(stored!.moviesCid).toBe("movies-1");
    expect(stored!.tvCid).toBe("tv-1");
    expect(stored!.animeCid).toBe("anime-1");
    expect(stored!.createdAt).toBe("2020-01-01T00:00:00.000Z");
  });

  it("cross-account: the 光鸭 account already belongs to another account → StorageOwnedByOtherAccountError, other row untouched", async () => {
    const rt = await boot();
    const repository = rt.getWorkflowRepository();
    await repository.upsertConnectedStorage({
      id: "cs_guangya_other",
      accountId: "acct_other",
      provider: "guangya",
      providerUid: PROVIDER_UID,
      label: null,
      payload: { accessToken: "x", refreshToken: "x", deviceId: "OTHER_DEV", meta: {} },
      rootCid: null,
      moviesCid: null,
      tvCid: null,
      animeCid: null,
      createdAt: "2020-01-01T00:00:00.000Z",
    });

    await expect(rt.connectGuangYa("AT-live", "RT-live")).rejects.toBeInstanceOf(rt.StorageOwnedByOtherAccountError);

    // The other account still owns exactly one 光鸭 drive, untouched; current got none.
    const otherRows = (await repository.listConnectedStorages("acct_other")).filter((s) => s.provider === "guangya");
    expect(otherRows).toHaveLength(1);
    expect((otherRows[0]!.payload as Record<string, unknown>).deviceId).toBe("OTHER_DEV");
    const defaultRows = (await repository.listConnectedStorages("acct_default")).filter((s) => s.provider === "guangya");
    expect(defaultRows).toHaveLength(0);
  });
});
