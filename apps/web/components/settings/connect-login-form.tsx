"use client";

import { useState, useTransition } from "react";
import { requestConnectLoginAction } from "../../app/actions";

/**
 * 设置页内的 Mediary Connect 登录框。
 *
 * 为什么在这里放一个登录框而不是只给跳转链接:能在这个页面操作的人
 * **已经有实例**(他正在用这个容器),把他踢去外站读一遍宣传再回来是多余的。
 * 跳转仍然保留,但降为次要出口。
 *
 * 提交走 server action —— worker 不发 CORS 头,浏览器直接 fetch 会被预检拦。
 */
export function ConnectLoginForm() {
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setMsg(null);
        startTransition(async () => {
          // **必须 catch**:server action 会 throw ——
          // demo 门禁(assertNotDemo → DemoReadOnlyError)、Next 的运行时错误、
          // 部署不一致导致的 action 找不到,都会走这里。不 catch 就是一个
          // 未处理的 promise rejection,而用户界面上**什么都不会变**
          // (按钮从 pending 复位,没有任何提示),他只会以为点了没反应。
          try {
            const r = await requestConnectLoginAction(email);
            setMsg({ ok: r.ok, text: r.message });
          } catch {
            // 不回显异常内容(可能含内部细节),给一句可操作的话。
            setMsg({ ok: false, text: "提交失败了。刷新页面后再试一次。" });
          }
        });
      }}
    >
      <p className="panel-note" style={{ margin: "0 0 6px" }}>
        用邮箱登录，就在这里开通
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input
          type="email"
          inputMode="email"
          autoComplete="email"
          placeholder="your@email.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={pending}
          aria-label="邮箱"
          style={{ flex: "1 1 220px", minWidth: 0 }}
        />
        <button className="primary-button" type="submit" disabled={pending}>
          {pending ? "发送中…" : "发送登录链接"}
        </button>
      </div>
      {msg ? (
        <p
          className="panel-note"
          role="status"
          style={{ marginTop: 10, color: msg.ok ? "var(--accent)" : "var(--negative)" }}
        >
          {msg.text}
        </p>
      ) : (
        <p className="panel-note" style={{ marginTop: 10 }}>
          第一次输入邮箱就是建号，没有注册这一步、也没有密码。点邮件里的链接回来，就能选档位与专属域名。
        </p>
      )}
    </form>
  );
}
