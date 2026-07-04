import Link from "next/link";
import { Film, RefreshCw, Search } from "lucide-react";
import { getTrending, TRENDING_KINDS, TRENDING_KIND_ORDER, type TrendingKind } from "../lib/trending";

const POSTER = "https://image.tmdb.org/t/p/w342";

/** The search page's empty-state discovery row. When getTrending yields []
 *  (proxy/network down) it falls back to the original "输入目标名称" placeholder,
 *  so the empty state is never blank and search is never blocked. Poster clicks
 *  navigate to `?q=<title>` so the pick lands in the normal results flow where the
 *  user explicitly chooses 获取. `basePath` is `/` or `/w/<id>` (never carries a
 *  query), so `?` is always the correct separator. */
export async function TrendingRow({
  activeKind,
  basePath,
}: {
  activeKind: TrendingKind;
  basePath: string;
}) {
  const cards = await getTrending(activeKind);
  if (cards.length === 0) {
    return (
      <div className="quiet-state">
        <Search size={24} aria-hidden />
        <strong>输入目标名称</strong>
        <span>搜索后才会请求元数据。</span>
      </div>
    );
  }
  return (
    <section className="trending" aria-label="近期热门">
      <div className="trending-head">
        <div className="trending-tabs">
          <h2>近期热门</h2>
          {TRENDING_KIND_ORDER.map((kind) => (
            <Link
              key={kind}
              className={`filter-pill ${kind === activeKind ? "is-active" : ""}`}
              href={`${basePath}?trending=${kind}`}
            >
              {TRENDING_KINDS[kind].label}
            </Link>
          ))}
        </div>
        <span className="trending-note">
          <RefreshCw size={12} aria-hidden /> 每日更新 · 来自 TMDB
        </span>
      </div>
      <div className="trending-grid">
        {cards.map((card, index) => (
          <Link
            key={`${card.mediaType}_${card.tmdbId}`}
            className="trending-card"
            href={`${basePath}?q=${encodeURIComponent(card.title)}`}
          >
            <div className="trending-poster">
              {card.posterPath ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={`${POSTER}${card.posterPath}`} alt="" loading="lazy" />
              ) : (
                <Film size={24} aria-hidden />
              )}
              <span className="trending-rank">#{index + 1}</span>
            </div>
            <span className="trending-title">{card.title}</span>
            <span className="trending-meta">
              {card.year ?? "—"} · {activeKind === "anime" ? "动漫" : card.mediaType === "movie" ? "电影" : "剧集"}
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}
