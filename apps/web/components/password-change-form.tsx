"use client";

import { useState, useTransition } from "react";
import { LoaderCircle } from "lucide-react";
import { changePasswordAction } from "../app/actions";

/** Self-service password change. On success all sessions are revoked server-side,
 *  so we send the user back to /login to sign in with the new password. */
export function PasswordChangeForm() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [isPending, startTransition] = useTransition();

  const submit = () => {
    setError(null);
    startTransition(async () => {
      const res = await changePasswordAction(current, next);
      if (res.ok) {
        setDone(true);
        setTimeout(() => {
          window.location.href = "/login";
        }, 1200);
        return;
      }
      setError(res.error ?? "修改失败，请重试。");
    });
  };

  if (done) {
    return <p className="panel-note" style={{ color: "var(--accent)" }}>已修改，正在跳转到登录页，请用新密码登录…</p>;
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      style={{ maxWidth: 320 }}
    >
      <div className="setting-row" style={{ marginBottom: 10 }}>
        <input
          type="password"
          className="setting-control"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          placeholder="当前密码"
          aria-label="当前密码"
          autoComplete="current-password"
        />
      </div>
      <div className="setting-row" style={{ marginBottom: 12 }}>
        <input
          type="password"
          className="setting-control"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          placeholder="新密码（至少 6 位）"
          aria-label="新密码"
          autoComplete="new-password"
        />
      </div>
      {error ? (
        <p className="panel-note" style={{ color: "var(--danger, #e5484d)", marginBottom: 10 }}>
          {error}
        </p>
      ) : null}
      <button type="submit" className="primary-button" disabled={isPending}>
        {isPending ? <LoaderCircle size={14} className="spin" aria-hidden /> : "修改密码"}
      </button>
    </form>
  );
}
