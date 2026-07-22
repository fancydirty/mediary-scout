"use client";

import { useEffect, useState } from "react";

/**
 * Full-width overview.
 * Mobile (≤860px): default 2-line clamp + gradient veil; tap block to expand.
 * Desktop: always full text, static markup (no button chrome).
 */
export function MovieSynopsis({ overview }: { overview: string }) {
  const text = overview.trim();
  const [expanded, setExpanded] = useState(false);
  const [mobile, setMobile] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 860px)");
    const sync = () => setMobile(mq.matches);
    sync();
    if (typeof mq.addEventListener === "function") {
      mq.addEventListener("change", sync);
      return () => mq.removeEventListener("change", sync);
    }
    mq.addListener(sync);
    return () => mq.removeListener(sync);
  }, []);

  if (!text) return null;

  // Desktop: static full text — no interactive control to focus.
  if (!mobile) {
    return (
      <section className="movie-synopsis is-expanded" aria-labelledby="movie-synopsis-title">
        <h2 className="movie-synopsis-label" id="movie-synopsis-title">
          简介
        </h2>
        <div className="movie-synopsis-body">{text}</div>
      </section>
    );
  }

  return (
    <section
      className={`movie-synopsis${expanded ? " is-expanded" : " is-collapsed"}`}
      aria-labelledby="movie-synopsis-title"
    >
      <h2 className="movie-synopsis-label" id="movie-synopsis-title">
        简介
      </h2>
      <button
        type="button"
        className="movie-synopsis-hit"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="movie-synopsis-body">{text}</span>
        <span className="movie-synopsis-hint">{expanded ? "收起" : "轻触展开全文"}</span>
      </button>
    </section>
  );
}
