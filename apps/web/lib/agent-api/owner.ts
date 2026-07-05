import { getWorkflowRepository } from "../workflow-runtime";

/**
 * The agent API operates on the OWNER account (v1: single-agent-principal).
 * Single-user instances: the seeded default account is the owner. Multi-user:
 * the account flagged is_owner (the first registrant / instance claimer).
 */
export async function getOwnerAccountId(): Promise<string> {
  const accounts = await getWorkflowRepository().listAccounts();
  const owner = accounts.find((account) => account.isOwner);
  if (!owner) {
    throw new Error("No owner account found — instance not initialized");
  }
  return owner.id;
}
