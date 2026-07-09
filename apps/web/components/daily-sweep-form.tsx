"use client";

import { useState, useTransition } from "react";
import { LoaderCircle, Plus, X } from "lucide-react";
import { saveDailySweepTimesAction } from "../app/actions";

/**
 * 巡检时间点 chips（1~6 个，北京时间）。即改即存：添加/删除立即持久化整个列表，
 * 失败回滚。上限/去重/格式由服务端 action 再校验一遍。
 */
export function DailySweepForm({ initial, max }: { initial: string[]; max: number }) {
  const [times, setTimes] = useState(initial);
  const [draft, setDraft] = useState("12:00");
  const [isPending, startTransition] = useTransition();
  const [note, setNote] = useState<string | null>(null);

  const persist = (next: string[], previous: string[]) => {
    startTransition(async () => {
      const res = await saveDailySweepTimesAction(next);
      if (!res.success) {
        setTimes(previous);
        setNote(`❌ ${res.message}`);
      } else {
        setNote("✅ 已保存");
      }
      setTimeout(() => setNote(null), 3000);
    });
  };

  const apply = (next: string[]) => {
    const previous = times;
    setTimes(next);
    persist(next, previous);
  };

  const add = (value: string) => {
    const next = [...new Set([...times, value])].sort();
    if (next.length === times.length || next.length > max) return;
    apply(next);
  };

  const remove = (value: string) => {
    if (times.length <= 1) return;
    apply(times.filter((t) => t !== value));
  };

  return (
    <div className="push-form">
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {times.map((time) => (
          <span key={time} className="sweep-chip">
            {time}
            {times.length > 1 ? (
              <button
                type="button"
                className="sweep-chip-remove"
                aria-label={`删除 ${time}`}
                disabled={isPending}
                onClick={() => remove(time)}
              >
                <X size={12} aria-hidden />
              </button>
            ) : null}
          </span>
        ))}
        {times.length < max ? (
          <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
            <input
              type="time"
              className="setting-control"
              style={{ width: 120 }}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              aria-label="新增巡检时间"
            />
            <button type="button" className="primary-button" disabled={isPending} onClick={() => add(draft)}>
              {isPending ? <LoaderCircle size={14} className="spin" aria-hidden /> : <Plus size={14} aria-hidden />}
              添加时间
            </button>
          </span>
        ) : null}
        <button type="button" className="sweep-preset" disabled={isPending} onClick={() => apply(["06:00", "21:00"])}>
          预设：早晚各一次
        </button>
      </div>
      <p className="panel-note" style={{ marginTop: 10 }}>
        最多 {max} 个时间点（北京时间）。到点时应用未运行？下次启动会自动补跑一次。
      </p>
      {note ? (
        <p className="panel-note" style={{ marginTop: 6 }}>
          {note}
        </p>
      ) : null}
    </div>
  );
}
