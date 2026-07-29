import { connection } from "next/server";
import { Globe, ShieldAlert, TriangleAlert } from "lucide-react";
import { getCurrentAccountSummary, hasLoginPassword } from "../../lib/workflow-runtime";
import {
  instanceTunnelToken,
  instanceConnectHostname,
  resolveRemoteAccessState,
  accountPasswordHref,
  BETA_SITE_URL,
  CONSOLE_URL,
} from "../../lib/remote-access";
import { PasswordChangeForm } from "../password-change-form";

/**
 * 「远程访问」设置 section。
 *
 * 非站主返回 `null` —— 与 `AccountManagementSection` 同款服务端判定
 * （`getCurrentAccountSummary().isOwner`，不是藏 UI）。slot 空即触发
 * `settings-tabs.tsx` 里的 MutationObserver 自动隐藏整个 tab，所以这里
 * **必须**返回 `null` 而不是空 fragment/空 div（那会流出一个直接子元素，
 * observer 就把 tab 判成可见了）。
 */
export async function RemoteAccessSection({
  searchParams,
}: {
  searchParams: Promise<{ w?: string }>;
}) {
  // connection() 必须是第一行：cacheComponents 下否则会在构建期预渲染，
  // 把 build 环境的 TUNNEL_TOKEN/账号状态烤成静态壳（PasswordChangeSection 同款教训）。
  // 本仓库禁用 `export const dynamic`，await connection() 是唯一手段。
  await connection();
  const me = await getCurrentAccountSummary();
  if (!me?.isOwner) return null;

  // hostname 现在有本地来源了:connect.sh 接入时把 MEDIARY_CONNECT_HOSTNAME
  // 写进 .env(worker 的 204 无 body 契约不变,不碰元数据端点)。
  const { w } = await searchParams;
  const passwordHref = accountPasswordHref(w);
  // 只求值一次:重复调用会重跑校验,理论上还可能在同一次渲染里读到不同 env。
  const localHostname = instanceConnectHostname();
  const state = await resolveRemoteAccessState({
    token: instanceTunnelToken(),
    hostname: localHostname,
  });

  if (state.kind === "not_provisioned") {
    // 内嵌报名表单已随设计改为**跳转链接**（beta.mediaryconnect.app 已上线，
    // 报名与问卷都在站上完成）。链接是唯一入口。
    // 没有「链接是否还活着」的自动检查：若 beta 站未来下线/迁移，把此分支
    // 改回 return null 即可让整个 tab 自动隐藏（settings-tabs.tsx 的机制）。
    return (
      <section className="panel" style={{ maxWidth: 720, marginTop: 24 }}>
        <div className="panel-header">
          <div>
            <h2 className="panel-title">
              <Globe size={16} aria-hidden style={{ verticalAlign: "-2px", marginRight: 8 }} />
              远程访问
            </h2>
            <p className="panel-note">
              从任何设备经加密隧道访问你的实例：不开端口、不需公网 IP、不需域名。
              内容与凭据始终只在你自己的机器上。
            </p>
          </div>
        </div>
        <a
          className="primary-button"
          href={BETA_SITE_URL}
          target="_blank"
          rel="noopener noreferrer"
          style={{ textDecoration: "none" }}
        >
          了解详情并申请内测 →
        </a>
        <p className="panel-note" style={{ marginTop: 10 }}>
          内测期免费，创始批 100 席。开通后回到这里会看到远程访问状态。
        </p>
      </section>
    );
  }

  const passwordState = await hasLoginPassword();
  // 三态：true / false / "unknown"（DB 读失败）。**不能**把 "unknown" 当 false，
  // 那会在数据库抖动时凭空弹出一条「你没设密码」的假警告；也不能当 true，
  // 那会在真没设密码时把唯一的警告吞掉。分开各说各话。
  const showNoPasswordWarning = passwordState === false;
  const showUnknownPasswordNote = passwordState === "unknown";

  return (
    <section className="panel" style={{ maxWidth: 720, marginTop: 24 }}>
      <div className="panel-header">
        <div>
          <h2 className="panel-title">
            <Globe size={16} aria-hidden style={{ verticalAlign: "-2px", marginRight: 8 }} />
            远程访问
          </h2>
          <p className="panel-note">经 Cloudflare 隧道对外发布本实例；关掉隧道容器即可随时下线</p>
        </div>
        <span className={`hub-badge tone-${state.kind === "active" ? "green" : "amber"}`}>
          {state.kind === "active" ? "已开启" : "状态未知"}
        </span>
      </div>

      {showNoPasswordWarning ? (
        <div
          role="alert"
          style={{
            display: "flex",
            gap: 10,
            padding: "12px 14px",
            marginBottom: 14,
            borderRadius: 8,
            border: "1px solid var(--danger, #e5484d)",
            background: "color-mix(in srgb, var(--danger, #e5484d) 12%, transparent)",
          }}
        >
          <ShieldAlert size={18} aria-hidden style={{ flexShrink: 0, marginTop: 1 }} />
          <div>
            <strong>远程访问已开启，但还没有设置登录密码。</strong>
            <p className="panel-note" style={{ margin: "4px 0 8px" }}>
              任何知道你域名的人都能直接进入，读取整个媒体库、网盘凭据与 LLM Key。请立即设置密码。
            </p>
            <a className="primary-button" href={passwordHref}>
              去设置密码
            </a>
          </div>
        </div>
      ) : null}

      {showUnknownPasswordNote ? (
        // 读不出密码状态 ≠ 没设密码。只提示「没能确认」，不冒充安全结论。
        <p className="panel-note" role="status" style={{ marginBottom: 12 }}>
          <TriangleAlert size={12} aria-hidden style={{ verticalAlign: "-2px", marginRight: 4 }} />
          暂时无法确认登录密码是否已设置（数据库读取失败）。
          若你尚未设置，请到{" "}
          <a href={passwordHref}>账号</a> 补上——远程访问下这是唯一的门禁。
        </p>
      ) : null}

      {state.kind === "active" && state.hostname ? (
        // 有本地 hostname(connect.sh 写进 .env)→ 直接给专属地址与链接。
        <div style={{ marginBottom: 14 }}>
          <p className="panel-note" style={{ margin: "0 0 6px" }}>你的专属地址</p>
          <a
            href={`https://${state.hostname}`}
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontFamily: "var(--font-mono, ui-monospace)", fontSize: "0.95rem" }}
          >
            {state.hostname}
          </a>
          <p className="panel-note" style={{ margin: "6px 0 0" }}>
            隧道连接正常。在任何设备的浏览器打开这个地址即可（收藏它）。
          </p>
        </div>
      ) : state.kind === "active" ? (
        // 早期接入的实例 .env 里没有 MEDIARY_CONNECT_HOSTNAME(connect.sh 后加的)
        // —— 回落到不给链接的旧文案,绝不臆造一个点了 404 的地址。
        <p className="panel-note" style={{ margin: "0 0 14px" }}>
          远程访问已开启，隧道连接正常。请使用开通时收到的专属地址访问（浏览器里收藏即可）。
        </p>
      ) : (
        <p className="panel-note" style={{ margin: "0 0 14px" }}>
          远程访问已开启，但暂时联系不上控制面，无法确认隧道状态。
          这通常是本机出站网络波动；不影响已建立的隧道，稍后刷新即可。
          {localHostname ? `（专属地址：${localHostname}）` : ""}
        </p>
      )}

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <a
          className="primary-button"
          href={CONSOLE_URL}
          target="_blank"
          rel="noopener noreferrer"
          style={{ textDecoration: "none" }}
        >
          打开 Mediary Connect 控制台 →
        </a>
        <span className="panel-note" style={{ margin: 0 }}>
          续期、换机器重新接入、查看到期时间都在控制台（用开通邮箱登录，无需密码）。
        </span>
      </div>

      {/* 远程访问的门禁就是本实例的登录密码——改它不必再跳去「账号」tab。
          改完服务端撤销所有会话,表单会把用户送回 /login 用新密码登入。
          **只在确知已设过密码时渲染**:changePasswordAction 要求填当前密码,
          没设密码的新实例根本填不出来,而且会紧贴在上面那条「还没设密码」
          警告下面,更让人糊涂——那种情况走警告里的「去设置密码」。
          passwordState === "unknown"(DB 读失败)同样不渲染:宁可少给一个
          表单,也不摆一个可能一提交就失败的东西。 */}
      {passwordState === true ? (
        <div
          style={{
            marginTop: 18,
            paddingTop: 16,
            borderTop: "1px solid var(--border, #2c2c2c)",
          }}
        >
          <p className="panel-note" style={{ margin: "0 0 4px", fontWeight: 600 }}>
            修改远程访问登录密码
          </p>
          <p className="panel-note" style={{ margin: "0 0 12px" }}>
            这就是打开专属地址时要输的密码（本实例的登录密码）。修改后所有设备需要重新登录。
          </p>
          <PasswordChangeForm />
        </div>
      ) : null}
    </section>
  );
}
