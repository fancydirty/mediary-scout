import { driveConnectionBadge } from "../../lib/settings-badge";
import { maskProviderUid } from "../../lib/mask-provider-uid";
import { connection } from "next/server";
import { Suspense } from "react";
import { Bell, Bot, Cable, CalendarClock, Clapperboard, Gauge, KeyRound, Languages, Radio, ShieldCheck, Subtitles, TriangleAlert, Users } from "lucide-react";
import { AppSidebar } from "../../components/app-sidebar";
import { AddDriveBrandTabs } from "../../components/add-drive-brand-tabs";
import { TestConnectionButton } from "../../components/test-connection-button";
import { UnbindStorageButton } from "../../components/unbind-storage-button";
import { PushNotificationForm } from "../../components/push-notification-form";
import { PreferredLanguageForm } from "../../components/preferred-language-form";
import { QualityPreferenceForm } from "../../components/quality-preference-form";
import { LlmConfigForm } from "../../components/llm-config-form";
import { TmdbApiKeyForm } from "../../components/tmdb-api-key-form";
import { AssrtTokenForm } from "../../components/assrt-token-form";
import { ProwlarrConfigForm } from "../../components/prowlarr-config-form";
import { PanSouConfigForm } from "../../components/pansou-config-form";
import { DailySweepForm } from "../../components/daily-sweep-form";
import { PatrolNowButton } from "../../components/patrol-now-button";
import { SettingsTabs } from "../../components/settings-tabs";
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
  getDailySweepTimes,
  MAX_DAILY_SWEEP_TIMES,
  LAST_SWEEP_COMPLETED_AT_SETTING_KEY,
  beijingDateTime,
  getPan115ConnectionStatus,
  getWorkflowRepository,
  PREFERRED_LANGUAGE_SETTING_KEY,
  QUALITY_PREFERENCE_SETTING_KEY,
  LLM_BASE_URL_SETTING_KEY,
  LLM_MODEL_ID_SETTING_KEY,
  LLM_API_KEY_SETTING_KEY,
  TMDB_API_KEY_SETTING_KEY,
  ASSRT_TOKEN_SETTING_KEY,
  PROWLARR_BASE_URL_SETTING_KEY,
  PROWLARR_API_KEY_SETTING_KEY,
  PANSOU_BASE_URL_SETTING_KEY,
  resolveGlobalWorkspace,
  resolveIsDesktop,
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
          <Suspense fallback={<div className="skeleton skeleton-heading" />}>
            <SettingsTabs
              drives={
                <Suspense fallback={<div className="skeleton skeleton-heading" />}>
                  <Pan115Section />
                </Suspense>
              }
              services={
                <>
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
                    <SubtitleSourceSection />
                  </Suspense>
                </>
              }
              preferences={
                <>
                  <Suspense fallback={<div className="skeleton skeleton-heading" />}>
                    <PreferredLanguageSection />
                  </Suspense>
                  <Suspense fallback={<div className="skeleton skeleton-heading" />}>
                    <QualityPreferenceSection />
                  </Suspense>
                </>
              }
              patrol={
                <>
                  <Suspense fallback={<div className="skeleton skeleton-heading" />}>
                    <DailySweepSection />
                  </Suspense>
                  <Suspense fallback={<div className="skeleton skeleton-heading" />}>
                    <PushNotificationSection />
                  </Suspense>
                </>
              }
              account={
                <>
                  <Suspense fallback={null}>
                    <PasswordChangeSection />
                  </Suspense>
                  <Suspense fallback={null}>
                    <AccountManagementSection />
                  </Suspense>
                </>
              }
            />
          </Suspense>
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
          <p className="panel-note">
            获取 agent 用的大模型(任意 OpenAI 兼容服务,自带);<strong>必填</strong>,未配置时获取会失败。本地模型 Key 可留空。只存你本机
          </p>
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
  const isDesktop = resolveIsDesktop();

  return (
    <section className="panel" style={{ maxWidth: 720, marginTop: 24 }}>
      <div className="panel-header">
        <div>
          <h2 className="panel-title">
            <Radio size={16} aria-hidden style={{ verticalAlign: "-2px", marginRight: 8 }} />
            资源提供商
          </h2>
          <p className="panel-note">
            agent 搜资源的来源；PanSou（网盘）{isDesktop ? "建议自建实例" : "默认内置"}
            {showProwlarr ? "，Prowlarr（磁力/PT）可选加挂，二者结果合并" : "（夸克盘不支持磁力，已隐藏 Prowlarr）"}
          </p>
        </div>
      </div>
      <PanSouConfigForm baseURL={pansouBaseURL} isDesktop={isDesktop} />
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

async function SubtitleSourceSection() {
  await connection();
  const repository = getAccountScopedSettings(await getCurrentAccountId());
  const tokenSet = Boolean((await repository.getSetting(ASSRT_TOKEN_SETTING_KEY))?.trim());

  return (
    <section className="panel" style={{ maxWidth: 720, marginTop: 24 }}>
      <div className="panel-header">
        <div>
          <h2 className="panel-title">
            <Subtitles size={16} aria-hidden style={{ verticalAlign: "-2px", marginRight: 8 }} />
            字幕来源
          </h2>
          <p className="panel-note">外挂中文字幕自动补全（assrt.net，免费）；仅对非国产内容生效，需网盘支持外链离线（目前：115）</p>
        </div>
      </div>
      <AssrtTokenForm tokenSet={tokenSet} />
    </section>
  );
}

/** 品牌显示名(与注册表 label 一致);盘卡与解绑确认共用。 */
const PROVIDER_LABELS: Record<string, string | undefined> = {
  pan115: "115网盘",
  quark: "夸克网盘",
  guangya: "光鸭云盘",
  tianyi: "天翼云盘",
  pan123: "123网盘",
};

function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
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
          <p className="panel-note">每块盘是独立工作区，左上角可切换；凭证入库后自动用于转存</p>
        </div>
        {(() => {
          // #93: derive the header badge from ALL drives — 115-only status made
          // a 光鸭/夸克-only user read a permanent misleading 未连接.
          const badge = driveConnectionBadge({ envConnected: status.connected && status.source === "env", drives });
          return (
            <span className={`hub-badge tone-${badge.tone}`}>
              {badge.tone === "green" ? (
                <ShieldCheck size={12} aria-hidden />
              ) : (
                <TriangleAlert size={12} aria-hidden />
              )}
              {badge.label}
            </span>
          );
        })()}
      </div>

      {drives.length === 0 ? (
        <p className="qr-hint">还没有连接任何网盘，选择下方品牌完成连接后即可开始获取资源。</p>
      ) : null}

      {drives.length > 0 ? (
        <div className="drive-grid">
          {drives.map((drive) => {
            const frozen = drive.status === "frozen";
            const ready = !frozen && drive.provisioned;
            return (
              <div key={drive.id} className={`drive-card${frozen ? " is-frozen" : ""}`}>
                <div className="drive-card-head">
                  {PROVIDER_LABELS[drive.provider] ? (
                    // 已注册品牌必有 svg(workspace-switcher 同款资产)
                    // eslint-disable-next-line @next/next/no-img-element
                    <img className="drive-card-icon" src={`/brands/${drive.provider}.svg`} alt="" width={26} height={26} />
                  ) : (
                    <span className="drive-dot amber" aria-hidden />
                  )}
                  <span className="drive-card-name">{providerLabel(drive.provider)}</span>
                  <span
                    className={`drive-dot ${ready ? "green" : "amber"}`}
                    role="img"
                    title={frozen ? "凭证已失效，重新绑定同一账号即可恢复" : ready ? "目录已就绪" : "目录待建"}
                    aria-label={frozen ? "掉线" : ready ? "就绪" : "目录待建"}
                  />
                </div>
                <div className="drive-card-uid" title={drive.providerUid}>
                  {maskProviderUid(drive.providerUid)}
                </div>
                <div className="drive-card-meta">
                  {frozen ? (
                    <span className="tone-amber-text">掉线 · 重新绑定即恢复</span>
                  ) : !drive.provisioned ? (
                    <span className="tone-amber-text">目录待建</span>
                  ) : drive.connectedAt ? (
                    <span>{drive.connectedAt.slice(0, 10)} 连接</span>
                  ) : (
                    <span>就绪</span>
                  )}
                </div>
                <div className="drive-card-actions">
                  <TestConnectionButton storageId={drive.id} />
                  <UnbindStorageButton storageId={drive.id} label={providerLabel(drive.provider)} />
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      <p className="panel-note drive-add-heading">
        {drives.length > 0 ? "添加网盘 · 选择品牌开始连接" : "添加你的第一块网盘"}
        {drives.length > 0 ? (
          <span className="drive-add-hint">不同账号即新增一块独立工作区；绑已连的同一账号会自动刷新登录</span>
        ) : null}
      </p>
      <AddDriveBrandTabs defaultBrand={drives.length > 0 ? null : "pan115"} />

      <p className="panel-note drive-risk-note">
        <TriangleAlert size={12} aria-hidden style={{ verticalAlign: "-2px", marginRight: 4 }} />
        同一网盘账号勿在多个账号或多个实例绑定，易触发风控；每个网盘账号在本实例内只能归属一个用户。
      </p>
    </section>
  );
}

async function DailySweepSection() {
  await connection();
  const repository = getWorkflowRepository();
  const times = await getDailySweepTimes(repository);
  const lastSweepAt = await repository.getSetting(LAST_SWEEP_COMPLETED_AT_SETTING_KEY);
  const { hhmm } = beijingDateTime();

  const nextSlot = times.find((slot) => slot > hhmm) ?? times[0]!;
  // 坏 ISO 串（手改/旧版遗留）会让 format() 抛 RangeError 炸掉整页 SSR——先验有效性。
  const lastSweepDate = lastSweepAt ? new Date(lastSweepAt) : null;
  const lastLabel =
    lastSweepDate && Number.isFinite(lastSweepDate.getTime())
      ? new Intl.DateTimeFormat("zh-CN", {
          timeZone: "Asia/Shanghai",
          month: "numeric",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        }).format(lastSweepDate)
      : "尚未巡检";

  return (
    <section className="panel" style={{ maxWidth: 720, marginTop: 24 }}>
      <div className="panel-header">
        <div>
          <h2 className="panel-title">
            <CalendarClock size={16} aria-hidden style={{ verticalAlign: "-2px", marginRight: 8 }} />
            每日定时巡检
          </h2>
          <p className="panel-note">在这些时间点自动追更：检查已追踪剧集，获取新播出或仍缺失的集数</p>
        </div>
      </div>
      <DailySweepForm initial={times} max={MAX_DAILY_SWEEP_TIMES} />
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          marginTop: 16,
          paddingTop: 14,
          borderTop: "1px solid #2a2a2a",
          flexWrap: "wrap",
        }}
      >
        <PatrolNowButton />
        <span className="push-help" style={{ marginLeft: "auto" }}>
          上次巡检 {lastLabel} · 下次巡检 {nextSlot}
        </span>
      </div>
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
