import { NextResponse, type NextRequest } from "next/server";
import { getAgentApiToken, verifyAgentApiToken } from "./auth";

/**
 * Security-relevant gate for all /api/agent/* routes:
 * - No token configured → 404 (endpoints are invisible)
 * - Token configured but wrong/missing header → 401 + WWW-Authenticate
 * - Valid → null (caller proceeds)
 */
export async function agentApiGuard(request: NextRequest): Promise<NextResponse | null> {
  const configured = await getAgentApiToken();
  if (!configured) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const valid = await verifyAgentApiToken(request.headers.get("authorization"));
  if (!valid) {
    return NextResponse.json(
      { error: "unauthorized" },
      { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
    );
  }
  return null;
}
