/** 设置页盘卡的 uid 展示归一:手机号形打码中段(天翼 loginName 去 @ 后缀)、
 *  长随机串中段截断、短数字 id 原样。完整值放 title 悬停可见,展示层不泄手机号。 */
export function maskProviderUid(uid: string): string {
  const v = (uid ?? "").trim();
  if (!v) {
    return "";
  }
  const phone = /^(1\d{2})\d{4}(\d{4})(?:@.*)?$/.exec(v);
  if (phone) {
    return `${phone[1]}****${phone[2]}`;
  }
  if (v.length > 14) {
    return `${v.slice(0, 4)}…${v.slice(-4)}`;
  }
  return v;
}
