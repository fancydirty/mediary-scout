import { connection } from "next/server";
import { Suspense } from "react";
import { Bell, Bot, Cable, CalendarClock, Clapperboard, Gauge, Languages, Radio, ShieldCheck, TriangleAlert } from "lucide-react";
import { AppSidebar } from "../../components/app-sidebar";
import { Pan115QrConnect } from "../../components/pan115-qr-connect";
import { PushNotificationForm } from "../../components/push-notification-form";
import { PreferredLanguageForm } from "../../components/preferred-language-form";
import { QualityPreferenceForm } from "../../components/quality-preference-form";
import { LlmConfigForm } from "../../components/llm-config-form";
import { TmdbApiKeyForm } from "../../components/tmdb-api-key-form";
import { ProwlarrConfigForm } from "../../components/prowlarr-config-form";
import { PanSouConfigForm } from "../../components/pansou-config-form";
import { DailySweepForm } from "../../components/daily-sweep-form";
import {
  getDailySweepTime,
  getPan115ConnectionStatus,
  getWorkflowRepository,
  PREFERRED_LANGUAGE_SETTING_KEY,
  QUALITY_PREFERENCE_SETTING_KEY,
  LLM_BASE_URL_SETTING_KEY,
  LLM_MODEL_ID_SETTING_KEY,
  LLM_API_KEY_SETTING_KEY,
  TMDB_API_KEY_SETTING_KEY,
  PROWLARR_BASE_URL_SETTING_KEY,
  PROWLARR_API_KEY_SETTING_KEY,
  PANSOU_BASE_URL_SETTING_KEY,
} from "../../lib/workflow-runtime";

export default function SettingsPage() {
  return (
    <div className="app-shell">
      <AppSidebar active="settings" />
      <main className="main product-main">
        <div className="section-heading library-heading">
          <div>
            <h1>设置</h1>
            <p>115 网盘连接与系统配置</p>
          </div>
        </div>
        <Suspense fallback={<div className="skeleton skeleton-heading" />}>
          <Pan115Section />
        </Suspense>
        <Suspense fallback={<div className="skeleton skeleton-heading" />}>
          <PreferredLanguageSection />
        </Suspense>
        <Suspense fallback={<div className="skeleton skeleton-heading" />}>
          <QualityPreferenceSection />
        </Suspense>
        <Suspense fallback={<div className="skeleton skeleton-heading" />}>
          <LlmConfigSection />
        </Suspense>
        <Suspense fallback={<div className="skeleton skeleton-heading" />}>
          <TmdbApiKeySection />
        </Suspense>
        <Suspense fallback={<div className="skeleton skeleton-heading" />}>
          <ResourceProviderSection />
        </Suspense>
        <Suspense fallback={<div className="skeleton skeleton-heading" />}>
          <DailySweepSection />
        </Suspense>
        <Suspense fallback={<div className="skeleton skeleton-heading" />}>
          <PushNotificationSection />
        </Suspense>
      </main>
    </div>
  );
}

async function PreferredLanguageSection() {
  await connection();
  const repository = getWorkflowRepository();
  const initial = (await repository.getSetting(PREFERRED_LANGUAGE_SETTING_KEY)) ?? "中文";

  return (
    <section className="panel" style={{ maxWidth: 720, marginTop: 24 }}>
      <div className="panel-header">
        <div>
          <h2 className="panel-title">
            <Languages size={16} aria-hidden style={{ verticalAlign: "-2px", marginRight: 8 }} />
            偏好语言
          </h2>
          <p className="panel-note">搜索资源时优先你偏好的字幕语言，避免拿到看不了的版本</p>
        </div>
      </div>
      <PreferredLanguageForm initial={initial} />
    </section>
  );
}

async function QualityPreferenceSection() {
  await connection();
  const repository = getWorkflowRepository();
  const initial = (await repository.getSetting(QUALITY_PREFERENCE_SETTING_KEY)) ?? "any";

  return (
    <section className="panel" style={{ maxWidth: 720, marginTop: 24 }}>
      <div className="panel-header">
        <div>
          <h2 className="panel-title">
            <Gauge size={16} aria-hidden style={{ verticalAlign: "-2px", marginRight: 8 }} />
            偏好画质
          </h2>
          <p className="panel-note">优先获取的画质档位（覆盖优先，找不到不留缺）</p>
        </div>
      </div>
      <QualityPreferenceForm initial={initial} />
    </section>
  );
}

async function LlmConfigSection() {
  await connection();
  const repository = getWorkflowRepository();
  const baseURL = (await repository.getSetting(LLM_BASE_URL_SETTING_KEY)) ?? "";
  const modelId = (await repository.getSetting(LLM_MODEL_ID_SETTING_KEY)) ?? "";
  const apiKeySet = Boolean((await repository.getSetting(LLM_API_KEY_SETTING_KEY))?.trim());

  return (
    <section className="panel" style={{ maxWidth: 720, marginTop: 24 }}>
      <div className="panel-header">
        <div>
          <h2 className="panel-title">
            <Bot size={16} aria-hidden style={{ verticalAlign: "-2px", marginRight: 8 }} />
            AI 模型
          </h2>
          <p className="panel-note">驱动获取 agent 的大模型(OpenAI 兼容);自带 key,只存你本机</p>
        </div>
      </div>
      <LlmConfigForm baseURL={baseURL} modelId={modelId} apiKeySet={apiKeySet} />
    </section>
  );
}

