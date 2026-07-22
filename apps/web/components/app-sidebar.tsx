import { Suspense } from "react";
import Link from "next/link";
import { Activity, Aperture, Bell, Library, Settings } from "lucide-react";
import { globalNavHref } from "@media-track/workflow";
import { SearchNavLink } from "./search-memory";
import { ActivityNavBadge } from "./activity-nav-badge";
import { NotificationsNavBadge } from "./notifications-nav-badge";
import { SettingsAttentionBadge } from "./settings-attention-badge";
import { WorkspaceSwitcherLoader } from "./workspace-switcher-loader";
import { AccountIdentityLoader } from "./account-identity-loader";

export function AppSidebar({
  active,
  searchQuery = "",
  basePath = "/",
  activeStorageId,
}: {
  active: "search" | "library" | "notifications" | "activity" | "settings" | "none";
  searchQuery?: string;
  /** Tree model: the active workspace path ("/w/<id>" or "/") so the search/library
   *  tabs keep you in the workspace you're viewing. */
  basePath?: string;
  /** The active non-primary drive id (undefined = primary). Global links
   *  (通知/活动/设置) carry it as `?w` so leaving a workspace keeps the drive. */
  activeStorageId?: string | undefined;
}) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">
          <Aperture size={18} aria-hidden />
        </span>
        <span className="brand-copy">
          <strong>Mediary Scout</strong>
          <span>multi-drive media agent</span>
        </span>
      </div>

      {/* Drive switcher (≥2 drives). In Suspense so its DB read never blocks the
          static shell, and so the client switcher's useSearchParams() is allowed. */}
      <Suspense fallback={null}>
        <WorkspaceSwitcherLoader />
      </Suspense>

      {/* Account identity — mobile top-bar copy (desktop keeps the footer one).
          Single-user/demo → AccountIdentityLoader returns null → empty. */}
      <Suspense fallback={null}>
        <div className="sidebar-top-identity">
          <AccountIdentityLoader />
        </div>
      </Suspense>

      <nav aria-label="主导航">
        <ul className="nav-list">
          <li>
            <SearchNavLink active={active === "search"} knownQuery={searchQuery} basePath={basePath} />
          </li>
          <li>
            <Link
              className={`nav-item ${active === "library" ? "is-active" : ""}`}
              href={`${basePath}?tab=library`}
            >
              <Library size={16} aria-hidden />
              媒体库
            </Link>
          </li>
          <li>
            <Link
              className={`nav-item ${active === "notifications" ? "is-active" : ""}`}
              href={globalNavHref("/notifications", activeStorageId)}
            >
              <Bell size={16} aria-hidden />
              通知
              <NotificationsNavBadge storageId={activeStorageId} />
            </Link>
          </li>
          {/* 活动 + 设置 are secondary: on desktop they live in the footer; on the
              mobile top bar (footer hidden) they surface as nav items here. */}
          <li className="nav-activity-item">
            <Link
              className={`nav-item ${active === "activity" ? "is-active" : ""}`}
              href={globalNavHref("/activity", activeStorageId)}
            >
              <Activity size={16} aria-hidden />
              活动
              <ActivityNavBadge storageId={activeStorageId} />
            </Link>
          </li>
          <li className="nav-settings-item">
            <Link
              className={`nav-item ${active === "settings" ? "is-active" : ""}`}
              href={globalNavHref("/settings", activeStorageId)}
            >
              <Settings size={16} aria-hidden />
              设置
              <SettingsAttentionBadge storageId={activeStorageId} visibleWhen="mobile" />
            </Link>
          </li>
        </ul>
      </nav>

      <div className="sidebar-footer">
        {/* Account identity (multi-user only) — who am I + 改密码/登出/账号管理. In
            Suspense so its DB read never blocks the shell. */}
        <Suspense fallback={null}>
          <AccountIdentityLoader />
        </Suspense>
        <Link
          className={`nav-item nav-secondary ${active === "activity" ? "is-active" : ""}`}
          href={globalNavHref("/activity", activeStorageId)}
        >
          <Activity size={16} aria-hidden />
          活动
          <ActivityNavBadge storageId={activeStorageId} />
        </Link>
        <Link className="health-card" href={globalNavHref("/settings", activeStorageId)} style={{ textDecoration: "none", color: "inherit" }}>
          <span className="health-icon">
            <Settings size={16} aria-hidden />
          </span>
          <span>
            <strong>设置</strong>
            <span>网盘连接 · 推送 · 偏好</span>
          </span>
          <SettingsAttentionBadge storageId={activeStorageId} visibleWhen="desktop" />
        </Link>
      </div>
    </aside>
  );
}
