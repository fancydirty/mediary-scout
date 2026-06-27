#!/usr/bin/env node
// §6a interrogation: ask the SHIPPING TV/anime task-agent prompt how it would
// handle the Lycoris-Recoil edge cases — real Mimo endpoint, NO tools, NO side
// effects, no 115, no PanSou. This verifies "聪明" before spending real money on
// transfers. Run `npm run build:workflow` first so packages/workflow/dist exists.
//
// Usage:
//   node scripts/interrogate-acquisition-agent.mjs
//   node scripts/interrogate-acquisition-agent.mjs --scenario "Target: 进击的巨人 S04, missing S04E28-S04E30."
//   node scripts/interrogate-acquisition-agent.mjs --language 中文
//
// Reads AGENT_MODEL_* from .env / environment. This run is READ-ONLY.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--help" || key === "-h") {
      args.help = true;
      continue;
    }
    if (!key.startsWith("--")) continue;
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
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log("Usage: node scripts/interrogate-acquisition-agent.mjs [--scenario <text>] [--language <lang>]");
  console.log("Read-only: asks the real model how it would reason. No 115/PanSou side effects.");
  process.exit(0);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadDotEnv(path.join(repoRoot, ".env"));

if (!process.env.AGENT_MODEL_API_KEY && !process.env.XIAOMI_MIMO_API_KEY) {
  console.error("AGENT_MODEL_API_KEY is not set (in .env or the environment). Aborting.");
  process.exit(1);
}

const { createAgentModelFromEnv, runInterrogation, buildTvAnimeSystemPrompt, buildMovieSystemPrompt } = await import(
  path.join(repoRoot, "packages/workflow/dist/index.js")
);

const agent = args.agent === "movie" ? "movie" : "tv";
const defaultScenario =
  agent === "movie"
    ? "Target: 获取电影《奥本海默》(2023)。"
    : "Target: 莉可丽丝 (Lycoris Recoil) season 1, missing S01E01-S01E13.";
const scenario = args.scenario ?? defaultScenario;
const promptOptions = args.language ? { preferredLanguage: args.language } : {};
const buildPrompt = agent === "movie" ? buildMovieSystemPrompt : buildTvAnimeSystemPrompt;
const only = args.only ? args.only.split(",").map((s) => s.trim()).filter(Boolean) : undefined;

console.log("=== §6a interrogation (read-only — verifies 聪明 before spending) ===");
console.log("agent:", agent);
console.log("model:", process.env.AGENT_MODEL_ID ?? process.env.XIAOMI_MIMO_MODEL_ID ?? "(unset — required)");
console.log("scenario:", scenario);
if (only) console.log("only:", only.join(", "));
console.log("");

const startedAt = Date.now();
const transcript = await runInterrogation({
  model: createAgentModelFromEnv(process.env),
  systemPrompt: buildPrompt(promptOptions),
  scenario,
  ...(only ? { only } : {}),
});
const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

for (const entry of transcript) {
  console.log(`\n## [${entry.id}]`);
  console.log(`Q: ${entry.prompt}`);
  console.log(`期望(供你判断): ${entry.expectation}`);
  console.log(`\nA: ${entry.answer}`);
  console.log("\n" + "—".repeat(72));
}
console.log(`\nDone in ${elapsed}s. Judge each answer against its 期望; tune the prompt until stable, THEN run 6b/live.`);
