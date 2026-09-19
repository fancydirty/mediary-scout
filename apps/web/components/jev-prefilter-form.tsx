"use client";

import { useState, useTransition } from "react";
import { Check, ExternalLink, LoaderCircle, Trash2 } from "lucide-react";
import { saveJevConfigAction, clearJevConfigAction, setJevPrefilterEnabledAction } from "../app/actions";
import { runAction } from "../lib/run-action";

/**
 * Settings → 资源提供商 的 Jev 候选预筛表单。保存即探活(见 lib/jev-probe):
 * 打不通的 key 不会被存下来,所以界面上的「已启用」永远等于「至少连通过一次」。
 * `active` 与服务端 isJevPrefilterActive 同一条规则(key + 启用 + 探活通过);
 * 本地改动后就地重算,避免点一下要等整页刷新才看到状态。
 */
export function JevPrefilterForm({
  baseUrl: initialBaseUrl,
  apiKeySet,
  enabled: initialEnabled,
  healthy,
  active: initialActive,
}: {
  baseUrl: string;
  apiKeySet: boolean;
  enabled: boolean;
  healthy: boolean;
  active: boolean;
}) {
  const [isPending, startTransition] = useTransition();
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl);
  const [apiKey, setApiKey] = useState("");
  const [hasKey, setHasKey] = useState(apiKeySet);
  const [isHealthy, setIsHealthy] = useState(healthy);
  const [enabled, setEnabled] = useState(initialEnabled);
  const [active, setActive] = useState(initialActive);
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
        flash("✅ 已连通并保存，预筛已启用");
        setApiKey("");
        setHasKey(true);
        setIsHealthy(true);
        setEnabled(true);
        setActive(true);
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
        setHasKey(false);
        setIsHealthy(false);
        setEnabled(false);
        setActive(false);
        setBaseUrl("");
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
        setActive(next && hasKey && isHealthy);
        flash(next ? "✅ 预筛已启用" : "✅ 预筛已关闭");
      } else {
        flash(`❌ ${r.value.message ?? "保存失败"}`);
      }
    });
  };

  return (
    <div className="push-form">
      <p className="panel-note" style={{ marginBottom: 6 }}>
        Jev 候选预筛：搜索结果进入 agent 之前，先由 Jev（TypeSafe 决策模型）判断每条候选是否指向目标作品——确定无关的直接剔除，拿不准的标记「相关度存疑」交给 agent。每次搜索约 1 秒、几乎零成本。未配置时不产生任何调用。
      </p>
      <p className="push-help" style={{ marginBottom: 12 }}>
        用 OpenRouter 的 API Key 即可（模型 jev-latest）{" "}
        <a href="https://openrouter.ai/typesafe/jev-latest" target="_blank" rel="noopener noreferrer">
          模型页 <ExternalLink size={12} style={{ verticalAlign: "-1px" }} />
        </a>
      </p>
      <div className="push-field">
        <label className="push-label">Base URL（留空用 OpenRouter decisions 端点）</label>
        <input
          type="text"
          className="setting-control"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder="https://openrouter.ai/api/alpha/decisions"
          aria-label="Jev Base URL"
        />
      </div>
      <div className="push-field">
        <label className="push-label">API Key</label>
        <div className="setting-row">
          <input
            type="password"
            className="setting-control"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={hasKey ? "已设置(留空不改)" : "粘贴 OpenRouter API Key"}
            aria-label="Jev API Key"
            autoComplete="off"
          />
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
        </div>
      </div>
      {hasKey && isHealthy ? (
        <div className="push-field">
          <label className="push-label" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => handleToggle(event.target.checked)}
              disabled={isPending}
              aria-label="启用 Jev 候选预筛"
            />
            启用候选预筛
          </label>
          <p className="push-help" style={{ margin: "6px 0 0" }}>
            {active ? "当前生效：搜索结果会先过一遍 Jev。" : "当前不生效：agent 拿到的是未经预筛的全部候选。"}
          </p>
        </div>
      ) : null}
      {result ? (
        <p className="panel-note" style={{ marginTop: 10 }}>
          {result}
        </p>
      ) : null}
    </div>
  );
}
