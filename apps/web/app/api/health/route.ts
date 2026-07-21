import { connection, NextResponse } from "next/server";
import { getWorkflowRepository } from "../../../lib/workflow-runtime";

/**
 * Liveness + readiness probe for the docker healthcheck and external uptime
 * monitors. It goes through the repository's REAL read path (getSetting →
 * ensureSchema), so it reports whether the app can actually USE the database, not
 * merely whether a TCP socket opens. During the 2026-07-21 wedge (schema-init
 * latched while postgres was reachable) a raw `SELECT 1` would have reported
 * healthy; this returns 503 instead, which is what makes it useful for catching
 * that class of failure. The raw error is logged server-side (docker logs) but
 * kept out of the response body so the endpoint is safe to expose.
 */
export async function GET() {
  // Request-time only: this reads the DB, so keep it out of build-time prerender.
  // `export const dynamic` is disallowed under nextConfig.cacheComponents — use
  // connection() (same pattern as /api/activity).
  await connection();
  try {
    await getWorkflowRepository().getSetting("__healthcheck__");
    return NextResponse.json({ status: "ok" });
  } catch (error) {
    // Log the Error object (not String(error)) so the stack survives in docker
    // logs; the response body stays generic so nothing sensitive is exposed.
    console.error("[health] database probe failed:", error);
    return NextResponse.json({ status: "degraded" }, { status: 503 });
  }
}
