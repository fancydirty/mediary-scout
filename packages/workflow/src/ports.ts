import type {
  AcquisitionFailureEvidence,
  AcquisitionPlan,
  ResourceCandidate,
  ResourceSnapshot,
  TransferAttempt,
  VerifiedFile,
} from "./domain.js";
import type { AgentNodeTraceEvent } from "./agent-node-runtime.js";
import type {
  PackageRecognitionDecision,
  PackageRecognitionInput,
  PackageTreeFile,
} from "./package-normalizer.js";

export interface ResourceProvider {
  search(input: { keyword: string }): Promise<ResourceSnapshot>;
}

/** A video file whose name exposes no episode identity — invisible to verification until rescued. */
export interface UnparsedVideoFile {
  providerFileId: string;
  name: string;
  sizeBytes: number;
}

export interface StorageExecutor {
  createDirectory(input: { name: string; parentId: string }): Promise<string>;
  listVideoFiles(directoryId: string): Promise<VerifiedFile[]>;
  /** Video files in the directory whose names expose no parseable episode code. */
  listUnparsedVideoFiles(directoryId: string): Promise<UnparsedVideoFile[]>;
  /** Rename a single file in place (same directory). */
  renameFile(input: { directoryId: string; fileId: string; newName: string }): Promise<void>;
  transfer(input: {
    workflowRunId: string;
    directoryId: string;
    candidate: ResourceCandidate;
  }): Promise<TransferAttempt>;
  flattenDirectory(directoryId: string): Promise<{ moved: string[]; removed: string[] }>;
  deleteFiles(input: { directoryId: string; fileIds: string[] }): Promise<{ deleted: string[] }>;
  /** Remove an ephemeral directory (e.g. a staging dir) and everything under it.
   *  Refuses protected/root/parent directories — only sub-directories inside the
   *  write scope may be removed. */
  removeDirectory(directoryId: string): Promise<{ removed: boolean }>;
  /** Path-preserving recursive snapshot of a staging directory (all files, not just videos). */
  listTree(input: { directoryId: string; maxDepth?: number }): Promise<PackageTreeFile[]>;
  /** Move files (by provider file id) into a target directory inside the write scope. */
  moveFiles(input: { fileIds: string[]; targetDirectoryId: string }): Promise<{ moved: string[] }>;
}

export interface AcquisitionSeasonContext {
  seasonNumber: number;
  totalEpisodes: number;
  latestAiredEpisode: number;
}

export interface AcquisitionPlanningInput {
  title: string;
  aliases: string[];
  /** Seasons in scope for this acquisition; single-element for Type 2/3. */
  seasons: AcquisitionSeasonContext[];
  qualityPreference: string;
  missingEpisodes: string[];
  initialKeyword: string;
  failureEvidence: AcquisitionFailureEvidence[];
  searchResources(input: { keyword: string }): Promise<ResourceSnapshot>;
}

export interface AcquisitionPlanningResult {
  plan: AcquisitionPlan;
  snapshots: ResourceSnapshot[];
  trace: AgentNodeTraceEvent[];
}

/**
 * Movie acquisition judgment. No seasons/episodes — the agent's job is to pick
 * the ONE resource that is exactly this film (not a remake/sequel/same-IP
 * different movie) as a single video at the best quality. The selected
 * candidate is mapped to the movie anchor's single synthetic episode S01E01.
 */
export interface MoviePlanningInput {
  title: string;
  aliases: string[];
  year: number;
  qualityPreference: string;
  initialKeyword: string;
  failureEvidence: AcquisitionFailureEvidence[];
  searchResources(input: { keyword: string }): Promise<ResourceSnapshot>;
}

export interface MovieMasterSelectionCandidate {
  providerFileId: string;
  name: string;
  sizeBytes: number;
}

/**
 * Picking the one main-feature file when a transferred movie resource flattened
 * into several videos (feature + extras/samples/duplicate versions). Pure
 * judgment over names+sizes; no tools, no side effects.
 */
export interface MovieMasterSelectionInput {
  title: string;
  year: number;
  candidates: MovieMasterSelectionCandidate[];
}

export interface MovieMasterSelectionDecision {
  node: string;
  /** The providerFileId of the single file to keep (the main feature). */
  keepFileId: string;
  reason: string;
}

/**
 * The agent boundary. One node owns the whole acquisition judgment
 * (search strategy, target matching, episode mapping, selection) through
 * read-only tools; one node maps ambiguous package files; one node picks the
 * main-feature file among a movie's flattened videos. None can
 * create directories, transfer, delete, or mutate workflow state.
 */
export interface AgentNodes {
  planAcquisition(input: AcquisitionPlanningInput): Promise<AcquisitionPlanningResult>;
  planMovieAcquisition(input: MoviePlanningInput): Promise<AcquisitionPlanningResult>;
  selectMovieMasterFile(input: MovieMasterSelectionInput): Promise<MovieMasterSelectionDecision>;
  recognizePackage(input: PackageRecognitionInput): Promise<PackageRecognitionDecision>;
}
