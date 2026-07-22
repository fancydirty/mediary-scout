"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

/** One-click copy for the owner-to-agent upgrade instruction. The full prompt is
 *  also visible behind <details> so the flow still works when the browser blocks
 *  Clipboard API (non-HTTPS self-host origins / automation contexts). */
export function CopyUpgradePromptButton({ prompt }: { prompt: string }) {
  const [copied, setCopied] = useState(false);
  const [manual, setManual] = useState(false);
  const timeoutRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  async function copyPrompt() {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    try {
      await navigator.clipboard.writeText(prompt);
      setManual(false);
      setCopied(true);
      timeoutRef.current = window.setTimeout(() => {
        setCopied(false);
        timeoutRef.current = null;
      }, 1800);
    } catch {
      setCopied(false);
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
      <details className="update-prompt-details">
        <summary>查看完整升级指令</summary>
        <pre>{prompt}</pre>
      </details>
    </div>
  );
}
