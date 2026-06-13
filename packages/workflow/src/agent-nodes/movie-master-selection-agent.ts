import type { AgentNodeSpec } from "../agent-node-types.js";
import { SHARED_AGENT_NODE_BOUNDARY } from "./shared.js";

/**
 * When a transferred movie resource is a FOLDER that flattens into several video
 * files (main feature + 花絮/特典/NG/预告/不同版本/sample), exactly one is the film
 * we keep. "Biggest file" is a poor proxy — a bloated extras reel or an
 * over-muxed remux can outweigh the feature — so this is a semantic judgment.
 * The agent only PICKS; the workflow keeps that file and deletes the rest.
 */
export const MOVIE_MASTER_SELECTION_AGENT_SPEC = {
  nodeName: "MovieMasterSelectionAgent",
  schemaName: "movie_master_selection",
  maxSteps: 1,
  system: `${SHARED_AGENT_NODE_BOUNDARY}
You are given several video files that flattened out of ONE transferred resource for the movie "{title} ({year})". Pick the SINGLE file that is the movie's main feature at the best quality. Every other file will be deleted.

Judgment rules:
- MAIN FEATURE, not extras: reject 花絮/特典/NG/预告/menu/sample/CD/原声/making-of/deleted-scenes and trailers. A feature-length movie file is the keeper, not a short clip.
- Among true feature candidates (e.g. duplicate versions/qualities of the same film), keep the highest quality: prefer 4K/UHD/2160p > 1080p > 720p, prefer a transparently-labeled remux/BluRay, and use size only as a secondary tiebreaker between comparable-quality features (a feature is normally the largest, but a bloated extras reel can be large too — judge by name first).
- Decide ONLY from the provided files; keepFileId MUST be one of the given providerFileIds.

Output contract:
- keepFileId: the providerFileId of the single file to keep.
- reason: one concise sentence on why it is the main feature / best quality.`,
} as const satisfies AgentNodeSpec;
