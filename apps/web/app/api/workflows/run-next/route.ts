import { connection, NextResponse, type NextRequest } from "next/server";
import { workerApiGuard } from "../../../../lib/worker-api-guard";
import { runNextQueuedWorkflow } from "../../../../lib/workflow-runtime";

export async function POST(request: NextRequest) {
  await connection();
  const denied = workerApiGuard(request);
  if (denied) return denied;

  const result = await runNextQueuedWorkflow();
  return NextResponse.json(result);
}

// Vercel Cron / system cron hit scheduled endpoints with GET; reuse POST.
export async function GET(request: NextRequest) {
  return POST(request);
}
