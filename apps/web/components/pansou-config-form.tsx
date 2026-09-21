"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, LoaderCircle } from "lucide-react";
import { savePanSouBaseUrlAction } from "../app/actions";
import { runAction } from "../lib/run-action";

export function PanSouConfigForm({ baseURL: initialBaseURL }: { baseURL: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [baseURL, setBaseURL] = useState(initialBaseURL);
  const [result, setResult] = useState<string | null>(null);

  const handleSave = () => {
    startTransition(async () => {
      // 必须 catch:server action 会 throw(demo 门禁、运行时错误、网络中断),
      // 不 catch 就是未处理 rejection,界面上什么都不变(见 runAction 注释)。
      // 业务错误(success:false)仍走下方原逻辑;这里只拦异常。
      const r = await runAction(
        () => savePanSouBaseUrlAction(baseURL),
        (msg) => {
          setResult(`❌ ${msg}`);
          setTimeout(() => setResult(null), 3000);
        },
      );
      if (!r.ok) return;
      const res = r.value;
      setResult(res.success ? "✅ 保存成功" : `❌ ${res.message ?? "保存失败"}`);
      if (res.success) router.refresh();
      setTimeout(() => setResult(null), 3000);
    });
  };

  return (
    <div className="push-form">
      <div className="push-field">
        <label className="push-label">服务地址（网盘搜索源）</label>
        <div className="setting-row">
          <input
            type="text"
            className="setting-control"
            value={baseURL}
            onChange={(event) => setBaseURL(event.target.value)}
            placeholder="形如 http://host:port，留空用默认实例"
            aria-label="PanSou Base URL"
          />
          <button type="button" className="primary-button" onClick={handleSave} disabled={isPending}>
            {isPending ? <LoaderCircle size={14} className="spin" aria-hidden /> : <Check size={14} aria-hidden />}
            保存
          </button>
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
