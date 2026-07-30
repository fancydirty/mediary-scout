/**
 * slug 输入净化与实时校验(客户端与服务端共享的纯函数)。
 *
 * 为什么放纯函数:这块逻辑最容易在「显示的值」与「校验的值」之间漂移
 * (原实现就有:输入框显示 `Alice` 却提示「✓ 可用」,实际开通的是 `alice`)。
 * 净化规则必须与 `assertSlug` 的最终裁决**完全一致** —— 前端净化只是
 * 提前给用户看,服务端的 assertSlug 才是权威。
 */

export const SLUG_MAX_LENGTH = 32;

/** 允许的字符:小写字母、数字、连字符。 */
const ALLOWED_RE = /^[a-z0-9-]*$/;

/**
 * 把任意输入净化成「候选 slug」。
 *
 * 规则(与 assertSlug 对齐,但只负责**净化**不负责**判可用**):
 * - 转小写(iOS 默认首字母大写,这是最常见的来源)
 * - 去掉不在允许集里的字符(空格、下划线、点、全角…)
 * - 连续连字符合成一个
 * - 去掉首尾连字符
 *
 * **刻意不在输入过程中弹错**:用户边打边看效果,不打断输入流。
 * 净化后的结果交给 slugIssues 判「还差什么」。
 */
export function sanitizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    // **字母数字之间的非法序列转成单个连字符,而不是删掉。**
    // 「my_nas」「my nas」「my.nas」的用户意图是分隔(想要 my-nas),
    // 直接删会粘连成 mynas —— 与原实现「显示 Alice 实际开通 alice」是
    // 同一类「显示值与结果值漂移」。开头的非法字符同样归一后,首尾再统一剥。
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX_LENGTH);
}

export type SlugIssue = "empty" | "too_short" | "edge_hyphen" | "too_long";

/**
 * 净化后的候选还差什么才能用。返回空数组 = 可直接用。
 *
 * 与 assertSlug 的错误一一对应,但用「还差什么」而非「哪里错了」的措辞
 * —— 用户在**完成**一个动作,不是在**犯**一个错。
 */
export function slugIssues(slug: string): SlugIssue[] {
  const issues: SlugIssue[] = [];
  if (slug.length === 0) issues.push("empty");
  // assertSlug 允许 1 个字符,但太短的名字没意义(且容易被抢注心态裹挟)。
  // 这里给个**提示性**的门槛,不是硬性拒绝 —— 见 ISSUE_TEXT,单字符仍放行。
  if (slug.length > 0 && slug.length < 3) issues.push("too_short");
  if (slug.length > SLUG_MAX_LENGTH) issues.push("too_long");
  // edge_hyphen 已被 sanitizeSlug 去掉,这里防御性保留(服务端若收到未净化值)。
  if (slug.startsWith("-") || slug.endsWith("-")) issues.push("edge_hyphen");
  return issues;
}

/** 逐条打勾的文案(zh)。 */
export const ISSUE_TEXT: Record<SlugIssue, string> = {
  empty: "输入一个名字",
  too_short: "至少 3 个字符",
  edge_hyphen: "不以连字符开头或结尾",
  too_long: `不超过 ${SLUG_MAX_LENGTH} 个字符`,
};

/** 判断规则是否满足(用于逐条打勾的 UI)。 */
export function isValidSlugChar(ch: string): boolean {
  return ALLOWED_RE.test(ch);
}
