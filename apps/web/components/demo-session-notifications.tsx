"use client";

import { CheckCircle2, PartyPopper } from "lucide-react";
import { isDemoModeClient } from "../lib/demo-mode";
import { demoSessionNotifications } from "../lib/demo-session";
import { useDemoAcquisitions } from "../lib/use-demo-session";

const TMDB_FEED_POSTER = "https://image.tmdb.org/t/p/w154";

/**
 * Read-only demo: this session's acquisitions surfaced as 通知-feed cards (no DB
 * notification exists). Mounted in the notifications page's static shell (NOT
 * inside the streaming Suspense) so it hydrates AND so its `data-created-at`
 * cards are seen by NotificationsSeenMarker — which marks them NEW and advances
 * the last-seen watermark, exactly like real notifications. Renders nothing
 * outside demo or when empty.
 */
export function DemoSessionNotifications() {
  // Guard at the COMPONENT boundary, before any demo hooks: isDemoModeClient() is a
  // build-time constant, so in real builds the inner (hook-using) body never mounts
  // → zero hook/effect/render cost. (Conditional component, NOT conditional hook.)
  if (!isDemoModeClient()) {
    return null;
  }
  return <DemoSessionNotificationsInner />;
}

function DemoSessionNotificationsInner() {
  const items = demoSessionNotifications(useDemoAcquisitions());

  if (items.length === 0) {
    return null;
  }

  return (
    <section className="feed" aria-label="本次演示通知">
      <section className="feed-day">
        <header className="feed-day-header">
          <span className="feed-day-label">本次浏览</span>
          <span className="feed-day-summary">{items.length} 项演示获取</span>
        </header>
        <div className="feed-cards">
          {items.map((item) => {
            const posterUrl = item.posterPath ? `${TMDB_FEED_POSTER}${item.posterPath}` : null;
            const heading = item.year ? `${item.title} (${item.year})` : item.title;
            return (
              <article
                className={`feed-card${posterUrl ? " has-poster" : ""}`}
                data-created-at={item.createdAt}
                key={item.id}
              >
                {posterUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img className="feed-poster" src={posterUrl} alt="" loading="lazy" />
                ) : null}
                <div className="feed-card-body">
                  <div className="feed-card-head">
                    <span className="feed-icon tone-green">
                      <PartyPopper size={15} aria-hidden />
                    </span>
                    <strong className="feed-card-title">{heading}</strong>
                    <span className="feed-status-pill tone-green">
                      <CheckCircle2 size={11} aria-hidden />
                      已入库
                    </span>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </section>
    </section>
  );
}
