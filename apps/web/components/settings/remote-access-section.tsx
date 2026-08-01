import { connection } from "next/server";
import { Globe, ShieldAlert, TriangleAlert } from "lucide-react";
import { getCurrentAccountSummary, hasLoginPassword } from "../../lib/workflow-runtime";
import {
  instanceTunnelToken,
  instanceConnectHostname,
  resolveRemoteAccessState,
  accountPasswordHref,
  formatLastSeen,
  CONNECT_SITE_URL,
  consoleUrl,
} from "../../lib/remote-access";
import { PasswordChangeForm } from "../password-change-form";
import { ConnectLoginForm } from "./connect-login-form";
import { RemoteAccessTestButton } from "./remote-access-test-button";

/**
 * 「上次从本机报到控制面」一行。
 *
 * **措辞是这个组件存在的全部理由。** 它显示的是 `endpoints.last_seen_at`,
 * 而那个值只在**本容器主动打到 worker** 时更新(出站方向)。用户真正想知道的是
 * 「外网现在能不能打开我的域名」(入站方向) —— **两个方向的失败模式完全不重叠**:
 * 容器出站正常但 cloudflared 容器挂了,是最常见的故障,而这个时间戳在那种情况下
 * 依然显示「刚刚」。
 *
 * 所以主语必须是「本机 → 控制面」。**绝不能写成「隧道已连接」「远程访问正常」**
 * 之类暗示入站可达的说法 —— 那就是拿一个恒真的指标冒充健康检查。
 * 真正回答入站问题的是「测试连接」按钮(C2)。
 */
function LastSeenLine({ label }: { label: string }) {
  return (
    <p className="panel-note" style={{ margin: "6px 0 0", opacity: 0.85 }}>
      本机上次向控制面报到：{label}
    </p>
  );
}

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

  // 「上次报到」只在 active 态有意义 —— 降级态本来就是「拿不到状态」,
  // 那时摆一个旧时间戳出来只会让人以为它是当前状态。
  const lastSeenLabel = state.kind === "active" ? formatLastSeen(state.lastSeenAt) : null;

  if (state.kind === "not_provisioned") {
    // **双入口**:登录框(主)+ apex 跳转(次)。
    // 登录框占主位是刻意的 —— 能在这个页面操作的人已经有实例(他正在用这个
    // 容器),转化路径最短,不该把他踢去外站读一遍宣传再回来。
    // 跳转仍然保留给「想先了解」的人。
    return (
      <section className="panel" style={{ maxWidth: 720, marginTop: 24 }}>
        <div className="panel-header">
          <div>
            <h2 className="panel-title">
              <Globe size={16} aria-hidden style={{ verticalAlign: "-2px", marginRight: 8 }} />
              远程访问服务已上线
            </h2>
            <p className="panel-note">
              给这台实例一个专属域名，在外面也能打开 —— 不用给路由器开端口、不用 DDNS、不用公网 IP。
              媒体内容与网盘凭据始终留在这台机器上。
            </p>
          </div>
          <span className="hub-badge tone-green">NEW</span>
        </div>

        <ConnectLoginForm />

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
            marginTop: 14,
            paddingTop: 14,
            borderTop: "1px solid var(--border)",
          }}
        >
          <span className="panel-note" style={{ margin: 0 }}>
            想先了解？
          </span>
          <a
            className="secondary-button"
            href={CONNECT_SITE_URL}
            target="_blank"
            rel="noopener noreferrer"
            style={{ textDecoration: "none" }}
          >
            打开 mediaryconnect.app ↗
          </a>
        </div>

        <p className="panel-note" style={{ marginTop: 14 }}>
          <strong>它做什么：</strong>用一条 Cloudflare 加密隧道把这台实例发布到{" "}
          <code>你选的名字.mediaryconnect.app</code>。<strong>它不做什么：</strong>
          不托管实例、不代你搜索下载、不持有这台机器的访问密码。预付时长，不自动续费，14 天无理由退款。
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
            在任何设备的浏览器打开这个地址即可（收藏它）。
          </p>
          {lastSeenLabel ? <LastSeenLine label={lastSeenLabel} /> : null}
          <div style={{ marginTop: 8 }}>
            <RemoteAccessTestButton />
          </div>
        </div>
      ) : state.kind === "active" ? (
        // 早期接入的实例 .env 里没有 MEDIARY_CONNECT_HOSTNAME(connect.sh 后加的)
        // —— 回落到不给链接的旧文案,绝不臆造一个点了 404 的地址。
        <div style={{ margin: "0 0 14px" }}>
          <p className="panel-note" style={{ margin: 0 }}>
            远程访问已开启。请使用开通时收到的专属地址访问（浏览器里收藏即可）。
          </p>
          {lastSeenLabel ? <LastSeenLine label={lastSeenLabel} /> : null}
          {/* 无 hostname 也要给探测按钮:action 会返回 no_hostname 的明确
              说明,而不是让用户干猜(Copilot round 3)。 */}
          <div style={{ marginTop: 8 }}>
            <RemoteAccessTestButton />
          </div>
        </div>
      ) : (
        <>
          <p className="panel-note" style={{ margin: "0 0 14px" }}>
            远程访问已开启，但暂时联系不上控制面，无法确认隧道状态。
            这通常是本机出站网络波动；不影响已建立的隧道，稍后刷新即可。
            {localHostname ? `（专属地址：${localHostname}）` : ""}
          </p>
          {/* 降级态正是最需要用「入站探测」确认域名是否可达的场景
              (出站失败 ≠ 入站失败,两个方向独立)—— 按钮必须在这里
              也能用(Copilot round 3)。 */}
          <div style={{ margin: "0 0 14px" }}>
            <RemoteAccessTestButton />
          </div>
        </>
      )}

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <a
          className="primary-button"
          href={consoleUrl()}
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
