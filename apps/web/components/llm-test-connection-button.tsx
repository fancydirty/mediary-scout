"use client";

import { useState, useTransition } from "react";
import { testLlmConnectionAction } from "../app/actions";
import { runAction } from "../lib/run-action";

/**
 * Settings → AI 模型 的「测试连接」:对**已保存**的 LLM 配置真发一发最小请求,通/
 * 不通当场显示。杜绝「存了错值却不自知、点获取才崩、反怪自己 key 错」的大误会。
 * 镜像网盘的 TestConnectionButton。先保存,再测试。
 */
export function LlmTestConnectionButton() {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <button
        type="button"
        className="ghost-button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const r = await runAction(
              () => testLlmConnectionAction(),
              (msg) => setResult({ ok: false, message: msg }),
            );
            if (!r.ok) return;
            setResult(r.value);
          })
        }
      >
        {pending ? "测试中…" : "测试连接"}
      </button>
      {result ? (
        <span className={`push-help ${result.ok ? "" : "tone-amber"}`}>{result.message}</span>
      ) : null}
    </span>
  );
}
