import Link from "next/link";
import { AlertTriangle, CircleAlert, Rocket } from "lucide-react";
import type { SettingsAttentionItem, AttentionKind } from "../lib/settings-attention";
import { CopyUpgradePromptButton } from "./copy-upgrade-prompt-button";
import { DismissAttentionButton } from "./dismiss-attention-button";

/**
 * Settings-page Action Inbox. Empty => render nothing (quiet is a feature).
 *
 * 视觉契约：卡片永远是标准面板底色；严重级别只通过左侧 3px 信号条 +
 * 条目图标色表达（info=绿/warning=琥珀/blocker=红）。「有新版本」是
 * 信息级（info）——它是新闻，不是警告。
 */
const KIND_ICON: Record<AttentionKind, typeof Rocket> = {
  update_available: Rocket,
  frozen_drive: AlertTriangle,
  missing_llm: CircleAlert,
  search_source_unreachable: CircleAlert,
};

const KIND_CLASS: Record<AttentionKind, string> = {
  update_available: "kind-info",
  frozen_drive: "kind-blocker",
  missing_llm: "kind-warning",
  search_source_unreachable: "kind-warning",
};

export function SettingsActionInbox({ items }: { items: SettingsAttentionItem[] }) {
  if (items.length === 0) return null;

  return (
    <section className="settings-card attention-inbox" aria-labelledby="settings-attention-title">
      <div className="attention-inbox-heading" id="settings-attention-title">
        <strong>需要处理（{items.length}）</strong>
        <span className="sub">点开即视为已读，条目可单独删除</span>
      </div>
      <div className="attention-inbox-list">
        {items.map((item) => {
          const Icon = KIND_ICON[item.kind];
          return (
            <div key={item.id} className={`attention-item ${KIND_CLASS[item.kind]}`}>
              <div className="attention-item-copy">
                <Icon className="attention-item-icon" size={16} aria-hidden />
                <div>
                  <div className="attention-item-title">{item.title}</div>
                  <div className="attention-item-body">{item.body}</div>
                  {item.kind === "update_available" && item.prompt ? (
                    <div className="attention-item-prompt">
                      <CopyUpgradePromptButton prompt={item.prompt} />
                    </div>
                  ) : null}
                </div>
              </div>
              <div className="attention-item-actions">
                {item.kind === "update_available" ? null : (
                  <Link className="primary-button attention-item-action" href={item.href}>
                    {item.actionLabel}
                  </Link>
                )}
                <DismissAttentionButton id={item.id} />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
