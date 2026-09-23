import { driveConnectionBadge } from "../../lib/settings-badge";
import { maskProviderUid } from "../../lib/mask-provider-uid";
import { connection } from "next/server";
import { headers } from "next/headers";
import { Suspense } from "react";
import { Bell, Bot, Cable, CalendarClock, Clapperboard, ExternalLink, Gauge, KeyRound, Languages, Radio, ShieldCheck, Subtitles, TriangleAlert, Users } from "lucide-react";
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
import { JevPrefilterForm } from "../../components/jev-prefilter-form";
import { ServiceBlock } from "../../components/service-block";
import { assrtPills, isEnvBackedValue, jevPills, llmPills, pansouPills, prowlarrPills, tmdbPills } from "../../lib/service-status";
import { PanSouConfigForm } from "../../components/pansou-config-form";
import { DailySweepForm } from "../../components/daily-sweep-form";
import { PatrolNowButton } from "../../components/patrol-now-button";
import { SettingsTabs } from "../../components/settings-tabs";
import { PasswordChangeForm } from "../../components/password-change-form";
import { AccountAdminPanel } from "../../components/account-admin-panel";
import { RemoteAccessSection } from "../../components/settings/remote-access-section";
import { GitHubNameplate } from "../../components/github-nameplate";
import { SettingsActionInbox } from "../../components/settings-action-inbox";
import { loadSettingsAttentionSummary, markSettingsAttentionSeen } from "../../lib/settings-attention-server";
import { resolveRequestOrigin } from "../../lib/request-origin";
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
  getProwlarrConfig,
  resolveAgentModelConfig,
  getJevConfig,
  getJevBaseUrlOverride,
  getJevInheritedBaseUrl,
  isJevPrefilterActive,
  JEV_API_KEY_SETTING_KEY,
  JEV_BASE_URL_SETTING_KEY,
  JEV_MODEL_SETTING_KEY,
  PANSOU_BASE_URL_SETTING_KEY,
  PANSOU_HEALTH_SETTING_KEY,
  resolveGlobalWorkspace,
  resolveIsDesktop,
} from "../../lib/workflow-runtime";
import { brandSupportsProwlarr, brandsSupportingProwlarr, getStorageBrand, isRegisteredStorageProvider } from "@media-track/workflow";
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
              想真正使用(连 夸克/115/光鸭/123/天翼、配 LLM key、自定义画质/通知)请{" "}
              <a href="https://github.com/fancydirty/mediary-scout" target="_blank" rel="noreferrer">
                自部署
              </a>
              。
            </p>
          </div>
        ) : (
          <>
            <Suspense fallback={null}>
              <SettingsAttentionSection searchParams={searchParams} />
            </Suspense>
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
              // Fallback is null, not a skeleton: a skeleton element would stream
              // into the slot and the empty-slot observer would read the tab as
              // visible before we know whether the viewer is the 站主.
              remote={
                // 桌面版没有远程访问功能(自托管才有):slot 置空 →
                // SettingsTabs 观察不到内容 → 「远程访问」tab 不出现。
                resolveIsDesktop() ? null : (
                  <Suspense fallback={null}>
                    <RemoteAccessSection searchParams={searchParams} />
                  </Suspense>
                )
              }
            />
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

async function SettingsAttentionSection({
  searchParams,
}: {
  searchParams: Promise<{ w?: string }>;
}) {
  // Request-time only: account drives + LLM config + optional update probe.
  // Loader resolves account/drives once (including optional ?w deep-link context).
  await connection();
  const { w } = await searchParams;
  const origin = resolveRequestOrigin(await headers());
  const summary = await loadSettingsAttentionSummary({ ...(w ? { w } : {}), origin });
  // AFTER the summary load: anything first sighted during THIS render gets
  // createdAt <= the seen_at written here → never badges the page it was shown on.
  await markSettingsAttentionSeen();
  return <SettingsActionInbox items={summary.items} />;
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
  const accountId = await getCurrentAccountId();
  const repository = getAccountScopedSettings(accountId);
  const baseURL = (await repository.getSetting(LLM_BASE_URL_SETTING_KEY)) ?? "";
  const modelId = (await repository.getSetting(LLM_MODEL_ID_SETTING_KEY)) ?? "";
  const apiKeySet = Boolean((await repository.getSetting(LLM_API_KEY_SETTING_KEY))?.trim());
  // The form shows the DB values; the pill shows what acquisitions will actually use —
  // the worker's own resolver (DB → AGENT_MODEL_* → XIAOMI_MIMO_*). fromEnv: a
  // non-blank effective value was filled in by env because its DB field is blank.
  const effectiveLlm = await resolveAgentModelConfig(repository);
  const llmFromEnv =
    isEnvBackedValue(baseURL, effectiveLlm.baseURL) ||
    isEnvBackedValue(modelId, effectiveLlm.modelId) ||
    (!apiKeySet && Boolean(effectiveLlm.apiKey?.trim()));
  // Jev lives here, not under 资源提供商: it is not a resource SOURCE, it is a second
  // AI service (with its own key) that assists the main model. One read, one rule:
  // getJevConfig applies DB→env fallback; isJevPrefilterActive is the same go/no-go
  // the worker uses, so the pill cannot drift from what actually runs.
  const jev = await getJevConfig(repository);
  const jevKeyFromEnv = !(await repository.getSetting(JEV_API_KEY_SETTING_KEY))?.trim() && Boolean(jev.apiKey);
  // The input shows THIS account's own override — not the resolved default and not a
  // global value (the facade above would fall back to it). Prefilling either would be
  // typed straight back on the next 保存, freezing that endpoint into the account row
  // and shadowing later global / env JEV_BASE_URL changes; the placeholder already
  // tells the user what blank resolves to.
  const jevBaseUrlOverride = await getJevBaseUrlOverride(accountId);
  const jevGlobalBaseUrl = (await getWorkflowRepository().getSetting(JEV_BASE_URL_SETTING_KEY))?.trim() ?? "";
  const jevBaseUrlFromEnv =
    !jevBaseUrlOverride && isEnvBackedValue(jevGlobalBaseUrl, process.env.JEV_BASE_URL);
  const jevFromEnv = jevKeyFromEnv || jevBaseUrlFromEnv;
  // …and blank resolves to THIS (instance → env → OpenRouter), shown as the placeholder.
  const jevInheritedBaseUrl = await getJevInheritedBaseUrl();
  const jevModel = (await repository.getSetting(JEV_MODEL_SETTING_KEY))?.trim() || null;

  return (
    <section className="panel" style={{ maxWidth: 720, marginTop: 24 }}>
      <div className="panel-header">
        <div>
          <h2 className="panel-title">
            <Bot size={16} aria-hidden style={{ verticalAlign: "-2px", marginRight: 8 }} />
            AI 模型
          </h2>
          <p className="panel-note">获取 agent 用的大模型，以及给它当「一秒判断」助手的 Jev</p>
        </div>
      </div>
      <ServiceBlock
        name="主模型"
        pills={llmPills({
          baseURL: effectiveLlm.baseURL ?? "",
          modelId: effectiveLlm.modelId ?? "",
          fromEnv: llmFromEnv,
        })}
        summary="任意 OpenAI 兼容服务，必填；Key 只存你本机。"
        details={
          <p>
            自带你自己的 key——它只存在你这台机器的数据库里，作者看不到。未配置时获取会失败；本地模型 Key 可留空。留空 API Key 不会改动已保存的值。
          </p>
        }
      >
        <LlmConfigForm baseURL={baseURL} modelId={modelId} apiKeySet={apiKeySet} />
      </ServiceBlock>
      <ServiceBlock
        name="Jev 候选预筛"
        pills={jevPills({
          apiKeySet: Boolean(jev.apiKey),
          healthy: jev.health === "ok",
          active: isJevPrefilterActive(jev),
          model: jevModel,
          fromEnv: jevFromEnv,
        })}
        summary="搜索结果进 agent 前先剔掉无关候选、标记存疑；每次搜索约 1–3 秒，成本可忽略。未配置时不产生任何调用。"
        details={
          <>
            <p>
              搜索结果进入 agent 之前，先由 Jev（TypeSafe 决策模型）判断每条候选是否指向目标作品——确定无关的直接剔除，拿不准的标记「相关度存疑」交给 agent。
            </p>
            <p>
              Jev API Key 两种来源都可以（模型 jev-latest）：{" "}
              <a href="https://openrouter.ai/typesafe/jev-latest" target="_blank" rel="noopener noreferrer">
                OpenRouter <ExternalLink size={12} style={{ verticalAlign: "-1px" }} />
              </a>{" "}
              或{" "}
              <a href="https://console.typesafe.ai/keys" target="_blank" rel="noopener noreferrer">
                TypeSafe 官方 <ExternalLink size={12} style={{ verticalAlign: "-1px" }} />
              </a>
              。用官方 Key 时把 Base URL 填为 https://api.typesafe.ai/v1/systemone；留空则沿用实例配置的地址（框内灰字，都未配置时为 OpenRouter 的 decisions 端点）。
            </p>
          </>
        }
      >
        <JevPrefilterForm
          baseUrl={jevBaseUrlOverride}
          inheritedBaseUrl={jevInheritedBaseUrl}
          apiKeySet={Boolean(jev.apiKey)}
          enabled={jev.enabled}
          healthy={jev.health === "ok"}
        />
      </ServiceBlock>
    </section>
  );
}

async function TmdbApiKeySection() {
  await connection();
  const repository = getAccountScopedSettings(await getCurrentAccountId());
  const apiKeySet = Boolean((await repository.getSetting(TMDB_API_KEY_SETTING_KEY))?.trim());
  // Mirrors getTmdbAccesses' second layer: no DB key → env TMDB_READ_TOKEN goes direct.
  const envKeySet = Boolean(process.env.TMDB_READ_TOKEN?.trim());

  return (
    <section className="panel" style={{ maxWidth: 720, marginTop: 24 }}>
      <div className="panel-header">
        <div>
          <h2 className="panel-title">
            <Clapperboard size={16} aria-hidden style={{ verticalAlign: "-2px", marginRight: 8 }} />
            TMDB 元数据
          </h2>
          <p className="panel-note">影视元数据来源</p>
        </div>
      </div>
      <ServiceBlock
        name="TMDB"
        pills={tmdbPills({ userKeySet: apiKeySet, envKeySet })}
        summary="海报、简介、集数的来源；默认走作者代理兜底，填自己的 Token 可直连。"
        details={
          <>
            <p>
              你在页面上看到的电影、剧集海报、简介、集数等数据，都来自 The Movie Database (TMDB)。默认由作者的代理服务兜底（已缓存、开箱即用，无需任何配置）。想更稳定可申请自己的 API Read Token 填入直连你自己的额度；调不通时会自动回退到代理。留空不改动已保存的值。
            </p>
            <p>
              了解 TMDB{" "}
              <a href="https://www.themoviedb.org/" target="_blank" rel="noopener noreferrer">
                官网 <ExternalLink size={12} style={{ verticalAlign: "-1px" }} />
              </a>
              {" · 申请自己的 API Read Token "}
              <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener noreferrer">
                获取方法 <ExternalLink size={12} style={{ verticalAlign: "-1px" }} />
              </a>
            </p>
          </>
        }
      >
        <TmdbApiKeyForm apiKeySet={apiKeySet} />
      </ServiceBlock>
    </section>
  );
}

const PANSOU_SELF_HOST_TUTORIAL_URL =
  "https://github.com/fancydirty/mediary-scout/blob/main/docs/pansou-self-host.md";

async function ResourceProviderSection() {
  await connection();
  const accountId = await getCurrentAccountId();
  const repository = getAccountScopedSettings(accountId);
  const pansouBaseURL = (await repository.getSetting(PANSOU_BASE_URL_SETTING_KEY)) ?? "";
  const pansouHealth = (await repository.getSetting(PANSOU_HEALTH_SETTING_KEY)) ?? "";
  const prowlarrBaseURL = (await repository.getSetting(PROWLARR_BASE_URL_SETTING_KEY)) ?? "";
  const prowlarrApiKeySet = Boolean((await repository.getSetting(PROWLARR_API_KEY_SETTING_KEY))?.trim());
  // The form shows the DB values; the pill follows what the worker mounts
  // (getProwlarrConfig: DB → env PROWLARR_BASE_URL / PROWLARR_API_KEY).
  const prowlarr = await getProwlarrConfig(repository);
  const prowlarrFromEnv =
    (!prowlarrBaseURL.trim() && Boolean(prowlarr.baseURL)) || (!prowlarrApiKeySet && Boolean(prowlarr.apiKey));
  // Prowlarr (磁力/PT) only works for brands that support magnet. Hide it when no
  // connected drive supports it. Shown for legacy/env-only setups (no
  // connected_storages rows) so we never hide it from a working 115.
  const drives = await getAccountConnectedStorages();
  const showProwlarr = drives.length === 0 || drives.some((drive) => brandSupportsProwlarr(drive.provider));
  const isDesktop = resolveIsDesktop();
  const magnetBrands = brandsSupportingProwlarr().join(" / ");

  return (
    <section className="panel" style={{ maxWidth: 720, marginTop: 24 }}>
      <div className="panel-header">
        <div>
          <h2 className="panel-title">
            <Radio size={16} aria-hidden style={{ verticalAlign: "-2px", marginRight: 8 }} />
            资源提供商
          </h2>
          <p className="panel-note">
            {showProwlarr
              ? "agent 搜资源的来源；网盘搜索为主，磁力可选加挂，结果合并"
              : "agent 搜资源的来源；已连接的网盘都不支持磁力，Prowlarr 已隐藏"}
          </p>
        </div>
      </div>
      <ServiceBlock
        name="PanSou 网盘搜索"
        pills={pansouPills({
          // The two layers of resolveUserPanSouBaseUrl (DB, then env PANSOU_BASE_URL);
          // both blank → the runtime falls back to the public DEFAULT_PANSOU_BASE_URL.
          dbBaseURL: pansouBaseURL,
          envBaseURL: process.env.PANSOU_BASE_URL?.trim() ?? "",
          health: pansouHealth,
        })}
        summary={
          isDesktop
            ? "未配置时用作者的公共实例，建议自建。"
            : "默认内置、开箱即用；填地址可换成自建或公共实例。"
        }
        details={
          <>
            {isDesktop ? (
              <p>
                桌面端<b>不含</b> PanSou 容器。未在下方配置时，默认指向作者的公共实例（资源有限、偶尔不稳）。想要更丰富的网盘源（尤其 115 分享、4K），建议自建一个配好频道的 PanSou 实例，把地址填在下方。{" "}
                <a href={PANSOU_SELF_HOST_TUTORIAL_URL} target="_blank" rel="noopener noreferrer">
                  查看自建教程 <ExternalLink size={12} style={{ verticalAlign: "-1px" }} />
                </a>
              </p>
            ) : (
              <p>
                PanSou 是默认的网盘资源搜索源（已内置、开箱即用）。docker compose 部署会自动指向自带的 PanSou 容器；想换成别的实例或公共域名时在此手填覆盖。留空则回退到环境变量 / 公共默认实例。
              </p>
            )}
            <p>
              了解 PanSou{" "}
              <a href="https://github.com/fish2018/pansou" target="_blank" rel="noopener noreferrer">
                项目主页 <ExternalLink size={12} style={{ verticalAlign: "-1px" }} />
              </a>
            </p>
          </>
        }
      >
        <PanSouConfigForm baseURL={pansouBaseURL} />
      </ServiceBlock>
      {showProwlarr ? (
        <ServiceBlock
          name="Prowlarr 磁力 / PT"
          pills={prowlarrPills({
            baseURL: prowlarr.baseURL ?? "",
            apiKeySet: Boolean(prowlarr.apiKey),
            fromEnv: prowlarrFromEnv,
          })}
          summary={`把你的种子站聚合成一个 API，磁力靠秒传瞬时落盘；仅对支持磁力的盘生效（${magnetBrands}）。`}
          details={
            <>
              <p>
                Prowlarr 是索引器聚合器：用它把你的公共/私有种子站统一成一个 API，agent 搜资源时会把 Prowlarr 的磁力和网盘搜索结果合并判断。磁力靠网盘秒传（哈希匹配）瞬时转存。不填则只用内置网盘搜索。留空 API Key 不改动已保存的值。
              </p>
              <p>
                了解 Prowlarr{" "}
                <a href="https://prowlarr.com/" target="_blank" rel="noopener noreferrer">
                  官网 <ExternalLink size={12} style={{ verticalAlign: "-1px" }} />
                </a>
              </p>
            </>
          }
        >
          <ProwlarrConfigForm baseURL={prowlarrBaseURL} apiKeySet={prowlarrApiKeySet} />
        </ServiceBlock>
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
          <p className="panel-note">外挂中文字幕自动补全</p>
        </div>
      </div>
      <ServiceBlock
        name="assrt.net 字幕"
        pills={assrtPills({ tokenSet })}
        summary="非国产内容自动补外挂中文字幕；需网盘支持外链离线（115 / 光鸭 / 123）。"
        details={
          <>
            <p>
              外挂中文字幕来源：assrt.net（伪射手）有免费官方 API，agent 获取非国产剧集/电影时会自动搜字幕候选并挑合适的落盘到视频旁。需网盘支持外链离线落盘（115 / 光鸭 / 123 支持，123 会占用该账号的离线下载额度；夸克、天翼没有离线接口，不触发）。免费申请 Token，留空则该功能完全不启用。国产内容原生中文对白，不需要此功能。
            </p>
            <p>
              了解 assrt.net{" "}
              <a href="https://assrt.net" target="_blank" rel="noopener noreferrer">
                官网 <ExternalLink size={12} style={{ verticalAlign: "-1px" }} />
              </a>
              {" · 免费申请 Token "}
              <a href="https://secure.assrt.net/user/register.xml" target="_blank" rel="noopener noreferrer">
                注册页面 <ExternalLink size={12} style={{ verticalAlign: "-1px" }} />
              </a>
            </p>
          </>
        }
      >
        <AssrtTokenForm tokenSet={tokenSet} />
      </ServiceBlock>
    </section>
  );
}

/** 品牌显示名直读 workflow 注册表(单一事实源,与 workspace-switcher 一致),
 *  未注册品牌兜底显示原始 provider 串。盘卡与解绑确认共用。 */
function providerLabel(provider: string): string {
  return isRegisteredStorageProvider(provider) ? getStorageBrand(provider).label : provider;
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
                  {isRegisteredStorageProvider(drive.provider) ? (
                    // 已注册品牌必有 svg(workspace-switcher 同款资产)
                    // eslint-disable-next-line @next/next/no-img-element
                    <img className="drive-card-icon" src={`/brands/${drive.provider}.svg`} alt="" width={26} height={26} />
                  ) : (
                    // 未注册品牌:中性方形占位(与右侧状态圆点区分形状,避免双点误读)
                    <span className="drive-card-icon-fallback" aria-hidden />
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
