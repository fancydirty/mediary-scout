"use client";

import { TriangleAlert } from "lucide-react";

/** Root error boundary. Before this existed, any server-render crash (e.g. every
 *  TMDB access unreachable on a GFW-blocked deployment, issue #134) fell through
 *  to Next's bare "This page couldn't load" screen with nothing actionable on it.
 *  Production redacts server error messages, so the digest is the only safe
 *  detail to surface — it lets a reporter quote something concrete in an issue. */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="quiet-state" role="alert">
      <TriangleAlert size={28} aria-hidden />
      <strong>页面渲染失败</strong>
      <span>
        多半是部署环境连不上某个上游服务（TMDB／资源搜索）——国内网络未配置代理时常见。
        检查部署主机（或容器）的网络后重试。
      </span>
      <button className="primary-button" type="button" onClick={reset}>
        重试
      </button>
      {error.digest ? <span className="panel-note">digest: {error.digest}</span> : null}
    </div>
  );
}
