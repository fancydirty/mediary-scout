import { connection, NextResponse, type NextRequest } from "next/server";
import { workerApiGuard } from "../../../../lib/worker-api-guard";
import { runScheduledType3 } from "../../../../lib/workflow-runtime";

export async function POST(request: NextRequest) {
  await connection();
  const denied = workerApiGuard(request);
  if (denied) return denied;

  // `?force=1` bypasses the daily-time gate for an on-demand "sweep now"; without
  // it the sweep runs at most once per Beijing day, only after the configured
  // time — so the Settings time is authoritative however often cron pings here.
  const force = new URL(request.url).searchParams.get("force") === "1";
  const result = await runScheduledType3({ force });
  return NextResponse.json(result);
}

// Vercel Cron / system cron hit scheduled endpoints with GET; reuse POST.
export async function GET(request: NextRequest) {
  return POST(request);
}
