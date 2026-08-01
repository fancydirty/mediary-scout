"use client";

import { useState, useTransition } from "react";
import { Check, ExternalLink, LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { connectPan123TokenAction } from "../app/actions";
import { runAction } from "../lib/run-action";

/**
 * 123网盘手动粘 token —— 扫码登录(Pan123QrConnect)的折叠回退。123 的登录凭证是
 * 一个 ~90 天有效的 JWT token(形如 eyJ…),用户从 App 扫码登录网页版后,可在浏览器
 * localStorage 里抓到它粘进来;服务端解 uid + probe 验活后绑定。
 */
export function Pan123TokenConnect() {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<string | null>(null);

  const handleConnect = () => {
    startTransition(async () => {
      // 必须 catch:server action 会 throw(demo 门禁、运行时错误、网络中断),
      // 不 catch 就是未处理 rejection,界面上什么都不变(见 runAction 注释)。
      const r = await runAction(
        () => connectPan123TokenAction(token),
        (msg) => setResult(`❌ ${msg}`),
      );
      if (!r.ok) return;
      const res = r.value;
      setResult(res.ok ? `✅ ${res.message}` : `❌ ${res.message}`);
      if (res.ok) {
        setToken("");
        router.refresh();
      }
    });
  };

  return (
    <div className="push-form">
      <p className="panel-note" style={{ marginBottom: 6 }}>
        扫码不便时的手动回退：用 App 扫码登录 <code>123pan.com</code> 网页版后，在浏览器开发者工具的
        Application → Local Storage 里找到登录 token（一段 <code>eyJ…</code> 开头的长字符串，约 90
        天有效），复制粘贴到下面。
      </p>
      <p className="push-help" style={{ marginBottom: 12 }}>
        123网盘{" "}
        <a href="https://www.123pan.com/" target="_blank" rel="noopener noreferrer">
          官网 <ExternalLink size={12} style={{ verticalAlign: "-1px" }} />
        </a>
      </p>
      <textarea
        className="setting-textarea"
        value={token}
        onChange={(event) => setToken(event.target.value)}
        placeholder="把 123网盘登录 token 粘到这里（形如 eyJ…）"
        aria-label="123网盘登录 token"
        rows={3}
        style={{ width: "100%", fontFamily: "monospace", fontSize: 12, resize: "vertical" }}
      />
      <div className="setting-row" style={{ marginTop: 10 }}>
        <button type="button" className="primary-button" onClick={handleConnect} disabled={isPending || !token.trim()}>
          {isPending ? <LoaderCircle size={14} className="spin" aria-hidden /> : <Check size={14} aria-hidden />}
          连接 123网盘
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
