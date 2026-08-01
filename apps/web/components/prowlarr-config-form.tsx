"use client";

import { useState, useTransition } from "react";
import { Check, ExternalLink, LoaderCircle, Trash2 } from "lucide-react";
import { saveProwlarrConfigAction, clearProwlarrConfigAction } from "../app/actions";
import { runAction } from "../lib/run-action";

export function ProwlarrConfigForm({ baseURL: initialBaseURL, apiKeySet }: { baseURL: string; apiKeySet: boolean }) {
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
      }
      setTimeout(() => setResult(null), 3000);
    });
  };

  return (
    <div className="push-form">
      <p className="panel-note" style={{ marginBottom: 6 }}>
        Prowlarr 是索引器聚合器：用它把你的公共/私有种子站统一成一个 API，agent 搜资源时会把 Prowlarr 的磁力和网盘搜索结果合并判断。磁力靠 115 秒传（哈希匹配）瞬时转存。不填则只用内置网盘搜索。留空 API Key 不改动已保存的值。
      </p>
      <p className="push-help" style={{ marginBottom: 12 }}>
        了解 Prowlarr{" "}
        <a href="https://prowlarr.com/" target="_blank" rel="noopener noreferrer">
          官网 <ExternalLink size={12} style={{ verticalAlign: "-1px" }} />
        </a>
      </p>
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
        <div className="setting-row">
          <input
            type="password"
            className="setting-control"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={hasKey ? "已设置(留空不改)" : "粘贴 Prowlarr API Key"}
            aria-label="Prowlarr API Key"
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
      </div>
      {result ? (
        <p className="panel-note" style={{ marginTop: 10 }}>
          {result}
        </p>
      ) : null}
    </div>
  );
}
