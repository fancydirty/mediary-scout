"use client";

import { useState } from "react";
import {
  collapseMovieSynopsis,
  shouldCollapseMovieSynopsis,
} from "../lib/movie-synopsis";

/** Full overview body for movie detail. Long copy collapses behind 展开/收起. */
export function MovieSynopsis({ overview }: { overview: string }) {
  const text = overview.trim();
  const collapsible = shouldCollapseMovieSynopsis(text);
  const [expanded, setExpanded] = useState(!collapsible);
  if (!text) return null;

  const body = expanded || !collapsible ? text : collapseMovieSynopsis(text);

  return (
    <section className="movie-synopsis" aria-labelledby="movie-synopsis-title">
      <h2 className="movie-synopsis-label" id="movie-synopsis-title">
        简介
      </h2>
      <p className="movie-synopsis-body">{body}</p>
      {collapsible ? (
        <button
          type="button"
          className="movie-synopsis-toggle"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "收起" : "展开"}
        </button>
      ) : null}
    </section>
  );
}
