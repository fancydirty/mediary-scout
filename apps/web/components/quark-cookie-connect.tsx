"use client";

import { useState, useTransition } from "react";
import { Check, ExternalLink, LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { connectQuarkAction } from "../app/actions";
import { runAction } from "../lib/run-action";

/**
 * 夸克手动 cookie 连接 —— 扫码登录(QuarkQrConnect)的折叠回退。用户从夸克 web 请求头
 * 复制 Cookie(需含 httpOnly 的 __pus,document.cookie 抓不全)粘贴进来。
 */
export function QuarkCookieConnect() {
  const router = useRouter();
  const [cookie, setCookie] = useState("");
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<string | null>(null);

  const handleConnect = () => {
    startTransition(async () => {
      // 必须 catch:server action 会 throw(demo 门禁、运行时错误、网络中断),
      // 不 catch 就是未处理 rejection,界面上什么都不变(见 runAction 注释)。
      const r = await runAction(
        () => connectQuarkAction(cookie),
        (msg) => setResult(`❌ ${msg}`),
      );
      if (!r.ok) return;
      const res = r.value;
      setResult(res.ok ? `✅ ${res.message}` : `❌ ${res.message}`);
      if (res.ok) {
        setCookie("");
        router.refresh();
      }
    });
  };

  return (
    <div className="push-form">
      <p className="panel-note" style={{ marginBottom: 6 }}>
        扫码登录失败时的手动回退：打开 <code>pan.quark.cn</code> 登录后，在浏览器开发者工具的
        Network 里点任意一个 <code>drive-pc.quark.cn</code> 请求 → 复制其请求头里的完整 Cookie（需包含
        <code> __pus</code> 与 <code>__uid</code>），粘贴到下面。
      </p>
      <p className="push-help" style={{ marginBottom: 12 }}>
        夸克网盘{" "}
        <a href="https://pan.quark.cn/" target="_blank" rel="noopener noreferrer">
          官网 <ExternalLink size={12} style={{ verticalAlign: "-1px" }} />
        </a>
      </p>
      <textarea
        className="setting-textarea"
        value={cookie}
        onChange={(event) => setCookie(event.target.value)}
        placeholder="把完整的 Cookie 粘到这里（形如 __pus=…; __uid=…; __kps=…）"
        aria-label="夸克 Cookie"
        rows={4}
        style={{ width: "100%", fontFamily: "monospace", fontSize: 12, resize: "vertical" }}
      />
      <div className="setting-row" style={{ marginTop: 10 }}>
        <button type="button" className="primary-button" onClick={handleConnect} disabled={isPending || !cookie.trim()}>
          {isPending ? <LoaderCircle size={14} className="spin" aria-hidden /> : <Check size={14} aria-hidden />}
          连接夸克
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
