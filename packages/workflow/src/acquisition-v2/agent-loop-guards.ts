import type { StopCondition, ToolSet } from "ai";
import { shouldStopForRepetition, type ToolStepSignature } from "./repetition-stop.js";

/**
 * Harness guards for the agent loop. The old `stepCountIs(40)` hard-kill was the
 * wrong primitive (killed legit long tasks like the 6-season 一人之下, missed tight
 * loops). We replace it with: a higher step ceiling (60), a cheap OpenHands-style
 * repetition stop, and a calm reflection nudge in the last 10 steps that tells the
 * agent to wrap up + clean staging rather than leave a half-done mess.
 * See the 2026-06-16 design spec.
 */

/** Raised from 40 — a multi-season show needs the headroom; cost/runaway is bounded by this + the repetition stop. */
export const DEFAULT_MAX_STEPS = 60;

/** How many steps before the cap the reflection reminder kicks in. */
export const REMIND_WITHIN_STEPS = 10;

/** Calm wrap-up nudge (R3: must NOT scare the agent into dropping still-gettable episodes). */
export const STEP_50_REMINDER =
  "【进度提醒】本次任务已接近步数预算(约剩 10 步)。这是正常的收尾信号,不是失败。请:" +
  "① 不要再发起新的 searchResources / transferCandidate;" +
  "② 把已转存好的用 moveToSeason 归位、对确实落盘的 markObtained;" +
  "③ discardStaging 清理本次 staging;④ finish。" +
  "这次没来得及拿的集不要紧——只要没被 markObtained,下次每日巡检会自动发现并补齐。" +
  "请稳妥收尾,绝不要为赶进度草率丢弃还能拿到的资源。";

/** 115 API-call SOFT-warning threshold. The HARD limit (where the guard actually
 *  throws Pan115RiskControlError) is 300 — see createProtectedStorage115Executor.
 *  At the soft mark we nudge the agent to wrap up (same idea as the step cap),
 *  leaving headroom so its own markObtained/discardStaging (which cost a few 115
 *  calls) still fit under 300 instead of being cut off mid-cleanup. */
export const BUDGET_SOFT_REMIND_AT = 240;

/** Calm wrap-up nudge for the 115 call budget — mirrors STEP_50_REMINDER's tone. */
export const BUDGET_REMINDER =
  "【网盘调用提醒】本次任务的 115 接口调用已接近软上限(约 240,硬上限 300)。这是正常的收尾信号,不是失败。请:" +
  "① 不要再发起新的 searchResources / transferCandidate;" +
  "② 对确实落盘的 markObtained、把已转存好的用 moveToSeason 归位;" +
  "③ discardStaging 打扫战场;④ finish。" +
  "这次没来得及拿的集不要紧——只要没被 markObtained,下次每日巡检会自动补齐。" +
  "请立刻稳妥收尾:到 300 次会被硬性中断,别把调用预算耗在还没收尾上。";

/** The step-cap reminder as a pure nudge (text or null) — within the last
 *  `within` steps before the cap. Composable with other nudges in prepareStep. */
export function stepReflectionNudge(
  stepNumber: number,
  maxSteps: number,
  within: number = REMIND_WITHIN_STEPS,
): string | null {
  return stepNumber >= maxSteps - within ? STEP_50_REMINDER : null;
}

/** The 115 call-budget reminder as a pure nudge (text or null) — at/after the soft
 *  threshold. `spent` undefined (storage without apiCallCount, e.g. fakes) → null. */
export function budgetReflectionNudge(
  spent: number | undefined,
  softAt: number = BUDGET_SOFT_REMIND_AT,
): string | null {
  return typeof spent === "number" && spent >= softAt ? BUDGET_REMINDER : null;
}

// Minimal structural view of an AI-SDK StepResult — only the fields we read.
interface StepLike {
  toolCalls?: ReadonlyArray<{ toolName: string; input: unknown }>;
  toolResults?: ReadonlyArray<{ output: unknown }>;
}

/** Normalize one loop step into a comparable signature (ids/timestamps excluded — input+output only). */
export function toStepSignature(step: StepLike): ToolStepSignature {
  const calls = step.toolCalls ?? [];
  const results = step.toolResults ?? [];
  return {
    tool: calls.map((c) => c.toolName).join("+"),
    args: JSON.stringify(calls.map((c) => c.input)),
    result: JSON.stringify(results.map((r) => r.output)),
  };
}

/** A StopCondition (for `generateText({ stopWhen })`) that fires on repetition/ping-pong. */
export function buildRepetitionStop<TOOLS extends ToolSet = ToolSet>(): StopCondition<TOOLS> {
  return ({ steps }) => shouldStopForRepetition((steps as ReadonlyArray<StepLike>).map(toStepSignature));
}

/**
 * The reflection nudge, as a pure decision: within the last REMIND_WITHIN_STEPS
 * steps before the cap, return the base system text + reminder (to override the
 * step's system message); otherwise undefined (no override). Pure → unit-testable.
 */
export function reflectionSystemOverride(input: {
  stepNumber: number;
  maxSteps: number;
  baseSystem: string;
  remindWithinSteps?: number;
}): string | undefined {
  const nudge = stepReflectionNudge(input.stepNumber, input.maxSteps, input.remindWithinSteps);
  return nudge ? `${input.baseSystem}\n\n${nudge}` : undefined;
}

/**
 * Compose the applicable wrap-up nudges (step-cap AND/OR 115 budget) onto the base
 * system for one step. Returns the overridden system text, or undefined when no
 * nudge applies. Both can fire at once (near the step cap AND over budget) — then
 * both are appended. Pure → unit-testable; prepareStep just calls this.
 */
export function prepareStepSystemOverride(input: {
  stepNumber: number;
  maxSteps: number;
  baseSystem: string;
  apiCallsSpent?: number;
  remindWithinSteps?: number;
  budgetSoftAt?: number;
}): string | undefined {
  const nudges = [
    stepReflectionNudge(input.stepNumber, input.maxSteps, input.remindWithinSteps),
    budgetReflectionNudge(input.apiCallsSpent, input.budgetSoftAt),
  ].filter((nudge): nudge is string => nudge !== null);
  return nudges.length > 0 ? [input.baseSystem, ...nudges].join("\n\n") : undefined;
}
