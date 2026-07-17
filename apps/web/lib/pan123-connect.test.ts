import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Bind-level tests for the 123网盘 connect flow (T7). Exercises the REAL
 * connectPan123Token / completePan123QrLogin against an in-memory SQLite
 * repository (mirrors tianyi-connect.test.ts), stubbing ONLY the network client
 * (Pan123Client, used by the probe) so no real HTTP is touched. Deliberately
 * hits the refresh + reject branches (which skip the insert-path directory
 * provision, i.e. no network) to keep the test hermetic and fast. The
 * load-bearing assertions:
 *   - providerUid is derived from the token's JWT payload id (parsePan123Uid);
 *     an unparseable token → friendly error, nothing stored.
 *   - the probe runs BEFORE bind: a dead token (Pan123Client.listFiles throws)
 *     → friendly error, nothing stored.
 *   - credential blob is exactly { token } + meta (pure-token model, v1 has no
 *     rotation — meta.connectedAt is the only durable metadata).
 *   - cross-account bind is rejected (instance-wide UNIQUE(provider, uid)).
 */

const b64url = (obj: unknown): string => Buffer.from(JSON.stringify(obj)).toString("base64url");

/** A structurally-valid 123 login JWT whose payload carries the stable numeric
 *  user id (providerUid source). PII-free — synthetic id. */
const VALID_TOKEN = `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ id: 10086 })}.sig`;
/** Parseable uid, but the fake client treats it as revoked (listFiles throws) —
 *  proves the probe gate runs before bind. */
const DEAD_TOKEN = `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ id: 424242 })}.DEAD`;

/** Counts FakePan123Client constructions — the connect entry points must NOT
 *  touch the network (probe) for input rejected locally (empty / unparseable
 *  token). Reset in boot(). */
let pan123ClientConstructions = 0;

/** Stub for @media-track/workflow's Pan123Client — no network. The probe arm
 *  calls listFiles("0"); a token whose signature segment is "DEAD" simulates a
 *  revoked/expired token (the real client throws Pan123AuthError on code 401). */
class FakePan123Client {
  private readonly token: string;
  constructor(opts: { token: string }) {
    pan123ClientConstructions++;
    this.token = opts.token;
  }
  async listFiles(_parentFileId: string, _opts?: { maxPages?: number }) {
    if (this.token.endsWith(".DEAD")) {
      throw new Error("PAN123_API_401: token dead");
    }
    return [];
  }
}

const prevPg = process.env.MEDIA_TRACK_POSTGRES_URL;
const prevMultiUser = process.env.MEDIA_TRACK_MULTI_USER;

/** Boot workflow-runtime against a fresh :memory: SQLite repo with the network
 *  client stubbed (parsePan123Uid stays REAL via importActual — uid derivation is
 *  part of what's under test). `failProvision` additionally makes the insert
 *  branch's directory provisioning throw (createExecutorForBrand → throw) WITHOUT
 *  any network, to test the "provision fails → still store the connection"
 *  contract (mirrors tianyi-connect.test.ts). */
