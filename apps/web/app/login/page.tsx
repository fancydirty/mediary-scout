"use client";

import { useEffect, useState, useTransition } from "react";
import { HelpCircle, LoaderCircle } from "lucide-react";

/**
 * §7 P1 login / register, with a context-aware CLAIM screen. Only reachable when
 * MEDIA_TRACK_MULTI_USER=1. On an UNCLAIMED instance (`/api/auth/bootstrap` →
 * needsClaim) the page becomes a claim screen: it registers the first user, which
 * adopts the seeded acct_default (keeping any existing library), and the copy makes
 * that explicit (接管 if a library already exists, otherwise 创建站主). Once claimed,
 * it's the normal login + open self-registration.
 */
export default function LoginPage() {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [whyOpen, setWhyOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [bootstrap, setBootstrap] = useState<{ needsClaim: boolean; hasExistingLibrary: boolean } | null>(null);

  useEffect(() => {
    fetch("/api/auth/bootstrap")
      .then((res) => res.json())
      .then((data) => setBootstrap(data))
      .catch(() => setBootstrap(null));
  }, []);

  const claiming = bootstrap?.needsClaim === true;
  // While unclaimed, only registration (→ adopt acct_default) is possible.
  const effectiveMode: "login" | "register" = claiming ? "register" : mode;

  const submit = () => {
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/auth/${effectiveMode}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (res.ok) {
        window.location.href = "/";
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? "操作失败，请重试。");
    });
  };

  const title = claiming
    ? bootstrap?.hasExistingLibrary
      ? "接管这台实例"
      : "创建站主账号"
    : mode === "login"
      ? "登录"
      : "创建账号";
  const note = claiming
    ? bootstrap?.hasExistingLibrary
      ? "这台实例已有媒体库。设置站主用户名 + 密码来接管它——你的库和网盘都会原样归你。"
      : "你是第一个用户。这个账号将成为站主，拥有管理权限。"
    : mode === "login"
      ? "登录以访问你的媒体库"
      : "创建一个本地账号开始使用";
  const buttonText = claiming ? "接管并进入" : mode === "login" ? "登录" : "创建并登录";

  return (
    <main style={{ maxWidth: 360, margin: "14vh auto", padding: "0 20px" }}>
      <div className="panel" style={{ textAlign: "center" }}>
        <h1 className="panel-title" style={{ margin: "0 0 6px" }}>
          {title}
        </h1>
        <p className="panel-note" style={{ marginBottom: 20 }}>
          {note}
        </p>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="setting-row" style={{ marginBottom: 10 }}>
            <input
              className="setting-control"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="用户名"
              aria-label="用户名"
              autoComplete="username"
            />
          </div>
          <div className="setting-row" style={{ marginBottom: 14 }}>
            <input
              type="password"
              className="setting-control"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="密码"
              aria-label="密码"
              autoComplete={effectiveMode === "login" ? "current-password" : "new-password"}
            />
          </div>
          {error ? (
            <p className="panel-note" style={{ color: "var(--danger, #e5484d)", marginBottom: 12 }}>
              {error}
            </p>
          ) : null}
          <button
            type="submit"
            className="primary-button"
            disabled={isPending}
            style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}
          >
            {isPending ? <LoaderCircle size={14} className="spin" aria-hidden /> : buttonText}
          </button>
        </form>

        {!claiming && mode === "register" ? (
          <div style={{ marginTop: 14 }}>
            <span
              role="note"
              tabIndex={0}
              onMouseEnter={() => setWhyOpen(true)}
              onMouseLeave={() => setWhyOpen(false)}
              onFocus={() => setWhyOpen(true)}
              onBlur={() => setWhyOpen(false)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                fontSize: 12,
                color: "var(--text-muted, #9a9a9a)",
                cursor: "help",
              }}
            >
              <HelpCircle size={13} aria-hidden />
              为什么我需要创建账号？
            </span>
            {whyOpen ? (
              <p
                className="panel-note"
                style={{
                  marginTop: 8,
                  textAlign: "left",
                  lineHeight: 1.7,
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid var(--border, #2a2a2a)",
                  borderRadius: 8,
                  padding: "10px 12px",
                }}
              >
                这个站点支持<strong>多人共用</strong>。注册账号后，你可以绑定<strong>自己的</strong> 115
                网盘，拥有一份只属于你的媒体库——你的获取记录、收藏都与其他用户互不可见。和家人或朋友合用
                同一个站点时，各自注册、各连各的 115 即可。
              </p>
            ) : null}
          </div>
        ) : null}

        {/* While unclaimed there is nobody to log in as, so hide the toggle. */}
        {!claiming ? (
          <p className="panel-note" style={{ marginTop: 16 }}>
            {mode === "login" ? "还没有账号？" : "已有账号？"}{" "}
            <button
              type="button"
              onClick={() => {
                setMode(mode === "login" ? "register" : "login");
                setError(null);
                setWhyOpen(false);
              }}
              style={{
                background: "none",
                border: "none",
                color: "var(--accent, #1db954)",
                cursor: "pointer",
                padding: 0,
                font: "inherit",
              }}
            >
              {mode === "login" ? "创建账号" : "去登录"}
            </button>
          </p>
        ) : null}
      </div>
    </main>
  );
}
