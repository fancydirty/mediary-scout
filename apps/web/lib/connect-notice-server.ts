import { getWorkflowRepository, getCurrentAccountId, UNAUTHENTICATED_ACCOUNT_ID } from "./workflow-runtime";
import { resolveInstanceTunnelToken } from "./remote-access";
import { isDemoMode } from "./demo-mode";
import { resolveIsDesktop } from "./workflow-runtime";
import { CONNECT_NOTICE_DISMISSED_KEY, shouldShowConnectNotice } from "./connect-notice";
import type { ConnectNoticeConditions } from "./connect-notice";

/**
 * Server-side: 读取 DB 并组装 Connect 通知的出现条件。
 * 
 * 调用路径：`app/page.tsx` 内的 Suspense 包裹组件。
 */
export async function resolveConnectNoticeConditions(): Promise<ConnectNoticeConditions> {
  const repository = getWorkflowRepository();
  const accountId = await getCurrentAccountId();

  // 未登录（acct_unauthenticated）→ 不读 settings
  let dismissedAt: string | null = null;
  if (accountId !== UNAUTHENTICATED_ACCOUNT_ID) {
    dismissedAt = await repository.getAccountSetting(accountId, CONNECT_NOTICE_DISMISSED_KEY);
  }

  const hasTunnelToken = (await resolveInstanceTunnelToken()) !== undefined;

  return {
    isDemo: isDemoMode(),
    // 桌面版没有远程访问功能(自托管才有) —— 横幅、设置入口一律不出现。
    isDesktop: resolveIsDesktop(),
    // 未登录时 accountId 应为 null，而不是哨兵值 —— shouldShowConnectNotice 期望
    // 已登录用户返回 true，null 返回 false。
    accountId: accountId === UNAUTHENTICATED_ACCOUNT_ID ? null : accountId,
    dismissedAt,
    hasTunnelToken,
  };
}

/**
 * 判断是否应该显示通知（server-side 入口）。
 */
export async function shouldShowConnectNoticeSsr(): Promise<boolean> {
  const conditions = await resolveConnectNoticeConditions();
  return shouldShowConnectNotice(conditions);
}
