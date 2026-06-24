"use client";

import { Check, LoaderCircle, QrCode, RefreshCw } from "lucide-react";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Session = { uid: string; time: number; sign: string; qrcodeContent: string };
type Phase = "idle" | "loading" | "waiting" | "scanned" | "confirming" | "done" | "expired" | "error";

const APP_OPTIONS = [
  { value: "alipaymini", label: "支付宝小程序（推荐，长效）" },
  { value: "wechatmini", label: "微信小程序" },
  { value: "tv", label: "电视端" },
  { value: "android", label: "Android" },
  { value: "ios", label: "iOS" },
  { value: "web", label: "网页端（不推荐，易失效）" },
] as const;

export function Pan115QrConnect() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [app, setApp] = useState<string>("alipaymini");
  const [session, setSession] = useState<Session | null>(null);
  const [message, setMessage] = useState<string>("");
  const generation = useRef(0);

  async function start() {
    const myGeneration = ++generation.current;
    setPhase("loading");
    setMessage("");
    try {
      const response = await fetch("/api/115/qrcode", { method: "POST" });
      const data = (await response.json()) as { ok: boolean; session?: Session; error?: string };
      if (!data.ok || !data.session) {
        throw new Error(data.error ?? "无法获取二维码");
      }
      if (generation.current !== myGeneration) return;
      setSession(data.session);
      setPhase("waiting");
      await pollLoop(data.session, myGeneration);
    } catch (error) {
      if (generation.current !== myGeneration) return;
      setPhase("error");
      setMessage(String(error));
    }
  }

  async function pollLoop(currentSession: Session, myGeneration: number) {
    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline && generation.current === myGeneration) {
      const query = new URLSearchParams({
        uid: currentSession.uid,
        time: String(currentSession.time),
        sign: currentSession.sign,
      });
      let status = "waiting";
      try {
        const response = await fetch(`/api/115/qrcode/status?${query.toString()}`);
        const data = (await response.json()) as { ok: boolean; status?: string };
        if (data.ok && data.status) {
          status = data.status;
        }
      } catch {
        // transient network issue: keep polling
      }
      if (generation.current !== myGeneration) return;
      if (status === "scanned") {
        setPhase("scanned");
      } else if (status === "confirmed") {
        setPhase("confirming");
        await confirm(currentSession, myGeneration);
        return;
      } else if (status === "expired" || status === "canceled") {
        setPhase("expired");
        setMessage(status === "canceled" ? "已在手机上取消。" : "二维码已过期，请重新生成。");
        return;
      }
    }
    if (generation.current === myGeneration) {
      setPhase("expired");
      setMessage("等待超时，请重新生成二维码。");
    }
  }

  async function confirm(currentSession: Session, myGeneration: number) {
    try {
      const response = await fetch("/api/115/qrcode/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: currentSession, app }),
      });
      const data = (await response.json()) as { ok: boolean; userName?: string; error?: string };
      if (!data.ok) {
        if (generation.current !== myGeneration) return;
        setPhase("error");
        setMessage(data.error ?? "登录失败");
        return;
      }
      if (generation.current !== myGeneration) return;
      setPhase("done");
      setMessage(data.userName ? `已连接为 ${data.userName}` : "已连接");
      router.refresh();
    } catch (error) {
      // Anything here is NOT a clean API error (those returned in `data` above):
      // a network failure (fetch threw) OR a JSON decode failure (response.json()
      // threw on a non-JSON body). Show a generic retry hint, no Error: prefix.
      if (generation.current !== myGeneration) return;
      setPhase("error");
      setMessage("网络异常，请重试。");
    }
  }

  return (
    <div className="qr-connect">
      <div className="qr-connect-controls">
        <label className="qr-app-select">
          客户端类型
          <select
            className="setting-control"
            value={app}
            onChange={(event) => setApp(event.target.value)}
            disabled={phase === "confirming"}
          >
            {APP_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
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

      <p className="qr-hint">
        所选客户端类型若已有登录会话，该设备会被登出；小程序类型平时用不到、cookie 长效，推荐保持默认。
      </p>

      {session && (phase === "waiting" || phase === "scanned" || phase === "confirming") ? (
        <div className="qr-frame">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`/api/115/qrcode/image?uid=${encodeURIComponent(session.uid)}`} alt="115 登录二维码" />
          <span className={`qr-status ${phase}`}>
            {phase === "waiting"
              ? "用 115 App 扫码"
              : phase === "scanned"
                ? "已扫码，请在手机上确认"
                : "正在完成登录…"}
          </span>
        </div>
      ) : null}

      {phase === "done" ? (
        <p className="import-result success">
          <Check size={14} aria-hidden style={{ verticalAlign: "-2px" }} /> {message}
        </p>
      ) : null}
      {(phase === "error" || phase === "expired") && message ? (
        <p className="import-result failed">{message}</p>
      ) : null}
    </div>
  );
}
