import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Bind-level tests for the 天翼 connect flow (Task 7). Exercises the REAL bind
 * against an in-memory SQLite repository (mirrors the runScheduledType3 harness),
 * stubbing ONLY the network login client (TianyiQrLoginClient) so no real HTTP is
 * touched. Deliberately hits the refresh + reject branches (which skip the
 * insert-path directory provision, i.e. no network) to keep the test hermetic and
 * fast. The load-bearing assertions:
 *   - providerUid is derived from session.loginName (NOT from the credential blob).
 *   - durable loginName lands under payload.meta.loginName, NOT top-level (T6
 *     contract: session renewal overwrites the top-level blob).
 *   - cross-account bind is rejected (instance-wide UNIQUE(provider, uid)).
 */

const LOGIN_NAME = "13800138000";

/** getSessionForPC's full payload — the shape bind consumes. */
const FAKE_SESSION = {
  sessionKey: "SK-web",
  sessionSecret: "SS-secret",
  accessToken: "AT-open",
  refreshToken: "RT-open",
  familySessionKey: "FSK-fam",
  familySessionSecret: "FSS-secret",
  loginName: LOGIN_NAME,
};

/** Stub for @media-track/workflow's TianyiQrLoginClient — returns a canned
 *  TianyiSession without any network. `loginBySson("EMPTY_UID")` yields a session
 *  with an empty loginName to exercise the missing-uid guard. */
class FakeTianyiQrLoginClient {
  async loginBySson(sson: string) {
    if (!sson) {
      throw new Error("empty SSON");
    }
    if (sson === "EMPTY_UID") {
      return { ...FAKE_SESSION, loginName: "" };
    }
    return FAKE_SESSION;
  }
  async exchangeSession(_session: unknown, _redirectUrl: string) {
    return FAKE_SESSION;
  }
}

const prevPg = process.env.MEDIA_TRACK_POSTGRES_URL;
const prevMultiUser = process.env.MEDIA_TRACK_MULTI_USER;

/** Boot workflow-runtime against a fresh :memory: SQLite repo with the network
 *  login client stubbed. `failProvision` additionally makes the insert branch's
 *  directory provisioning throw (createExecutorForBrand → throw) WITHOUT any
 *  network, to test the "provision fails → still store the connection" contract. */
