"use client";

import { useState, useTransition } from "react";
import { Check, ExternalLink, LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { connectGuangYaAction } from "../app/actions";
import { parseTokenPaste, sanitizeToken } from "../lib/guangya-token-paste";

/**
 * 光鸭云盘 token 连接 —— 光鸭用 access_token + refresh_token 鉴权(非 cookie)。
 * 用户从光鸭 app/web 抓出这两个 token 粘进来;refresh_token 用于 401 时自动续期,
 * 续期后新 token 会持久化回该盘。
 */
export function GuangYaTokenConnect() {
  const router = useRouter();
  const [accessToken, setAccessToken] = useState("");
  const [refreshToken, setRefreshToken] = useState("");
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<string | null>(null);

  // 智能粘贴:Console snippet 拷出的整块 JSON({"accessToken":…,"refreshToken":…})
  // 粘进任一框 → 自动拆填两个字段;裸 token → 仅清洗当前字段。
  const handleTokenInput = (value: string, setSelf: (v: string) => void) => {
    const blob = parseTokenPaste(value);
    if (blob) {
      setAccessToken(blob.accessToken);
      setRefreshToken(blob.refreshToken);
      return;
    }
    setSelf(sanitizeToken(value));
  };

  const handleConnect = () => {
    startTransition(async () => {
      const res = await connectGuangYaAction(accessToken, refreshToken);
      setResult(res.ok ? `✅ ${res.message}` : `❌ ${res.message}`);
      if (res.ok) {
        setAccessToken("");
        setRefreshToken("");
        router.refresh();
      }
    });
  };

  return (
    <div className="push-form">
      <p className="panel-note" style={{ marginBottom: 6 }}>
        从光鸭云盘 app/网页端的登录态中复制 <code>access_token</code> 与 <code>refresh_token</code>，分别粘到下面两个框。
        access_token 用于鉴权，refresh_token 在过期时自动续期（续期后新 token 会自动保存）。
        也可以直接把复制到的整块 JSON（含 accessToken 与 refreshToken）粘到任一框，会自动拆填到两个框。
      </p>
      <p className="push-help" style={{ marginBottom: 12 }}>
        光鸭云盘{" "}
        <a href="https://www.guangyapan.com" target="_blank" rel="noopener noreferrer">
          官网 <ExternalLink size={12} style={{ verticalAlign: "-1px" }} />
        </a>
      </p>
      <textarea
        className="setting-textarea"
        value={accessToken}
        onChange={(event) => handleTokenInput(event.target.value, setAccessToken)}
        placeholder="粘贴 access_token（形如 eyJ…），或整块 JSON"
        aria-label="光鸭 access_token"
        rows={3}
        style={{ width: "100%", fontFamily: "monospace", fontSize: 12, resize: "vertical" }}
      />
      <textarea
        className="setting-textarea"
        value={refreshToken}
        onChange={(event) => handleTokenInput(event.target.value, setRefreshToken)}
        placeholder="粘贴 refresh_token"
        aria-label="光鸭 refresh_token"
        rows={3}
        style={{ width: "100%", fontFamily: "monospace", fontSize: 12, resize: "vertical", marginTop: 8 }}
      />
      <div className="setting-row" style={{ marginTop: 10 }}>
        <button
          type="button"
          className="primary-button"
          onClick={handleConnect}
          disabled={isPending || !accessToken.trim() || !refreshToken.trim()}
        >
          {isPending ? <LoaderCircle size={14} className="spin" aria-hidden /> : <Check size={14} aria-hidden />}
          连接光鸭
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
