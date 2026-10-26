"use client";

import { Check, LoaderCircle, Trash2 } from "lucide-react";
import { useState, useTransition } from "react";
import { useRouter } from "../lib/use-router";
import { clearHaisouConfigAction, saveHaisouConfigAction } from "../app/actions";
import { runAction } from "../lib/run-action";

/**
 * 海搜 API Key。和 Prowlarr 那个表单同构：密码输入框、留空不改、
 * 保存后清空输入框只显示「已设置」。
 *
 * 这里刻意**没有**「点击按钮跳去海搜登录再回来自动取 cookie」那条路。
 * 海搜的站点接口靠 `hs_web_session` cookie，匿名配额耗尽后连续 429，且
 * 站方页脚把「开放接口」指向 idatariver —— 说明官方给出的程序化入口就是
 * 那个 apikey。让用户把自己的网页登录 cookie 交给容器，既比 apikey 更脆
 * （180 天但会随登出失效），也不是站方期望的用法。
 */
export function HaisouConfigForm({ apiKeySet }: { apiKeySet: boolean }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [apiKey, setApiKey] = useState("");
  const [hasKey, setHasKey] = useState(apiKeySet);
  const [result, setResult] = useState<string | null>(null);

  const handleSave = () => {
    startTransition(async () => {
      const r = await runAction(
        () => saveHaisouConfigAction({ apiKey }),
        (msg) => {
          setResult(`❌ ${msg}`);
          setTimeout(() => setResult(null), 4000);
        },
      );
      if (!r.ok) return;
      const res = r.value;
      setResult(res.success ? "✅ 保存成功（已实测可用）" : `❌ ${res.message ?? "保存失败"}`);
      if (res.success) {
        setApiKey("");
        setHasKey(true);
        router.refresh();
      }
      setTimeout(() => setResult(null), 4000);
    });
  };

  const handleClear = () => {
    startTransition(async () => {
      const r = await runAction(
        () => clearHaisouConfigAction(),
        (msg) => {
          setResult(`❌ ${msg}`);
          setTimeout(() => setResult(null), 4000);
        },
      );
      if (!r.ok) return;
      const res = r.value;
      setResult(res.success ? "✅ 已清除，海搜搜索源关闭" : `❌ ${res.message ?? "清除失败"}`);
      if (res.success) {
        setHasKey(false);
        router.refresh();
      }
      setTimeout(() => setResult(null), 3000);
    });
  };

  return (
    <div className="push-form">
      <div className="push-field">
        <label className="push-label">API Key（idatariver → 控制台 → API Keys）</label>
        <input
          type="password"
          className="setting-control"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={hasKey ? "已设置（填入新 Key 可替换）" : "粘贴 idr_ 开头的 Key"}
          aria-label="海搜 API Key"
          autoComplete="off"
        />
      </div>
      <div className="service-actions">
        <button
          type="button"
          className="primary-button"
          onClick={handleSave}
          disabled={isPending || !apiKey.trim()}
        >
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
