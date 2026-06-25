import { connection } from "next/server";
import { Suspense } from "react";
import { Bell, Bot, Cable, CalendarClock, Clapperboard, Gauge, KeyRound, Languages, Radio, ShieldCheck, TriangleAlert, Users } from "lucide-react";
import { AppSidebar } from "../../components/app-sidebar";
import { AddDriveBrandTabs } from "../../components/add-drive-brand-tabs";
import { TestConnectionButton } from "../../components/test-connection-button";
import { UnbindStorageButton } from "../../components/unbind-storage-button";
import { PushNotificationForm } from "../../components/push-notification-form";
import { PreferredLanguageForm } from "../../components/preferred-language-form";
import { QualityPreferenceForm } from "../../components/quality-preference-form";
import { LlmConfigForm } from "../../components/llm-config-form";
import { TmdbApiKeyForm } from "../../components/tmdb-api-key-form";
import { ProwlarrConfigForm } from "../../components/prowlarr-config-form";
import { PanSouConfigForm } from "../../components/pansou-config-form";
import { DailySweepForm } from "../../components/daily-sweep-form";
import { PasswordChangeForm } from "../../components/password-change-form";
import { AccountAdminPanel } from "../../components/account-admin-panel";
import { GitHubNameplate } from "../../components/github-nameplate";
import {
  getAccountConnectedStorages,
  getAccountScopedSettings,
  getCurrentAccountId,
  getCurrentAccountSummary,
  isMultiUserEnabled,
  listManagedAccounts,
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
  resolveGlobalWorkspace,
} from "../../lib/workflow-runtime";
import { brandSupportsProwlarr } from "@media-track/workflow";
import { isDemoMode } from "../../lib/demo-mode";

export default function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ w?: string }>;
}) {
  return (
    <div className="app-shell">
      {/* Only the sidebar depends on the active drive (`?w`); wrap just it in
          Suspense so the static shell + per-section streaming stay intact and the
          route still prerenders (cacheComponents). Fallback = primary sidebar. */}
      <Suspense fallback={<AppSidebar active="settings" />}>
        <SettingsSidebar searchParams={searchParams} />
      </Suspense>
      <main className="main product-main">
        <div className="section-heading library-heading">
          <div>
            <h1>设置</h1>
            <p>网盘连接与系统配置</p>
          </div>
        </div>
        {isDemoMode() ? (
          <div className="settings-card">
            <p>
              🔭 这是只读演示站,不提供网盘连接、登录与任何写入设置。
              想真正使用(连 115/夸克、配 LLM key、自定义画质/通知)请{" "}
              <a href="https://github.com/fancydirty/mediary-scout" target="_blank" rel="noreferrer">
                自部署
              </a>
              。
            </p>
          </div>
        ) : (
          <>
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
            <Suspense fallback={null}>
              <PasswordChangeSection />
            </Suspense>
            <Suspense fallback={null}>
              <AccountManagementSection />
            </Suspense>
          </>
        )}
        <GitHubNameplate />
      </main>
    </div>
  );
}

async function SettingsSidebar({ searchParams }: { searchParams: Promise<{ w?: string }> }) {
  const { w } = await searchParams;
  const workspace = await resolveGlobalWorkspace(w);
  return <AppSidebar active="settings" basePath={workspace.basePath} activeStorageId={workspace.activeStorageId} />;
}

async function PasswordChangeSection() {
  // connection() FIRST: cacheComponents would otherwise prerender this at build time
  // (multi-user off) and bake it as null → never shows in production multi-user.
  await connection();
  if (!isMultiUserEnabled()) return null;
  return (
    <section id="password" className="panel" style={{ maxWidth: 720, marginTop: 24 }}>
      <div className="panel-header">
        <div>
          <h2 className="panel-title">
            <KeyRound size={16} aria-hidden style={{ verticalAlign: "-2px", marginRight: 8 }} />
            修改密码
          </h2>
          <p className="panel-note">修改后所有登录会话失效，需用新密码重新登录</p>
        </div>
      </div>
      <PasswordChangeForm />
    </section>
  );
}

async function AccountManagementSection() {
  await connection();
  if (!isMultiUserEnabled()) return null;
  const me = await getCurrentAccountSummary();
  if (!me?.isOwner) return null;
  const accounts = await listManagedAccounts(await getCurrentAccountId());
  if (!accounts) return null;
  return (
    <section id="accounts" className="panel" style={{ maxWidth: 720, marginTop: 24 }}>
      <div className="panel-header">
        <div>
          <h2 className="panel-title">
            <Users size={16} aria-hidden style={{ verticalAlign: "-2px", marginRight: 8 }} />
            账号管理
          </h2>
          <p className="panel-note">作为站主，你可以为忘记密码的用户重置密码（不影响他们的网盘和媒体库）</p>
        </div>
      </div>
      <AccountAdminPanel accounts={accounts} />
    </section>
  );
}

