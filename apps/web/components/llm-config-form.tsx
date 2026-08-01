"use client";

import { useState, useTransition } from "react";
import { Check, LoaderCircle } from "lucide-react";
import { saveLlmConfigAction } from "../app/actions";
import { runAction } from "../lib/run-action";
import { LlmTestConnectionButton } from "./llm-test-connection-button";

export function LlmConfigForm({
  baseURL: initialBaseURL,
  modelId: initialModelId,
  apiKeySet,
}: {
  baseURL: string;
  modelId: string;
  apiKeySet: boolean;
}) {
  const [isPending, startTransition] = useTransition();
  const [baseURL, setBaseURL] = useState(initialBaseURL);
  const [modelId, setModelId] = useState(initialModelId);
  // The API key is never echoed back from the server; the user only types one to
  // set/replace it. Blank submit keeps the stored key.
  const [apiKey, setApiKey] = useState("");
  const [result, setResult] = useState<string | null>(null);

  const handleSave = () => {
    startTransition(async () => {
      // 必须 catch:server action 会 throw(demo 门禁、运行时错误、网络中断),
      // 不 catch 就是未处理 rejection,界面上什么都不变(见 runAction 注释)。
      // 业务错误(success:false)仍走下方原逻辑;这里只拦异常。
      const r = await runAction(
        () => saveLlmConfigAction({ baseURL, modelId, apiKey }),
        (msg) => {
          setResult(`❌ ${msg}`);
          setTimeout(() => setResult(null), 4000);
        },
      );
      if (!r.ok) return;
      const res = r.value;
      setResult(res.success ? "✅ 保存成功 —— 点「测试连接」确认可用" : `❌ ${res.message ?? "保存失败"}`);
      if (res.success) setApiKey("");
      setTimeout(() => setResult(null), 4000);
    });
  };

  return (
    <div className="push-form">
      <p className="panel-note" style={{ marginBottom: 12 }}>
        AI 模型(OpenAI 兼容)。自带你自己的 key——它只存在你这台机器的数据库里,作者看不到。留空 API Key 不会改动已保存的值。
      </p>
      <div className="push-field">
        <label className="push-label">Base URL</label>
        <input
          type="text"
          className="setting-control"
          value={baseURL}
          onChange={(event) => setBaseURL(event.target.value)}
          placeholder="https://api.openai.com/v1"
          aria-label="LLM Base URL"
        />
      </div>
      <div className="push-field">
        <label className="push-label">Model ID</label>
        <input
          type="text"
          className="setting-control"
          value={modelId}
          onChange={(event) => setModelId(event.target.value)}
          placeholder="gpt-4o-mini"
          aria-label="LLM Model ID"
        />
      </div>
      <div className="push-field">
        <label className="push-label">API Key</label>
        <input
          type="password"
          className="setting-control"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={apiKeySet ? "已设置(留空不改)" : "sk-…"}
          aria-label="LLM API Key"
          autoComplete="off"
        />
      </div>
      <div className="setting-row" style={{ marginTop: 4, gap: 12, flexWrap: "wrap" }}>
        <button type="button" className="primary-button" onClick={handleSave} disabled={isPending}>
          {isPending ? <LoaderCircle size={14} className="spin" aria-hidden /> : <Check size={14} aria-hidden />}
          保存
        </button>
        <LlmTestConnectionButton />
        {result ? <span className="panel-note">{result}</span> : null}
      </div>
    </div>
  );
}
