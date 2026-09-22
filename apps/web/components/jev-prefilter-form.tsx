"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, LoaderCircle, Trash2 } from "lucide-react";
import { saveJevConfigAction, clearJevConfigAction, setJevPrefilterEnabledAction } from "../app/actions";
import { runAction } from "../lib/run-action";

/**
 * Settings → AI 模型 的 Jev 候选预筛表单（字段 + 动作行；块头的状态胶囊由
 * 服务端 ServiceBlock 渲染,保存/清除/开关成功后 router.refresh() 让它跟上）。
 * 保存即探活(见 lib/jev-probe):打不通的 key 不会被存下来,所以「已启用」永远
 * 等于「至少连通过一次」。本地的 hasKey/isHealthy 只用来决定「清除」和「启用」
 * 勾选是否出现,不再自己算「生效中」—— 那是胶囊的事(单一事实源 isJevPrefilterActive)。
 */
export function JevPrefilterForm({
  baseUrl: initialBaseUrl,
  inheritedBaseUrl,
  apiKeySet,
  enabled: initialEnabled,
  healthy,
}: {
  baseUrl: string;
  /** Where a blank field resolves (instance → env → OpenRouter); shown as the placeholder. */
  inheritedBaseUrl: string;
  apiKeySet: boolean;
  enabled: boolean;
  healthy: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl);
  const [apiKey, setApiKey] = useState("");
  const [hasKey, setHasKey] = useState(apiKeySet);
  const [isHealthy, setIsHealthy] = useState(healthy);
  const [enabled, setEnabled] = useState(initialEnabled);
  // router.refresh() 会带着新 props 重渲染,但 useState 只吃一次初值 —— 三个本地镜像
  // 必须跟上,否则表单会和块头胶囊打架(例:清掉账号 key 后全局/env key 仍生效,
  // 胶囊是「待测试」,表单却藏起了「清除」)。输入框不同步,免得冲掉正在打的字。
  useEffect(() => setHasKey(apiKeySet), [apiKeySet]);
  useEffect(() => setIsHealthy(healthy), [healthy]);
  useEffect(() => setEnabled(initialEnabled), [initialEnabled]);
  const [result, setResult] = useState<string | null>(null);
  const flash = (msg: string) => {
    setResult(msg);
    setTimeout(() => setResult(null), 3000);
  };

  const handleSave = () => {
    startTransition(async () => {
      // 必须 catch:server action 会 throw(demo 门禁、运行时错误、网络中断),
      // 不 catch 就是未处理 rejection,界面上什么都不变(见 runAction 注释)。
      const r = await runAction(
        () => saveJevConfigAction({ apiKey, baseUrl }),
        (msg) => flash(`❌ ${msg}`),
      );
      if (!r.ok) return;
      if (r.value.success) {
        // 带上 action 回的模型名:保存成功时用户最想确认的是「到底是谁答的」。
        flash(`✅ ${r.value.message ?? "已连通并保存"}，预筛已启用`);
        setApiKey("");
        setHasKey(true);
        setIsHealthy(true);
        setEnabled(true);
        router.refresh();
      } else {
        flash(`❌ ${r.value.message ?? "保存失败"}`);
      }
    });
  };

  const handleClear = () => {
    startTransition(async () => {
      const r = await runAction(() => clearJevConfigAction(), (msg) => flash(`❌ ${msg}`));
      if (!r.ok) return;
      if (r.value.success) {
        flash("✅ 已清除");
        // 输入框里还留着刚打的 key 的话,下一次「保存并测试」会把已清除的配置又写回去。
        setApiKey("");
        setHasKey(false);
        setIsHealthy(false);
        setEnabled(false);
        setBaseUrl("");
        router.refresh();
      } else {
        flash(`❌ ${r.value.message ?? "清除失败"}`);
      }
    });
  };

  const handleToggle = (next: boolean) => {
    startTransition(async () => {
      const r = await runAction(() => setJevPrefilterEnabledAction(next), (msg) => flash(`❌ ${msg}`));
      if (!r.ok) return;
      if (r.value.success) {
        setEnabled(next);
        flash(next ? "✅ 预筛已启用" : "✅ 预筛已关闭");
        router.refresh();
      } else {
        flash(`❌ ${r.value.message ?? "保存失败"}`);
      }
    });
  };

  return (
    <div className="push-form">
      <div className="push-field">
        <label className="push-label">Base URL（留空 = 沿用实例配置，即框内灰字）</label>
        <input
          type="text"
          className="setting-control"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder={inheritedBaseUrl}
          aria-label="Jev Base URL"
        />
      </div>
      <div className="push-field">
        <label className="push-label">Jev API Key</label>
        <input
          type="password"
          className="setting-control"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={hasKey ? "已设置(留空不改)" : "粘贴 Jev API Key"}
          aria-label="Jev API Key"
          autoComplete="off"
        />
      </div>
      <div className="service-actions">
        <button type="button" className="primary-button" onClick={handleSave} disabled={isPending}>
          {isPending ? <LoaderCircle size={14} className="spin" aria-hidden /> : <Check size={14} aria-hidden />}
          保存并测试
        </button>
        {hasKey ? (
          <button type="button" className="secondary-button" onClick={handleClear} disabled={isPending}>
            <Trash2 size={14} aria-hidden />
            清除
          </button>
        ) : null}
        {hasKey && isHealthy ? (
          <label className="service-toggle">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => handleToggle(event.target.checked)}
              disabled={isPending}
              aria-label="启用 Jev 候选预筛"
            />
            启用候选预筛
          </label>
        ) : null}
        {result ? <span className="panel-note">{result}</span> : null}
      </div>
    </div>
  );
}
