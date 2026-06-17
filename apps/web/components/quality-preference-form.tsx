"use client";

import { useState, useTransition } from "react";
import { Check, LoaderCircle } from "lucide-react";
import { saveQualityPreferenceAction } from "../app/actions";

const QUALITIES = [
  { key: "any", label: "不限（默认）" },
  { key: "high", label: "高画质（≈4K）" },
  { key: "medium", label: "中画质（≈1080p）" },
] as const;

export function QualityPreferenceForm({ initial }: { initial: string }) {
  const [isPending, startTransition] = useTransition();
  const [value, setValue] = useState(initial || "any");
  const [result, setResult] = useState<string | null>(null);

  const handleSave = () => {
    startTransition(async () => {
      const res = await saveQualityPreferenceAction(value);
      setResult(res.success ? "✅ 保存成功" : `❌ ${res.message ?? "保存失败"}`);
      setTimeout(() => setResult(null), 3000);
    });
  };

  return (
    <div className="push-form">
      <p className="panel-note" style={{ marginBottom: 12 }}>
        偏好的画质档位会作为「召回后选片优先级」传给 AI；找不到目标画质时仍优先保证入库完整（覆盖优先）。画质不进搜索关键词。
      </p>
      <div className="setting-row">
        <select
          value={value}
          onChange={(event) => setValue(event.target.value)}
          className="setting-control"
          aria-label="偏好画质"
        >
          {QUALITIES.map((quality) => (
            <option key={quality.key} value={quality.key}>
              {quality.label}
            </option>
          ))}
        </select>
        <button type="button" className="primary-button" onClick={handleSave} disabled={isPending}>
          {isPending ? <LoaderCircle size={14} className="spin" aria-hidden /> : <Check size={14} aria-hidden />}
          保存
        </button>
      </div>
      {result ? (
        <p className="panel-note" style={{ marginTop: 10 }}>
          {result}
        </p>
      ) : null}
    </div>
  );
}
