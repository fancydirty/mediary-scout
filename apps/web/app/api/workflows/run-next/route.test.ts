import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...actual, connection: vi.fn().mockResolvedValue(undefined) };
});

vi.mock("../../../../lib/workflow-runtime", () => ({
  runNextQueuedWorkflow: vi.fn().mockResolvedValue({ status: "idle" }),
}));

import { GET, POST } from "./route";
import { runNextQueuedWorkflow } from "../../../../lib/workflow-runtime";

function request(method: "GET" | "POST", secret?: string) {
  return new NextRequest("http://localhost/api/workflows/run-next", {
    method,
    ...(secret ? { headers: { "x-media-track-worker-secret": secret } } : {}),
  });
}

describe("/api/workflows/run-next", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("MEDIA_TRACK_DEMO_MODE", "");
    vi.stubEnv("MEDIA_TRACK_MULTI_USER", "");
    vi.stubEnv("MEDIA_TRACK_WORKER_SECRET", "");
  });

  afterEach(() => vi.unstubAllEnvs());

  it("rejects demo-mode requests without running the worker", async () => {
    vi.stubEnv("MEDIA_TRACK_DEMO_MODE", "1");

    const response = await GET(request("GET"));

    expect(response.status).toBe(403);
    expect(runNextQueuedWorkflow).not.toHaveBeenCalled();
  });

  it("fails closed in multi-user mode when no worker secret is configured", async () => {
    vi.stubEnv("MEDIA_TRACK_MULTI_USER", "1");

    const response = await POST(request("POST"));

    expect(response.status).toBe(401);
    expect(runNextQueuedWorkflow).not.toHaveBeenCalled();
  });

  it("rejects a mismatched configured worker secret", async () => {
    vi.stubEnv("MEDIA_TRACK_WORKER_SECRET", "expected");

    const response = await POST(request("POST", "wrong"));

    expect(response.status).toBe(401);
    expect(runNextQueuedWorkflow).not.toHaveBeenCalled();
  });

  it("accepts the configured worker secret", async () => {
    vi.stubEnv("MEDIA_TRACK_WORKER_SECRET", "expected");

    const response = await POST(request("POST", "expected"));

    expect(response.status).toBe(200);
    expect(runNextQueuedWorkflow).toHaveBeenCalledOnce();
  });

  it("preserves secretless single-user cron compatibility", async () => {
    const response = await GET(request("GET"));

    expect(response.status).toBe(200);
    expect(runNextQueuedWorkflow).toHaveBeenCalledOnce();
  });
});
