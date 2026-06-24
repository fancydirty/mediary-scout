"use client";

import { LoaderCircle, QrCode, RefreshCw } from "lucide-react";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Session = { token: string; qrcodeContent: string };
type Phase = "idle" | "loading" | "waiting" | "scanned" | "confirming" | "done" | "expired" | "error";

/**
 * 夸克扫码登录:与 Pan115QrConnect 同构的相位机。生成二维码 → 用户夸克 App 扫 →
 * 每 2s 轮询(夸克非长轮询)→ confirmed 拿 service_ticket → /confirm 兑换+绑定。
 * 扫码兑换失败时,外层折叠的 cookie 粘贴是回退。
 */
export function QuarkQrConnect() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [session, setSession] = useState<Session | null>(null);
  const [message, setMessage] = useState<string>("");
  const generation = useRef(0);

  async function start() {
    const myGen = ++generation.current;
    setPhase("loading");
    setMessage("");
    try {
      const res = await fetch("/api/quark/qrcode", { method: "POST" });
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

  async function pollLoop(s: Session, myGen: number) {
    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline && generation.current === myGen) {
      await new Promise((r) => setTimeout(r, 2000));
      if (generation.current !== myGen) return;
      let status = "waiting";
      let serviceTicket: string | undefined;
      try {
        const res = await fetch(`/api/quark/qrcode/status?token=${encodeURIComponent(s.token)}`);
        const data = (await res.json()) as { ok: boolean; status?: string; serviceTicket?: string };
        if (data.ok && data.status) {
          status = data.status;
          serviceTicket = data.serviceTicket;
        }
      } catch {
        // transient — keep polling
      }
      if (generation.current !== myGen) return;
      if (status === "scanned") {
        setPhase("scanned");
      } else if (status === "confirmed" && serviceTicket) {
        setPhase("confirming");
        await confirm(serviceTicket, myGen);
        return;
      } else if (status === "expired") {
        setPhase("expired");
        setMessage("二维码已过期，请重新生成。");
        return;
      }
    }
    if (generation.current === myGen) {
      setPhase("expired");
      setMessage("等待超时，请重新生成二维码。");
    }
  }

  async function confirm(serviceTicket: string, myGen: number) {
    try {
      const res = await fetch("/api/quark/qrcode/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serviceTicket }),
      });
      const data = (await res.json()) as { ok: boolean; providerUid?: string; error?: string };
      if (!data.ok) {
        if (generation.current !== myGen) return;
        setPhase("error");
        setMessage(`${data.error ?? "登录失败"}（可改用下方手动粘 cookie）`);
        return;
      }
      if (generation.current !== myGen) return;
      setPhase("done");
      setMessage("夸克已连接。");
      router.refresh();
    } catch (error) {
      // Anything here is NOT a clean API error (those returned in `data` above):
      // a network failure (fetch threw) OR a JSON decode failure (response.json()
      // threw on a non-JSON body). Show a generic retry hint + the cookie fallback.
      if (generation.current !== myGen) return;
      setPhase("error");
      setMessage("网络异常，请重试。（可改用下方手动粘 cookie）");
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
      <p className="qr-hint">用手机夸克 App 扫码登录；cookie 持久化到数据库，自动用于后续转存。</p>
      {session && (phase === "waiting" || phase === "scanned" || phase === "confirming") ? (
        <div className="qr-frame">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`/api/quark/qrcode/image?content=${encodeURIComponent(session.qrcodeContent)}`} alt="夸克登录二维码" />
          <span className={`qr-status ${phase}`}>
            {phase === "waiting"
              ? "用夸克 App 扫码"
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
