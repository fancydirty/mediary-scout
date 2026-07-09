"use client";

import { useTransition } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { LogOut, KeyRound, Users, LoaderCircle } from "lucide-react";

/**
 * Sidebar account-identity block (multi-user only): who am I + a dropdown to change
 * password, log out, and (owner only) open account management. Distinct from the
 * drive/workspace switcher — that picks a drive, this picks/acts on the person.
 */
export function AccountIdentity({ username, isOwner }: { username: string; isOwner: boolean }) {
  const [isPending, startTransition] = useTransition();
  const initial = username.trim().charAt(0).toUpperCase() || "?";
  // Preserve the active workspace (?w) like the sidebar's globalNavHref does —
  // otherwise opening 账号 settings from a non-primary drive resets the context.
  const w = useSearchParams().get("w");
  const accountHref = (hash: string) =>
    `/settings?tab=account${w ? `&w=${encodeURIComponent(w)}` : ""}${hash}`;

  const logout = () => {
    startTransition(async () => {
      await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
      window.location.href = "/login";
    });
  };

  return (
    <details className="account-identity">
      <summary className="account-identity-summary">
        <span className="account-identity-dot" aria-hidden>
          {initial}
        </span>
        <span className="account-identity-name">{username}</span>
        {isOwner ? <span className="account-identity-owner">站主</span> : null}
      </summary>
      <div className="account-identity-menu">
        <Link className="account-identity-item" href={accountHref("#password")}>
          <KeyRound size={14} aria-hidden />
          修改密码
        </Link>
        {isOwner ? (
          <Link className="account-identity-item" href={accountHref("#accounts")}>
            <Users size={14} aria-hidden />
            账号管理
          </Link>
        ) : null}
        <button type="button" className="account-identity-item" onClick={logout} disabled={isPending}>
          {isPending ? <LoaderCircle size={14} className="spin" aria-hidden /> : <LogOut size={14} aria-hidden />}
          退出登录
        </button>
      </div>
    </details>
  );
}
