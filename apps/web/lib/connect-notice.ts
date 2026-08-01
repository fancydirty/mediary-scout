/**
 * Connect notice — top banner on home page for users who haven't opened remote-access yet.
 * Pure logic, testable without DB.
 */

export const CONNECT_NOTICE_DISMISSED_KEY = "connect_notice_dismissed_at";

export interface ConnectNoticeConditions {
  isDemo: boolean;
  accountId: string | null;
  dismissedAt: string | null;
  hasTunnelToken: boolean;
}

/**
 * 判断是否显示 Connect 通知横幅。
 * 
 * 出现条件（必须全部满足）：
 * 1. 不是 demo 模式
 * 2. 已登录（有 accountId）
 * 3. 从未关闭过横幅（dismissedAt 为 null）
 * 4. 尚未开通远程访问（没有 tunnel token）
 */
export function shouldShowConnectNotice(
  conditions: ConnectNoticeConditions
): boolean {
  const { isDemo, accountId, dismissedAt, hasTunnelToken } = conditions;

  // 任一条件不满足就不显示
  if (isDemo) return false;
  if (!accountId) return false;
  if (dismissedAt !== null) return false;
  if (hasTunnelToken) return false;

  return true;
}
