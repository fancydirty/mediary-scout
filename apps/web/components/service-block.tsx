// apps/web/components/service-block.tsx
import type { ReactNode } from "react";
import type { ServicePill } from "../lib/service-status";

/**
 * 设置 → 资源与服务 的「服务块」：面板内每个服务一段固定节奏 ——
 *   名称 + 状态胶囊 → 一句话用途 → （可折叠的长说明）→ 字段 + 动作行（children）。
 * 服务端组件、无 hooks：胶囊由 Section 用 lib/service-status 的纯函数算好传入；
 * 表单（client）保存成功后 router.refresh()，胶囊随之更新。
 * 同一面板内相邻块之间的 1px 细线由 CSS `.service-block + .service-block` 画。
 */
export function ServiceBlock({
  name,
  pills = [],
  summary,
  details,
  children,
}: {
  name: string;
  pills?: ServicePill[];
  summary: string;
  /** 原来散在表单里的长说明 + 外链，默认收起。不传则不渲染折叠区。 */
  details?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="service-block">
      <div className="service-block-head">
        <h3 className="service-block-name">{name}</h3>
        {pills.map((pill) => (
          // title：胶囊超宽时 CSS 用省略号截断（用户填的模型名可以很长），全文靠悬停看。
          <span key={`${pill.tone}:${pill.label}`} className={`service-pill is-${pill.tone}`} title={pill.label}>
            {pill.label}
          </span>
        ))}
      </div>
      <p className="service-block-summary">{summary}</p>
      {details ? (
        <details className="service-block-details">
          {/* 每个块都有一个「说明」：可访问名带上服务名，读屏时才分得清是谁的说明。 */}
          <summary aria-label={`${name} 说明`}>说明</summary>
          <div className="service-block-details-body">{details}</div>
        </details>
      ) : null}
      {children}
    </section>
  );
}
