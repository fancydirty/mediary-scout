import { describe, expect, it, vi } from "vitest";
import { buildSessionCookie } from "./session.js";
import { resolveAccount } from "./account-auth.js";

const NOW = "2026-10-03T00:00:00.000Z";
const SECRET = "a".repeat(64);
const CREDENTIAL = `ic_${"a".repeat(43)}`;

describe("resolveAccount", () => {
  it("resolves a valid instance bearer and touches it best effort", async () => {
    const touch = vi.fn(async () => {});
    const db = {
      getActiveInstanceCredentialBySha: vi.fn(async () => ({
        id: "icr_1",
        account_id: "act_1",
        credential_sha256: "sha",
        link_request_id: "ilr_1",
        created_at: NOW,
        last_used_at: null,
        revoked_at: null,
      })),
      touchInstanceCredential: touch,
    };
    const result = await resolveAccount(
      new Request("https://mediaryconnect.app/api/account", {
        headers: { authorization: `Bearer ${CREDENTIAL}` },
      }),
      { db, sessionSecret: SECRET, now: () => NOW } as never,
    );
    expect(result).toEqual({ ok: true, accountId: "act_1", via: "bearer" });
    expect(touch).toHaveBeenCalledWith("icr_1", NOW);
  });

  it("does not fall back to a valid cookie when a bearer is invalid", async () => {
    const cookie = await buildSessionCookie("act_cookie", {
      secret: SECRET,
      ttlMs: 3600_000,
      now: Date.parse(NOW),
    });
    const result = await resolveAccount(
      new Request("https://mediaryconnect.app/api/account", {
        headers: { authorization: "Bearer ic_unknown", cookie },
      }),
      {
        db: {
          getActiveInstanceCredentialBySha: vi.fn(async () => null),
          touchInstanceCredential: vi.fn(async () => {}),
        },
        sessionSecret: SECRET,
        now: () => NOW,
      } as never,
    );
    expect(result).toEqual({ ok: false });
  });

  it("falls back to the signed session cookie only when no authorization header exists", async () => {
    const cookie = await buildSessionCookie("act_cookie", {
      secret: SECRET,
      ttlMs: 3600_000,
      now: Date.parse(NOW),
    });
    const result = await resolveAccount(
      new Request("https://mediaryconnect.app/api/account", { headers: { cookie } }),
      {
        db: {
          getActiveInstanceCredentialBySha: vi.fn(async () => null),
          touchInstanceCredential: vi.fn(async () => {}),
        },
        sessionSecret: SECRET,
        now: () => NOW,
      } as never,
    );
    expect(result).toEqual({ ok: true, accountId: "act_cookie", via: "cookie" });
  });

  it("ignores touch failures after authenticating a bearer", async () => {
    const result = await resolveAccount(
      new Request("https://mediaryconnect.app/api/account", {
        headers: { authorization: `Bearer ${CREDENTIAL}` },
      }),
      {
        db: {
          getActiveInstanceCredentialBySha: vi.fn(async () => ({
            id: "icr_1",
            account_id: "act_1",
            credential_sha256: "sha",
            link_request_id: "ilr_1",
            created_at: NOW,
            last_used_at: null,
            revoked_at: null,
          })),
          touchInstanceCredential: vi.fn(async () => {
            throw new Error("database unavailable");
          }),
        },
        sessionSecret: SECRET,
        now: () => NOW,
      } as never,
    );
    expect(result).toEqual({ ok: true, accountId: "act_1", via: "bearer" });
  });
});
