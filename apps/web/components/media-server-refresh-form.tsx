"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
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

type ServerChannel = "emby" | "jellyfin" | "plex";

const DELAY_OPTIONS = [
  { value: 0, label: "立即刷新（0 秒）" },
  { value: 5, label: "延迟 5 秒（默认，适合 CloudDrive2 / OpenList 挂载）" },
  { value: 15, label: "延迟 15 秒" },
  { value: 30, label: "延迟 30 秒（适合 rclone / NFS 缓存刷新）" },
  { value: 60, label: "延迟 60 秒" },
] as const;

/** Per-brand copy: only the words differ, the block is identical. */
const SERVER_LABELS: Record<ServerChannel, { name: string; urlPlaceholder: string; secretPlaceholder: string }> = {
  emby: {
    name: "Emby",
    urlPlaceholder: "服务地址，如 http://192.168.x.x:8096",
    secretPlaceholder: "Emby 后台 → 高级 → API 密钥",
  },
  jellyfin: {
    name: "Jellyfin",
    urlPlaceholder: "服务地址，如 http://192.168.x.x:8096",
    secretPlaceholder: "控制台 → 联网 → API 密钥",
  },
  plex: {
    name: "Plex",
    urlPlaceholder: "服务地址，如 http://192.168.x.x:32400",
    secretPlaceholder: "粘贴 X-Plex-Token",
  },
};

/** The saved value can come from env / a hand-edited row (0–120 s), which the preset
 *  list does not cover — keep it selectable instead of silently rewriting it. */
function delayOptionsFor(current: number): Array<{ value: number; label: string }> {
  const options: Array<{ value: number; label: string }> = DELAY_OPTIONS.map((option) => ({ ...option }));
  if (!options.some((option) => option.value === current)) {
    options.push({ value: current, label: `延迟 ${current} 秒（当前保存值）` });
    options.sort((a, b) => a.value - b.value);
  }
  return options;
}

