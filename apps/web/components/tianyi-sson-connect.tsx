"use client";

import { useState, useTransition } from "react";
import { Check, ExternalLink, LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { connectTianyiSsonAction } from "../app/actions";

/**
 * 天翼手动 SSON 连接 —— 扫码登录(TianyiQrConnect)的折叠回退。用户从 cloud.189.cn
 * 的浏览器 cookie 里复制 SSON 的值粘贴进来,服务端用它走 loginBySsoCooike 换全套 session。
 */
export function TianyiSsonConnect() {
  const router = useRouter();
  const [sson, setSson] = useState("");
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<string | null>(null);

  const handleConnect = () => {
    startTransition(async () => {
      const res = await connectTianyiSsonAction(sson);
      setResult(res.ok ? `✅ ${res.message}` : `❌ ${res.message}`);
      if (res.ok) {
        setSson("");
        router.refresh();
      }
    });
  };

  return (
    <div className="push-form">
      <p className="panel-note" style={{ marginBottom: 6 }}>
        扫码登录失败时的手动回退：登录 <code>cloud.189.cn</code> 后，在浏览器开发者工具的 Application →
        Cookies 里找到 <code>SSON</code>，复制它的值粘贴到下面（仅粘值，不带 <code>SSON=</code> 前缀）。
      </p>
      <p className="push-help" style={{ marginBottom: 12 }}>
        天翼云盘{" "}
        <a href="https://cloud.189.cn/" target="_blank" rel="noopener noreferrer">
          官网 <ExternalLink size={12} style={{ verticalAlign: "-1px" }} />
        </a>
      </p>
      <textarea
        className="setting-textarea"
        value={sson}
        onChange={(event) => setSson(event.target.value)}
        placeholder="把 SSON cookie 的值粘到这里"
        aria-label="天翼 SSON cookie"
        rows={3}
        style={{ width: "100%", fontFamily: "monospace", fontSize: 12, resize: "vertical" }}
      />
      <div className="setting-row" style={{ marginTop: 10 }}>
        <button type="button" className="primary-button" onClick={handleConnect} disabled={isPending || !sson.trim()}>
          {isPending ? <LoaderCircle size={14} className="spin" aria-hidden /> : <Check size={14} aria-hidden />}
          连接天翼
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
