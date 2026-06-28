import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE_NAME, isCookieSecure, logoutSession } from "../../../../lib/workflow-runtime";

/** Destroy the session + clear the cookie. */
export async function POST(request: NextRequest) {
  const cookie = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  await logoutSession(cookie);
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: isCookieSecure(request),
    path: "/",
    maxAge: 0,
  });
  return response;
}
