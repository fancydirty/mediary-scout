"use client";

import { useState, useTransition } from "react";
import { LoaderCircle } from "lucide-react";
import { resetUserPasswordAction } from "../app/actions";

interface ManagedAccount {
  id: string;
  username: string;
  isOwner: boolean;
  createdAt: string;
  driveCount: number;
}

/** Owner-only account list with per-user password reset. The owner check is also
 *  enforced server-side in resetUserPasswordAction — this UI is convenience, not the
 *  gate. Resetting never touches the user's drives or library. */
export function AccountAdminPanel({ accounts }: { accounts: ManagedAccount[] }) {
  return (
    <div className="account-admin">
      {accounts.map((account) => (
        <AccountAdminRow key={account.id} account={account} />
      ))}
    </div>
  );
}

function AccountAdminRow({ account }: { account: ManagedAccount }) {
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  const submit = () => {
    setMsg(null);
    startTransition(async () => {
      const res = await resetUserPasswordAction(account.id, pw);
      if (res.ok) {
        setMsg({ ok: true, text: `已重置「${account.username}」的密码，请把新密码交给 TA。` });
        setOpen(false);
        setPw("");
      } else {
        setMsg({ ok: false, text: res.error ?? "重置失败。" });
      }
    });
  };

  const created = account.createdAt.slice(0, 10);

  return (
    <div className="account-admin-row">
      <div className="account-admin-info">
        <span className="account-admin-name">{account.username}</span>
        {account.isOwner ? <span className="account-identity-owner">站主</span> : null}
        <span className="account-admin-meta">
          {created} · {account.driveCount} 个网盘
        </span>
      </div>
      <div className="account-admin-action">
        {open ? (
          <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
            <input
              type="text"
              className="setting-control"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              placeholder="新密码（至少 6 位）"
              aria-label={`${account.username} 的新密码`}
              style={{ width: 180 }}
            />
            <button type="button" className="primary-button" onClick={submit} disabled={isPending}>
              {isPending ? <LoaderCircle size={14} className="spin" aria-hidden /> : "确认"}
            </button>
            <button
              type="button"
              className="account-identity-item"
              style={{ width: "auto", padding: "7px 10px" }}
              onClick={() => {
                setOpen(false);
                setPw("");
              }}
            >
              取消
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="account-identity-item"
            style={{ width: "auto", padding: "7px 12px" }}
            onClick={() => {
              setOpen(true);
              setMsg(null);
            }}
          >
            重置密码
          </button>
        )}
      </div>
      {msg ? (
        <p
          className="panel-note"
          style={{ width: "100%", margin: "6px 0 0", color: msg.ok ? "var(--accent)" : "var(--danger, #e5484d)" }}
        >
          {msg.text}
        </p>
      ) : null}
    </div>
  );
}
