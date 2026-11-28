"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "../lib/use-router";
import { Check, Copy, Eye, EyeOff, LoaderCircle, Power, RefreshCw } from "lucide-react";
import {
  regenerateVirtualEmbyTokenAction,
  setVirtualEmbyEnabledAction,
} from "../app/actions";
import { runAction } from "../lib/run-action";

export interface VirtualEmbyPanelProps {
  initialEnabled: boolean;
  initialServerUrl: string;
  username: string;
  initialToken: string;
  isOwner: boolean;
  counts: {
    movies: number;
    series: number;
    episodes: number;
  };
}

export function VirtualEmbyPanel({
  initialEnabled,
  initialServerUrl,
  username,
  initialToken,
  isOwner,
  counts,
}: VirtualEmbyPanelProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [enabled, setEnabled] = useState(initialEnabled);
  const [token, setToken] = useState(initialToken);
  const [showToken, setShowToken] = useState(false);
  const [copiedField, setCopiedField] = useState<"url" | "user" | "token" | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [clientOrigin, setClientOrigin] = useState<string | null>(null);

  useEffect(() => {
    setEnabled(initialEnabled);
  }, [initialEnabled]);

  useEffect(() => {
    setToken(initialToken);
  }, [initialToken]);

  useEffect(() => {
    setClientOrigin(window.location.origin);
  }, []);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showStatus = useCallback((msg: string, ms = 3500) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setStatusMessage(msg);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setStatusMessage(null);
    }, ms);
  }, []);
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    },
    [],
  );

  const serverUrl = clientOrigin ? `${clientOrigin}/emby` : initialServerUrl;

  const copyText = async (field: "url" | "user" | "token", value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedField(field);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => {
        copyTimerRef.current = null;
        setCopiedField((prev) => (prev === field ? null : prev));
      }, 2000);
    } catch {
      showStatus("❌ 无法访问剪贴板，请手动复制");
    }
  };

  const handleToggle = () => {
    const nextEnabled = !enabled;
    startTransition(async () => {
      const r = await runAction(
        () => setVirtualEmbyEnabledAction(nextEnabled),
        (msg) => showStatus(`❌ ${msg}`),
      );
      if (!r.ok) return;
      if (r.value.ok) {
        setEnabled(nextEnabled);
        if (r.value.token) setToken(r.value.token);
        showStatus(nextEnabled ? "✅ 虚拟 Emby 服务已开启" : "✅ 虚拟 Emby 服务已关闭");
        router.refresh();
      } else {
        showStatus(`❌ ${r.value.message ?? "操作失败"}`);
      }
    });
  };

  const handleRegenerateToken = () => {
    startTransition(async () => {
      const r = await runAction(
        () => regenerateVirtualEmbyTokenAction(),
        (msg) => showStatus(`❌ ${msg}`),
      );
      if (!r.ok) return;
      if (r.value.ok && r.value.token) {
        setToken(r.value.token);
        setShowToken(true);
        showStatus("✅ 已重置访问令牌，旧客户端需重新填入新令牌", 5000);
        router.refresh();
      } else {
        showStatus(`❌ ${r.value.message ?? "重置失败"}`);
      }
    });
  };

  const maskedToken = token ? `${token.slice(0, 6)}${"•".repeat(16)}${token.slice(-4)}` : "";

  return (
    <div className="virtual-emby-panel">
      <div className="virtual-emby-head">
        <div className="virtual-emby-badges">
          <span className={`hub-badge ${enabled ? "tone-green" : "tone-muted"}`}>
            {enabled ? "已开启" : "未开启"}
          </span>
          <span className="panel-note">
            当前可播：{counts.movies} 部电影 · {counts.series} 部剧集（{counts.episodes} 集）
          </span>
        </div>
        {isOwner ? (
          <button
            type="button"
            className={enabled ? "secondary-button" : "primary-button"}
            onClick={handleToggle}
            disabled={isPending}
          >
            {isPending ? (
              <LoaderCircle size={14} className="spin" aria-hidden />
            ) : (
              <Power size={14} aria-hidden />
            )}
            {enabled ? "关闭服务" : "开启虚拟 Emby"}
          </button>
        ) : null}
      </div>

      {enabled ? (
        <div className="virtual-emby-fields">
          <div className="virtual-emby-row">
            <label className="push-label">服务器地址（Emby）</label>
            <div className="virtual-emby-copy-line">
              <code className="virtual-emby-code">{serverUrl}</code>
              <button
                type="button"
                className="secondary-button"
                onClick={() => copyText("url", serverUrl)}
              >
                {copiedField === "url" ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
                {copiedField === "url" ? "已复制" : "复制"}
              </button>
            </div>
          </div>

          <div className="virtual-emby-row">
            <label className="push-label">用户名</label>
            <div className="virtual-emby-copy-line">
              <code className="virtual-emby-code">{username}</code>
              <button
                type="button"
                className="secondary-button"
                onClick={() => copyText("user", username)}
              >
                {copiedField === "user" ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
                {copiedField === "user" ? "已复制" : "复制"}
              </button>
            </div>
          </div>

          <div className="virtual-emby-row">
            <label className="push-label">访问令牌（在播放器中作为密码填入）</label>
            <div className="virtual-emby-copy-line">
              <code className="virtual-emby-code">{showToken ? token : maskedToken}</code>
              <button
                type="button"
                className="secondary-button"
                onClick={() => setShowToken((v) => !v)}
                aria-label={showToken ? "隐藏令牌" : "显示令牌"}
              >
                {showToken ? <EyeOff size={13} aria-hidden /> : <Eye size={13} aria-hidden />}
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => copyText("token", token)}
                disabled={!token}
              >
                {copiedField === "token" ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
                {copiedField === "token" ? "已复制" : "复制"}
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={handleRegenerateToken}
                disabled={isPending}
                title="重置访问令牌（旧令牌立即失效）"
              >
                <RefreshCw size={13} aria-hidden />
                重置
              </button>
            </div>
          </div>

          <div className="virtual-emby-tips">
            <p>
              <strong>播放器接入（网易爆米花 / Infuse / VidHub / SenPlayer）：</strong>
              添加媒体服务器 → 选择 <strong>Emby</strong> → 地址填上方服务地址（含 <code>/emby</code>），用户名填{" "}
              <code>{username}</code>，密码填上方<strong>访问令牌</strong>（已设访问密码时也可直接用登录密码）。
            </p>
            <p>
              <strong>六盘统一播放：</strong>
              115 / 123 / 光鸭 / 天翼走 <strong>302 直链</strong>（零服务器流量），夸克 / UC 自动走{" "}
              <strong>流式 Range 代理</strong>；同一影片存在多盘副本时支持在播放器内切换版本，若某盘文件被删会自动切到另一块盘，且巡检不会把你手动删掉的影片重新下回来。
            </p>
          </div>
        </div>
      ) : (
        <p className="panel-note" style={{ marginTop: 10 }}>
          开启后，无需安装 Emby、无需配置 STRM 或 CloudDrive2/rclone 挂载、无需扫库：直接用网易爆米花 / Infuse / VidHub 连接本机即可看你六个网盘里的全部影视。
        </p>
      )}

      {statusMessage ? (
        <p className="panel-note" style={{ marginTop: 10 }}>
          {statusMessage}
        </p>
      ) : null}
    </div>
  );
}
