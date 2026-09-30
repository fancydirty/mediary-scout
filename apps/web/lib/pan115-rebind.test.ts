import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Re-scanning the same 115 account on a 掉线 (frozen) drive. Real completePan115QrLogin
 * against in-memory SQLite; only the QR login client is stubbed (no network): its
 * exchangeCookie hands back a fresh cookie for the same UID.
 */

class FakePan115QrLoginClient {
  async exchangeCookie() {
    return { cookie: "UID=103164004_A1_1; CID=fresh; SEID=fresh", userName: "tester", app: "alipaymini" };
  }
}

const prevPg = process.env.MEDIA_TRACK_POSTGRES_URL;
const prevMultiUser = process.env.MEDIA_TRACK_MULTI_USER;
const prevCookie = process.env.PAN115_COOKIE;

// Cold import of ./workflow-runtime can take several seconds on a loaded machine: boot in
// the hook with its own timeout (see pan123-connect.test.ts).
const COLD_IMPORT_TIMEOUT_MS = 30_000;
let rt: typeof import("./workflow-runtime");
beforeEach(async () => {
  process.env.MEDIA_TRACK_SQLITE_PATH = ":memory:";
  delete process.env.MEDIA_TRACK_POSTGRES_URL;
  delete process.env.MEDIA_TRACK_MULTI_USER;
  vi.resetModules();
  vi.doMock("@media-track/workflow", async () => {
    const actual = await vi.importActual<typeof import("@media-track/workflow")>("@media-track/workflow");
    return { ...actual, Pan115QrLoginClient: FakePan115QrLoginClient };
  });
  rt = await import("./workflow-runtime");
}, COLD_IMPORT_TIMEOUT_MS);

afterEach(() => {
  vi.doUnmock("@media-track/workflow");
  delete process.env.MEDIA_TRACK_SQLITE_PATH;
  if (prevPg !== undefined) process.env.MEDIA_TRACK_POSTGRES_URL = prevPg;
  if (prevMultiUser !== undefined) process.env.MEDIA_TRACK_MULTI_USER = prevMultiUser;
  if (prevCookie === undefined) delete process.env.PAN115_COOKIE;
  else process.env.PAN115_COOKIE = prevCookie;
  vi.resetModules();
});

describe("completePan115QrLogin on a frozen drive", () => {
  it("re-scanning the same account brings the drive back: active, reason cleared, CIDs kept", async () => {
    const repository = rt.getWorkflowRepository();
    await repository.upsertConnectedStorage({
      id: "cs_103164004",
      accountId: "acct_default",
      provider: "pan115",
      providerUid: "103164004",
      label: "tester",
      payload: { cookie: "UID=103164004_A1_1; CID=old; SEID=old" },
      tvCid: "tv-1",
      createdAt: "2020-01-01T00:00:00.000Z",
    });
    await repository.setConnectedStorageStatus("cs_103164004", "frozen", "PAN115_COOKIE_EXPIRED", "2026-09-30T00:00:00.000Z");

    await rt.completePan115QrLogin({ session: { uid: "u", time: 1, sign: "s", qrcodeContent: "q" } });

    const stored = (await repository.listConnectedStorages("acct_default")).find((s) => s.id === "cs_103164004");
    expect(stored).toMatchObject({ status: "active", frozenReason: null, frozenAt: null, tvCid: "tv-1" });
    expect((stored?.payload as { cookie?: string }).cookie).toContain("CID=fresh");
  });
});
