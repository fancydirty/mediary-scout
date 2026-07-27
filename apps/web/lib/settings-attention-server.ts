import {
  getStorageBrand,
  isRegisteredStorageProvider,
  resolveWorkspaceFromParam,
  type WorkflowRepository,
} from "@media-track/workflow";
import { isDemoMode } from "./demo-mode";
import { loadDeploymentUpdateState } from "./deployment-update-server";
import { DEFAULT_LOCAL_ORIGIN } from "./request-origin";
import {
  ATTENTION_DISMISSED_KEY,
  ATTENTION_SEEN_AT_KEY,
  ATTENTION_STATE_SINCE_KEY,
  applySettingsAttentionState,
  buildSettingsAttentionItems,
  parseAttentionTimeMap,
  type SettingsAttentionSummary,
} from "./settings-attention";
import {
  getAccountScopedSettings,
  getCurrentAccountId,
  getLlmConfig,
  getWorkflowRepository,
  isMultiUserEnabled,
  UNAUTHENTICATED_ACCOUNT_ID,
} from "./workflow-runtime";

function brandLabel(provider: string): string {
  try {
    return getStorageBrand(provider).label;
  } catch {
    return provider;
  }
}

/** update_available is an instance-level signal (BUILD_COMMIT vs remote main):
 *  multi-user shows it to the owner only; single-user is the implicit owner. */
async function resolveIsOwner(accountId: string): Promise<boolean> {
  if (!isMultiUserEnabled()) return true;
  const account = await getWorkflowRepository().getAccountById(accountId);
  return account?.isOwner ?? false;
}

/** Attention bookkeeping is per-account ONLY — read via getAccountSetting
 *  directly, never the global-fallback scoped settings. */
async function loadAttentionState(
  repository: WorkflowRepository,
  accountId: string,
): Promise<{ seenAt: string | null; dismissed: Record<string, string>; stateSince: Record<string, string> }> {
  const [seenRaw, dismissedRaw, stateSinceRaw] = await Promise.all([
    repository.getAccountSetting(accountId, ATTENTION_SEEN_AT_KEY),
    repository.getAccountSetting(accountId, ATTENTION_DISMISSED_KEY),
    repository.getAccountSetting(accountId, ATTENTION_STATE_SINCE_KEY),
  ]);
  const seenAt = seenRaw && Number.isFinite(Date.parse(seenRaw)) ? seenRaw : null;
  return {
    seenAt,
    dismissed: parseAttentionTimeMap(dismissedRaw),
    stateSince: parseAttentionTimeMap(stateSinceRaw),
  };
}

const MAX_DISMISSALS = 100;

/** Account-scoped attention items for Settings badge + Action Inbox.
 *  Resolves account + drives once; optional `w` preserves workspace on deep-links.
 *  `origin` (public request origin) is baked into the update prompt. */
export async function loadSettingsAttentionSummary(options?: {
  w?: string | null;
  origin?: string;
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

  const [llm, update, isOwner] = await Promise.all([
    getLlmConfig(getAccountScopedSettings(accountId)),
    loadDeploymentUpdateState(),
    resolveIsOwner(accountId),
  ]);

  const items = buildSettingsAttentionItems({
    demo: false,
    isOwner,
    drives: drives.map((drive) => ({
      id: drive.id,
      provider: drive.provider,
      label: drive.label,
      status: drive.status,
    })),
    brandLabel,
    llmConfigured: Boolean(llm.baseURL && llm.modelId),
    update,
    origin: options?.origin ?? DEFAULT_LOCAL_ORIGIN,
    ...(workspace.activeStorageId ? { activeStorageId: workspace.activeStorageId } : {}),
  });

  // The unauthenticated sentinel must never grow account_settings rows.
  const tracked = accountId !== UNAUTHENTICATED_ACCOUNT_ID;
  const state = tracked
    ? await loadAttentionState(repository, accountId)
    : { seenAt: null, dismissed: {}, stateSince: {} };
  const resolved = applySettingsAttentionState({
    items,
    ...state,
    now: new Date().toISOString(),
  });
  if (tracked && resolved.stateSinceChanged) {
    try {
      await repository.setAccountSetting(
        accountId,
        ATTENTION_STATE_SINCE_KEY,
        JSON.stringify(resolved.nextStateSince),
      );
    } catch {
      // Badge poll must not die on a write hiccup; next read re-derives.
    }
  }
  return { count: resolved.count, severity: resolved.severity, items: resolved.items };
}

/** The user opened Settings: badge counts only items created AFTER this call.
 *  Called by the settings page section AFTER loadSettingsAttentionSummary, so
 *  anything first sighted during THAT render gets createdAt <= seen_at and can
 *  never badge the page it was already shown on. */
export async function markSettingsAttentionSeen(
  now: string = new Date().toISOString(),
): Promise<void> {
  if (isDemoMode()) return;
  const accountId = await getCurrentAccountId();
  if (accountId === UNAUTHENTICATED_ACCOUNT_ID) return;
  try {
    await getWorkflowRepository().setAccountSetting(accountId, ATTENTION_SEEN_AT_KEY, now);
  } catch {
    // Best-effort: a lost write just means the badge survives one more sweep.
  }
}

/** Per-item dismiss with memory. Records the dismissal time; read-time filtering
 *  (applySettingsAttentionState) makes it apply only to the current occurrence. */
export async function dismissSettingsAttentionItem(
  accountId: string,
  id: string,
  now: string = new Date().toISOString(),
): Promise<void> {
  const repository = getWorkflowRepository();
  const dismissed = parseAttentionTimeMap(
    await repository.getAccountSetting(accountId, ATTENTION_DISMISSED_KEY),
  );
  dismissed[id] = now;
  // Bound growth: keep the most recent MAX_DISMISSALS entries.
  // 按数值时间戳排序：parseAttentionTimeMap 允许带时区偏移的合法 ISO 串，
  // 字典序会把「字符串大但实际更早」的条目误判成最新而留下它、丢掉真正最新的。
  const bounded = Object.fromEntries(
    Object.entries(dismissed)
      .sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]))
      .slice(0, MAX_DISMISSALS),
  );
  await repository.setAccountSetting(
    accountId,
    ATTENTION_DISMISSED_KEY,
    JSON.stringify(bounded),
  );
}
