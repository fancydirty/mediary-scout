"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * 条目级删除按钮（client）。成功后走 router.refresh() 让服务端重渲染 inbox——
 * 直接 querySelector().remove() 会把 DOM 改到 React 树之外，下一次 re-render
 * 会把删掉的行又画回来（且空态收尾也得手工模拟）。
 * 删除是「记住」的：版本类条目等远端再更新时自然复现，状态类条目（盘失效/
 * 缺 LLM）等状态变化后自动重置（见 settings-attention.ts）。
 */
export function DismissAttentionButton({ id }: { id: string }) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  // refresh 期间也保持禁用，避免同一条被连点两次。
  const pending = saving || refreshing;

  const dismiss = async () => {
    if (pending) return;
    setSaving(true);
    try {
      const res = await fetch("/api/settings/attention/dismiss", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
      // 失败（含网络异常）不刷新，按钮恢复可点，用户可重试。
      if (!res.ok) return;
      // 服务端已记住删除；重渲染后这一条不再出现，最后一条删完 inbox 整体消失。
      startRefresh(() => {
        router.refresh();
      });
    } catch {
      // keep retryable
    } finally {
      setSaving(false);
    }
  };

  return (
    <button
      type="button"
      className="attention-item-dismiss"
      data-dismiss-id={id}
      onClick={() => void dismiss()}
      disabled={pending}
      aria-label="删除此条提醒"
      title="删除此条"
    >
      ✕
    </button>
  );
}
