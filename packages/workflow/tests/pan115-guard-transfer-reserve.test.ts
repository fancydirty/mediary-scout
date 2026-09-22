import { describe, expect, it } from "vitest";
import {
  Pan115ApiGuard,
  Pan115RiskControlError,
  PAN115_TRANSFER_RESERVE_CALLS,
  type Pan115ApiGuardEvent,
} from "../src/index.js";

/** Spend `n` calls on a listing (never transfer-class). */
async function spendListings(guard: Pan115ApiGuard, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await guard.run("listItems", async () => []);
  }
}

describe("Pan115ApiGuard transfer reserve (预算分层:转存类在硬上限之前的保留额处被拒)", () => {
  it("reserve 0 (default) is the plain hard cap — transfers run right up to it", async () => {
    const guard = new Pan115ApiGuard({ maxCallsPerOperation: 3 });
    expect(guard.transferCallBudget()).toBe(3);
    await spendListings(guard, 2);
    await guard.run("receiveShare", async () => ({ ok: true, message: "" })); // call #3 allowed
    await expect(guard.run("receiveShare", async () => ({ ok: true, message: "" }))).rejects.toThrow(
      "API call budget exhausted before receiveShare; maxCallsPerOperation=3",
    );
  });

  it("refuses receiveShare / addOfflineTask once callCount reaches hard − reserve, while listing/moving/deleting/renaming run to the hard limit", async () => {
    const guard = new Pan115ApiGuard({ maxCallsPerOperation: 10, transferReserveCalls: 4 });
    expect(guard.transferCallBudget()).toBe(6);
    await spendListings(guard, 6);
    await expect(guard.run("receiveShare", async () => ({ ok: true, message: "" }))).rejects.toBeInstanceOf(
      Pan115RiskControlError,
    );
    await expect(guard.run("addOfflineTask", async () => ({ ok: true, message: "" }))).rejects.toThrow(
      /PAN115_RATE_LIMIT: transfer budget exhausted before addOfflineTask/,
    );
    // Wrap-up class keeps going: 4 more calls fit before the hard limit.
    await guard.run("getDirectoryInfo", async () => null);
    await guard.run("moveItems", async () => ({ ok: true, message: "" }));
    await guard.run("deleteItems", async () => ({ ok: true, message: "" }));
    await guard.run("renameFile", async () => ({ ok: true, message: "" }));
    expect(guard.callsSpent()).toBe(10);
    await expect(guard.run("listItems", async () => [])).rejects.toThrow("maxCallsPerOperation=10");
  });

  it("listOfflineTasks / removeOfflineTask (cleanup) and createFolder are NOT transfer-class", async () => {
    const guard = new Pan115ApiGuard({ maxCallsPerOperation: 5, transferReserveCalls: 3 });
    await spendListings(guard, 2); // at the transfer cutoff (5 − 3 = 2)
    await guard.run("listOfflineTasks", async () => []);
    await guard.run("removeOfflineTask", async () => ({ ok: true, message: "" }));
    await guard.run("createFolder", async () => "id");
    expect(guard.callsSpent()).toBe(5);
  });

  it("a reserve refusal is NOT counted and does NOT open the circuit", async () => {
    const events: Pan115ApiGuardEvent[] = [];
    const guard = new Pan115ApiGuard({ maxCallsPerOperation: 4, transferReserveCalls: 2, onEvent: (e) => events.push(e) });
    await spendListings(guard, 2);
    await expect(guard.run("receiveShare", async () => ({ ok: true, message: "" }))).rejects.toThrow();
    expect(guard.callsSpent()).toBe(2);
    expect(events.map((e) => e.kind)).toEqual(["budget_exhausted"]);
    await guard.run("listItems", async () => []); // circuit still closed
    expect(guard.callsSpent()).toBe(3);
  });

  it("the refusal tells the agent what the remaining calls are for (wrap-up), with the numbers", async () => {
    const guard = new Pan115ApiGuard({ maxCallsPerOperation: 10, transferReserveCalls: 4 });
    await spendListings(guard, 7);
    await expect(guard.run("addOfflineTask", async () => ({ ok: true, message: "" }))).rejects.toThrow(
      /7 of maxCallsPerOperation=10 calls spent.*transfers stop at 6.*remaining 3 calls are reserved for wrap-up.*moveToSeason.*discardStaging/,
    );
  });

  it("transferCallBudget is clamped into [0, hard]: a reserve larger than the hard limit means no transfers at all, and a zero hard limit refuses transfers exactly like listings", async () => {
    expect(new Pan115ApiGuard({ maxCallsPerOperation: 2, transferReserveCalls: 40 }).transferCallBudget()).toBe(0);
    const zero = new Pan115ApiGuard({ maxCallsPerOperation: 0 });
    expect(zero.transferCallBudget()).toBe(0);
    await expect(zero.run("listItems", async () => [])).rejects.toThrow("maxCallsPerOperation=0");
    await expect(zero.run("receiveShare", async () => ({ ok: true, message: "" }))).rejects.toThrow("maxCallsPerOperation=0");
    expect(zero.callsSpent()).toBe(0);
  });

  it("a negative reserve clamps to 0 — it can never WIDEN the transfer budget past the hard limit", () => {
    expect(new Pan115ApiGuard({ maxCallsPerOperation: 10, transferReserveCalls: -5 }).transferCallBudget()).toBe(10);
  });

  it("assertTransferBudget lets a caller fail fast BEFORE it spends preparatory calls, and costs nothing itself", async () => {
    const guard = new Pan115ApiGuard({ maxCallsPerOperation: 10, transferReserveCalls: 6 });
    await spendListings(guard, 3); // one call short of the transfer line (10 − 6 = 4)
    expect(() => guard.assertTransferBudget("receiveShare")).not.toThrow();

    await spendListings(guard, 1); // now AT the line
    expect(() => guard.assertTransferBudget("receiveShare")).toThrow(
      /PAN115_RATE_LIMIT: transfer budget exhausted before receiveShare/,
    );
    expect(() => guard.assertTransferBudget("addOfflineTask")).toThrow(Pan115RiskControlError);
    expect(guard.callsSpent()).toBe(4); // the check is not a call
  });

  it("past the HARD limit a transfer gets the plain budget message — the wording keys on state, not on whether a reserve is configured", async () => {
    const guard = new Pan115ApiGuard({ maxCallsPerOperation: 5, transferReserveCalls: 2 });
    await spendListings(guard, 5); // at the hard limit; the reserve is long gone

    const error = await guard
      .run("addOfflineTask", async () => ({ ok: true, message: "" }))
      .then(() => null)
      .catch((thrown: unknown) => thrown as Error);

    // Exact message: no "reserved for wrap-up … wrap up now" text, which would be a
    // lie once there are zero calls left to wrap up with.
    expect(error?.message).toBe(
      "PAN115_RATE_LIMIT: API call budget exhausted before addOfflineTask; maxCallsPerOperation=5",
    );
  });

  it("the shipped reserve keeps the 拍板 ordering: soft 240 < transfer stop 260 < hard 300", () => {
    expect(PAN115_TRANSFER_RESERVE_CALLS).toBe(40);
    const guard = new Pan115ApiGuard({ maxCallsPerOperation: 300, transferReserveCalls: PAN115_TRANSFER_RESERVE_CALLS });
    expect(guard.transferCallBudget()).toBe(260);
  });
});
