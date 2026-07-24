import { HttpError } from "./http.js";

// The Authorization header must exactly equal `Bearer ${adminToken}`.
export function requireAdmin(request: Request, adminToken: string): void {
  const header = request.headers.get("authorization");
  const expected = `Bearer ${adminToken}`;
  if (header === null || header.length !== expected.length) {
    throw new HttpError(401, "unauthorized");
  }
  // Best-effort constant-time compare: no early exit on the first mismatching
  // byte. True constant-time is impossible to guarantee in JS (the JIT may
  // optimize the loop), hence best-effort.
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= header.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  if (diff !== 0) {
    throw new HttpError(401, "unauthorized");
  }
}
