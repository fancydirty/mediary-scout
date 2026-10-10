"use client";

import { useState, useTransition } from "react";
import { useRouter } from "../lib/use-router";
import { LoaderCircle } from "lucide-react";
import { restoreFreeLlmAction } from "../app/actions";
import { runAction } from "../lib/run-action";

/**
 * 主模型块标题行右侧的「换回免费模型」（ServiceBlock.headerAction，只在非免费档
 * 渲染）。一键把出厂预设写进本账号 settings 并 router.refresh()：胶囊、表单预填、
 * 折叠说明、按钮去留全由服务端渲染，刷新即整体切回出厂态（不动表单输入）。
 * 已存的 API Key 由 action 侧保留。
 */
export function RestoreFreeLlmButton() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const run = () => {
    startTransition(async () => {
      // 必须 catch（见 runAction 注释）：server action 会 throw（demo 门禁、运行时
      // 错误、断网），不 catch 就是未处理 rejection、界面什么都不变。
      const r = await runAction(
        () => restoreFreeLlmAction(),
        (msg) => setError(`❌ ${msg}`),
      );
      if (!r.ok) return;
      const res = r.value;
      if (!res.success) {
        setError(`❌ ${res.message ?? "换回失败"}`);
      } else {
        setError(null);
      }
      // 失败也要刷新复位（按钮不会卡在 pending；胶囊跟随服务端真相）。
      router.refresh();
      setTimeout(() => setError(null), 4000);
    });
  };

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <button type="button" className="restore-free-llm-button" onClick={run} disabled={isPending}>
        {isPending ? <LoaderCircle size={12} className="spin" aria-hidden /> : null}
        {isPending ? "换回中…" : "换回免费模型"}
      </button>
      {error ? <span className="panel-note">{error}</span> : null}
    </span>
  );
}
