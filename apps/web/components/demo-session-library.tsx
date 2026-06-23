"use client";

import { Check, LoaderCircle } from "lucide-react";
import { isDemoModeClient } from "../lib/demo-mode";
import { demoInProgressLibraryCards } from "../lib/demo-session";
import { useDemoAcquisitions, useDemoInProgress } from "../lib/use-demo-session";

/**
 * Read-only demo: top sections reflecting THIS session's activity (client-only
 * sessionStorage — no DB, no server render). Mounted in the library's static
 * shell (NOT inside the streaming Suspense) so it actually hydrates. Shows
 * in-progress "获取中" placeholder cards (clock-driven, mirroring production's
 * InProgressCard) above the completed "本次演示获取" wall. Renders nothing outside
 * demo or when both are empty.
 */
export function DemoSessionLibrary() {
  // Guard at the COMPONENT boundary, before any demo hooks: isDemoModeClient() is a
  // build-time constant, so in real builds the inner (hook-using) body never mounts
  // → zero hook/effect/render cost. (Conditional component, NOT conditional hook.)
  if (!isDemoModeClient()) {
    return null;
  }
  return <DemoSessionLibraryInner />;
}

function DemoSessionLibraryInner() {
  const entries = useDemoAcquisitions();
  const acquiring = demoInProgressLibraryCards(useDemoInProgress());

  if (entries.length === 0 && acquiring.length === 0) {
    return null;
  }

  return (
    <>
      {acquiring.length > 0 ? (
        <div className="category-section" aria-label="获取中">
          <div className="category-header is-static">
            <h2>获取中 {acquiring.length}</h2>
          </div>
          <div className="poster-row">
            {acquiring.map((e) => (
              <div
                className="wall-card is-loading"
                aria-disabled
                key={`ip_${e.type}_${e.tmdbId}`}
                title="获取中，完成后可进入"
              >
                <span className="wall-poster">
                  {e.posterPath ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={`https://image.tmdb.org/t/p/w342${e.posterPath}`} alt="" loading="lazy" />
                  ) : (
                    <span className="poster-fallback">{e.title.slice(0, 4)}</span>
                  )}
                  <span className="wall-loading-overlay">
                    <LoaderCircle size={20} className="spin" aria-hidden />
                    <span>获取中</span>
                  </span>
                </span>
                <span className="wall-copy">
                  <strong>{e.title}</strong>
                  <span>{e.year} · 正在获取</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {entries.length > 0 ? (
        <div className="category-section" aria-label="本次演示获取">
          <div className="category-header is-static">
            <h2>本次演示获取 {entries.length}</h2>
          </div>
          <div className="poster-row">
            {entries.map((e) => (
          <div className="wall-card" key={`${e.type}_${e.tmdbId}`} title="本次演示获取（仅本次浏览）">
            <span className="wall-poster">
              {e.posterPath ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={`https://image.tmdb.org/t/p/w342${e.posterPath}`} alt="" loading="lazy" />
              ) : (
                <span className="poster-fallback">{e.title.slice(0, 4)}</span>
              )}
              <span className="wall-states">
                <span className="wall-state tone-green" title="已获取">
                  <Check size={13} aria-hidden />
                </span>
              </span>
            </span>
            <span className="wall-copy">
              <strong>{e.title}</strong>
              <span>{e.year} · 已获取</span>
            </span>
          </div>
        ))}
          </div>
        </div>
      ) : null}
    </>
  );
}
