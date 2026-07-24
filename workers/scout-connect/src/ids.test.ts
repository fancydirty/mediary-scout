import { describe, it, expect } from "vitest";
import { newId, newInviteCode } from "./ids.js";

describe("ids", () => {
  it("newId returns prefix underscore 16 hex chars", () => {
    for (const prefix of ["inv", "ep", "aud"] as const) {
      const id = newId(prefix);
      expect(id.startsWith(`${prefix}_`)).toBe(true);
      expect(id).toMatch(new RegExp(`^${prefix}_[0-9a-f]{16}$`));
    }
  });

  it("newInviteCode returns 40 hex chars", () => {
    expect(newInviteCode()).toMatch(/^[0-9a-f]{40}$/);
  });

  it("two calls differ", () => {
    expect(newId("inv")).not.toBe(newId("inv"));
    expect(newId("ep")).not.toBe(newId("ep"));
    expect(newId("aud")).not.toBe(newId("aud"));
    expect(newInviteCode()).not.toBe(newInviteCode());
  });
});
