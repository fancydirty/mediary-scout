import { isMultiUserEnabled, getCurrentAccountSummary } from "../lib/workflow-runtime";
import { AccountIdentity } from "./account-identity";

/**
 * Async server loader for the sidebar identity block. Renders nothing in single-user
 * mode (no login) or when there's no valid session. Mounted inside <Suspense> so its
 * DB read never blocks the static sidebar shell (mirrors WorkspaceSwitcherLoader).
 */
export async function AccountIdentityLoader() {
  if (!isMultiUserEnabled()) return null;
  const summary = await getCurrentAccountSummary();
  if (!summary) return null;
  return <AccountIdentity username={summary.username} isOwner={summary.isOwner} />;
}
