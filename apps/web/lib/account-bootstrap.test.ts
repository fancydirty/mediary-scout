import { describe, expect, it } from "vitest";
import type { Account } from "@media-track/workflow";
import { resolveRegistration, deriveBootstrapState, canManageAccounts } from "./account-bootstrap";

const DEFAULT = "acct_default";
function acct(over: Partial<Account>): Account {
  return { id: "x", username: "u", passwordHash: "h", groupId: null, isOwner: false, createdAt: "t", ...over };
}
const unclaimedDefault = acct({ id: DEFAULT, username: "default", passwordHash: "", isOwner: true });

describe("resolveRegistration", () => {
  it("adopt-default when only the unclaimed acct_default exists", () => {
    expect(resolveRegistration([unclaimedDefault])).toEqual({ kind: "adopt-default" });
  });
  it("create-new once acct_default is claimed (has a hash)", () => {
    expect(resolveRegistration([acct({ id: DEFAULT, passwordHash: "scrypt:x:y", isOwner: true })])).toEqual({
      kind: "create-new",
    });
  });
  it("create-new when another claimed account already exists", () => {
    expect(resolveRegistration([unclaimedDefault, acct({ id: "a", passwordHash: "scrypt:1:2" })])).toEqual({
      kind: "create-new",
    });
  });
});

describe("deriveBootstrapState", () => {
  it("needsClaim + no library (fresh empty instance)", () => {
    expect(deriveBootstrapState([unclaimedDefault], 0)).toEqual({ needsClaim: true, hasExistingLibrary: false });
  });
  it("needsClaim + existing library (existing single-user data)", () => {
    expect(deriveBootstrapState([unclaimedDefault], 7)).toEqual({ needsClaim: true, hasExistingLibrary: true });
  });
  it("not needsClaim once someone has a password", () => {
    expect(deriveBootstrapState([acct({ id: DEFAULT, passwordHash: "scrypt:x:y" })], 7).needsClaim).toBe(false);
  });
});

describe("canManageAccounts", () => {
  it("only the owner", () => {
    expect(canManageAccounts(acct({ isOwner: true }))).toBe(true);
    expect(canManageAccounts(acct({ isOwner: false }))).toBe(false);
    expect(canManageAccounts(null)).toBe(false);
  });
});
