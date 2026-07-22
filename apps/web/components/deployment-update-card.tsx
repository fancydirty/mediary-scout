import { ArrowUpCircle, ExternalLink } from "lucide-react";
import {
  buildContainerUpgradePrompt,
  GITHUB_MAIN_COMPARE_URL,
  type DeploymentUpdateState,
} from "../lib/deployment-update";
import { CopyUpgradePromptButton } from "./copy-upgrade-prompt-button";

/** Quiet self-host update hint. Only a confirmed-behind compose container gets
 *  the copyable agent instruction; probe failure renders nothing (false alarms
 *  are worse than no reminder). Desktop releases use the download route instead. */
export function DeploymentUpdateCard({ state }: { state: DeploymentUpdateState }) {
  if (state.kind === "desktop") {
    return (
      <section className="settings-card update-card" aria-labelledby="deployment-update-title-desktop">
        <p id="deployment-update-title-desktop">
          桌面版检查更新请看{" "}
          <a href="https://github.com/fancydirty/mediary-scout/releases/latest" target="_blank" rel="noreferrer">
            Releases
          </a>
          ；新版本可直接覆盖安装，不需要先卸载。
        </p>
      </section>
    );
  }
  if (state.kind !== "container" || state.behind !== true || !state.currentShort || !state.latestShort) {
    return null;
  }
  const prompt = buildContainerUpgradePrompt({
    currentShort: state.currentShort,
    latestShort: state.latestShort,
  });
  return (
    <section className="settings-card update-card" aria-labelledby="deployment-update-title">
      <div className="update-card-heading" id="deployment-update-title">
        <ArrowUpCircle size={18} aria-hidden />
        <strong>当前版本与远端 main 不同</strong>
      </div>
      <p>
        当前构建 <code>{state.currentShort}</code>，远端 <code>{state.latestShort}</code>。
        如果你按本项目 main 自部署，通常可安全升级；自定义分支/固定版本请先核对变更。
        不需要卸载容器；把下面指令发给你部署机上的 Agent，它会按项目自检流程升级。
      </p>
      <div className="update-card-actions">
        <CopyUpgradePromptButton prompt={prompt} />
        <a className="ghost-button update-link" href={GITHUB_MAIN_COMPARE_URL} target="_blank" rel="noreferrer">
          <ExternalLink size={14} aria-hidden />
          查看 main 变更
        </a>
      </div>
    </section>
  );
}
