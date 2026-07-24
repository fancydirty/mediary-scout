import { describe, it, expect } from "vitest";
import { requireAdmin } from "./auth.js";
import { HttpError } from "./http.js";

const TOKEN = "test-admin-token-fixture";

function req(authorization?: string): Request {
  const headers = new Headers();
  if (authorization !== undefined) {
    headers.set("authorization", authorization);
  }
  return new Request("https://mediaryconnect.app/api/admin/invites", { headers });
}

function expect401(fn: () => void): void {
  try {
    fn();
    expect.unreachable("expected HttpError(401)");
  } catch (e) {
    expect(e).toBeInstanceOf(HttpError);
    expect((e as HttpError).status).toBe(401);
    expect((e as HttpError).message).toBe("unauthorized");
  }
}

describe("requireAdmin", () => {
  it("accepts the exact Bearer token", () => {
    expect(() => requireAdmin(req(`Bearer ${TOKEN}`), TOKEN)).not.toThrow();
  });

  it("missing Authorization header → 401", () => {
    expect401(() => requireAdmin(req(), TOKEN));
  });

  it("wrong token (same length, exercises the full compare loop) → 401", () => {
    const wrong = `${TOKEN.slice(0, -1)}X`;
    expect401(() => requireAdmin(req(`Bearer ${wrong}`), TOKEN));
  });

  it("Basic scheme → 401", () => {
    expect401(() => requireAdmin(req(`Basic ${btoa("user:pass")}`), TOKEN));
  });

  it("different length → 401", () => {
    expect401(() => requireAdmin(req("Bearer short"), TOKEN));
  });
});
