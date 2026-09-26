"use client";

import { useState, useTransition } from "react";
import { LoaderCircle } from "lucide-react";
import { savePatrolConcurrencyAction } from "../app/actions";
import { runAction } from "../lib/run-action";

/**
 * 巡检同时处理几部作品。和时间点 chips 一样即改即存，失败回滚；范围由服务端
 * action 再校验一遍。
 */
export function PatrolConcurrencyForm({ initial, max }: { initial: number; max: number }) {
  const [value, setValue] = useState(initial);
  const [isPending, startTransition] = useTransition();
  const [note, setNote] = useState<string | null>(null);

  const flash = (text: string) => {
    setNote(text);
    setTimeout(() => setNote(null), 3000);
  };

  const change = (next: number) => {
    if (next === value) return;
    const previous = value;
    setValue(next);
    startTransition(async () => {
      const r = await runAction(
        () => savePatrolConcurrencyAction(next),
        (msg) => {
          setValue(previous);
          flash(`❌ ${msg}`);
        },
      );
      if (!r.ok) return;
      if (!r.value.success) {
        setValue(previous);
        flash(`❌ ${r.value.message}`);
        return;
      }
      flash("✅ 已保存");
    });
  };

  return (
    <div className="push-form" style={{ marginTop: 16 }}>
      <div className="setting-row">
        <label htmlFor="patrol-concurrency" className="push-help">
          同时巡检
        </label>
        <select
          id="patrol-concurrency"
          className="setting-control"
          style={{ width: 160 }}
          value={value}
          disabled={isPending}
          onChange={(event) => change(Number(event.target.value))}
        >
          {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>
              {n === 1 ? "1 部（默认）" : `最多 ${n} 部`}
            </option>
          ))}
        </select>
        {isPending ? <LoaderCircle size={14} className="spin" aria-hidden /> : null}
      </div>
      <p className="panel-note" style={{ marginTop: 10 }}>
        放在不同网盘上的作品才会一起跑；同一块网盘上的仍是一部接一部，免得触发网盘风控。调高后 AI 模型也会同时收到多路请求，免费模型容易撞到限额。
      </p>
      {note ? (
        <p className="panel-note" style={{ marginTop: 6 }}>
          {note}
        </p>
      ) : null}
    </div>
  );
}