async function TmdbApiKeySection() {
  await connection();
  const repository = getWorkflowRepository();
  const apiKeySet = Boolean((await repository.getSetting(TMDB_API_KEY_SETTING_KEY))?.trim());

  return (
    <section className="panel" style={{ maxWidth: 720, marginTop: 24 }}>
      <div className="panel-header">
        <div>
          <h2 className="panel-title">
            <Clapperboard size={16} aria-hidden style={{ verticalAlign: "-2px", marginRight: 8 }} />
            TMDB 元数据
          </h2>
          <p className="panel-note">影视元数据来源；默认走代理兜底，可填自己的 key 直连</p>
        </div>
      </div>
      <TmdbApiKeyForm apiKeySet={apiKeySet} />
    </section>
  );
}

async function ResourceProviderSection() {
  await connection();
  const repository = getWorkflowRepository();
  const pansouBaseURL = (await repository.getSetting(PANSOU_BASE_URL_SETTING_KEY)) ?? "";
  const prowlarrBaseURL = (await repository.getSetting(PROWLARR_BASE_URL_SETTING_KEY)) ?? "";
  const prowlarrApiKeySet = Boolean((await repository.getSetting(PROWLARR_API_KEY_SETTING_KEY))?.trim());

  return (
    <section className="panel" style={{ maxWidth: 720, marginTop: 24 }}>
      <div className="panel-header">
        <div>
          <h2 className="panel-title">
            <Radio size={16} aria-hidden style={{ verticalAlign: "-2px", marginRight: 8 }} />
            资源提供商
          </h2>
          <p className="panel-note">agent 搜资源的来源；PanSou（网盘）默认内置，Prowlarr（磁力/PT）可选加挂，二者结果合并</p>
        </div>
      </div>
      <PanSouConfigForm baseURL={pansouBaseURL} />
      <div style={{ height: 18 }} />
      <ProwlarrConfigForm baseURL={prowlarrBaseURL} apiKeySet={prowlarrApiKeySet} />
    </section>
  );
}

async function Pan115Section() {
  await connection();
  const status = await getPan115ConnectionStatus();

  return (
    <section className="panel" style={{ maxWidth: 720 }}>
      <div className="panel-header">
        <div>
          <h2 className="panel-title">
            <Cable size={16} aria-hidden style={{ verticalAlign: "-2px", marginRight: 8 }} />
            115 网盘
          </h2>
          <p className="panel-note">扫码登录后 cookie 持久化到数据库，自动用于后续转存</p>
        </div>
        {status.connected ? (
          <span className="hub-badge tone-green">
            <ShieldCheck size={12} aria-hidden />
            {status.source === "qr" ? "已扫码连接" : "已连接（.env）"}
          </span>
        ) : (
          <span className="hub-badge tone-amber">
            <TriangleAlert size={12} aria-hidden />
            未连接
          </span>
        )}
      </div>

      {status.connected ? (
        <p className="qr-hint">
          {status.userName ? `账号：${status.userName} · ` : ""}
          {status.app ? `客户端类型：${status.app} · ` : ""}
          {status.connectedAt ? `连接于 ${status.connectedAt.slice(0, 16).replace("T", " ")}` : ""}
          {status.source === "env" ? "当前 cookie 来自 .env；扫码连接后将以数据库为准。" : ""}
        </p>
      ) : (
        <p className="qr-hint">还没有可用的 115 cookie，扫码连接后即可开始获取资源。</p>
      )}

      <Pan115QrConnect />

      <p className="panel-note" style={{ marginTop: 12 }}>
        ⚠️ 请勿在多个账号或多个实例上绑定同一个 115 账号，易触发 115 风控。每个 115 账号在本实例内只能归属一个用户。
      </p>
    </section>
  );
}

async function DailySweepSection() {
  await connection();
  const repository = getWorkflowRepository();
  const initial = await getDailySweepTime(repository);

  return (
    <section className="panel" style={{ maxWidth: 720, marginTop: 24 }}>
      <div className="panel-header">
        <div>
          <h2 className="panel-title">
            <CalendarClock size={16} aria-hidden style={{ verticalAlign: "-2px", marginRight: 8 }} />
            每日定时巡检
          </h2>
          <p className="panel-note">每天定时自动追更：检查已追踪剧集，获取新播出或仍缺失的集数</p>
        </div>
      </div>
      <DailySweepForm initial={initial} />
    </section>
  );
}

async function PushNotificationSection() {
  await connection();
  const repository = getWorkflowRepository();

  // Only whether each channel is configured — the plaintext key is never sent
  // to the client.
  const configured: Record<string, boolean> = {};
  for (const key of ["bark", "serverchan", "wecom", "webhook"]) {
    const value = await repository.getSetting(`push_${key}`);
    configured[key] = Boolean(value && value.trim());
  }

  return (
    <section className="panel" style={{ maxWidth: 720, marginTop: 24 }}>
      <div className="panel-header">
        <div>
          <h2 className="panel-title">
            <Bell size={16} aria-hidden style={{ verticalAlign: "-2px", marginRight: 8 }} />
            推送通知
          </h2>
          <p className="panel-note">配置推送渠道后，每日定时巡检完成时会自动推送更新播报</p>
        </div>
      </div>

      <PushNotificationForm configured={configured} />
    </section>
  );
}
