import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { PanSouResourceProvider } from "./pansou-provider.js";

// 2026-07-06 field incident: a stalled PanSou instance hung the pre-agent
// search for 4.5 minutes because the default fetch had no timeout — the
// same failure class as the TMDB hang (#68). These tests pin the bounded-
// wait contract so a dead upstream degrades to "fewer candidates", never
// "frozen run".
describe("PanSouResourceProvider request timeout", () => {
  let server: Server | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  it("returns an empty snapshot instead of hanging when the server never responds", async () => {
    server = createServer(() => {
      // Accept the request and go silent — no headers, no body, no end.
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    const provider = new PanSouResourceProvider({
      baseURL: `http://127.0.0.1:${port}`,
      requestTimeoutMs: 200,
      maxSearchAttempts: 2,
      searchPollMs: 1,
    });

    const startedAt = Date.now();
    const snapshot = await provider.search({ keyword: "闪灵" });
    const elapsedMs = Date.now() - startedAt;

    expect(snapshot.candidates).toEqual([]);
    // One stalled attempt aborts at ~200ms and the poll loop bails on the
    // error path; well under a second proves the wait is bounded.
    expect(elapsedMs).toBeLessThan(2000);
  }, 10_000);
});
