"use client";

import { useState } from "react";

/**
 * Full-width overview. On mobile (≤860px) defaults to 2-line clamp + gradient
 * veil; tap the block to expand/collapse. Desktop always shows full text
 * (CSS ignores the collapsed class above the breakpoint).
 */
export function MovieSynopsis({ overview }: { overview: string }) {
  const text = overview.trim();
  const [expanded, setExpanded] = useState(false);
  if (!text) return null;

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
        <p className="movie-synopsis-body">{text}</p>
        <span className="movie-synopsis-hint">{expanded ? "收起" : "轻触展开全文"}</span>
      </button>
    </section>
  );
}
