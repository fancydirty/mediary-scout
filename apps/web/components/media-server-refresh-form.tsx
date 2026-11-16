"use client";

import { useState, useTransition } from "react";
import { useRouter } from "../lib/use-router";
import { Check, LoaderCircle, RefreshCw, Trash2 } from "lucide-react";
import {
  clearMediaServerChannelAction,
  saveMediaServerSettingsAction,
  testMediaServerRefreshAction,
  type MediaServerFormInput,
} from "../app/actions";
import { runAction } from "../lib/run-action";

export interface MediaServerFormState {
  embyUrl: string;
  embyKeySet: boolean;
  jellyfinUrl: string;
  jellyfinKeySet: boolean;
  plexUrl: string;
  plexTokenSet: boolean;
  webhookSet: boolean;
  delaySeconds: number;
}

const DELAY_OPTIONS = [
  { value: 0, label: "立即刷新（0 秒）" },
  { value: 5, label: "延迟 5 秒（默认，适合 CloudDrive2 / OpenList 挂载）" },
  { value: 15, label: "延迟 15 秒" },
  { value: 30, label: "延迟 30 秒（适合 rclone / NFS 缓存刷新）" },
  { value: 60, label: "延迟 60 秒" },
] as const;

export function MediaServerRefreshForm({ initial }: { initial: MediaServerFormState }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [embyUrl, setEmbyUrl] = useState(initial.embyUrl);
  const [embyApiKey, setEmbyApiKey] = useState("");
  const [embyKeySet, setEmbyKeySet] = useState(initial.embyKeySet);

  const [jellyfinUrl, setJellyfinUrl] = useState(initial.jellyfinUrl);
  const [jellyfinApiKey, setJellyfinApiKey] = useState("");
  const [jellyfinKeySet, setJellyfinKeySet] = useState(initial.jellyfinKeySet);

  const [plexUrl, setPlexUrl] = useState(initial.plexUrl);
  const [plexToken, setPlexToken] = useState("");
  const [plexTokenSet, setPlexTokenSet] = useState(initial.plexTokenSet);

  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookSet, setWebhookSet] = useState(initial.webhookSet);

  const [delaySeconds, setDelaySeconds] = useState(initial.delaySeconds);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const currentDraft = (): MediaServerFormInput => ({
    embyUrl,
    ...(embyApiKey.trim() ? { embyApiKey } : {}),
    jellyfinUrl,
    ...(jellyfinApiKey.trim() ? { jellyfinApiKey } : {}),
    plexUrl,
    ...(plexToken.trim() ? { plexToken } : {}),
    ...(webhookUrl.trim() ? { webhookUrl } : {}),
    delaySeconds,
  });

  const handleSave = () => {
    startTransition(async () => {
      const r = await runAction(
        () => saveMediaServerSettingsAction(currentDraft()),
        (msg) => {
          setStatusMessage(`❌ ${msg}`);
          setTimeout(() => setStatusMessage(null), 4000);
        },
      );
      if (!r.ok) return;
      const res = r.value;
      if (res.success) {
        if (embyApiKey.trim()) {
          setEmbyKeySet(true);
          setEmbyApiKey("");
        }
        if (!embyUrl.trim()) {
          setEmbyKeySet(false);
        }
        if (jellyfinApiKey.trim()) {
          setJellyfinKeySet(true);
          setJellyfinApiKey("");
        }
        if (!jellyfinUrl.trim()) {
          setJellyfinKeySet(false);
        }
        if (plexToken.trim()) {
          setPlexTokenSet(true);
          setPlexToken("");
        }
        if (!plexUrl.trim()) {
          setPlexTokenSet(false);
        }
        if (webhookUrl.trim()) {
          setWebhookSet(true);
          setWebhookUrl("");
        }
        router.refresh();
      }
      setStatusMessage(res.success ? "✅ 已保存" : `❌ ${res.message ?? "保存失败"}`);
      setTimeout(() => setStatusMessage(null), 4000);
    });
  };

  const handleClear = (channel: "emby" | "jellyfin" | "plex" | "webhook") => {
    startTransition(async () => {
      const r = await runAction(
        () => clearMediaServerChannelAction(channel),
        (msg) => {
          setStatusMessage(`❌ ${msg}`);
          setTimeout(() => setStatusMessage(null), 3500);
        },
      );
      if (!r.ok) return;
      const res = r.value;
      if (res.success) {
        if (channel === "emby") {
          setEmbyUrl("");
          setEmbyApiKey("");
          setEmbyKeySet(false);
        } else if (channel === "jellyfin") {
          setJellyfinUrl("");
          setJellyfinApiKey("");
          setJellyfinKeySet(false);
        } else if (channel === "plex") {
          setPlexUrl("");
          setPlexToken("");
          setPlexTokenSet(false);
        } else if (channel === "webhook") {
          setWebhookUrl("");
          setWebhookSet(false);
        }
        router.refresh();
      }
      setStatusMessage(res.success ? "✅ 已清除" : `❌ ${res.message ?? "清除失败"}`);
      setTimeout(() => setStatusMessage(null), 3500);
    });
  };

  const handleTest = () => {
    startTransition(async () => {
      const r = await runAction(
        () => testMediaServerRefreshAction(currentDraft()),
        (msg) => {
          setStatusMessage(`❌ ${msg}`);
          setTimeout(() => setStatusMessage(null), 5000);
        },
      );
      if (!r.ok) return;
      const res = r.value;
      setStatusMessage(
        res.success
          ? `✅ 已成功触发刷新：${res.refreshed?.join("、") ?? "已配置服务"}`
          : `❌ ${res.message ?? "刷新失败"}`,
      );
      setTimeout(() => setStatusMessage(null), 5000);
    });
  };

  return (
    <div className="push-form media-server-form">
      <div className="media-server-group">
        <div className="media-server-group-head">
          <strong>Emby</strong>
          {embyUrl.trim() || embyKeySet ? (
            <button
              type="button"
              className="selection-pref-reset"
              onClick={() => handleClear("emby")}
              disabled={isPending}
              aria-label="清除 Emby 配置"
            >
              <Trash2 size={12} aria-hidden />
              清除
            </button>
          ) : null}
        </div>
        <div className="media-server-pair">
          <input
            type="text"
            className="setting-control"
            value={embyUrl}
            onChange={(e) => setEmbyUrl(e.target.value)}
            placeholder="服务地址，如 http://192.168.x.x:8096"
            aria-label="Emby 服务地址"
          />
          <input
            type="password"
            className="setting-control"
            value={embyApiKey}
            onChange={(e) => setEmbyApiKey(e.target.value)}
            placeholder={embyKeySet ? "API 密钥已保存（留空不改）" : "Emby 后台 → 高级 → API 密钥"}
            aria-label="Emby API 密钥"
            autoComplete="off"
          />
        </div>
      </div>

      <div className="media-server-group">
        <div className="media-server-group-head">
          <strong>Jellyfin</strong>
          {jellyfinUrl.trim() || jellyfinKeySet ? (
            <button
              type="button"
              className="selection-pref-reset"
              onClick={() => handleClear("jellyfin")}
              disabled={isPending}
              aria-label="清除 Jellyfin 配置"
            >
              <Trash2 size={12} aria-hidden />
              清除
            </button>
          ) : null}
        </div>
        <div className="media-server-pair">
          <input
            type="text"
            className="setting-control"
            value={jellyfinUrl}
            onChange={(e) => setJellyfinUrl(e.target.value)}
            placeholder="服务地址，如 http://192.168.x.x:8096"
            aria-label="Jellyfin 服务地址"
          />
          <input
            type="password"
            className="setting-control"
            value={jellyfinApiKey}
            onChange={(e) => setJellyfinApiKey(e.target.value)}
            placeholder={jellyfinKeySet ? "API 密钥已保存（留空不改）" : "控制台 → 联网 → API 密钥"}
            aria-label="Jellyfin API 密钥"
            autoComplete="off"
          />
        </div>
      </div>

      <div className="media-server-group">
        <div className="media-server-group-head">
          <strong>Plex</strong>
          {plexUrl.trim() || plexTokenSet ? (
            <button
              type="button"
              className="selection-pref-reset"
              onClick={() => handleClear("plex")}
              disabled={isPending}
              aria-label="清除 Plex 配置"
            >
              <Trash2 size={12} aria-hidden />
              清除
            </button>
          ) : null}
        </div>
        <div className="media-server-pair">
          <input
            type="text"
            className="setting-control"
            value={plexUrl}
            onChange={(e) => setPlexUrl(e.target.value)}
            placeholder="服务地址，如 http://192.168.x.x:32400"
            aria-label="Plex 服务地址"
          />
          <input
            type="password"
            className="setting-control"
            value={plexToken}
            onChange={(e) => setPlexToken(e.target.value)}
            placeholder={plexTokenSet ? "Plex Token 已保存（留空不改）" : "粘贴 X-Plex-Token"}
            aria-label="Plex Token"
            autoComplete="off"
          />
        </div>
      </div>

      <div className="media-server-group">
        <div className="media-server-group-head">
          <strong>自定义入库 Webhook（飞牛 fnOS / 脚本桥接）</strong>
          {webhookSet ? (
            <button
              type="button"
              className="selection-pref-reset"
              onClick={() => handleClear("webhook")}
              disabled={isPending}
              aria-label="清除入库 Webhook"
            >
              <Trash2 size={12} aria-hidden />
              清除
            </button>
          ) : null}
        </div>
        <input
          type="password"
          className="setting-control"
          value={webhookUrl}
          onChange={(e) => setWebhookUrl(e.target.value)}
          placeholder={webhookSet ? "Webhook 已保存（留空不改）" : "https://你的接收端/library-landed（仅新文件落盘时 POST JSON）"}
          aria-label="自定义入库 Webhook 地址"
          autoComplete="off"
        />
      </div>

      <div className="push-field">
        <label className="push-label" htmlFor="media-server-delay">
          落盘后等待时间（给远程挂载目录留出刷新缓存的时间）
        </label>
        <select
          id="media-server-delay"
          className="setting-control"
          value={delaySeconds}
          onChange={(e) => setDelaySeconds(Number(e.target.value))}
          aria-label="落盘后等待时间"
        >
          {DELAY_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      <div className="service-actions">
        <button type="button" className="primary-button" onClick={handleSave} disabled={isPending}>
          {isPending ? <LoaderCircle size={14} className="spin" aria-hidden /> : <Check size={14} aria-hidden />}
          保存
        </button>
        <button type="button" className="secondary-button" onClick={handleTest} disabled={isPending}>
          {isPending ? <LoaderCircle size={14} className="spin" aria-hidden /> : <RefreshCw size={14} aria-hidden />}
          测试刷新
        </button>
        {statusMessage ? <span className="panel-note">{statusMessage}</span> : null}
      </div>
    </div>
  );
}
