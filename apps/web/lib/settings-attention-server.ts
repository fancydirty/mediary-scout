import {
  getStorageBrand,
  isRegisteredStorageProvider,
  resolveWorkspaceFromParam,
} from "@media-track/workflow";
import { isDemoMode } from "./demo-mode";
import { loadDeploymentUpdateState } from "./deployment-update-server";
import {
  buildSettingsAttentionItems,
  summarizeSettingsAttention,
  type SettingsAttentionSummary,
} from "./settings-attention";
import {
  getAccountScopedSettings,
  getCurrentAccountId,
  getLlmConfig,
  getWorkflowRepository,
} from "./workflow-runtime";

function brandLabel(provider: string): string {
  try {
    return getStorageBrand(provider).label;
  } catch {
    return provider;
  }
}

/** Account-scoped attention items for Settings badge + Action Inbox.
 *  Resolves account + drives once; optional `w` preserves workspace on deep-links. */
export async function loadSettingsAttentionSummary(options?: {
  w?: string | null;
}): Promise<SettingsAttentionSummary> {
  if (isDemoMode()) {
    return { count: 0, severity: null, items: [] };
  }

  const accountId = await getCurrentAccountId();
  const repository = getWorkflowRepository();
  const drives = await repository.listConnectedStorages(accountId);
  const workspace = resolveWorkspaceFromParam(
    drives.filter((drive) => isRegisteredStorageProvider(drive.provider)),
    options?.w ?? undefined,
  );

  const [llm, update] = await Promise.all([
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
    ...(workspace.activeStorageId ? { activeStorageId: workspace.activeStorageId } : {}),
  });
  return summarizeSettingsAttention(items);
}
