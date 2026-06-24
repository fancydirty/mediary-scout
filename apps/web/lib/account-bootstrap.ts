import type { Account } from "@media-track/workflow";

const DEFAULT_ACCOUNT_ID = "acct_default";

/** No account has set a password yet → the instance is unclaimed. */
function noneClaimed(accounts: Account[]): boolean {
  return accounts.every((a) => a.passwordHash === "");
}

/**
 * First registration on an unclaimed instance ADOPTS the seeded acct_default
 * (keeps its existing library + drives); otherwise create a fresh account. The
 * same path serves a brand-new empty install (adopt the empty default) and an
 * existing single-user instance (adopt the populated default).
 */
export function resolveRegistration(accounts: Account[]): { kind: "adopt-default" } | { kind: "create-new" } {
  const def = accounts.find((a) => a.id === DEFAULT_ACCOUNT_ID);
  if (noneClaimed(accounts) && def && def.passwordHash === "") {
    return { kind: "adopt-default" };
  }
  return { kind: "create-new" };
}

/**
 * Drives the /login claim screen. `needsClaim` = nobody has claimed the instance
 * yet; `hasExistingLibrary` = the default account already owns tracked data (so the
 * claim copy says "接管" rather than "创建").
 */
export function deriveBootstrapState(
  accounts: Account[],
  libraryItemCount: number,
): { needsClaim: boolean; hasExistingLibrary: boolean } {
  return { needsClaim: noneClaimed(accounts), hasExistingLibrary: libraryItemCount > 0 };
}

/** Only the owner may manage other accounts (reset passwords, view the panel). */
export function canManageAccounts(account: Account | null): boolean {
  return Boolean(account?.isOwner);
}
