"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy, ExternalLink, Play } from "lucide-react";

export interface DirectPlayButtonProps {
  embyItemId: string;
  /** Short-lived, item-scoped playback token (`pt_...`). */
  playbackToken: string;
  label?: string;
  compact?: boolean;
}

export function DirectPlayButton({
  embyItemId,
  playbackToken,
  label = "播放",
  compact = false,
}: DirectPlayButtonProps) {
  const [open, setOpen] = useState(false);
  const [alignLeft, setAlignLeft] = useState(false);
  const [copied, setCopied] = useState(false);
  const [manualCopyUrl, setManualCopyUrl] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!open) {
      setManualCopyUrl(null);
      return;
    }
    const onPointerDown = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const buildStreamUrl = (): string => {
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    return `${origin}/emby/Videos/${encodeURIComponent(embyItemId)}/stream?Static=true&api_key=${encodeURIComponent(playbackToken)}`;
  };

  const toggleMenu = (event: React.MouseEvent) => {
    event.stopPropagation();
    if (!open && wrapRef.current && typeof window !== "undefined") {
      const rect = wrapRef.current.getBoundingClientRect();
      // Right-aligned menu needs ~192px to the left of rect.right; flip left-aligned when near left edge.
      setAlignLeft(rect.right < 200 && window.innerWidth - rect.left >= 180);
    }
    setOpen((v) => !v);
  };

  const openScheme = (schemeBuilder: (streamUrl: string) => string) => {
    const url = schemeBuilder(buildStreamUrl());
    setOpen(false);
    window.location.href = url;
  };

  const copyStreamUrl = async () => {
    const url = buildStreamUrl();
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        ok = true;
      }
    } catch {
      ok = false;
    }
    if (!ok && typeof document !== "undefined") {
      try {
        const ta = document.createElement("textarea");
        ta.value = url;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        try {
          ta.select();
          ok = document.execCommand("copy");
        } finally {
          document.body.removeChild(ta);
        }
      } catch {
        ok = false;
      }
    }
    if (ok) {
      setManualCopyUrl(null);
      setCopied(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => {
        copyTimerRef.current = null;
        setCopied(false);
        setOpen(false);
      }, 1200);
    } else {
      // Plain HTTP LAN context without clipboard access: keep menu open with selectable URL input.
      setManualCopyUrl(url);
    }
  };

  return (
    <div className={`direct-play-wrap${compact ? " is-compact" : ""}`} ref={wrapRef}>
      <button
        type="button"
        className={compact ? "direct-play-compact-btn" : "primary-button"}
        onClick={toggleMenu}
        aria-expanded={open}
        aria-haspopup="menu"
        title={compact ? "选择外部播放器播放" : undefined}
      >
        <Play size={compact ? 11 : 14} aria-hidden />
        {compact ? null : label}
      </button>
      {open ? (
        <div
          className={`direct-play-menu${alignLeft ? " is-align-left" : ""}`}
          role="menu"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            className="direct-play-menu-item"
            onClick={() => openScheme((u) => `iina://weblink?url=${encodeURIComponent(u)}`)}
          >
            <ExternalLink size={13} aria-hidden />
            用 IINA 打开
          </button>
          <button
            type="button"
            role="menuitem"
            className="direct-play-menu-item"
            onClick={() => openScheme((u) => `infuse://x-callback-url/play?url=${encodeURIComponent(u)}`)}
          >
            <ExternalLink size={13} aria-hidden />
            用 Infuse 打开
          </button>
          <button
            type="button"
            role="menuitem"
            className="direct-play-menu-item"
            onClick={() => openScheme((u) => `potplayer://${u}`)}
          >
            <ExternalLink size={13} aria-hidden />
            用 PotPlayer 打开
          </button>
          <button
            type="button"
            role="menuitem"
            className="direct-play-menu-item"
            onClick={copyStreamUrl}
          >
            {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
            {copied ? "已复制直链" : "复制播放直链"}
          </button>
          {manualCopyUrl ? (
            <div className="direct-play-manual-copy">
              <span>当前环境不支持自动剪贴板，请手动复制：</span>
              <input
                type="text"
                readOnly
                value={manualCopyUrl}
                onFocus={(e) => e.currentTarget.select()}
                onClick={(e) => e.currentTarget.select()}
                aria-label="播放直链地址"
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
