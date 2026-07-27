"use client";

import { useState } from "react";

/**
 * 条目级删除按钮（client）。成功后从 DOM 移除所在行——badge 每 8s 自轮询，
 * 不需要手动同步。删除是「记住」的：版本类条目等远端再更新时自然复现，
 * 状态类条目（盘失效/缺 LLM）等状态变化后自动重置（见 settings-attention.ts）。
 */
export function DismissAttentionButton({ id }: { id: string }) {
  const [pending, setPending] = useState(false);
  const dismiss = async () => {
    if (pending) return;
    setPending(true);
    try {
      const res = await fetch("/api/settings/attention/dismiss", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) {
        setPending(false);
        return;
      }
      // 服务端已记住删除；本地把这一行拿掉即可，下次刷新也不再来。
      const btn = document.querySelector(`[data-dismiss-id="${CSS.escape(id)}"]`);
      btn?.closest(".attention-item")?.remove();
      // 若这是最后一条，把整个 inbox 收掉（空态=安静，与非站主同款机制）。
      document.querySelectorAll(".attention-inbox-list .attention-item").length === 0 &&
        document.querySelector(".attention-inbox")?.remove();
    } catch {
      setPending(false);
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