const boot = async (opts: { failProvision?: boolean } = {}) => {
  process.env.MEDIA_TRACK_SQLITE_PATH = ":memory:";
  delete process.env.MEDIA_TRACK_POSTGRES_URL;
  delete process.env.MEDIA_TRACK_MULTI_USER; // single-user → getCurrentAccountId() = acct_default
  vi.resetModules();
  vi.doMock("@media-track/workflow", async () => {
    const actual = await vi.importActual<typeof import("@media-track/workflow")>("@media-track/workflow");
    return {
      ...actual,
      TianyiQrLoginClient: FakeTianyiQrLoginClient,
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

describe("connectTianyiSson (bind)", () => {
  it("same-account re-login (refresh): providerUid=loginName, loginName under meta (NOT top-level), keeps resolved CIDs", async () => {
    const rt = await boot();
    const repository = rt.getWorkflowRepository();
    // Seed an existing 天翼 drive owned by the current (default) account.
    await repository.upsertConnectedStorage({
      id: "cs_tianyi_seed",
      accountId: "acct_default",
      provider: "tianyi",
      providerUid: LOGIN_NAME,
      label: "旧标签",
      payload: {
        sessionKey: "OLD-SK",
        accessToken: "OLD-AT",
        refreshToken: "OLD-RT",
        meta: { connectedAt: "2020-01-01T00:00:00.000Z", loginName: LOGIN_NAME },
      },
      rootCid: "root-1",
      moviesCid: "movies-1",
      tvCid: "tv-1",
      animeCid: "anime-1",
      createdAt: "2020-01-01T00:00:00.000Z",
    });

    const { providerUid } = await rt.connectTianyiSson("SSON-abc");
    expect(providerUid).toBe(LOGIN_NAME); // derived from session.loginName

    const stored = (await repository.listConnectedStorages("acct_default")).find((s) => s.provider === "tianyi");
    expect(stored).toBeDefined();
    const payload = stored!.payload as Record<string, unknown>;
    const meta = payload.meta as Record<string, unknown>;

    // Durable identity lives ONLY under meta.
    expect(meta.loginName).toBe(LOGIN_NAME);
    expect(payload.loginName).toBeUndefined();
    expect(meta.connectedAt).toEqual(expect.any(String));

    // Top-level = the rotating credential blob, refreshed from the new session.
    expect(payload.sessionKey).toBe("SK-web");
    expect(payload.accessToken).toBe("AT-open");
    expect(payload.refreshToken).toBe("RT-open");
    expect(payload.familySessionKey).toBe("FSK-fam");
    // The *secrets* are intentionally NOT persisted (WEB face needs only sessionKey;
    // renewal uses accessToken/refreshToken).
    expect(payload.sessionSecret).toBeUndefined();
    expect(payload.familySessionSecret).toBeUndefined();

    // Refresh keeps the row's id, resolved CIDs, and createdAt.
    expect(stored!.id).toBe("cs_tianyi_seed");
    expect(stored!.rootCid).toBe("root-1");
    expect(stored!.moviesCid).toBe("movies-1");
    expect(stored!.tvCid).toBe("tv-1");
    expect(stored!.animeCid).toBe("anime-1");
    expect(stored!.createdAt).toBe("2020-01-01T00:00:00.000Z");
  });

  it("cross-account: the 天翼 account already belongs to another account → StorageOwnedByOtherAccountError, other row untouched", async () => {
    const rt = await boot();
    const repository = rt.getWorkflowRepository();
    await repository.upsertConnectedStorage({
      id: "cs_tianyi_other",
      accountId: "acct_other",
      provider: "tianyi",
      providerUid: LOGIN_NAME,
      label: null,
      payload: {
        sessionKey: "x",
        accessToken: "x",
        refreshToken: "x",
        meta: { loginName: LOGIN_NAME },
      },
      rootCid: null,
      moviesCid: null,
      tvCid: null,
      animeCid: null,
      createdAt: "2020-01-01T00:00:00.000Z",
    });

    await expect(rt.connectTianyiSson("SSON-abc")).rejects.toBeInstanceOf(rt.StorageOwnedByOtherAccountError);

    // The other account still owns exactly one 天翼 drive; the current account got none.
    const otherRows = (await repository.listConnectedStorages("acct_other")).filter((s) => s.provider === "tianyi");
    expect(otherRows).toHaveLength(1);
    const defaultRows = (await repository.listConnectedStorages("acct_default")).filter((s) => s.provider === "tianyi");
    expect(defaultRows).toHaveLength(0);
  });

  it("empty SSON → friendly error before any network/login call", async () => {
    const rt = await boot();
    await expect(rt.connectTianyiSson("   ")).rejects.toThrow(/SSON/);
  });

  it("login yielded no loginName → refuses to bind an account with an empty uid", async () => {
    const rt = await boot();
    await expect(rt.connectTianyiSson("EMPTY_UID")).rejects.toThrow(/loginName/);
    const rows = (await rt.getWorkflowRepository().listConnectedStorages("acct_default")).filter(
      (s) => s.provider === "tianyi",
    );
    expect(rows).toHaveLength(0);
  });

  it("insert branch: provision throws → row still stored with null CIDs and bind does NOT throw", async () => {
    // Fresh uid (no seeded row) → resolveStorageBinding → insert → provision runs
    // → createExecutorForBrand stubbed to throw. The bind must swallow it and still
    // persist the connection (best-effort provision contract).
    const rt = await boot({ failProvision: true });
    const repository = rt.getWorkflowRepository();

    const { providerUid } = await rt.connectTianyiSson("SSON-fresh");
    expect(providerUid).toBe(LOGIN_NAME);

    const stored = await repository.findConnectedStorageByUid("tianyi", LOGIN_NAME);
    expect(stored).not.toBeNull();
    expect(stored!.id).toBe(`cs_tianyi_${LOGIN_NAME}`); // digits-only uid → suffix intact
    // Provision failed → all CIDs null; the connection is still usable (worker self-heals).
    expect(stored!.rootCid).toBeNull();
    expect(stored!.moviesCid).toBeNull();
    expect(stored!.tvCid).toBeNull();
    expect(stored!.animeCid).toBeNull();
    // Credential blob + durable identity still land correctly.
    const payload = stored!.payload as Record<string, unknown>;
    expect((payload.meta as Record<string, unknown>).loginName).toBe(LOGIN_NAME);
    expect(payload.sessionKey).toBe("SK-web");
  });
});

describe("completeTianyiQrLogin (QR bind)", () => {
  it("exchanges the poll redirectUrl for a session, then binds (refresh): providerUid + meta.loginName", async () => {
    const rt = await boot();
    const repository = rt.getWorkflowRepository();
    await repository.upsertConnectedStorage({
      id: "cs_tianyi_seed",
      accountId: "acct_default",
      provider: "tianyi",
      providerUid: LOGIN_NAME,
      label: null,
      payload: { sessionKey: "OLD", accessToken: "OLD", refreshToken: "OLD", meta: { loginName: LOGIN_NAME } },
      rootCid: "root-1",
      moviesCid: "movies-1",
      tvCid: "tv-1",
      animeCid: "anime-1",
      createdAt: "2020-01-01T00:00:00.000Z",
    });

    // The QR session's cookie jar is consumed inside exchangeSession (stubbed) and
    // does NOT participate in bind — bind only sees the exchanged TianyiSession.
    const fakeQrSession = { uuid: "U", encryuuid: "E", paramId: "P", reqId: "R", lt: "L", cookies: [["a", "b"]] };
    const { providerUid } = await rt.completeTianyiQrLogin(fakeQrSession as never, "https://cloud.189.cn/redirect?x=1");
    expect(providerUid).toBe(LOGIN_NAME);

    const stored = (await repository.listConnectedStorages("acct_default")).find((s) => s.provider === "tianyi");
    const payload = stored!.payload as Record<string, unknown>;
    expect((payload.meta as Record<string, unknown>).loginName).toBe(LOGIN_NAME);
    expect(payload.sessionKey).toBe("SK-web");
  });
});
