import type { TransferAttempt } from "../domain.js";

/**
 * Systemic transfer-block detection. A magnet must be materialized via 115 云下载/
 * 离线下载 (or a quark 转存) — if that is blocked at the ACCOUNT level (quota
 * exhausted, login expired, not-VIP) then EVERY candidate fails for the same
 * reason, even though the resources exist. Reporting that as "no_coverage / 暂未
 * 找到资源" blames the resource for an account problem (别甩锅). This classifier
 * distinguishes "account is blocked" from "these particular links are dead", so the
 * report can say "转存失败:配额不足" (actionable: top up / re-login) instead.
 *
 * Returns the block reason when: NOTHING landed (no succeeded attempt) AND at least
 * one failure carries a SYSTEMIC message (quota / auth / VIP). Dead-link messages
 * (过期/取消/错误的链接/不存在) are NOT systemic — they don't trigger a block.
 */
const SYSTEMIC_PATTERNS: RegExp[] = [
  /配额|额度|quota/i,
  /VIP|会员|升级/i,
  /云下载|离线/,
  /登录|重新登陆|未登录|登陆超时|登录超时/,
  /PAN115_AUTH|AUTH_FAILED|未授权|鉴权/i,
];

export function classifyTransferBlock(
  attempts: TransferAttempt[],
): { reason: string } | null {
  if (attempts.length === 0) {
    return null;
  }
  // Something landed → not a systemic block (the account can transfer).
  if (attempts.some((a) => a.status === "succeeded")) {
    return null;
  }
  for (const attempt of attempts) {
    // Only a genuine FAILED transfer signals a block — a no_target_change (115 has
    // no cached copy / nothing new) can carry an incidental message that must NOT
    // be misread as an account-level block.
    if (attempt.status !== "failed") {
      continue;
    }
    const message = attempt.providerMessage?.trim() ?? "";
    if (message && SYSTEMIC_PATTERNS.some((pattern) => pattern.test(message))) {
      return { reason: message };
    }
  }
  return null;
}