async function PreferredLanguageSection() {
  await connection();
  const repository = getAccountScopedSettings(await getCurrentAccountId());
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
  const repository = getAccountScopedSettings(await getCurrentAccountId());
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
  const repository = getAccountScopedSettings(await getCurrentAccountId());
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
  const repository = getAccountScopedSettings(await getCurrentAccountId());
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
  const repository = getAccountScopedSettings(await getCurrentAccountId());
  const pansouBaseURL = (await repository.getSetting(PANSOU_BASE_URL_SETTING_KEY)) ?? "";
  const prowlarrBaseURL = (await repository.getSetting(PROWLARR_BASE_URL_SETTING_KEY)) ?? "";
  const prowlarrApiKeySet = Boolean((await repository.getSetting(PROWLARR_API_KEY_SETTING_KEY))?.trim());
  // Prowlarr (磁力/PT) only works for brands that support magnet (115). Hide it
  // when every connected drive is 夸克 (no magnet API). Shown for legacy/env-only
  // setups (no connected_storages rows) so we never hide it from a working 115.
  const drives = await getAccountConnectedStorages();
  const showProwlarr = drives.length === 0 || drives.some((drive) => brandSupportsProwlarr(drive.provider));

  return (
    <section className="panel" style={{ maxWidth: 720, marginTop: 24 }}>
      <div className="panel-header">
        <div>
          <h2 className="panel-title">
            <Radio size={16} aria-hidden style={{ verticalAlign: "-2px", marginRight: 8 }} />
            资源提供商
          </h2>
          <p className="panel-note">
            agent 搜资源的来源；PanSou（网盘）默认内置
            {showProwlarr ? "，Prowlarr（磁力/PT）可选加挂，二者结果合并" : "（夸克盘不支持磁力，已隐藏 Prowlarr）"}
          </p>
        </div>
      </div>
      <PanSouConfigForm baseURL={pansouBaseURL} />
      {showProwlarr ? (
        <>
          <div style={{ height: 18 }} />
          <ProwlarrConfigForm baseURL={prowlarrBaseURL} apiKeySet={prowlarrApiKeySet} />
          <p className="push-help" style={{ margin: "10px 0 0" }}>
            注：夸克网盘 API 不支持磁力，Prowlarr 仅对 115 盘生效；若你只用夸克，无需配置 Prowlarr。
          </p>
        </>
      ) : null}
    </section>
  );
}

async function Pan115Section() {
  await connection();
  const status = await getPan115ConnectionStatus();
  const drives = await getAccountConnectedStorages();

  return (
    <section className="panel" style={{ maxWidth: 720 }}>
      <div className="panel-header">
        <div>
          <h2 className="panel-title">
            <Cable size={16} aria-hidden style={{ verticalAlign: "-2px", marginRight: 8 }} />
            网盘连接
          </h2>
          <p className="panel-note">连接 115（扫码）或夸克（粘贴 cookie）；凭证持久化到数据库，自动用于后续转存。每块盘是独立工作区</p>
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

      {drives.length === 0 ? (
        <p className="qr-hint">还没有连接任何网盘，扫码 115 或粘贴夸克 cookie 后即可开始获取资源。</p>
      ) : null}

      {drives.length > 0 ? (
        <div style={{ margin: "14px 0" }}>
          <p className="panel-note" style={{ marginBottom: 8 }}>
            本账号已连接的网盘{drives.length >= 2 ? "（左上角可切换工作区，每块盘各自独立）" : ""}
          </p>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
            {drives.map((drive) => (
              <li key={drive.id} className="setting-row" style={{ justifyContent: "space-between" }}>
                <span>
                  {drive.provider === "pan115" ? "115网盘" : drive.provider === "quark" ? "夸克网盘" : drive.provider}
                  <span className="push-help"> · 账号 {drive.providerUid}</span>
                  {drive.connectedAt ? (
                    <span className="push-help"> · 连接于 {drive.connectedAt.slice(0, 16).replace("T", " ")}</span>
                  ) : null}
                </span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                  {drive.status === "frozen" ? (
                    <span className="hub-badge tone-amber" title="cookie 已失效，重新扫码绑定同一个 115 即可恢复">
                      <TriangleAlert size={12} aria-hidden />
                      掉线
                    </span>
                  ) : (
                    <span className={`hub-badge ${drive.provisioned ? "tone-green" : "tone-amber"}`}>
                      {drive.provisioned ? "目录已就绪" : "目录待建"}
                    </span>
                  )}
                  <TestConnectionButton storageId={drive.id} />
                  <UnbindStorageButton
                    storageId={drive.id}
                    label={drive.provider === "pan115" ? "115网盘" : drive.provider === "quark" ? "夸克网盘" : drive.provider}
                  />
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="panel-note" style={{ marginBottom: 8 }}>
        {drives.length > 0
          ? "添加另一块网盘（115 或夸克）——不同账号即新增一块独立工作区；绑到已连的同一账号会自动刷新登录"
          : "添加你的第一块网盘"}
      </p>
      <AddDriveBrandTabs />

      <p className="panel-note" style={{ marginTop: 12 }}>
        ⚠️ 请勿在多个账号或多个实例上绑定同一个网盘账号，易触发风控。每个网盘账号在本实例内只能归属一个用户。
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
  const repository = getAccountScopedSettings(await getCurrentAccountId());

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
