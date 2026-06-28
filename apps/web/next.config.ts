import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// Next only auto-loads .env files from the app directory; this workspace
// keeps ALL runtime config (TMDB token, 115 cookie, adapter switches) in the
// repo-root .env. Load it here without overriding anything already set.
try {
  const repoRootEnv = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.env");
  for (const line of readFileSync(repoRootEnv, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] ??= value;
  }
} catch {
  // no .env present (CI, fresh clone) — fine, fall back to process env
}

const nextConfig: NextConfig = {
  // Lean container image: a self-contained server bundle (+ traced node_modules
  // and the @media-track/workflow workspace) the Docker runner stage copies whole.
  output: "standalone",
  // Trace from the monorepo root so standalone captures the workspace package +
  // root-hoisted deps (the app is in apps/web; deps hoist to the repo root).
  outputFileTracingRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
  transpilePackages: ["@media-track/workflow"],
  // Cache Components: PPR becomes the default rendering model. "use cache"
  // builds the static shell; runtime reads live inside Suspense holes.
  cacheComponents: true,
  // Keep a visited route (and its loading boundary) reusable in the client Router
  // Cache for a window, so re-entering a detail page you just opened doesn't
  // re-fetch the dynamic hole and flash a skeleton every time. Fresh data still
  // arrives after the window / on a real change (the AcquiringPoller refreshes
  // mid-acquisition regardless).
  experimental: {
    staleTimes: { dynamic: 60, static: 300 },
    serverActions: {
      allowedOrigins: (process.env.MEDIA_TRACK_ALLOWED_ORIGINS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    },
  },
  // Legacy per-season URL → the canonical one-page-per-show route. Handled at
  // the routing layer (not a render-time redirect page, which can't prerender
  // under cacheComponents).
  async redirects() {
    return [
      { source: "/show/:tmdbId/:seasonNumber", destination: "/show/:tmdbId", permanent: false },
    ];
  },
};

export default nextConfig;
