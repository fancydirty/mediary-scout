/**
 * server action 调用的统一异常边界。
 *
 * **为什么需要它**：`startTransition(async () => { const r = await someAction(); ... })`
 * 这个写法在本项目出现了 32 次，其中绝大多数没有 try/catch。而 server action
 * **会 throw**，来源至少三类：
 *
 * 1. demo 门禁 —— `assertNotDemo()` 抛 `DemoReadOnlyError`（actions.ts 里 31 处）
 * 2. Next.js 运行时错误 —— 序列化失败、action 找不到（部署不一致时常见）
 * 3. 网络中断 —— 用户点完就断网
 *
 * 不 catch 的后果不是"报错"，而是**界面上什么都不会发生**：promise rejection
 * 未处理，按钮从 pending 复位，没有任何提示。用户只会以为"点了没反应"，
 * 然后重复点击。这比明确报错更糟。
 */

/**
 * 为什么是 tagged union 而不是 `Promise<T | undefined>`。
 *
 * 因为 `T` 本身可以是 `undefined` —— 那些返回 `void` 的 action 一旦被包进
 * `T | undefined`，调用方的 `if (r === undefined) return;` 就**无法区分
 * 「成功但无返回值」和「抛错了」**。这是签名层面的歧义，不是用法问题，
 * 加注释也修不好，只能靠类型结构排除。
 */
export type RunActionOutcome<T> = { ok: true; value: T } | { ok: false };

/** 兜底文案。不回显异常内容 —— 可能含堆栈、内部路径、SQL 片段。 */
const FALLBACK_MESSAGE = "操作失败了。刷新页面后再试一次。";

/**
 * 跑一个 server action，把异常收敛成 `onError` 回调。
 *
 * ```ts
 * startTransition(async () => {
 *   const r = await runAction(() => saveThingAction(value), (m) => setResult({ ok: false, message: m }));
 *   if (!r.ok) return;          // ← 但先看下面这条警告
 *   setResult({ ok: true, message: r.value.message });
 * });
 * ```
 *
 * **⚠️ 失败时调用方通常还有状态机要复位。** 直接 `if (!r.ok) return;` 会吞掉
 * 本来在成功路径上做的收尾，例如：
 *
 * - `unbind-storage-button`：不复位 `confirming`，按钮永远停在「确认取消绑定」
 * - `patrol-now-button`：不跑 `router.refresh()`，也不清 note
 *
 * 这些不是可选的收尾，是**状态机复位**。每个调用点改造时要单独看一眼，
 * 该复位的放进 `onError` 或提前到 `finally` 语义的位置。
 *
 * @param fn 真正发起 action 的函数。用闭包传参，不在这里做参数转发 ——
 *           那样会把类型推导搞复杂，收益为零。
 * @param onError 拿到用户可读文案。**不会**收到异常对象，防止顺手回显。
 */
export async function runAction<T>(
  fn: () => Promise<T>,
  onError: (message: string) => void,
): Promise<RunActionOutcome<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch {
    // 刻意不传异常给 onError：一旦给了，早晚有人 `onError(String(e))`
    // 把内部细节回显到界面上。想排查问题看服务端日志。
    onError(FALLBACK_MESSAGE);
    return { ok: false };
  }
}
