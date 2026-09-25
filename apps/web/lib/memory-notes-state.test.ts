import { describe, expect, it } from "vitest";
import { restoreNote, visibleAfterRefresh } from "./memory-notes-state";
import type { MemoryItem } from "./agent-memory-server";

const note = (name: string): MemoryItem => ({ name, text: name, verdict: null, driveLabel: null, updatedAt: "2026-09-25T00:00:00.000Z" });

describe("notes list across a refresh during the undo window (Copilot #274)", () => {
  it("a refresh keeps the pending-deleted note hidden, and undo puts it back exactly once", () => {
    const [a, b, c] = [note("a"), note("b"), note("c")];
    // User deleted b (index 1); the page refreshes before the delete is sent.
    const afterRefresh = visibleAfterRefresh([a, b, c], new Set(["b"]));
    expect(afterRefresh.map((i) => i.name)).toEqual(["a", "c"]);
    const afterUndo = restoreNote(afterRefresh, b, 1);
    expect(afterUndo.map((i) => i.name)).toEqual(["a", "b", "c"]);
  });

  it("a refresh while the delete request is IN FLIGHT (undo window over) still hides it", () => {
    const [a, b, c] = [note("a"), note("b"), note("c")];
    // b's window ran out and its delete is being sent; c was deleted after and is waiting.
    expect(visibleAfterRefresh([a, b, c], new Set(["b", "c"])).map((i) => i.name)).toEqual(["a"]);
  });

  it("restoring a note the list already has is a no-op (no duplicate keys)", () => {
    const [a, b] = [note("a"), note("b")];
    expect(restoreNote([a, b], b, 0).map((i) => i.name)).toEqual(["a", "b"]);
  });

  it("no pending delete → the server list as is; out-of-range index clamps", () => {
    const [a, b] = [note("a"), note("b")];
    expect(visibleAfterRefresh([a, b], new Set())).toEqual([a, b]);
    expect(restoreNote([a], b, 9).map((i) => i.name)).toEqual(["a", "b"]);
  });
});
