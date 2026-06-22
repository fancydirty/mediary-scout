import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_STEPS,
  STEP_50_REMINDER,
  BUDGET_SOFT_REMIND_AT,
  BUDGET_REMINDER,
  budgetReflectionNudge,
  stepReflectionNudge,
  prepareStepSystemOverride,
  buildRepetitionStop,
  reflectionSystemOverride,
  toStepSignature,
} from "../src/index.js";

describe("toStepSignature", () => {
  it("normalizes a step into tool/args/result (ids excluded — uses input+output)", () => {
    const step = {
      toolCalls: [{ toolName: "inspectTargetDir", input: { season: 6 } }],
      toolResults: [{ output: [] }],
    };
    expect(toStepSignature(step)).toEqual({
      tool: "inspectTargetDir",
      args: JSON.stringify([{ season: 6 }]),
      result: JSON.stringify([[]]),
    });
  });

  it("handles a final no-tool step", () => {
    expect(toStepSignature({ toolCalls: [], toolResults: [] })).toEqual({
      tool: "",
      args: "[]",
      result: "[]",
    });
  });
});

describe("buildRepetitionStop", () => {
  it("returns a StopCondition that stops on 4 identical steps", async () => {
    const stop = buildRepetitionStop();
    const same = { toolCalls: [{ toolName: "searchResources", input: { keyword: "x" } }], toolResults: [{ output: "empty" }] };
    expect(await stop({ steps: [same, same, same, same] as never })).toBe(true);
    expect(await stop({ steps: [same, same] as never })).toBe(false);
  });
});

describe("reflectionSystemOverride", () => {
  const base = "BASE SYSTEM";

  it("injects the reminder once within the last N steps before the cap", () => {
    // maxSteps 60, remind within last 10 → from step 50.
    expect(reflectionSystemOverride({ stepNumber: 50, maxSteps: 60, baseSystem: base })).toContain(
      STEP_50_REMINDER,
    );
    expect(reflectionSystemOverride({ stepNumber: 55, maxSteps: 60, baseSystem: base })).toContain(base);
  });

  it("does NOT inject before the threshold", () => {
    expect(reflectionSystemOverride({ stepNumber: 49, maxSteps: 60, baseSystem: base })).toBeUndefined();
    expect(reflectionSystemOverride({ stepNumber: 0, maxSteps: 60, baseSystem: base })).toBeUndefined();
  });

  it("reminder is calm, not scary — frames a normal wrap-up + next-patrol safety net", () => {
    // R3 in the spec: must not panic the agent into dropping still-gettable episodes.
    expect(STEP_50_REMINDER).toContain("巡检"); // remaining caught next patrol
    expect(STEP_50_REMINDER).toContain("discardStaging");
    expect(STEP_50_REMINDER).toMatch(/不是失败|正常|稳/); // reassuring framing
  });
});

describe("stepReflectionNudge", () => {
  it("returns the step reminder within the window, null before", () => {
    expect(stepReflectionNudge(50, 60)).toBe(STEP_50_REMINDER);
    expect(stepReflectionNudge(59, 60)).toBe(STEP_50_REMINDER);
    expect(stepReflectionNudge(49, 60)).toBeNull();
  });
});

describe("budgetReflectionNudge (115 call-budget soft warning)", () => {
  it("fires at/after the soft threshold (240), not before", () => {
    expect(budgetReflectionNudge(239)).toBeNull();
    expect(budgetReflectionNudge(240)).toBe(BUDGET_REMINDER);
    expect(budgetReflectionNudge(299)).toBe(BUDGET_REMINDER);
  });

  it("no nudge when spent is unknown (fakes/sim without apiCallCount)", () => {
    expect(budgetReflectionNudge(undefined)).toBeNull();
  });

  it("soft threshold is 240 (hard limit 300 is the guard's throw)", () => {
    expect(BUDGET_SOFT_REMIND_AT).toBe(240);
  });

  it("reminder is a calm wrap-up: markObtained + discardStaging + next-patrol safety net", () => {
    expect(BUDGET_REMINDER).toContain("markObtained");
    expect(BUDGET_REMINDER).toContain("discardStaging");
    expect(BUDGET_REMINDER).toMatch(/不是失败|正常|巡检/);
  });
});

describe("prepareStepSystemOverride (composes step-cap + budget nudges)", () => {
  const base = "BASE SYSTEM";
  it("budget only: over 240 calls, far from step cap → budget nudge, no step nudge", () => {
    const s = prepareStepSystemOverride({ stepNumber: 5, maxSteps: 60, baseSystem: base, apiCallsSpent: 250 })!;
    expect(s).toContain(BUDGET_REMINDER);
    expect(s).not.toContain(STEP_50_REMINDER);
    expect(s).toContain(base);
  });
  it("step only: near cap, under budget → step nudge, no budget nudge", () => {
    const s = prepareStepSystemOverride({ stepNumber: 55, maxSteps: 60, baseSystem: base, apiCallsSpent: 10 })!;
    expect(s).toContain(STEP_50_REMINDER);
    expect(s).not.toContain(BUDGET_REMINDER);
  });
  it("both: near cap AND over budget → both nudges appended", () => {
    const s = prepareStepSystemOverride({ stepNumber: 55, maxSteps: 60, baseSystem: base, apiCallsSpent: 260 })!;
    expect(s).toContain(STEP_50_REMINDER);
    expect(s).toContain(BUDGET_REMINDER);
  });
  it("neither → undefined (no override)", () => {
    expect(prepareStepSystemOverride({ stepNumber: 5, maxSteps: 60, baseSystem: base, apiCallsSpent: 10 })).toBeUndefined();
    expect(prepareStepSystemOverride({ stepNumber: 5, maxSteps: 60, baseSystem: base })).toBeUndefined();
  });
});

describe("DEFAULT_MAX_STEPS", () => {
  it("is 60 (raised from the old 40 that killed 一人之下)", () => {
    expect(DEFAULT_MAX_STEPS).toBe(60);
  });
});
