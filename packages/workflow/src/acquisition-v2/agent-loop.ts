import { generateText, stepCountIs, type LanguageModel, type ToolSet } from "ai";
import { z } from "zod";
import type { TaskSandbox } from "./sandbox.js";
import { readSkillSection } from "./skill.js";
import {
  DEFAULT_MAX_STEPS,
  buildRepetitionStop,
  buildSystemicBlockStop,
  prepareStepSystemOverride,
} from "./agent-loop-guards.js";
import { interpretTool, type AgentToolEvent } from "./activity.js";

/**
 * Phase 3 — the agent loop harness. The strong agent drives its own
 * observe-act-verify loop through the sandbox tools; the system only orchestrates
 * the AI SDK tool-loop and feeds each tool's result (which the sandbox already
 * force-rereads) straight back into the model context. The sandbox stays the
 * permission cage: every guard refusal comes back to the model as `{ error }`
 * text it must read and adapt to — never a crash that aborts the loop.
 */

/** Wrap a sandbox call so a guard refusal becomes evidence, not an exception. */
async function asEvidence(run: () => Promise<unknown>): Promise<unknown> {
  try {
    return await run();
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Opt-in observability (MEDIA_TRACK_AGENT_LOG=1): log every sandbox tool call the
 * agent makes — the keyword it searches, the candidate it transfers, what it
 * moves/marks, and the evidence that comes back. Off by default (silent in
 * tests); turned on for live e2e so the agent loop is not a black box.
 */
/**
 * Wrap every tool's execute so each call can (a) emit a cleaned progress event for
 * the activity page (always, when `onToolCall` is given) and (b) log the raw
 * call/result to stdout (opt-in via MEDIA_TRACK_AGENT_LOG=1). The wrapper is a
 * passthrough when neither is active. The progress emit is best-effort — a throw
 * in `onToolCall` must never break the agent's tool execution.
 */
function wrapTools(
  tools: ToolSet,
  options: { onToolCall?: (toolName: string, args: Record<string, unknown>) => void; log: boolean },
): ToolSet {
  if (!options.onToolCall && !options.log) {
    return tools;
  }
  const wrapped: Record<string, unknown> = {};
  for (const [name, tool] of Object.entries(tools)) {
    const execute = (tool as { execute: (args: unknown, options: unknown) => Promise<unknown> }).execute;
    wrapped[name] = {
      ...(tool as object),
      execute: async (args: unknown, executeOptions: unknown) => {
        if (options.onToolCall) {
          try {
            options.onToolCall(name, (args && typeof args === "object" ? args : {}) as Record<string, unknown>);
          } catch {
            // progress is a display nicety — never let it break a tool call
          }
        }
        if (options.log) {
          const argStr =
            args && typeof args === "object" && Object.keys(args).length > 0
              ? ` ${JSON.stringify(args).slice(0, 240)}`
              : "";
          console.log(`[agent] → ${name}${argStr}`);
        }
        const result = await execute(args, executeOptions);
        if (options.log) {
          console.log(`[agent] ← ${name}: ${JSON.stringify(result).slice(0, 400)}`);
        }
        return result;
      },
    };
  }
  return wrapped as ToolSet;
}

/** Build the AI SDK ToolSet that exposes the sandbox to the model. Each tool's
 *  execute drives the sandbox and returns its (already reread) evidence. The
 *  movie-only `transferUntilLanded` is included only when `options.movie` — the
 *  TV/anime agent must NOT get it (it would confuse with multi-resource season
 *  coverage). */
export function buildSandboxToolSet(
  sandbox: TaskSandbox,
  options: {
    movie?: boolean;
    onToolCall?: (toolName: string, args: Record<string, unknown>) => void;
    /** The run's drive brand — selects the brand-specific dead-links section. */
    storageProvider?: string;
  } = {},
): ToolSet {
  const tools: Record<string, unknown> = {
    readSkill: {
      description:
        "Read a section of your domain skill manual ON DEMAND — the hard-won playbook for HOW to act. Sections: protocol, dead-links-black-box, dedup, movie, tv, mistakes. Read your sections before you act, and re-read the relevant one the moment its situation arises. Acting from memory instead of the skill is how the old agent hammered the drive and corrupted libraries.",
      inputSchema: z.object({ section: z.string() }),
      execute: (args: { section: string }) =>
        Promise.resolve({ section: args.section, body: readSkillSection(args.section, options.storageProvider) }),
    },
    searchResources: {
      description:
        "Search the resource provider with ONE keyword. Read-only. Returns the full snapshot of candidates (no slicing). Repeats are deduped; the search budget is capped — decide from gathered evidence when refused.",
      inputSchema: z.object({ keyword: z.string() }),
      execute: (args: { keyword: string }) => asEvidence(() => sandbox.searchResources(args.keyword)),
    },
    inspectStaging: {
      description: "Read-only: the full raw file tree currently in this task's staging. Judge identity/dupes/extras from these real files.",
      inputSchema: z.object({}),
      execute: () => asEvidence(() => sandbox.inspectStaging()),
    },
    inspectTargetDir: {
      description:
        "Read-only ground truth for what has landed. Pass `season` to see that season's directory (so you know what it already holds before moving/deduping); omit it to see all target seasons at once. Multi-season tasks: check each season here.",
      inputSchema: z.object({ season: z.number().int().positive().optional() }),
      execute: (args: { season?: number }) => asEvidence(() => sandbox.inspectTargetDir(args)),
    },
    transferCandidate: {
      description:
        "Transfer ONE snapshot-bound candidate into staging, then read back the TRUE materialized files. The candidate must come from a snapshot you searched this task. Refused once coverage is already met.",
      inputSchema: z.object({ snapshotId: z.string(), candidateId: z.string() }),
      execute: (args: { snapshotId: string; candidateId: string }) =>
        asEvidence(() => sandbox.transferCandidate(args)),
    },
    moveToSeason: {
      description:
        "Submit your WHOLE distribution plan in ONE call: `{moves:[{season,fileIds},...]}` — which files go into which season's directory. Each video's SUBTITLES go in the SAME season's fileIds (never leave subtitles behind — they must land beside their video). Move ONLY still-missing episodes; never recopy a season the library already has. A movie move OMITS `season` (the file lands in the movie directory). Returns every touched season dir + the remaining staging so you verify the whole distribution at once and fix any misplacement with another call. Every fileId must currently be in staging.",
      inputSchema: z.object({
        moves: z.array(z.object({ season: z.number().int().positive().optional(), fileIds: z.array(z.string()) })),
      }),
      execute: (args: { moves: Array<{ season?: number; fileIds: string[] }> }) =>
        asEvidence(() => sandbox.moveToSeason(args)),
    },
    deleteFiles: {
      description:
        "Delete files you confirmed (dedup keep-larger, or residue) from a named scoped directory. For directory='season' on a multi-season task, pass `season` to name which season's dir. Every id must currently be in that directory. Rereads it.",
      inputSchema: z.object({
        directory: z.enum(["staging", "season"]),
        season: z.number().int().positive().optional(),
        fileIds: z.array(z.string()),
      }),
      execute: (args: { directory: "staging" | "season"; season?: number; fileIds: string[] }) =>
        asEvidence(() => sandbox.deleteFiles(args)),
    },
    flattenMovie: {
      description:
        'Movie only — AUTOMATIC: pull every video AND subtitle file out of the resource wrapper(s) up into the movie directory and remove the wrappers, in one call (no file selection — a movie is one film, take it all, subtitles included). Then delete any extras (trailers/花絮) with deleteFiles and markObtained(["MOVIE"]).',
      inputSchema: z.object({}),
      execute: () => asEvidence(() => sandbox.flattenMovie()),
    },
    discardStaging: {
      description:
        "TV/anime clean-up, your final step: after every needed episode (with its subtitles) is moved into its season directory and marked, wipe the WHOLE staging directory — leftovers you didn't need are discarded. You may only delete your own staging (never a season/show/root dir).",
      inputSchema: z.object({}),
      execute: () => asEvidence(() => sandbox.discardStaging()),
    },
    markObtained: {
      description:
        "Your FINAL action: declare the episode codes you have obtained (e.g. [\"S01E13\"], or [\"MOVIE\"] for a film). Do this LAST — only after you have moved the files into the target dir, flattened the wrapper, and confirmed from your inspect that the real films are in place. Pure agent judgment: no fileId, the system does not re-read to second-guess you. MOVIE last-resort fallback: if you landed a raw-name match of the correct film WITHOUT a confirmed 中文 sub track (中字 budget exhausted), pass subtitleFallback:true so the system flags 可能无中文字幕.",
      inputSchema: z.object({ codes: z.array(z.string()), subtitleFallback: z.boolean().optional() }),
      execute: (args: { codes: string[]; subtitleFallback?: boolean }) =>
        asEvidence(() => sandbox.markObtained(args)),
    },
    finish: {
      description: "Declare the task done. Returns the honest coverage summary (what is obtained, what remains).",
      inputSchema: z.object({}),
      execute: () => asEvidence(() => sandbox.finish()),
    },
    reportNoCoverage: {
      description:
        "Honestly report you cannot cover the target. Valid only after a real search ran; backs the report with real provider evidence.",
      inputSchema: z.object({ reason: z.string() }),
      execute: (args: { reason: string }) => asEvidence(() => sandbox.reportNoCoverage(args.reason)),
    },
  };
  if (options.movie) {
    tools["transferUntilLanded"] = {
      description:
        'Movie only. Transfer a PRIORITY-ORDERED list of candidates you judged to be the SAME target film (best resource first), stopping at the FIRST that 秒传-lands; the rest are abandoned. 115 SHARE LINKS ONLY — magnets do NOT fail loud, so for a magnet use transferCandidate and verify via inspectStaging. YOU pick the set (a keyword search returns same-named DIFFERENT works — never hand it everything); the system just burns through the dead links for you (链接已过期/分享已取消/错误的链接 are common). Returns {landed, transferredCandidateId, attempts}. Use this when several 115 shares for the one film may be dead/black-box; for a single obvious share, transferCandidate is fine.',
      inputSchema: z.object({ candidateIds: z.array(z.string()) }),
      execute: (args: { candidateIds: string[] }) => asEvidence(() => sandbox.transferUntilLanded(args)),
    };
  }
  const toolSet = tools as ToolSet;
  return wrapTools(toolSet, {
    ...(options.onToolCall ? { onToolCall: options.onToolCall } : {}),
    log: process.env.MEDIA_TRACK_AGENT_LOG === "1",
  });
}

export interface AcquisitionAgentRequest {
  sandbox: TaskSandbox;
  model: LanguageModel;
  system: string;
  prompt: string;
  /** Hard ceiling on tool-loop steps (the model still terminates earlier via finish/reportNoCoverage). */
  maxSteps?: number;
  /** Movie task → expose the movie-only transferUntilLanded tool. */
  movie?: boolean;
  /** The run's drive brand — selects the brand-specific dead-links skill section. */
  storageProvider?: string;
  /** Per-tool-call live progress for the activity page (cleaned activity + phase
   *  + raw name/args). Best-effort; absent in tests/headless. */
  onProgress?: (event: AgentToolEvent) => void;
  /** Cumulative 115 API calls so far (real 115 only). Lets prepareStep inject the
   *  budget soft-warning, the same way it injects the step-cap wind-down. Absent
   *  (fakes/sim) → no budget nudge. */
  apiCallCount?: () => number | undefined;
  /** SOFT-warning threshold, derived from the configured HARD budget upstream
   *  (budgetSoftThreshold). Absent → falls back to BUDGET_SOFT_REMIND_AT. */
  budgetSoftAt?: number;
}

export interface AcquisitionAgentResult {
  /** The model's final free text (after it stopped calling tools). */
  text: string;
  /** Number of loop steps the model took. */
  steps: number;
  /** Final honest coverage picture, read from the sandbox after the loop. */
  coverage: { coverageMet: boolean; obtained: string[]; missing: string[]; subtitleFallback: boolean };
}

/** Run the strong agent's self-driven loop over the sandbox tools. */
export async function runAcquisitionAgent(
  request: AcquisitionAgentRequest,
): Promise<AcquisitionAgentResult> {
  const onProgress = request.onProgress;
  const tools = buildSandboxToolSet(request.sandbox, {
    movie: request.movie ?? false,
    ...(request.storageProvider === undefined ? {} : { storageProvider: request.storageProvider }),
    ...(onProgress
      ? {
          onToolCall: (toolName: string, args: Record<string, unknown>) =>
            onProgress({ toolName, args, ...interpretTool(toolName, args) }),
        }
      : {}),
  });
  const maxSteps = request.maxSteps ?? DEFAULT_MAX_STEPS;
  const result = await generateText({
    model: request.model,
    system: request.system,
    prompt: request.prompt,
    tools,
    // Three stops: step cap (cost/runaway), repetition (agent crazy), and systemic
    // transfer block (account quota/auth — every candidate will fail, stop grinding).
    stopWhen: [stepCountIs(maxSteps), buildRepetitionStop(), buildSystemicBlockStop()],
    // Last ~10 steps before the cap: inject a calm "wrap up + clean staging" nudge
    // so a step-capped run doesn't leave the 一人之下-style half-done mess.
    prepareStep: ({ stepNumber }) => {
      const spent = request.apiCallCount?.();
      const system = prepareStepSystemOverride({
        stepNumber,
        maxSteps,
        baseSystem: request.system,
        ...(typeof spent === "number" ? { apiCallsSpent: spent } : {}),
        ...(typeof request.budgetSoftAt === "number" ? { budgetSoftAt: request.budgetSoftAt } : {}),
      });
      return system ? { system } : undefined;
    },
  });
  const steps = result.steps?.length ?? 0;
  if (process.env.MEDIA_TRACK_AGENT_LOG === "1") {
    const total = result.totalUsage?.totalTokens;
    const perStep = total ? ` ~${Math.round(total / Math.max(steps, 1))}/step` : "";
    // peakContext = the LAST step's input — the single-request window usage that
    // decides whether context condensation/compact is ever needed (vs the 1M
    // window). totalTokens above is the cumulative BILLED count, not window usage.
    const peak = result.usage?.inputTokens;
    const peakStr = peak ? ` peakContext=${peak}` : "";
    console.log(
      `[agent] loop done: steps=${steps} tokens=${total ?? "n/a"}${perStep}${peakStr} finish=${result.finishReason}`,
    );
  }
  return {
    text: result.text,
    steps,
    coverage: await request.sandbox.finish(),
  };
}
