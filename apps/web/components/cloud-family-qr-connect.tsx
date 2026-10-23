"use client";

import { LoaderCircle, QrCode, RefreshCw } from "lucide-react";
import { useRef, useState } from "react";
import { useRouter } from "../lib/use-router";

type Session = { token: string; qrcodeContent: string };
type Phase = "idle" | "loading" | "waiting" | "scanned" | "confirming" | "done" | "expired" | "error";

/** Per-brand wiring for the family CAS scan flow. The two brands share one
 *  protocol; only the API route prefix, the app name to scan with, and the copy
 *  differ. */
const BRANDS = {
  quark: { label: "夸克", app: "夸克 App", api: "/api/quark/qrcode" },
  uc: { label: "UC网盘", app: "UC 浏览器", api: "/api/uc/qrcode" },
} as const;

/**
 * 扫码登录(阿里云盘族):生成二维码 → 用户用对应 App 扫 → 每 2s 轮询(非长轮询)
 * → confirmed 拿 service_ticket → /confirm 兑换+绑定。扫码兑换失败时,外层折叠的
 * cookie 粘贴是回退 —— 兑换这一步只有真机扫码才能确认。
 */
export function CloudFamilyQrConnect({ brand }: { brand: keyof typeof BRANDS }) {
  const config = BRANDS[brand];
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
      const res = await fetch(config.api, { method: "POST" });
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
        const res = await fetch(`${config.api}/status?token=${encodeURIComponent(s.token)}`);
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
      const res = await fetch(`${config.api}/confirm`, {
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
      setMessage(`${config.label}已连接。`);
      router.refresh();
    } catch {
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
      <p className="qr-hint">用手机{config.app}扫码登录；cookie 持久化到数据库，自动用于后续转存。</p>
      {session && (phase === "waiting" || phase === "scanned" || phase === "confirming") ? (
        <div className="qr-frame">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`${config.api}/image?content=${encodeURIComponent(session.qrcodeContent)}`}
            alt={`${config.label}登录二维码`}
          />
          <span className={`qr-status ${phase}`}>
            {phase === "waiting"
              ? `用${config.app}扫码`
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
