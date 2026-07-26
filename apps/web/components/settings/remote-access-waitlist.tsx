"use client";

import { useState } from "react";
import { LoaderCircle } from "lucide-react";

/**
 * 内测 waitlist 登记表单。直接打 worker 的公开端点（`POST /waitlist`，
 * 无鉴权），不经本实例的 API —— 未开通的实例没有任何凭据可代理这次请求。
 *
 * 契约见 `workers/scout-connect/README.md`：
 *   201 `{ id, position }`               新登记
 *   200 `{ already_exists, id, position }` 已在队列（position 是 201 的严格超集）
 *   400 `{ error }`                      email required / invalid email / invalid json / invalid body
 *   413 `{ error: "body too large" }`
 *
 * 两条成功路径都带 `position`，所以这里不按状态码分支取排名——重复提交
 * （双击/刷新）正是用户想再看一眼排名的时刻。
 */

/** 与服务端同一个默认值（见 lib/remote-access.ts）。 */
const DEFAULT_WORKER_BASE = "https://mediaryconnect.app";

export function RemoteAccessWaitlistForm(props: { workerBaseUrl?: string }) {
  const [email, setEmail] = useState("");
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, setPending] = useState(false);

  const base = (props.workerBaseUrl?.trim() || DEFAULT_WORKER_BASE).replace(/\/+$/, "");

  const submit = async () => {
    setPending(true);
    setResult(null);
    try {
      const res = await fetch(`${base}/waitlist`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      // 错误响应也可能不是 JSON（网关/反代插进来的 HTML 502），parse 失败
      // 不能把整个 handler 炸成 unhandled rejection。
      const data = (await res.json().catch(() => null)) as
        | { id?: string; position?: number; already_exists?: boolean; error?: string }
        | null;

      if (res.ok) {
        // position 两条成功路径都有；万一缺了也别显示 "第 undefined 位"。
        const position = typeof data?.position === "number" ? data.position : null;
        const prefix = data?.already_exists ? "你已经在队列里" : "已登记";
        setResult({
          ok: true,
          text: position === null ? `${prefix}。` : `${prefix}，当前排在第 ${position} 位。`,
        });
        return;
      }
      setResult({ ok: false, text: waitlistErrorText(res.status, data?.error) });
    } catch {
      setResult({ ok: false, text: "网络异常，提交失败——请稍后再试。" });
    } finally {
      setPending(false);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!pending) void submit();
      }}
      style={{ maxWidth: 420, marginTop: 14 }}
    >
      <div className="setting-row" style={{ marginBottom: 10 }}>
        <input
          type="email"
          required
          className="setting-control"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="你的邮箱"
          aria-label="用于接收内测邀请的邮箱"
          autoComplete="email"
        />
      </div>
      <button type="submit" className="primary-button" disabled={pending || email.trim() === ""}>
        {pending ? <LoaderCircle size={14} className="spin" aria-hidden /> : "申请内测资格"}
      </button>
      {result ? (
        <p
          className="panel-note"
          // 提交结果要被读屏播报：它是用户这次操作的唯一反馈。
          role="status"
          style={{ margin: "10px 0 0", color: result.ok ? "var(--accent)" : "var(--danger, #e5484d)" }}
        >
          {result.text}
        </p>
      ) : null}
    </form>
  );
}

/** worker 的 error 串是英文且面向调用方，直接展示对用户无意义——按状态码归类。 */
function waitlistErrorText(status: number, error: string | undefined): string {
  if (status === 400) {
    // invalid json / invalid body 属于本表单自己发错了，不该怪用户的邮箱格式。
    return error === "email required" || error === "invalid email"
      ? "邮箱格式不正确，请检查后重试。"
      : "提交内容有误，请刷新页面后重试。";
  }
  if (status === 413) return "邮箱地址过长，请换一个。";
  if (status === 429) return "提交过于频繁，请稍后再试。";
  if (status >= 500) return "服务暂时不可用，请稍后再试。";
  return "提交失败，请稍后再试。";
}
