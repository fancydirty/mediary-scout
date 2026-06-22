import { describe, expect, it } from "vitest";
import { Pan115ApiGuard } from "../src/index.js";

describe("Pan115ApiGuard.callsSpent", () => {
  it("counts each successful api call", async () => {
    const guard = new Pan115ApiGuard();
    expect(guard.callsSpent()).toBe(0);
    await guard.run("listItems", async () => []);
    await guard.run("createFolder", async () => "id");
    expect(guard.callsSpent()).toBe(2);
  });
});
