import { getStorageBrand } from "@media-track/workflow";
import { isDemoMode } from "./demo-mode";
import { loadDeploymentUpdateState } from "./deployment-update-server";
import {
  buildSettingsAttentionItems,
  summarizeSettingsAttention,
  type SettingsAttentionSummary,
} from "./settings-attention";
import {
  getAccountConnectedStorages,
  getAccountScopedSettings,
  getCurrentAccountId,
  getLlmConfig,
} from "./workflow-runtime";

function brandLabel(provider: string): string {
  try {
    return getStorageBrand(provider).label;
  } catch {
    return provider;
  }
}

/** Account-scoped attention items for Settings badge + Action Inbox. */
export async function loadSettingsAttentionSummary(): Promise<SettingsAttentionSummary> {
  if (isDemoMode()) {
    return { count: 0, severity: null, items: [] };
  }

  const accountId = await getCurrentAccountId();
  const [drives, llm, update] = await Promise.all([
    getAccountConnectedStorages(),
    getLlmConfig(getAccountScopedSettings(accountId)),
    loadDeploymentUpdateState(),
  ]);

  const items = buildSettingsAttentionItems({
    demo: false,
    drives: drives.map((drive) => ({
      id: drive.id,
      provider: drive.provider,
      label: drive.label,
      status: drive.status,
    })),
    brandLabel,
    llmConfigured: Boolean(llm.baseURL && llm.modelId),
    update,
  });
  return summarizeSettingsAttention(items);
}
