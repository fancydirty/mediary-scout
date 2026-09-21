"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, LoaderCircle, Trash2 } from "lucide-react";
import { saveProwlarrConfigAction, clearProwlarrConfigAction } from "../app/actions";
import { runAction } from "../lib/run-action";

export function ProwlarrConfigForm({ baseURL: initialBaseURL, apiKeySet }: { baseURL: string; apiKeySet: boolean }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [baseURL, setBaseURL] = useState(initialBaseURL);
  const [apiKey, setApiKey] = useState("");
  const [hasKey, setHasKey] = useState(apiKeySet);
  const [result, setResult] = useState<string | null>(null);

  const handleSave = () => {
    startTransition(async () => {
      // 必须 catch:server action 会 throw(demo 门禁、运行时错误、网络中断),
      // 不 catch 就是未处理 rejection,界面上什么都不变(见 runAction 注释)。
      // 业务错误(success:false)仍走下方原逻辑;这里只拦异常。
      const r = await runAction(
        () => saveProwlarrConfigAction({ baseURL, apiKey }),
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
        () => clearProwlarrConfigAction(),
        (msg) => {
          setResult(`❌ ${msg}`);
          setTimeout(() => setResult(null), 3000);
        },
      );
      if (!r.ok) return;
      const res = r.value;
      setResult(res.success ? "✅ 已清除" : `❌ ${res.message ?? "清除失败"}`);
      if (res.success) {
        setHasKey(false);
        setBaseURL("");
        router.refresh();
      }
      setTimeout(() => setResult(null), 3000);
    });
  };

  return (
    <div className="push-form">
      <div className="push-field">
        <label className="push-label">Base URL（Prowlarr 实例地址）</label>
        <input
          type="text"
          className="setting-control"
          value={baseURL}
          onChange={(event) => setBaseURL(event.target.value)}
          placeholder="形如 http://192.168.x.x:9696"
          aria-label="Prowlarr Base URL"
        />
      </div>
      <div className="push-field">
        <label className="push-label">API Key（Prowlarr 设置 → General 里获取）</label>
        <input
          type="password"
          className="setting-control"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={hasKey ? "已设置(留空不改)" : "粘贴 Prowlarr API Key"}
          aria-label="Prowlarr API Key"
          autoComplete="off"
        />
      </div>
      <div className="service-actions">
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
        {result ? <span className="panel-note">{result}</span> : null}
      </div>
    </div>
  );
}
