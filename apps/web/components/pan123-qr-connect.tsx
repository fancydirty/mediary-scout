"use client";

import { LoaderCircle, QrCode, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/** 123 的 QR session 是无状态的:{ uniID, qrcodeContent } 就是全部——没有天翼那种
 *  cookie jar 滚动回传,轮询只带 uniID,confirm 只带轮询拿到的 90 天 token。 */
type Session = {
  uniID: string;
  qrcodeContent: string;
};
type Phase = "idle" | "loading" | "waiting" | "scanned" | "confirming" | "done" | "expired" | "error";

/**
 * 123网盘扫码登录:与 115/夸克/天翼 QrConnect 同构的相位机,但链路最短——生成
 * (generate → uniID + 登录 URL 内容)→ 用户 123网盘 App 扫 → 每 2s 轮询 result
 * (只传 uniID;有真实 scanned 相位)→ confirmed 直接带回 ~90 天 token →
 * /confirm 验活并绑定(无 exchange 步骤)。扫码失败时,外层折叠的粘 token 是回退。
 */
export function Pan123QrConnect() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [session, setSession] = useState<Session | null>(null);
  const [message, setMessage] = useState<string>("");
  const generation = useRef(0);

  // Unmount: bump the generation so any in-flight poll loop stops.
  useEffect(() => {
    return () => {
      generation.current += 1;
    };
  }, []);

  async function start() {
    const myGen = ++generation.current;
    setPhase("loading");
    setMessage("");
    try {
      const res = await fetch("/api/pan123/qrcode", { method: "POST" });
      const data = (await res.json()) as { ok: boolean; session?: Session; error?: string };
      if (!data.ok || !data.session) throw new Error(data.error ?? "无法获取二维码");
      if (generation.current !== myGen) return;
      setSession(data.session);
      setPhase("waiting");
      await pollLoop(data.session, myGen);
    } catch (error) {
      if (generation.current !== myGen) return;
      setPhase("error");
      setMessage(String(error));
    }
  }

  async function pollLoop(current: Session, myGen: number) {
    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline && generation.current === myGen) {
      await new Promise((r) => setTimeout(r, 2000));
      if (generation.current !== myGen) return;
      let status = "waiting";
      let token: string | undefined;
      try {
        const res = await fetch("/api/pan123/qrcode/status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ uniID: current.uniID }),
        });
        const data = (await res.json()) as { ok: boolean; status?: string; token?: string };
        if (data.ok && data.status) {
          status = data.status;
          token = data.token;
        }
      } catch {
        // transient — keep polling
      }
      if (generation.current !== myGen) return;
      if (status === "scanned") {
        setPhase("scanned");
      } else if (status === "confirmed" && token) {
        setPhase("confirming");
        await confirm(token, myGen);
        return;
      } else if (status === "expired") {
        setPhase("expired");
        setMessage("二维码已失效，点击刷新。");
        return;
      }
      // "confirmed" WITHOUT a token: keep polling — the token is the only thing
      // /confirm can bind, and the next result poll normally carries it.
    }
    if (generation.current === myGen) {
      setPhase("expired");
      setMessage("等待超时，请重新生成二维码。");
    }
  }

  async function confirm(token: string, myGen: number) {
    try {
      const res = await fetch("/api/pan123/qrcode/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = (await res.json()) as { ok: boolean; providerUid?: string; error?: string };
      if (!data.ok) {
        if (generation.current !== myGen) return;
        setPhase("error");
        setMessage(`${data.error ?? "登录失败"}（可改用下方手动粘 token）`);
        return;
      }
      if (generation.current !== myGen) return;
      setPhase("done");
      setMessage("123网盘已连接。");
      router.refresh();
    } catch {
      // NOT a clean API error (those return in `data` above): a network failure
      // (fetch threw) or a JSON decode failure. Generic retry hint + fallback.
      if (generation.current !== myGen) return;
      setPhase("error");
      setMessage("网络异常，请重试。（可改用下方手动粘 token）");
    }
  }

  return (
    <div className="qr-connect">
      <div className="qr-connect-controls">
        <button
          className="primary-button"
          type="button"
          onClick={start}
          disabled={phase === "loading" || phase === "confirming"}
        >
          {phase === "loading" ? (
            <LoaderCircle size={14} className="spin" aria-hidden />
          ) : phase === "waiting" || phase === "scanned" || phase === "expired" ? (
            <RefreshCw size={14} aria-hidden />
          ) : (
            <QrCode size={14} aria-hidden />
          )}
          {phase === "idle" || phase === "done" ? "生成二维码" : "重新生成"}
        </button>
      </div>
      <p className="qr-hint">用 123网盘 App 扫码登录（约 90 天有效）；凭证持久化到数据库，自动用于后续转存。</p>
      {session?.qrcodeContent && (phase === "waiting" || phase === "scanned" || phase === "confirming") ? (
        <div className="qr-frame">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/pan123/qrcode/image?content=${encodeURIComponent(session.qrcodeContent)}`}
            alt="123网盘登录二维码"
          />
          <span className={`qr-status ${phase}`}>
            {phase === "waiting"
              ? "请用 123网盘 App 扫码"
              : phase === "scanned"
                ? "已扫码，请在手机上确认"
                : "正在完成登录…"}
          </span>
        </div>
      ) : null}
      {message ? (
        <p className="panel-note" style={{ marginTop: 10 }}>
          {message}
        </p>
      ) : null}
    </div>
  );
}