const boot = async (opts: { failProvision?: boolean } = {}) => {
  process.env.MEDIA_TRACK_SQLITE_PATH = ":memory:";
  delete process.env.MEDIA_TRACK_POSTGRES_URL;
  delete process.env.MEDIA_TRACK_MULTI_USER; // single-user → getCurrentAccountId() = acct_default
  pan123ClientConstructions = 0;
  vi.resetModules();
  vi.doMock("@media-track/workflow", async () => {
    const actual = await vi.importActual<typeof import("@media-track/workflow")>("@media-track/workflow");
    return {
      ...actual,
      Pan123Client: FakePan123Client,
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

describe("connectPan123Token (bind)", () => {
  it("same-account re-login (refresh): providerUid from JWT payload id, blob is exactly {token}+meta, keeps resolved CIDs", async () => {
    const rt = await boot();
    const repository = rt.getWorkflowRepository();
    // Seed an existing 123 drive owned by the current (default) account.
    await repository.upsertConnectedStorage({
      id: "cs_pan123_seed",
      accountId: "acct_default",
      provider: "pan123",
      providerUid: "10086",
      label: "旧标签",
      payload: { token: "OLD-TOKEN", meta: { connectedAt: "2020-01-01T00:00:00.000Z" } },
      rootCid: "root-1",
      moviesCid: "movies-1",
      tvCid: "tv-1",
      animeCid: "anime-1",
      createdAt: "2020-01-01T00:00:00.000Z",
    });

    const { providerUid } = await rt.connectPan123Token(`  ${VALID_TOKEN}  `);
    expect(providerUid).toBe("10086"); // derived from the JWT payload id, trimmed input

    const stored = (await repository.listConnectedStorages("acct_default")).find((s) => s.provider === "pan123");
    expect(stored).toBeDefined();
    const payload = stored!.payload as Record<string, unknown>;

    // Pure-token model: the rotating blob is exactly { token }; durable metadata
    // rides under meta (v1 never rotates, but the shape follows the T6 contract).
    expect(payload.token).toBe(VALID_TOKEN);
    expect((payload.meta as Record<string, unknown>).connectedAt).toEqual(expect.any(String));
    expect(Object.keys(payload).sort()).toEqual(["meta", "token"]);

    // Refresh keeps the row's id, resolved CIDs, and createdAt.
    expect(stored!.id).toBe("cs_pan123_seed");
    expect(stored!.rootCid).toBe("root-1");
    expect(stored!.moviesCid).toBe("movies-1");
    expect(stored!.tvCid).toBe("tv-1");
    expect(stored!.animeCid).toBe("anime-1");
    expect(stored!.createdAt).toBe("2020-01-01T00:00:00.000Z");
  });

  it("cross-account: the 123 account already belongs to another account → StorageOwnedByOtherAccountError, other row untouched", async () => {
    const rt = await boot();
    const repository = rt.getWorkflowRepository();
    await repository.upsertConnectedStorage({
      id: "cs_pan123_other",
      accountId: "acct_other",
      provider: "pan123",
      providerUid: "10086",
      label: null,
      payload: { token: "x", meta: {} },
      rootCid: null,
      moviesCid: null,
      tvCid: null,
      animeCid: null,
      createdAt: "2020-01-01T00:00:00.000Z",
    });

    await expect(rt.connectPan123Token(VALID_TOKEN)).rejects.toBeInstanceOf(rt.StorageOwnedByOtherAccountError);

    const otherRows = (await repository.listConnectedStorages("acct_other")).filter((s) => s.provider === "pan123");
    expect(otherRows).toHaveLength(1);
    const defaultRows = (await repository.listConnectedStorages("acct_default")).filter((s) => s.provider === "pan123");
    expect(defaultRows).toHaveLength(0);
  });

  it("insert branch: provision throws → row still stored with null CIDs and bind does NOT throw", async () => {
    // Fresh uid (no seeded row) → resolveStorageBinding → insert → provision runs
    // → createExecutorForBrand stubbed to throw. The bind must swallow it and still
    // persist the connection (best-effort provision contract). This is the primary
    // real-world path: a brand-new user's first bind.
    const rt = await boot({ failProvision: true });
    const repository = rt.getWorkflowRepository();

    const { providerUid } = await rt.connectPan123Token(VALID_TOKEN);
    expect(providerUid).toBe("10086");

    const stored = await repository.findConnectedStorageByUid("pan123", "10086");
    expect(stored).not.toBeNull();
    expect(stored!.id).toBe("cs_pan123_10086"); // digits-only uid → suffix intact
    // Provision failed → all CIDs null; the connection is still usable (worker self-heals).
    expect(stored!.rootCid).toBeNull();
    expect(stored!.moviesCid).toBeNull();
    expect(stored!.tvCid).toBeNull();
    expect(stored!.animeCid).toBeNull();
    // Credential blob still lands correctly (pure-token model).
    const payload = stored!.payload as Record<string, unknown>;
    expect(payload.token).toBe(VALID_TOKEN);
    expect((payload.meta as Record<string, unknown>).connectedAt).toEqual(expect.any(String));
  });

  it("empty token → friendly error, zero network (no probe client constructed)", async () => {
    const rt = await boot();
    await expect(rt.connectPan123Token("   ")).rejects.toThrow(/token/);
    expect(pan123ClientConstructions).toBe(0);
  });

  it("unparseable token (not a 123 JWT) → precise local error, zero network, nothing stored", async () => {
    const rt = await boot();
    // uid is parsed LOCALLY before the probe: garbage input must hit the precise
    // "不是有效的 123 登录 token" message WITHOUT ever sending the garbage token to
    // 123 (no Pan123Client construction), and must not be masked by the probe's
    // "确认 token 完整且未过期" wording.
    await expect(rt.connectPan123Token("not-a-jwt")).rejects.toThrow(/识别/);
    expect(pan123ClientConstructions).toBe(0);
    const rows = (await rt.getWorkflowRepository().listConnectedStorages("acct_default")).filter(
      (s) => s.provider === "pan123",
    );
    expect(rows).toHaveLength(0);
  });

  it("dead token: probe (listFiles) throws → friendly error, nothing stored (probe gates bind)", async () => {
    const rt = await boot();
    await expect(rt.connectPan123Token(DEAD_TOKEN)).rejects.toThrow(/无法用该 token 连接 123网盘/);
    const rows = (await rt.getWorkflowRepository().listConnectedStorages("acct_default")).filter(
      (s) => s.provider === "pan123",
    );
    expect(rows).toHaveLength(0);
  });
});

describe("completePan123QrLogin (QR bind)", () => {
  it("binds the polled 90-day token directly (refresh): providerUid + {token}+meta blob", async () => {
    const rt = await boot();
    const repository = rt.getWorkflowRepository();
    await repository.upsertConnectedStorage({
      id: "cs_pan123_seed",
      accountId: "acct_default",
      provider: "pan123",
      providerUid: "10086",
      label: null,
      payload: { token: "OLD-TOKEN", meta: { connectedAt: "2020-01-01T00:00:00.000Z" } },
      rootCid: "root-1",
      moviesCid: "movies-1",
      tvCid: "tv-1",
      animeCid: "anime-1",
      createdAt: "2020-01-01T00:00:00.000Z",
    });

    // 123 has no exchange step (the polled token IS the final credential) — the
    // QR completion feeds the token straight into probe + bind.
    const { providerUid } = await rt.completePan123QrLogin(VALID_TOKEN);
    expect(providerUid).toBe("10086");

    const stored = (await repository.listConnectedStorages("acct_default")).find((s) => s.provider === "pan123");
    const payload = stored!.payload as Record<string, unknown>;
    expect(payload.token).toBe(VALID_TOKEN);
    expect(stored!.rootCid).toBe("root-1"); // refresh keeps CIDs
  });

  it("QR flow returned an empty token → friendly re-scan error, no probe", async () => {
    const rt = await boot();
    await expect(rt.completePan123QrLogin("  ")).rejects.toThrow(/扫码/);
    expect(pan123ClientConstructions).toBe(0);
  });

  it("QR flow returned an unparseable token → precise local error, zero network", async () => {
    const rt = await boot();
    await expect(rt.completePan123QrLogin("garbage-not-a-jwt")).rejects.toThrow(/识别/);
    expect(pan123ClientConstructions).toBe(0);
  });

  it("QR flow returned a dead token → probe fails with a re-scan error, nothing stored", async () => {
    const rt = await boot();
    await expect(rt.completePan123QrLogin(DEAD_TOKEN)).rejects.toThrow(/请重新扫码/);
    const rows = (await rt.getWorkflowRepository().listConnectedStorages("acct_default")).filter(
      (s) => s.provider === "pan123",
    );
    expect(rows).toHaveLength(0);
  });
});
