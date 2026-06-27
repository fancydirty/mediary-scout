"use client";

import { useState, useTransition } from "react";
import { Check, ExternalLink, LoaderCircle, Wand2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { connectGuangYaAction } from "../app/actions";
import { extractGuangYaTokens, parseTokenPaste, sanitizeToken } from "../lib/guangya-token-paste";

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
  const [extractNote, setExtractNote] = useState<string | null>(null);

  // 智能粘贴:Console snippet 拷出的整块 JSON({"accessToken":…,"refreshToken":…})
  // 粘进任一框 → 自动拆填两个字段;裸 token → 仅清洗当前字段。
  const handleTokenInput = (value: string, setSelf: (v: string) => void) => {
    setExtractNote(null);
    const blob = parseTokenPaste(value);
    if (blob) {
      setAccessToken(blob.accessToken);
      setRefreshToken(blob.refreshToken);
      return;
    }
    setSelf(sanitizeToken(value));
  };

  // 显式「识别并拆分」:鲁棒提取(JSON / 标签文本 / 启发式),不管粘的是 Console 打印的
  // 两段还是复制的 JSON,一次粘 box1 + 一次点击就能把两个框都填好。
  const handleExtract = () => {
    const r = extractGuangYaTokens(accessToken);
    if (r) {
      setAccessToken(r.accessToken);
      setRefreshToken(r.refreshToken);
      setExtractNote("✅ 已识别 access + refresh");
    } else {
      setExtractNote(
        "没识别出两个 token —— 请确认粘贴内容里同时含 access_token 和 refresh_token(可直接粘 Console 打印的两段或复制的 JSON)。",
      );
    }
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
        最省事：把粘贴内容（Console 打印的两段、或复制的 JSON 都行）粘到第一个框，再点
        <strong>「识别并拆分」</strong>，两个框会自动填好。
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
      {accessToken.trim() ? (
        <div style={{ marginTop: 6 }}>
          <button
            type="button"
            className="secondary-button"
            onClick={handleExtract}
            style={{ fontSize: 12, padding: "4px 10px" }}
          >
            <Wand2 size={12} aria-hidden style={{ verticalAlign: "-2px", marginRight: 4 }} />
            识别并拆分 token
          </button>
          {extractNote ? (
            <p className="panel-note" style={{ marginTop: 6, marginBottom: 0 }}>
              {extractNote}
            </p>
          ) : null}
        </div>
      ) : null}
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