export function MediaServerRefreshForm({ initial }: { initial: MediaServerFormState }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  // URL + freshly typed secret per channel; `keySet` = a secret is already stored.
  const [urls, setUrls] = useState<Record<ServerChannel, string>>({
    emby: initial.embyUrl,
    jellyfin: initial.jellyfinUrl,
    plex: initial.plexUrl,
  });
  const [secrets, setSecrets] = useState<Record<ServerChannel, string>>({ emby: "", jellyfin: "", plex: "" });
  const [keySet, setKeySet] = useState<Record<ServerChannel, boolean>>({
    emby: initial.embyKeySet,
    jellyfin: initial.jellyfinKeySet,
    plex: initial.plexTokenSet,
  });
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookSet, setWebhookSet] = useState(initial.webhookSet);
  const [delaySeconds, setDelaySeconds] = useState(initial.delaySeconds);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // One timer for the transient status line: a later action must not be overwritten
  // by an earlier action's timeout, and nothing fires after unmount.
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearStatusTimer = useCallback(() => {
    if (statusTimer.current !== null) {
      clearTimeout(statusTimer.current);
      statusTimer.current = null;
    }
  }, []);
  const showStatus = useCallback(
    (message: string, ms: number) => {
      clearStatusTimer();
      setStatusMessage(message);
      statusTimer.current = setTimeout(() => {
        statusTimer.current = null;
        setStatusMessage(null);
      }, ms);
    },
    [clearStatusTimer],
  );
  useEffect(() => clearStatusTimer, [clearStatusTimer]);

  const currentDraft = (): MediaServerFormInput => {
    const draft: MediaServerFormInput = { delaySeconds };
    if (urls.emby.trim()) draft.embyUrl = urls.emby;
    else draft.embyUrl = "";
    if (secrets.emby.trim()) draft.embyApiKey = secrets.emby;
    if (urls.jellyfin.trim()) draft.jellyfinUrl = urls.jellyfin;
    else draft.jellyfinUrl = "";
    if (secrets.jellyfin.trim()) draft.jellyfinApiKey = secrets.jellyfin;
    if (urls.plex.trim()) draft.plexUrl = urls.plex;
    else draft.plexUrl = "";
    if (secrets.plex.trim()) draft.plexToken = secrets.plex;
    if (webhookUrl.trim()) draft.webhookUrl = webhookUrl;
    return draft;
  };

  const handleSave = () => {
    startTransition(async () => {
      const r = await runAction(
        () => saveMediaServerSettingsAction(currentDraft()),
        (msg) => showStatus(`❌ ${msg}`, 4000),
      );
      if (!r.ok) return;
      const res = r.value;
      if (res.success) {
        // Re-mask the typed secrets that were just stored, and forget keys whose URL was cleared.
        setKeySet((prev) => {
          const next = { ...prev };
          for (const channel of ["emby", "jellyfin", "plex"] as const) {
            if (secrets[channel].trim()) next[channel] = true;
            if (!urls[channel].trim()) next[channel] = false;
          }
          return next;
        });
        setSecrets({ emby: "", jellyfin: "", plex: "" });
        if (webhookUrl.trim()) {
          setWebhookSet(true);
          setWebhookUrl("");
        }
        router.refresh();
      }
      showStatus(res.success ? "✅ 已保存" : `❌ ${res.message ?? "保存失败"}`, 4000);
    });
  };

  const handleClear = (channel: ServerChannel | "webhook") => {
    startTransition(async () => {
      const r = await runAction(
        () => clearMediaServerChannelAction(channel),
        (msg) => showStatus(`❌ ${msg}`, 3500),
      );
      if (!r.ok) return;
      const res = r.value;
      if (res.success) {
        if (channel === "webhook") {
          setWebhookUrl("");
          setWebhookSet(false);
        } else {
          setUrls((prev) => ({ ...prev, [channel]: "" }));
          setSecrets((prev) => ({ ...prev, [channel]: "" }));
          setKeySet((prev) => ({ ...prev, [channel]: false }));
        }
        router.refresh();
      }
      showStatus(res.success ? "✅ 已清除" : `❌ ${res.message ?? "清除失败"}`, 3500);
    });
  };

  const handleTest = () => {
    startTransition(async () => {
      const r = await runAction(
        () => testMediaServerRefreshAction(currentDraft()),
        (msg) => showStatus(`❌ ${msg}`, 5000),
      );
      if (!r.ok) return;
      const res = r.value;
      showStatus(
        res.success
          ? `✅ 已成功触发刷新：${res.refreshed?.join("、") ?? "已配置服务"}`
          : `❌ ${res.message ?? "刷新失败"}`,
        5000,
      );
    });
  };

  return (
    <div className="push-form media-server-form">
      {(["emby", "jellyfin", "plex"] as const).map((channel) => {
        const labels = SERVER_LABELS[channel];
        const configured = Boolean(urls[channel].trim() || keySet[channel]);
        return (
          <div className="media-server-group" key={channel}>
            <div className="media-server-group-head">
              <strong>{labels.name}</strong>
              {configured ? (
                <button
                  type="button"
                  className="selection-pref-reset"
                  onClick={() => handleClear(channel)}
                  disabled={isPending}
                  aria-label={`清除 ${labels.name} 配置`}
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
                value={urls[channel]}
                onChange={(event) =>
                  setUrls((prev) => ({ ...prev, [channel]: event.target.value }))
                }
                placeholder={labels.urlPlaceholder}
                aria-label={`${labels.name} 服务地址`}
              />
              <input
                type="password"
                className="setting-control"
                value={secrets[channel]}
                onChange={(event) =>
                  setSecrets((prev) => ({ ...prev, [channel]: event.target.value }))
                }
                placeholder={keySet[channel] ? "密钥已保存（留空不改）" : labels.secretPlaceholder}
                aria-label={`${labels.name} 密钥`}
                autoComplete="off"
              />
            </div>
          </div>
        );
      })}

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
          onChange={(event) => setWebhookUrl(event.target.value)}
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
          onChange={(event) => setDelaySeconds(Number(event.target.value))}
          aria-label="落盘后等待时间"
        >
          {delayOptionsFor(delaySeconds).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
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
