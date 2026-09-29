import { connection } from "next/server";
import { isDemoMode } from "../../lib/demo-mode";
import { getAutoUpdateSettings, getWorkflowRepository, resolveIsDesktop } from "../../lib/workflow-runtime";
import { ACTIVE_UPDATER_PHASES, type UpdateView } from "../../lib/update-state";
import { loadUpdateView } from "../../lib/update-view-server";
import { resolveCurrentIsOwner } from "../../lib/settings-attention-server";
import type { UpdaterPhase } from "../../lib/updater-client";
import { AutoUpdateSwitch, CheckUpdatesButton, CopyCommandButton, UpdateNowButton } from "./update-actions";

const MIGRATE_COMMAND = "./scripts/deploy.sh";

const KIND_LABEL = { add: "新增", improve: "改进", fix: "修复" } as const;

/** How to install the download, by installer type ("page" = the release page). */
const INSTALL_HINT = {
  dmg: "下载后打开 .dmg，先从菜单栏图标退出巡影，再把新版拖进「应用程序」替换。数据和设置都会保留。",
  exe: "下载后运行安装包，它会先关掉正在运行的巡影再安装。数据和设置都会保留。",
  page: "在发布页下载对应系统的安装包。数据和设置都会保留。",
} as const;

/* Hallmark · component: update-tab · genre: modern-minimal · theme: project (apps/web/DESIGN.md, Spotify)
 * states: up-to-date · update-available · desktop-download · updating · waiting · rolled-back · no-updater · offline feed · auto-update row
 * 方向 A：状态卡在上 · 更新日志在下。 */
export async function UpdateSection() {
  await connection();
  if (isDemoMode() || !(await resolveCurrentIsOwner())) return null;
  const desktop = resolveIsDesktop();
  const [view, autoUpdate] = await Promise.all([loadUpdateView(), getAutoUpdateSettings(getWorkflowRepository())]);
  return <UpdateTab view={view} desktop={desktop} autoUpdate={autoUpdate} />;
}

export function ReleaseBlock({ release }: { release: UpdateView["releases"][number] }) {
  return (
    <div className="update-release">
      <div className="update-release-head">
        <strong>{release.tag}</strong>
        <span className="update-faint">{release.date}</span>
        {release.isCurrent ? <span className="service-pill">当前</span> : null}
      </div>
      <ul>
        {release.notes.map((note, index) => (
          <li key={`${index}:${note.text}`}>
            <span className={`update-kind is-${note.kind}`}>{KIND_LABEL[note.kind]}</span>
            {note.text}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Desktop: a newer published release → download it here; cannot tell → the release page; up to date → nothing. */
function DesktopUpdateHint({ view }: { view: UpdateView }) {
  if (view.download) {
    return (
      <div className="update-download">
        <a className="primary-button" href={view.download.url} target="_blank" rel="noopener noreferrer">
          下载新版本
        </a>
        <p className="update-muted">{INSTALL_HINT[view.download.file ?? "page"]}</p>
      </div>
    );
  }
  if (view.status === "latest") return null;
  return (
    <p className="update-muted">
      桌面版在{" "}
      <a href="https://github.com/fancydirty/mediary-scout/releases/latest" target="_blank" rel="noopener noreferrer">
        发布页
      </a>{" "}
      下载新版本安装包。
    </p>
  );
}

function outcomeLabel(phase: UpdaterPhase): string {
  if (phase === "done") return "成功";
  if (phase === "rolled_back") return "已回滚";
  return "没成功";
}

export function formatUpdateFinishedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

export function UpdateTab({
  view,
  desktop,
  autoUpdate,
}: {
  view: UpdateView;
  desktop: boolean;
  autoUpdate: { enabled: boolean; time: string };
}) {
  const updating = Boolean(view.updater && ACTIVE_UPDATER_PHASES.has(view.updater.phase));
  const failed = Boolean(view.updater && (view.updater.phase === "rolled_back" || view.updater.phase === "failed"));
  return (
    <div className="update-tab">
      <section className="panel update-status">
        <div className="update-status-head">
          <div>
            <div className="update-faint">当前版本</div>
            <div className="update-version">{view.current.label}</div>
          </div>
          <div className="update-status-side">
            {view.available ? (
              <span className="service-pill is-on">有新版本 {view.available.tag}</span>
            ) : view.status === "offline" ? (
              <span className="service-pill is-off">暂时查不到新版本</span>
            ) : view.status === "unknown" ? (
              <span className="service-pill is-off">无法确认是否最新</span>
            ) : (
              <span className="service-pill">已是最新</span>
            )}
            {!desktop && !updating && !view.available ? <CheckUpdatesButton /> : null}
          </div>
        </div>
        {desktop ? <DesktopUpdateHint view={view} /> : null}
        {!desktop && view.updater && (updating || (view.available && !view.updater.needsManualRecovery)) ? (
          <UpdateNowButton tag={updating ? null : (view.available?.tag ?? null)} initial={view.updater} />
        ) : null}
        {!desktop && !updating && view.available && !view.updater && view.updaterInstalled ? (
          <p className="update-muted">更新助手暂时没有回应，稍后刷新再试。</p>
        ) : null}
        {!desktop && !updating && view.available && !view.updater && !view.updaterInstalled ? (
          <div className="update-migrate">
            <p className="update-muted">一键更新需要先完成一次手动升级。在部署目录运行：</p>
            <pre className="update-cmd">{MIGRATE_COMMAND}</pre>
            <CopyCommandButton command={MIGRATE_COMMAND} />
          </div>
        ) : null}
        {!desktop && failed && view.updater ? (
          <div className="update-failure">
            <p className="update-warn">{view.updater.message}</p>
            <details>
              <summary>查看详情</summary>
              <pre className="update-cmd">{view.updater.logTail}</pre>
            </details>
          </div>
        ) : null}
        {!desktop && view.updater?.finishedAt ? (
          <p className="update-muted">
            上次更新：{formatUpdateFinishedAt(view.updater.finishedAt)} · {outcomeLabel(view.updater.phase)}
          </p>
        ) : null}
      </section>
      {!desktop && view.updaterInstalled ? (
        <section className="panel update-auto">
          <AutoUpdateSwitch initial={autoUpdate} />
          <p className="update-muted">
            有新版本时，每天这个时间自动更新；有获取任务在进行时会等它结束。更新需要几分钟，期间网页会短暂打不开。同一个版本连续两次没更新成功，就不再自动重试，等你点「立即更新」。
          </p>
        </section>
      ) : null}
      <section className="panel update-log">
        <h3 className="update-log-title">更新日志</h3>
        {view.releases.length === 0 ? <p className="update-muted">暂时查不到更新日志。</p> : null}
        {view.releases.slice(0, 3).map((release) => (
          <ReleaseBlock key={release.tag} release={release} />
        ))}
        {view.releases.length > 3 ? (
          <details className="update-older">
            <summary>更早的版本</summary>
            {view.releases.slice(3, 10).map((release) => (
              <ReleaseBlock key={release.tag} release={release} />
            ))}
            {view.releases.length > 10 ? (
              <p className="update-muted">
                这里只列最近 10 个版本，更早的见{" "}
                <a href="https://github.com/fancydirty/mediary-scout/tree/main/release-notes" target="_blank" rel="noopener noreferrer">
                  全部发布说明
                </a>
                。
              </p>
            ) : null}
          </details>
        ) : null}
      </section>
    </div>
  );
}
