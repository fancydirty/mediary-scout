"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

/** One-click copy for the owner-to-agent upgrade instruction. Clipboard API can
 *  be unavailable on non-HTTPS self-host origins; fall back to selection. */
export function CopyUpgradePromptButton({ prompt }: { prompt: string }) {
  const [copied, setCopied] = useState(false);
  const [manual, setManual] = useState(false);

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(prompt);
      setManual(false);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setManual(true);
    }
  }

  return (
    <div className="update-copy-block">
      <button type="button" className="ghost-button" onClick={copyPrompt}>
        {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
        {copied ? "已复制" : "复制给本地 Agent"}
      </button>
      {manual ? (
        <textarea
          className="update-copy-textarea"
          value={prompt}
          readOnly
          rows={6}
          onFocus={(event) => event.currentTarget.select()}
          aria-label="升级指令"
        />
      ) : null}
    </div>
  );
}
