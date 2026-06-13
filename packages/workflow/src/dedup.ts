import { episodeCode, episodePartsFromCode, type MediaTitle, type VerifiedFile } from "./domain.js";
import type { AgentNodes } from "./ports.js";

export interface DedupPlan {
  /** episodeCode -> file ids (only episodes that actually have duplicates). */
  duplicateGroups: Record<string, string[]>;
  deleteFileIds: string[];
  keepFileIds: string[];
}

export interface ConfirmedDedupPlan extends DedupPlan {
  /** Files in suspect duplicate groups whose episode mapping the agent did not confirm — kept, never deleted. */
  unconfirmedFileIds: string[];
}

/**
 * Deletion-safe dedup. The deterministic filename parser can MISIDENTIFY
 * episodes (release-group numbers parsed as episode numbers), and deletion is
 * the most destructive side effect in the system — so "these files really are
 * the same episode" must be confirmed by the recognition agent before any
 * file is scheduled for deletion. Parser output is evidence, not authority.
 * Files the agent does not confirm are kept (fail-safe). The keep-larger
 * policy itself stays deterministic.
 */
export async function buildConfirmedDedupPlan(input: {
  title: MediaTitle;
  seasonNumber: number;
  files: VerifiedFile[];
  agents: AgentNodes;
}): Promise<ConfirmedDedupPlan> {
  const suspect = buildDedupPlan({ files: input.files });
  if (Object.keys(suspect.duplicateGroups).length === 0) {
    return { duplicateGroups: {}, deleteFileIds: [], keepFileIds: suspect.keepFileIds, unconfirmedFileIds: [] };
  }

  const suspectFileIds = new Set(Object.values(suspect.duplicateGroups).flat());
  const suspectFiles = input.files.filter((file) => suspectFileIds.has(file.id));
  const decision = await input.agents.recognizePackage({
    title: input.title.title,
    year: input.title.year,
    files: suspectFiles.map((file) => ({
      path: file.name,
      providerFileId: file.id,
      sizeBytes: file.sizeBytes,
    })),
    parserEvidence: suspectFiles.map((file) => {
      // Suspects only come from non-null episode groups (buildDedupPlan skips
      // null codes), so the code is guaranteed present here.
      const parts = episodePartsFromCode(file.episodeCode ?? "S00E00");
      return {
        providerFileId: file.id,
        path: file.name,
        parsedSeasonNumber: parts.seasonNumber,
        parsedEpisodeNumber: parts.episodeNumber,
        confidence: "medium" as const,
        evidence: ["filename_parser"],
      };
    }),
  });

  const confirmedEpisodeByFileId = new Map<string, string>();
  if (decision.confidence !== "low") {
    const knownIds = new Set(suspectFiles.map((file) => file.id));
    for (const mapping of decision.fileMappings) {
      if (!knownIds.has(mapping.providerFileId) || mapping.confidence === "low") {
        continue;
      }
      confirmedEpisodeByFileId.set(
        mapping.providerFileId,
        episodeCode(mapping.seasonNumber, mapping.episodeNumber),
      );
    }
  }

  const confirmedGroups = new Map<string, VerifiedFile[]>();
  const unconfirmedFileIds: string[] = [];
  for (const file of suspectFiles) {
    const confirmedEpisode = confirmedEpisodeByFileId.get(file.id);
    if (confirmedEpisode === undefined) {
      unconfirmedFileIds.push(file.id);
      continue;
    }
    const group = confirmedGroups.get(confirmedEpisode) ?? [];
    group.push(file);
    confirmedGroups.set(confirmedEpisode, group);
  }

  const duplicateGroups: Record<string, string[]> = {};
  const deleteFileIds: string[] = [];
  const keepFileIds = [...suspect.keepFileIds];
  for (const [episode, group] of confirmedGroups) {
    if (group.length === 1) {
      keepFileIds.push(group[0]!.id);
      continue;
    }
    duplicateGroups[episode] = group.map((file) => file.id);
    let keeper = group[0]!;
    for (const candidate of group.slice(1)) {
      if (candidate.sizeBytes > keeper.sizeBytes) {
        keeper = candidate;
      }
    }
    keepFileIds.push(keeper.id);
    for (const file of group) {
      if (file.id !== keeper.id) {
        deleteFileIds.push(file.id);
      }
    }
  }

  return { duplicateGroups, deleteFileIds, keepFileIds, unconfirmedFileIds };
}

/**
 * Deterministic duplicate cleanup over a verified file snapshot.
 *
 * Skill rules made structural: file size is the ONLY criterion (larger =
 * better; "new" or "collection pack" never wins by itself), the sole file of
 * an episode can never be scheduled for deletion, and the plan is built from
 * one stable snapshot. Files whose episode could not be parsed never reach
 * this function — the executor does not surface them as VerifiedFile.
 */
export function buildDedupPlan(input: { files: VerifiedFile[] }): DedupPlan {
  const byEpisode = new Map<string, VerifiedFile[]>();
  for (const file of input.files) {
    // Episode-less videos (movies, unparsed names) have no episode to duplicate
    // against — keep them untouched, never a deletion candidate.
    if (file.episodeCode === null) {
      continue;
    }
    const group = byEpisode.get(file.episodeCode) ?? [];
    group.push(file);
    byEpisode.set(file.episodeCode, group);
  }

  const duplicateGroups: Record<string, string[]> = {};
  const deleteFileIds: string[] = [];
  const keepFileIds: string[] = [];

  for (const [episodeCode, group] of byEpisode) {
    if (group.length === 1) {
      keepFileIds.push(group[0]!.id);
      continue;
    }
    duplicateGroups[episodeCode] = group.map((file) => file.id);
    let keeper = group[0]!;
    for (const candidate of group.slice(1)) {
      if (candidate.sizeBytes > keeper.sizeBytes) {
        keeper = candidate;
      }
    }
    keepFileIds.push(keeper.id);
    for (const file of group) {
      if (file.id !== keeper.id) {
        deleteFileIds.push(file.id);
      }
    }
  }

  return { duplicateGroups, deleteFileIds, keepFileIds };
}
