import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...actual, connection: vi.fn().mockResolvedValue(undefined) };
});
vi.mock("../../../../lib/workflow-runtime", async () => {
  const actual = await vi.importActual<typeof import("../../../../lib/workflow-runtime")>(
    "../../../../lib/workflow-runtime",
  );
  return {
    isRemoteRequest: actual.isRemoteRequest,
    isMultiUserEnabled: vi.fn(() => false),
    hasLoginPassword: vi.fn(async () => false),
    getBootstrapState: vi.fn(async () => ({ needsClaim: true, hasExistingLibrary: false })),
  };
});

import { GET } from "./route";
import * as runtime from "../../../../lib/workflow-runtime";

const TUNNEL = { "cf-ray": "8f3-abc", "cf-connecting-ip": "203.0.113.7" };
const get = (headers: Record<string, string> = {}) =>
  GET(new NextRequest("http://localhost:3000/api/auth/bootstrap", { headers }));

describe("GET /api/auth/bootstrap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("tells the login page whether the visitor came through the tunnel (single user)", async () => {
    expect(await (await get(TUNNEL)).json()).toMatchObject({ singleUser: true, passwordSet: false, remote: true });
    expect(await (await get()).json()).toMatchObject({ singleUser: true, passwordSet: false, remote: false });
  });

  it("tells the login page whether the visitor came through the tunnel (multi user)", async () => {
    vi.mocked(runtime.isMultiUserEnabled).mockReturnValue(true);
    expect(await (await get(TUNNEL)).json()).toMatchObject({ singleUser: false, needsClaim: true, remote: true });
  });
});
