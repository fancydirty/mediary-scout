"use client";

import { useState, useTransition } from "react";
import { runAction } from "../../lib/run-action";
import { testRemoteAccessConnectionAction } from "../../app/actions";

/**
 * 「测试连接」—— 回答用户真正的问题:"我的域名现在能不能打开"。
 *
 * 与「上次报到」那一行互补:last_seen_at 只证明本机→控制面(出站),
 * 探测打的是 https://<hostname>/api/health(入站),两者方向相反。
 *
 * 点击才探测(不自动跑):探测是跨网请求,不该在渲染路径上发生。
 */
export function RemoteAccessTestButton() {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <button
        type="button"
        className="ghost-button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            // runAction 统一异常边界(Spec B):server action 会 throw
            // (网络中断、demo 门禁、部署不一致),不 catch 就是静默失败。
            const r = await runAction(
              () => testRemoteAccessConnectionAction(),
              (m) => setResult({ ok: false, message: m }),
            );
            if (!r.ok) return;
            const v = r.value;
            setResult(
              v.detail === "reachable"
                ? { ok: true, message: "连接正常" }
                : v.detail === "instance_problem"
                  ? { ok: false, message: "隧道通了,但实例内部有问题(如数据库)。请检查那台机器。" }
                  : v.detail === "no_hostname"
                    ? { ok: false, message: "本机未配置专属地址,无法探测。" }
                    : { ok: false, message: "连不上。隧道可能断了,或实例不在线。" },
            );
          })
        }
      >
        {pending ? "检测中…" : "测试连接"}
      </button>
      {result ? (
        <span className={`push-help ${result.ok ? "" : "tone-amber"}`}>{result.message}</span>
      ) : null}
    </span>
  );
}
