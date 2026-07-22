import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import type { SettingsAttentionItem } from "../lib/settings-attention";
import { CopyUpgradePromptButton } from "./copy-upgrade-prompt-button";

/** Settings-page Action Inbox. Empty => render nothing (quiet is a feature). */
export function SettingsActionInbox({ items }: { items: SettingsAttentionItem[] }) {
  if (items.length === 0) return null;

  return (
    <section className="settings-card attention-inbox" aria-labelledby="settings-attention-title">
      <div className="attention-inbox-heading" id="settings-attention-title">
        <AlertTriangle size={16} aria-hidden />
        <strong>需要处理（{items.length}）</strong>
      </div>
      <div className="attention-inbox-list">
        {items.map((item) => (
          <div key={item.id} className={`attention-item severity-${item.severity}`}>
            <div className="attention-item-copy">
              <div className="attention-item-title">{item.title}</div>
              <div className="attention-item-body">{item.body}</div>
              {item.kind === "update_available" && item.prompt ? (
                <div className="attention-item-prompt">
                  <CopyUpgradePromptButton prompt={item.prompt} />
                </div>
              ) : null}
            </div>
            {item.kind === "update_available" ? null : (
              <Link className="primary-button attention-item-action" href={item.href}>
                {item.actionLabel}
              </Link>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
