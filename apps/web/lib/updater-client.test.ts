import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getUpdaterStatus,
  isUpdaterToken,
  requestUpdate,
  servingRepoCommit,
  isUpdaterInstalled,
} from "./updater-client";

const dir = mkdtempSync(join(tmpdir(), "upd-"));
writeFileSync(join(dir, "token"), "t0k3n\n");
const SHA = "a".repeat(40);

describe("updater client", () => {
  const previousUrl = process.env.MEDIA_TRACK_UPDATER_URL;

  beforeEach(() => {
    delete process.env.MEDIA_TRACK_UPDATER_URL;
  });

  afterEach(() => {
    if (previousUrl === undefined) delete process.env.MEDIA_TRACK_UPDATER_URL;
    else process.env.MEDIA_TRACK_UPDATER_URL = previousUrl;
    vi.restoreAllMocks();
  });

  it("returns null when the updater is not installed (no token file)", async () => {
    const fetchImpl = vi.fn();
    expect(await getUpdaterStatus({ stateDir: join(dir, "missing"), fetchImpl: fetchImpl as never })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends the token and returns the status", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("http://updater:8787/status");
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer t0k3n");
      return new Response(JSON.stringify({ phase: "idle", message: "", repoCommit: SHA }), { status: 200 });
    });
    expect(await getUpdaterStatus({ stateDir: dir, fetchImpl: fetchImpl as never })).toMatchObject({
      phase: "idle",
      repoCommit: SHA,
    });
  });

  it("returns null when the updater answers with a non-object or a non-200", async () => {
    const bad = vi.fn(async () => new Response("[]", { status: 200 }));
    expect(await getUpdaterStatus({ stateDir: dir, fetchImpl: bad as never })).toBeNull();
    const down = vi.fn(async () => new Response("nope", { status: 500 }));
    expect(await getUpdaterStatus({ stateDir: dir, fetchImpl: down as never })).toBeNull();
  });

  it("maps a 409 with needs_recovery to needs_recovery", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ accepted: false, reason: "needs_recovery" }), { status: 409 }));
    expect(await requestUpdate("v2026.10.02", { stateDir: dir, fetchImpl: fetchImpl as never })).toEqual({
      ok: false,
      reason: "needs_recovery",
    });
  });

  it("maps a 409 with serving_unknown to serving_unknown", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ accepted: false, reason: "serving_unknown" }), { status: 409 }));
    expect(await requestUpdate("v2026.10.02", { stateDir: dir, fetchImpl: fetchImpl as never })).toEqual({
      ok: false,
      reason: "serving_unknown",
    });
  });

  it("maps 409 to busy, 400 to bad_tag, and anything else to unreachable", async () => {
    const busy = vi.fn(async () => new Response(JSON.stringify({ accepted: false, reason: "busy" }), { status: 409 }));
    expect(await requestUpdate("v2026.10.02", { stateDir: dir, fetchImpl: busy as never })).toEqual({
      ok: false,
      reason: "busy",
    });
    const bad = vi.fn(async () => new Response("{}", { status: 400 }));
    expect(await requestUpdate("v2026.10.02", { stateDir: dir, fetchImpl: bad as never })).toEqual({
      ok: false,
      reason: "bad_tag",
    });
    const started = vi.fn(async () => new Response("{}", { status: 202 }));
    expect(await requestUpdate("v2026.10.02", { stateDir: dir, fetchImpl: started as never })).toEqual({ ok: true });
    const down = vi.fn(async () => {
      throw new Error("offline");
    });
    expect(await requestUpdate("v2026.10.02", { stateDir: dir, fetchImpl: down as never })).toEqual({
      ok: false,
      reason: "unreachable",
    });
  });

  it("does not call the updater when there is no token", async () => {
    const fetchImpl = vi.fn();
    expect(await requestUpdate("v2026.10.02", { stateDir: join(dir, "missing"), fetchImpl: fetchImpl as never })).toEqual({
      ok: false,
      reason: "no_updater",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("knows the updater is installed from its token volume alone", async () => {
    expect(await isUpdaterInstalled({ stateDir: dir })).toBe(true);
    expect(await isUpdaterInstalled({ stateDir: join(dir, "missing") })).toBe(false);
  });

  it("reports the deploy folder commit only while the updater is at rest", () => {
    const base = { targetTag: null, fromCommit: null, startedAt: null, finishedAt: null, message: "", logTail: "" };
    for (const phase of ["idle", "done", "rolled_back", "failed"] as const) {
      expect(servingRepoCommit({ ...base, phase, repoCommit: SHA })).toBe(SHA);
    }
    for (const phase of ["waiting", "backing_up", "building", "switching", "verifying"] as const) {
      expect(servingRepoCommit({ ...base, phase, repoCommit: SHA })).toBeNull();
    }
    expect(servingRepoCommit({ ...base, phase: "failed", repoCommit: SHA, pendingRestore: true })).toBeNull();
    expect(servingRepoCommit({ ...base, phase: "failed", repoCommit: SHA, needsManualRecovery: true })).toBeNull();
    // Exit 60: the folder moved while the old container kept serving — the folder HEAD is not it.
    expect(servingRepoCommit({ ...base, phase: "failed", repoCommit: SHA, servingUnknown: true })).toBeNull();
    expect(servingRepoCommit({ ...base, phase: "idle", repoCommit: "nope" })).toBeNull();
    expect(servingRepoCommit({ ...base, phase: "idle" })).toBeNull();
    expect(servingRepoCommit(null)).toBeNull();
  });

  it("accepts only the bearer token from the shared volume", async () => {
    expect(await isUpdaterToken("Bearer t0k3n", { stateDir: dir })).toBe(true);
    expect(await isUpdaterToken("Bearer other", { stateDir: dir })).toBe(false);
    expect(await isUpdaterToken("Bearer t0k3n-longer", { stateDir: dir })).toBe(false);
    expect(await isUpdaterToken(null, { stateDir: dir })).toBe(false);
    expect(await isUpdaterToken("Bearer t0k3n", { stateDir: join(dir, "missing") })).toBe(false);
  });
});
