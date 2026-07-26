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

/**
 * `workerBaseUrl` 是**必填**且刻意没有本地默认值：唯一来源是服务端的
 * `scoutConnectBaseUrl()`（见 lib/remote-access.ts），由调用方透传下来。
 *
 * 这里若留一个 `?:` + 本地兜底常量，某个将来忘记传参的调用点就会**静默**
 * 退回生产 worker——把预发/自建实例的报名写进真实队列，正是上一个 commit
 * 修掉的 bug。设成必填后，漏传是编译错误，不是线上脏数据。
 */
export function RemoteAccessWaitlistForm(props: { workerBaseUrl: string }) {
  const [email, setEmail] = useState("");
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, setPending] = useState(false);

  const base = props.workerBaseUrl.trim().replace(/\/+$/, "");

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
        // 光看 res.ok 不够：网关塞回来的 200 HTML、或空 body 让 json() 解析失败时，
        // data 会是 null，用户却看到「已登记」——一次根本没发生的报名。
        // 契约（README + addToWaitlist JSDoc）两条成功路径都必带 id:string 与
        // position:number，所以拿它们当「这确实是 worker 的应答」的凭据。
        const hasContract = typeof data?.id === "string" && typeof data?.position === "number";
        if (!hasContract) {
          setResult({
            ok: false,
            text: "提交后没收到有效回执，无法确认是否登记成功——请稍后重试一次。",
          });
          return;
        }
        const prefix = data.already_exists ? "你已经在队列里" : "已登记";
        setResult({ ok: true, text: `${prefix}，当前排在第 ${data.position} 位。` });
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
      <button
        type="submit"
        className="primary-button"
        disabled={pending || email.trim() === ""}
        // 提交中按钮内只剩 aria-hidden 的 spinner，读屏会念成无名「按钮」。
        // 用 aria-label 补一个始终存在的可访问名称（仓库既有约定，见 login/page.tsx）。
        aria-label={pending ? "正在提交内测申请" : "申请内测资格"}
        aria-busy={pending}
      >
        {pending ? <LoaderCircle size={14} className="spin" aria-hidden /> : "申请内测资格"}
      </button>
      {result ? (
        <p
          className="panel-note"
          // 提交结果要被读屏播报：它是用户这次操作的唯一反馈。
          // 失败走 alert（assertive，立刻打断）——politeness 下的失败提示很容易
          // 被用户完全错过，而这时表单看起来「什么都没发生」。成功走 status。
          // 与 remote-access-section.tsx 的无密码警告同款约定。
          role={result.ok ? "status" : "alert"}
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
