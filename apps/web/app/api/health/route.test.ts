import { describe, expect, it, vi, beforeEach } from "vitest";

// connection() opts the route out of build-time prerender; stub it (keeping
// NextResponse real) so the handler runs outside a Next request scope in tests.
vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...actual, connection: vi.fn().mockResolvedValue(undefined) };
});

// The health probe must go through the repository's real read path so it reflects
// whether the app can actually USE the database. Mock the repo getter so we can
// drive the reachable / unreachable cases without a live postgres.
vi.mock("../../../lib/workflow-runtime", () => ({
  getWorkflowRepository: vi.fn(),
}));

import { GET } from "./route";
import { getWorkflowRepository } from "../../../lib/workflow-runtime";

const mockRepo = (getSetting: () => Promise<unknown>) =>
  (getWorkflowRepository as ReturnType<typeof vi.fn>).mockReturnValue({ getSetting });

describe("GET /api/health", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 200 ok when the database read path works", async () => {
    mockRepo(vi.fn().mockResolvedValue(null));
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("ok");
  });

  it("returns 503 degraded when the database read path throws", async () => {
    mockRepo(vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:5432")));
    const res = await GET();
    expect(res.status).toBe(503);
    expect((await res.json()).status).toBe("degraded");
  });

  it("does not leak the raw error into the response body", async () => {
    mockRepo(vi.fn().mockRejectedValue(new Error('password authentication failed for user "mediatrack"')));
    const res = await GET();
    const body = await res.json();
    expect(JSON.stringify(body)).not.toMatch(/password|mediatrack|ECONNREFUSED/);
  });
});
