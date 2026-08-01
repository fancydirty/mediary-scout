"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle, Radar } from "lucide-react";
import { runPatrolNowAction } from "../app/actions";
import { runAction } from "../lib/run-action";

/** 手动触发一次全量巡检（force：不占用定时计划）。 */
export function PatrolNowButton() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [note, setNote] = useState<string | null>(null);

  const run = () => {
    startTransition(async () => {
      // 必须 catch(见 runAction 注释)。router.refresh 与清 note 在失败时
      // 也要执行 —— 否则抛错后界面既不刷新也不清提示(spec B 点名的陷阱)。
      const r = await runAction(
        () => runPatrolNowAction(),
        (msg) => {
          setNote(`❌ ${msg}`);
          router.refresh();
          setTimeout(() => setNote(null), 6000);
        },
      );
      if (!r.ok) return;
      const res = r.value;
      setNote(res.success ? `✅ 巡检完成，检查了 ${res.checked ?? 0} 项` : `❌ ${res.message}`);
      router.refresh();
      setTimeout(() => setNote(null), 6000);
    });
  };

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
      <button type="button" className="primary-button" onClick={run} disabled={isPending}>
        {isPending ? <LoaderCircle size={14} className="spin" aria-hidden /> : <Radar size={14} aria-hidden />}
        {isPending ? "巡检中…" : "立即巡检"}
      </button>
      <span className="push-help">手动巡检不占用定时计划</span>
      {note ? <span className="push-help">{note}</span> : null}
    </span>
  );
}
