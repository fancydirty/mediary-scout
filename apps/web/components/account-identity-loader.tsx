import { connection } from "next/server";
import { isMultiUserEnabled, getCurrentAccountSummary } from "../lib/workflow-runtime";
import { AccountIdentity } from "./account-identity";

/**
 * Async server loader for the sidebar identity block. Renders nothing in single-user
 * mode (no login) or when there's no valid session. Mounted inside <Suspense> so its
 * DB read never blocks the static sidebar shell (mirrors WorkspaceSwitcherLoader).
 *
 * `connection()` FIRST so cacheComponents evaluates this per-request, not at build
 * time — otherwise it'd be prerendered while multi-user is off, baked as null, and the
 * identity block would never appear in production even with multi-user on.
 */
export async function AccountIdentityLoader() {
  await connection();
  if (!isMultiUserEnabled()) return null;
  const summary = await getCurrentAccountSummary();
  if (!summary) return null;
  return <AccountIdentity username={summary.username} isOwner={summary.isOwner} />;
}
