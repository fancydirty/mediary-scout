"use client";

import { LoaderCircle, QrCode, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "../lib/use-router";
import { buildGuangYaQrContent } from "../lib/guangya-qr-content";

type Session = { deviceCode: string; userCode: string; verificationUrl: string; expiresIn: number; interval: number };

function qrContent(session: Session): string {
  return buildGuangYaQrContent({ verificationUrl: session.verificationUrl, userCode: session.userCode });
}
type Phase = "idle" | "loading" | "waiting" | "done" | "expired" | "error";

const API = "/api/guangya/qrcode";

function buttonIcon(phase: Phase) {
  if (phase === "loading") return <LoaderCircle size={14} className="spin" aria-hidden />;
  if (phase === "waiting" || phase === "expired") return <RefreshCw size={14} aria-hidden />;
  return <QrCode size={14} aria-hidden />;
}

/**
 * 光鸭扫码登录 —— 走 RFC 8628 设备码流程，**这套端点就是光鸭网页「扫码登录」
 * 按钮自己在用的那套**（2026-10-26 真站抓包确认：网页点「扫码登录」→
 * POST /v1/auth/device/code → 把 verification_url 编码成二维码）。
 *
 * 所以这里不是"模拟网页"，是走同一个官方协议。二维码里编的就是那个
 * verification_url，光鸭 App 扫到后会完成授权；之后我们轮询换 token 并绑定。
 *
 * 与夸克/UC 的区别：那两家的二维码内容是各家 CAS 的登录串，兑换时给
 * service_ticket；光鸭直接给 access_token + refresh_token。轮询期服务端不收
 * 任何状态 —— deviceCode 由本组件持有并回传，多实例部署行为一致。
 */
export function GuangYaQrConnect() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [session, setSession] = useState<Session | null>(null);
  const [message, setMessage] = useState<string>("");
  const generation = useRef(0);

  // Stop the poll loop when the panel unmounts (user switched brand / left the
  // page). Without this the loop keeps hitting the token endpoint until the
  // device code's own 120s expiry. Same guard as the quark/uc component.
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
      const res = await fetch(API, { method: "POST" });
      const data = (await res.json()) as { ok: boolean; error?: string } & Partial<Session>;
      // userCode is required too: without it the QR resolves to a 404 in the
      // 光鸭 app (see buildGuangYaQrContent). Fail fast rather than render a
      // code nobody can use.
      if (!data.ok || !data.deviceCode || !data.userCode || !data.verificationUrl) {
        throw new Error(data.error ?? "无法获取二维码");
      }
      if (generation.current !== myGen) return;
      const next: Session = {
        deviceCode: data.deviceCode,
        userCode: data.userCode,
        verificationUrl: data.verificationUrl,
        expiresIn: data.expiresIn ?? 120,
        interval: data.interval ?? 2,
      };
      setSession(next);
      setPhase("waiting");
      await pollLoop(next, myGen);
    } catch (error) {
      if (generation.current !== myGen) return;
      setPhase("error");
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function pollLoop(s: Session, myGen: number) {
    // The server's own expires_in (120s) is authoritative; poll slightly past it
    // so a last-second approval is not missed.
    const deadline = Date.now() + (s.expiresIn + 5) * 1000;
    const waitMs = Math.max(1, s.interval) * 1000;
    while (Date.now() < deadline && generation.current === myGen) {
      await new Promise((r) => setTimeout(r, waitMs));
      if (generation.current !== myGen) return;

      let status = "pending";
      let error: string | undefined;
      try {
        // This call also BINDS on approval — the device code is single-use, so
        // the exchange has to happen in the same request that observes it.
        const res = await fetch(`${API}/status?deviceCode=${encodeURIComponent(s.deviceCode)}`);
        const data = (await res.json()) as { ok: boolean; status?: string; error?: string };
        if (data.ok && data.status) {
          status = data.status;
        } else if (!data.ok) {
          // ANY non-ok response is terminal: the device code may already be spent
          // (this call consumes it), so looping would spin until the deadline
          // showing nothing. `data.error` can be absent, hence the fallback.
          error = data.error || "登录失败，请重新生成二维码";
        }
      } catch {
        // network blip — keep polling
      }
      if (generation.current !== myGen) return;

      if (error) {
        setPhase("error");
        setMessage(error);
        return;
      }
      if (status === "expired") {
        setPhase("expired");
        setMessage("二维码已过期，请重新生成。");
        return;
      }
      if (status === "confirmed") {
        setPhase("done");
        setMessage("光鸭云盘已连接。");
        router.refresh();
        return;
      }
    }
    if (generation.current === myGen) {
      setPhase("expired");
      setMessage("等待超时，请重新生成二维码。");
    }
  }

  return (
    <div className="qr-connect">
      <div className="qr-connect-controls">
        <button
          className="primary-button"
          type="button"
          onClick={start}
          disabled={phase === "loading"}
        >
          {buttonIcon(phase)}
          {phase === "idle" || phase === "done" ? "生成二维码" : "重新生成"}
        </button>
      </div>
      <p className="qr-hint">
        用光鸭 App 扫码登录；token 持久化到数据库，过期时自动续期（续期后自动保存）。
      </p>
      {session && phase === "waiting" ? (
        <div className="qr-frame">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`${API}/image?content=${encodeURIComponent(qrContent(session))}`}
            alt="光鸭云盘登录二维码"
          />
          <span className={`qr-status ${phase}`}>用光鸭 App 扫码</span>
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
