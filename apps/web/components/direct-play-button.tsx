"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy, ExternalLink, Play } from "lucide-react";

export interface DirectPlayButtonProps {
  embyItemId: string;
  embyToken: string;
  label?: string;
  compact?: boolean;
}

export function DirectPlayButton({
  embyItemId,
  embyToken,
  label = "播放",
  compact = false,
}: DirectPlayButtonProps) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
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
    return `${origin}/emby/Videos/${encodeURIComponent(embyItemId)}/stream?Static=true&api_key=${encodeURIComponent(embyToken)}`;
  };

  const openScheme = (schemeBuilder: (streamUrl: string) => string) => {
    const url = schemeBuilder(buildStreamUrl());
    setOpen(false);
    window.location.href = url;
  };

  const copyStreamUrl = async () => {
    try {
      await navigator.clipboard.writeText(buildStreamUrl());
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
        setOpen(false);
      }, 1200);
    } catch {
      setOpen(false);
    }
  };

  return (
    <div className={`direct-play-wrap${compact ? " is-compact" : ""}`} ref={wrapRef}>
      <button
        type="button"
        className={compact ? "direct-play-compact-btn" : "primary-button"}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((v) => !v);
        }}
        aria-expanded={open}
        aria-haspopup="menu"
        title={compact ? "选择外部播放器播放" : undefined}
      >
        <Play size={compact ? 11 : 14} aria-hidden />
        {compact ? null : label}
      </button>
      {open ? (
        <div className="direct-play-menu" role="menu">
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
        </div>
      ) : null}
    </div>
  );
}
