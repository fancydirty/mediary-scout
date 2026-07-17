"use client";

import { LoaderCircle, QrCode, RefreshCw } from "lucide-react";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

/** The FULL TianyiQrSession round-trips through the browser (the 天翼 poll needs
 *  uuid/paramId/lt/… — not just a token like quark). `cookies` is the STATEFUL
 *  login jar: every /status response returns an updated copy that must replace
 *  ours before the next poll / the final confirm. */
type CookieJar = Array<[string, string]>;
type Session = {
  uuid: string;
  encryuuid: string;
  paramId: string;
  reqId: string;
  lt: string;
  appId: string;
  clientType: string;
  returnUrl: string;
  cookies: CookieJar;
  qrcodeContent?: string;
};
type Phase = "idle" | "loading" | "waiting" | "scanned" | "confirming" | "done" | "expired" | "error";

/**
 * 天翼扫码登录:与 Quark/Pan115 QrConnect 同构的相位机。生成二维码(内容=裸 uuid)→
 * 用户天翼云盘 App 扫 → 每 2s 轮询(天翼非长轮询;有真实 scanned 相位)→ confirmed 拿
 * redirectUrl → /confirm 兑换全套 session + 绑定。
 * 🔴 cookie jar 滚动回传:每次 /status 都会带回更新过的 cookies,必须替换进 session
 * 再发起下一轮/最终 confirm —— 用旧 jar 会丢掉天翼轮换过的登录 cookie,真机上兑换会失败。
 * 扫码兑换失败时,外层折叠的 SSON 粘贴是回退。
 */
export function TianyiQrConnect() {
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
      const res = await fetch("/api/tianyi/qrcode", { method: "POST" });
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

  async function pollLoop(initial: Session, myGen: number) {
    // `current` is the freshest session — its jar is replaced from EVERY poll
    // response (rolling round-trip), and it is what the final confirm sends.
    let current = initial;
    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline && generation.current === myGen) {
      await new Promise((r) => setTimeout(r, 2000));
      if (generation.current !== myGen) return;
      let status = "waiting";
      let redirectUrl: string | undefined;
      try {
        const res = await fetch("/api/tianyi/qrcode/status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session: current }),
        });
        const data = (await res.json()) as {
          ok: boolean;
          status?: string;
          redirectUrl?: string;
          cookies?: CookieJar;
        };
        if (data.ok && data.status) {
          status = data.status;
          redirectUrl = data.redirectUrl;
          if (data.cookies) {
            // 🔴 make-or-break: store the poll's updated jar back into the
            // session so nothing 天翼 rotated mid-poll is dropped.
            current = { ...current, cookies: data.cookies };
            setSession(current);
          }
        }
      } catch {
        // transient — keep polling
      }
      if (generation.current !== myGen) return;
      if (status === "scanned") {
        setPhase("scanned");
      } else if (status === "confirmed" && redirectUrl) {
        setPhase("confirming");
        await confirm(current, redirectUrl, myGen);
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

  async function confirm(currentSession: Session, redirectUrl: string, myGen: number) {
    try {
      const res = await fetch("/api/tianyi/qrcode/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: currentSession, redirectUrl }),
      });
      const data = (await res.json()) as { ok: boolean; providerUid?: string; error?: string };
      if (!data.ok) {
        if (generation.current !== myGen) return;
        setPhase("error");
        setMessage(`${data.error ?? "登录失败"}（可改用下方手动粘 SSON cookie）`);
        return;
      }
      if (generation.current !== myGen) return;
      setPhase("done");
      setMessage("天翼云盘已连接。");
      router.refresh();
    } catch (error) {
      // Anything here is NOT a clean API error (those returned in `data` above):
      // a network failure (fetch threw) OR a JSON decode failure (response.json()
      // threw on a non-JSON body). Show a generic retry hint + the SSON fallback.
      if (generation.current !== myGen) return;
      setPhase("error");
      setMessage("网络异常，请重试。（可改用下方手动粘 SSON cookie）");
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
      <p className="qr-hint">用天翼云盘 App 扫码登录；凭证持久化到数据库，自动用于后续转存。</p>
      {session?.qrcodeContent && (phase === "waiting" || phase === "scanned" || phase === "confirming") ? (
        <div className="qr-frame">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/tianyi/qrcode/image?content=${encodeURIComponent(session.qrcodeContent)}`}
            alt="天翼云盘登录二维码"
          />
          <span className={`qr-status ${phase}`}>
            {phase === "waiting"
              ? "用天翼云盘 App 扫码"
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
