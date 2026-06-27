#!/usr/bin/env node
// Live smoke for the AcquisitionPlanningAgent: real Mimo endpoint + real
// PanSou search, zero storage side effects. Run `npm run build:workflow`
// first so packages/workflow/dist exists.
//
// Usage:
//   node scripts/agent-planning-smoke.mjs \
//     --title "翘楚" --keyword "翘楚 4K" --season 1 \
//     --missing S01E15 --latest 14 --alias "Ashes to Crown"

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HELP = `Usage: node scripts/agent-planning-smoke.mjs --title <title> [options]

Options:
  --title    <string>   Target media title (required unless --help)
  --keyword  <string>   Initial search keyword (default: "<title> 4K")
  --season   <number>   Season number (default: 1)
  --missing  <codes>    Comma-separated missing episode codes (default: S01E01)
  --latest   <number>   Latest aired episode number (default: highest missing)
  --alias    <names>    Comma-separated alias titles (default: none)
  --quality  <string>   Quality preference (default: 4K)
  --help                Show this help

Reads AGENT_MODEL_* and PANSOU_BASE_URL from .env / environment.
This run is read-only: it searches PanSou and asks the model to plan;
it never touches 115 storage.`;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--help" || key === "-h") {
      args.help = true;
      continue;
    }
    if (!key.startsWith("--")) {
      continue;
    }
    args[key.slice(2)] = argv[i + 1];
    i += 1;
  }
  return args;
}

function loadDotEnv(envPath) {
  let raw;
  try {
    raw = readFileSync(envPath, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.title) {
  console.log(HELP);
  process.exit(args.help ? 0 : 1);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadDotEnv(path.join(repoRoot, ".env"));

if (!process.env.AGENT_MODEL_API_KEY) {
  console.error("AGENT_MODEL_API_KEY is not set (in .env or the environment). Aborting.");
  process.exit(1);
}
if (!process.env.PANSOU_BASE_URL) {
  console.error("PANSOU_BASE_URL is not set (in .env or the environment). Aborting.");
  process.exit(1);
}

const {
  createPanSouResourceProviderFromEnv,
  createAgentNodesFromEnv,
  runAcquisitionPlanningSmoke,
} = await import(path.join(repoRoot, "packages/workflow/dist/index.js"));

const missingEpisodes = (args.missing ?? "S01E01").split(",").map((code) => code.trim()).filter(Boolean);
const seasonNumber = Number(args.season ?? 1);
const latestAired =
  args.latest !== undefined
    ? Number(args.latest)
    : Math.max(...missingEpisodes.map((code) => Number(code.slice(-2))));

const input = {
  title: args.title,
  aliases: (args.alias ?? "").split(",").map((alias) => alias.trim()).filter(Boolean),
  seasonNumber,
  qualityPreference: args.quality ?? "4K",
  missingEpisodes,
  latestAiredEpisode: latestAired,
  initialKeyword: args.keyword ?? `${args.title} 4K`,
};

console.log("=== acquisition planning live smoke (read-only) ===");
console.log(JSON.stringify(input, null, 2));
console.log("model:", process.env.AGENT_MODEL_ID ?? "(unset — required)");

const startedAt = Date.now();
const result = await runAcquisitionPlanningSmoke({
  ...input,
  agents: createAgentNodesFromEnv(process.env),
  resourceProvider: createPanSouResourceProviderFromEnv(),
});
const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);

console.log(`\n--- result (${elapsedSeconds}s) ---`);
console.log("status:", result.status);
console.log("snapshots:", JSON.stringify(result.snapshots, null, 2));
console.log("selectedCandidateTitles:", JSON.stringify(result.selectedCandidateTitles, null, 2));
if (result.validationError) {
  console.log("validationError:", result.validationError);
}
if (result.agentError) {
  console.log("agentError:", result.agentError);
}
console.log("\n--- plan ---");
console.log(JSON.stringify(result.plan, null, 2));
console.log("\n--- trace (tool calls) ---");
for (const event of result.trace) {
  if (event.type === "tool_call") {
    console.log("tool_call:", JSON.stringify(event.input));
  } else if (event.type === "tool_result" && event.output && typeof event.output === "object") {
    const output = event.output;
    if ("error" in output) {
      console.log("tool_result (error):", JSON.stringify(output));
    } else {
      console.log("tool_result:", JSON.stringify({
        snapshotId: output.snapshotId,
        keyword: output.keyword,
        candidateCount: output.candidateCount,
      }));
    }
  }
}

process.exit(result.status === "agent_error" ? 1 : 0);
