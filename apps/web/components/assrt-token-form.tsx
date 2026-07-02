"use client";

import { useState, useTransition } from "react";
import { Check, ExternalLink, LoaderCircle, Trash2 } from "lucide-react";
import { saveAssrtTokenAction, clearAssrtTokenAction } from "../app/actions";

export function AssrtTokenForm({ tokenSet }: { tokenSet: boolean }) {
  const [isPending, startTransition] = useTransition();
  const [token, setToken] = useState("");
  const [hasToken, setHasToken] = useState(tokenSet);
  const [result, setResult] = useState<string | null>(null);

  const handleSave = () => {
    // Blank input: the server action would no-op yet report success — guard here
    // so first-time setup never sees a misleading "保存成功".
    if (!token.trim()) {
      setResult("❌ 请输入 Token 后再保存");
      setTimeout(() => setResult(null), 3000);
      return;
    }
    startTransition(async () => {
      const res = await saveAssrtTokenAction(token);
      setResult(res.success ? "✅ 保存成功" : `❌ ${res.message ?? "保存失败"}`);
      if (res.success && token.trim()) {
        setToken("");
        setHasToken(true);
      }
      setTimeout(() => setResult(null), 3000);
    });
  };

  const handleClear = () => {
    startTransition(async () => {
      const res = await clearAssrtTokenAction();
      setResult(res.success ? "✅ 已清除，字幕补全功能关闭" : `❌ ${res.message ?? "清除失败"}`);
      if (res.success) {
        setHasToken(false);
        setToken("");
      }
      setTimeout(() => setResult(null), 3000);
    });
  };

  return (
    <div className="push-form">
      <p className="panel-note" style={{ marginBottom: 6 }}>
        外挂中文字幕来源：assrt.net（伪射手）有免费官方 API，agent 获取非国产剧集/电影时会自动搜字幕候选并挑合适的落盘到视频旁。需网盘支持外链离线落盘（115/光鸭支持；夸克暂不触发）。免费申请 Token，留空则该功能完全不启用。国产内容原生中文对白，不需要此功能。
      </p>
      <p className="push-help" style={{ marginBottom: 12 }}>
        了解 assrt.net{" "}
        <a href="https://assrt.net" target="_blank" rel="noopener noreferrer">
          官网 <ExternalLink size={12} style={{ verticalAlign: "-1px" }} />
        </a>
        {" · 免费申请 Token "}
        <a href="https://secure.assrt.net/user/register.xml" target="_blank" rel="noopener noreferrer">
          注册页面 <ExternalLink size={12} style={{ verticalAlign: "-1px" }} />
        </a>
      </p>
      <div className="setting-row">
        <input
          type="password"
          className="setting-control"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder={hasToken ? "已设置(留空不改)" : "assrt Token"}
          aria-label="assrt Token"
          autoComplete="off"
        />
        <button type="button" className="primary-button" onClick={handleSave} disabled={isPending}>
          {isPending ? <LoaderCircle size={14} className="spin" aria-hidden /> : <Check size={14} aria-hidden />}
          保存
        </button>
        {hasToken ? (
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
