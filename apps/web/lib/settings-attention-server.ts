import {
  getStorageBrand,
  isRegisteredStorageProvider,
  resolveWorkspaceFromParam,
  type WorkflowRepository,
} from "@media-track/workflow";
import { isDemoMode } from "./demo-mode";
import { loadUpdateView } from "./update-view-server";
import {
  ATTENTION_DISMISSED_KEY,
  ATTENTION_SEEN_AT_KEY,
  ATTENTION_STATE_SINCE_KEY,
  applySettingsAttentionState,
  buildSettingsAttentionItems,
  isAttentionItemId,
  parseAttentionTimeMap,
  type SettingsAttentionSummary,
} from "./settings-attention";
import {
  getAccountScopedSettings,
  getCurrentAccountId,
  getWorkflowRepository,
  isMultiUserEnabled,
  PANSOU_BASE_URL_SETTING_KEY,
  PANSOU_HEALTH_SETTING_KEY,
  resolveAgentModelConfig,
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
async function resolveIsOwner(
  repository: WorkflowRepository,
  accountId: string,
): Promise<boolean> {
  // 单用户下经隧道来的匿名访客只要带任意 mt_session cookie 就能过 proxy(它只查
  // 有无),getCurrentAccountId() 会把这样的请求解析成这个哨兵账号。哨兵绝不是站主——
  // 否则匿名访客就能读更新日志尾、点「立即更新」。必须在放行单用户之前先挡掉。
  if (accountId === UNAUTHENTICATED_ACCOUNT_ID) return false;
  if (!isMultiUserEnabled()) return true;
  const account = await repository.getAccountById(accountId);
  return account?.isOwner ?? false;
}

/** Owner check for the current request's account (single-user = implicit owner). */
export async function resolveCurrentIsOwner(): Promise<boolean> {
  const repository = getWorkflowRepository();
  return resolveIsOwner(repository, await getCurrentAccountId());
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

  // 「未配置 AI 模型」提醒的口径必须与获取链路一致：resolveAgentModelConfig
  // 会经 DB → env → 出厂免费预设（Kilo 免费池）回落，零配置出厂态下生效配置
  // 依然存在（baseURL/modelId 永远有值）——看原始 DB 配置（getLlmConfig）会把
  // 开箱即用的出厂态误报成「还没配置 AI 模型」。提醒只剩一个真语义：生效配置
  // 真的无法构造模型（半截配置：只有地址没模型名，回落分支不接这种用户错误）。
  const [llm, isOwner] = await Promise.all([
    resolveAgentModelConfig(getAccountScopedSettings(accountId)),
    resolveIsOwner(repository, accountId),
  ]);

  // 自建搜索源:**只读 DB,绝不探活**。这个函数在徽章轮询路径上(每 8s 一次),
  // 在这里打网络等于每 8s 捶一遍用户的 PanSou。健康态有两个写入方:保存时探活
  // 与每次真实搜索后的运行时回写(recordPanSouHealth)。这里只读结论。
  //
  // custom 只认 DB 设置(不含 env PANSOU_BASE_URL):env 配的源从不经过保存探活,
  // reachable 对它没有意义,拿一个从没被探过的源告警只会是假警报。
  const scopedSettings = getAccountScopedSettings(accountId);
  const [pansouBaseUrl, pansouHealth] = await Promise.all([
    scopedSettings.getSetting(PANSOU_BASE_URL_SETTING_KEY),
    scopedSettings.getSetting(PANSOU_HEALTH_SETTING_KEY),
  ]);
  // 判「是否配了自建源」要同时认 DB 与 env 注入:compose 用 PANSOU_BASE_URL 注入
  // 自带容器,DB 是空的 —— 只看 DB 会把 env-only 场景误判成未配置,于是
  // recordPanSouHealth 明明写了 unhealthy、徽章却永不亮(Copilot 评审)。
  // 健康结论本身就是「有一个源在跑」的证据,作为兜底信号。
  const customSearchSource = Boolean(pansouBaseUrl?.trim() || pansouHealth?.trim());
  // 没有结论时按「可达」处理:这条提醒只在有确凿失败证据时才响。宁可漏报也不
  // 能对着一个从没探过的源(老用户在本次改动之前保存的)天天报假警。
  const searchSourceReachable = (pansouHealth?.trim() ?? "") !== "" ? pansouHealth!.trim() === "ok" : true;
  // update_available 只对站主存在（见 buildSettingsAttentionItems 的 isOwner
  // 门控），所以非站主不该付这份代价。徽章每 8s 轮询：传 updaterStatus:false 跳过
  // 更新助手往返，只问发布视图有没有更新的发行版。桌面也算——loadUpdateView 在桌面
  // 走桌面发布源，有新安装包时同样给 available，徽章点进「更新」tab 下载。
  const view = isOwner ? await loadUpdateView({ updaterStatus: false }) : null;
  const availableUpdate = view?.available
    ? { tag: view.available.tag, commit: view.available.commit, currentLabel: view.current.label }
    : null;

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
    searchSource: { custom: customSearchSource, reachable: searchSourceReachable },
    availableUpdate,
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
  // 存储层自己把关，不指望调用方：路由现在会校验，但这个导出函数很容易被
  // 别处直接调用，届时任意键就会写进 account_settings。
  // 未认证哨兵绝不增行——与上面 markSettingsAttentionSeen 同一条不变式，
  // 这里此前漏了。
  if (accountId === UNAUTHENTICATED_ACCOUNT_ID) return;
  if (!isAttentionItemId(id)) return;
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
