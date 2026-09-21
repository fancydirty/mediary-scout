"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, LoaderCircle, Trash2 } from "lucide-react";
import { saveTmdbApiKeyAction, clearTmdbApiKeyAction } from "../app/actions";
import { runAction } from "../lib/run-action";

export function TmdbApiKeyForm({ apiKeySet }: { apiKeySet: boolean }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [apiKey, setApiKey] = useState("");
  const [hasKey, setHasKey] = useState(apiKeySet);
  const [result, setResult] = useState<string | null>(null);

  const handleSave = () => {
    startTransition(async () => {
      // 必须 catch:server action 会 throw(demo 门禁、运行时错误、网络中断),
      // 不 catch 就是未处理 rejection,界面上什么都不变(见 runAction 注释)。
      // 业务错误(success:false)仍走下方原逻辑;这里只拦异常。
      const r = await runAction(
        () => saveTmdbApiKeyAction(apiKey),
        (msg) => {
          setResult(`❌ ${msg}`);
          setTimeout(() => setResult(null), 3000);
        },
      );
      if (!r.ok) return;
      const res = r.value;
      setResult(res.success ? "✅ 保存成功" : `❌ ${res.message ?? "保存失败"}`);
      if (res.success && apiKey.trim()) {
        setApiKey("");
        setHasKey(true);
      }
      if (res.success) router.refresh();
      setTimeout(() => setResult(null), 3000);
    });
  };

  const handleClear = () => {
    startTransition(async () => {
      // 必须 catch:server action 会 throw(demo 门禁、运行时错误、网络中断),
      // 不 catch 就是未处理 rejection,界面上什么都不变(见 runAction 注释)。
      // 业务错误(success:false)仍走下方原逻辑;这里只拦异常。
      const r = await runAction(
        () => clearTmdbApiKeyAction(),
        (msg) => {
          setResult(`❌ ${msg}`);
          setTimeout(() => setResult(null), 3000);
        },
      );
      if (!r.ok) return;
      const res = r.value;
      setResult(res.success ? "✅ 已清除，改用代理兜底" : `❌ ${res.message ?? "清除失败"}`);
      if (res.success) {
        setHasKey(false);
        router.refresh();
      }
      setTimeout(() => setResult(null), 3000);
    });
  };

  return (
    <div className="push-form">
      <div className="setting-row">
        <input
          type="password"
          className="setting-control"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={hasKey ? "已设置(留空不改)" : "TMDB API Read Token（eyJhbGciOi…）"}
          aria-label="TMDB API Key"
          autoComplete="off"
        />
        <button type="button" className="primary-button" onClick={handleSave} disabled={isPending}>
          {isPending ? <LoaderCircle size={14} className="spin" aria-hidden /> : <Check size={14} aria-hidden />}
          保存
        </button>
        {hasKey ? (
          <button type="button" className="secondary-button" onClick={handleClear} disabled={isPending}>
            <Trash2 size={14} aria-hidden />
            清除
          </button>
        ) : null}
      </div>
      {result ? (
        <p className="panel-note" style={{ marginTop: 10 }}>
          {result}
        </p>
      ) : null}
    </div>
  );
}
