"use client";

import { useState, useTransition } from "react";
import { Check, LoaderCircle } from "lucide-react";
import { savePreferredLanguageAction } from "../app/actions";
import { runAction } from "../lib/run-action";

const LANGUAGES = [
  { key: "中文", label: "中文（默认）" },
  { key: "English", label: "English" },
  { key: "日本語", label: "日本語" },
  { key: "any", label: "不限（最大化覆盖）" },
] as const;

export function PreferredLanguageForm({ initial }: { initial: string }) {
  const [isPending, startTransition] = useTransition();
  const [value, setValue] = useState(initial || "中文");
  const [result, setResult] = useState<string | null>(null);

  const handleSave = () => {
    startTransition(async () => {
      // 必须 catch:server action 会 throw(demo 门禁、运行时错误、网络中断),
      // 不 catch 就是未处理 rejection,界面上什么都不变(见 runAction 注释)。
      // 业务错误(success:false)仍走下方原逻辑;这里只拦异常。
      const r = await runAction(
        () => savePreferredLanguageAction(value),
        (msg) => {
          setResult(`❌ ${msg}`);
          setTimeout(() => setResult(null), 3000);
        },
      );
      if (!r.ok) return;
      const res = r.value;
      setResult(res.success ? "✅ 保存成功" : `❌ ${res.message}`);
      setTimeout(() => setResult(null), 3000);
    });
  };

  return (
    <div className="push-form">
      <p className="panel-note" style={{ marginBottom: 12 }}>
        资源用什么语言起名，就更可能带那个语言的字幕。设置后会作为上下文传给 AI，让它优先搜你能看的语言的资源。
      </p>
      <div className="setting-row">
        <select
          value={value}
          onChange={(event) => setValue(event.target.value)}
          className="setting-control"
          aria-label="偏好语言"
        >
          {LANGUAGES.map((lang) => (
            <option key={lang.key} value={lang.key}>
              {lang.label}
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
