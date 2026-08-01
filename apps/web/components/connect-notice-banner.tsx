"use client";

import { X } from "lucide-react";
import { useState, useTransition } from "react";
import { dismissConnectNoticeAction } from "../app/actions";
import { runAction } from "../lib/run-action";

export function ConnectNoticeBanner() {
  const [dismissed, setDismissed] = useState(false);
  const [isPending, startTransition] = useTransition();

  if (dismissed) return null;

  function handleDismiss() {
    startTransition(async () => {
      // 必须 catch(见 runAction 注释):dismiss 失败不能静默 ——
      // 否则用户以为关了,下次刷新又出现。
      const r = await runAction(
        () => dismissConnectNoticeAction(),
        () => setDismissed(true),  // 乐观关闭:写 DB 失败本次会话也隐藏
      );
      if (!r.ok) return;
      setDismissed(true);
    });
  }

  return (
    <div className="bg-gradient-to-r from-green-500/10 via-green-500/5 to-transparent border-b border-green-500/20">
      <div className="container mx-auto px-4 py-3 flex items-center justify-between gap-4">
        <div className="flex-1 flex items-center gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-green-500/20">
            <svg className="h-4 w-4 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground">
              🎉 付费远程访问现已上线！扫码即通 — 详见控制台
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <a
            href="/settings?tab=remote-access"
            className="text-sm font-medium text-green-600 hover:text-green-700 dark:text-green-400 dark:hover:text-green-300 transition-colors"
          >
            了解详情
          </a>
          <button
            onClick={handleDismiss}
            disabled={isPending}
            className="p-1 rounded-md hover:bg-accent transition-colors disabled:opacity-50"
            aria-label="关闭通知"
          >
            <X className="h-4 w-4 text-muted-foreground" />
          </button>
        </div>
      </div>
    </div>
  );
}
