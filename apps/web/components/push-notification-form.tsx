"use client";

import { useState, useTransition } from "react";
import { Bell, ExternalLink, LoaderCircle, Trash2 } from "lucide-react";
import {
  clearPushChannelAction,
  savePushSettingsAction,
  testPushNotificationAction,
} from "../app/actions";
import { runAction } from "../lib/run-action";

const CHANNELS = [
  {
    key: "bark",
    label: "Bark (iOS)",
    placeholder: "粘贴 Bark Key",
    help: "iPhone App Store 安装 Bark → 打开复制 Key",
    link: "https://apps.apple.com/cn/app/bark/id1403753865",
  },
  {
    key: "serverchan",
    label: "Server酱 Turbo",
    placeholder: "粘贴 SendKey",
    help: "微信扫码登录 → 复制 SendKey（免费 5 条/天）",
    link: "https://sct.ftqq.com",
  },
  {
    key: "wecom",
    label: "企业微信群机器人",
    placeholder: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...",
    help: "企业微信群 → 添加机器人 → 复制 Webhook",
    link: "https://developer.work.weixin.qq.com/document/path/91770",
  },
  {
    key: "webhook",
    label: "通用 Webhook",
    placeholder: "https://你的接收端/endpoint",
    help: "自定义接收端 URL，接收 POST JSON",
    link: null,
  },
] as const;

export function PushNotificationForm({ configured }: { configured: Record<string, boolean> }) {
  const [isPending, startTransition] = useTransition();
  // Saved keys are NEVER echoed back as plaintext — inputs start empty and show
  // a masked "already saved" placeholder. The user only types to UPDATE a key.
  const [values, setValues] = useState<Record<string, string>>({});
  const [savedChannels, setSavedChannels] = useState(configured);
  const [testResult, setTestResult] = useState<string | null>(null);

  const handleSave = () => {
    startTransition(async () => {
      const r = await runAction(
        () => savePushSettingsAction(values),
        (msg) => {
          setTestResult(`❌ ${msg}`);
          setTimeout(() => setTestResult(null), 3000);
        },
      );
      if (!r.ok) return;
      const result = r.value;
      if (result.success) {
        const next = { ...savedChannels };
        for (const [key, value] of Object.entries(values)) {
          if (value.trim()) next[key] = true;
        }
        setSavedChannels(next);
        setValues({}); // re-mask: drop the just-typed plaintext from the inputs
      }
      setTestResult(result.success ? "✅ 保存成功" : `❌ ${result.message}`);
      setTimeout(() => setTestResult(null), 3000);
    });
  };

  const handleClear = (key: string) => {
    startTransition(async () => {
      const r = await runAction(
        () => clearPushChannelAction(key),
        (msg) => {
          setTestResult(`❌ ${msg}`);
          setTimeout(() => setTestResult(null), 3000);
        },
      );
      if (!r.ok) return;
      const result = r.value;
      if (result.success) {
        setSavedChannels((prev) => ({ ...prev, [key]: false }));
        setValues((prev) => {
          const next = { ...prev };
          delete next[key];
          return next;
        });
        setTestResult("✅ 已清除");
      } else {
        setTestResult(`❌ ${result.message}`);
      }
      setTimeout(() => setTestResult(null), 3000);
    });
  };

  const handleTest = () => {
    startTransition(async () => {
      const r = await runAction(
        () => testPushNotificationAction(values),
        (msg) => {
          setTestResult(`❌ ${msg}`);
          setTimeout(() => setTestResult(null), 5000);
        },
      );
      if (!r.ok) return;
      const result = r.value;
      setTestResult(
        result.success
          ? `✅ 测试通知已发送到 ${result.sentTo?.join("、") ?? "已配置渠道"}`
          : `❌ ${result.message}`,
      );
      setTimeout(() => setTestResult(null), 5000);
    });
  };

  return (
    <div className="push-form">
      {CHANNELS.map((channel) => (
        <div className="push-channel" key={channel.key}>
          <label>
            <strong>{channel.label}</strong>
            <span className="push-help">
              {channel.help}
              {channel.link ? (
                <>
                  {" · "}
                  <a href={channel.link} target="_blank" rel="noopener noreferrer">
                    获取方法 <ExternalLink size={12} style={{ verticalAlign: "-1px" }} />
                  </a>
                </>
              ) : null}
            </span>
          </label>
          <div className="push-input-row">
            <input
              type="text"
              className="push-input"
              placeholder={savedChannels[channel.key] ? "已保存 ••••••（留空则保持不变）" : channel.placeholder}
              value={values[channel.key] ?? ""}
              onChange={(e) => setValues({ ...values, [channel.key]: e.target.value })}
              disabled={isPending}
            />
            {savedChannels[channel.key] ? (
              <button
                type="button"
                className="push-clear"
                title="清除该渠道"
                onClick={() => handleClear(channel.key)}
                disabled={isPending}
              >
                <Trash2 size={13} aria-hidden />
                清除
              </button>
            ) : null}
          </div>
        </div>
      ))}

      <div className="push-actions">
        <button className="primary-button" type="button" onClick={handleSave} disabled={isPending}>
          {isPending ? <LoaderCircle size={14} className="spin" aria-hidden /> : <Bell size={14} aria-hidden />}
          保存配置
        </button>
        <button className="secondary-button" type="button" onClick={handleTest} disabled={isPending}>
          发送测试通知
        </button>
        {testResult ? <span className="push-result">{testResult}</span> : null}
      </div>
    </div>
  );
}
