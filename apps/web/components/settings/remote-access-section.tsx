import { connection } from "next/server";
import { Globe, ShieldAlert, TriangleAlert } from "lucide-react";
import { getCurrentAccountSummary, hasLoginPassword } from "../../lib/workflow-runtime";
import {
  instanceTunnelToken,
  resolveRemoteAccessState,
  accountPasswordHref,
  BETA_SITE_URL,
} from "../../lib/remote-access";

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

  // hostname 当前无本地来源，故不传（详见 lib/remote-access.ts 文件头）。
  const { w } = await searchParams;
  const passwordHref = accountPasswordHref(w);
  const state = await resolveRemoteAccessState({ token: instanceTunnelToken() });

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

      {state.kind === "active" ? (
        // 刻意不显示专属域名/链接：worker 的状态端点回 204 无 body（不泄露任何
        // 端点元数据），而实例本地并没有存过自己的公网域名。臆造一个只会给出
        // 点了 404 的链接。详见 lib/remote-access.ts 文件头注释。
        <p className="panel-note" style={{ margin: 0 }}>
          远程访问已开启，隧道连接正常。请使用开通时收到的专属地址访问（浏览器里收藏即可）。
        </p>
      ) : (
        <p className="panel-note" style={{ margin: 0 }}>
          远程访问已开启，但暂时联系不上控制面，无法确认隧道状态。
          这通常是本机出站网络波动；不影响已建立的隧道，稍后刷新即可。
        </p>
      )}
    </section>
  );
}
