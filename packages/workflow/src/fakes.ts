import {
  type CandidateDisposition,
  type ResourceCandidate,
  type ResourceSnapshot,
  type TransferAttempt,
  type TransferStatus,
  type VerifiedFile,
} from "./domain.js";
import type {
  PackageRecognitionDecision,
  PackageRecognitionInput,
} from "./package-normalizer.js";
import type { PackageTreeFile } from "./package-normalizer.js";
import { episodeCodeFromFileName } from "./episode-code.js";
import type {
  AcquisitionPlanningInput,
  MoviePlanningInput,
  AcquisitionPlanningResult,
  AgentNodes,
  MovieMasterSelectionDecision,
  MovieMasterSelectionInput,
  ResourceProvider,
  StorageExecutor,
  UnparsedVideoFile,
} from "./ports.js";

export type FakePackageTreeFile = PackageTreeFile & { episodeCode?: string };

const FIXED_CREATED_AT = "2026-01-01T00:00:00.000Z";

export interface CandidateFixture {
  title: string;
  episodeHints: string[];
  qualityHints?: string[];
  source?: string;
  providerPayload?: Record<string, unknown>;
}

export interface TransferOutcome {
  status: TransferStatus;
  providerMessage: string;
  files: VerifiedFile[];
}

export interface FakeAgentNodesOptions {
  packageRecognition?: PackageRecognitionDecision;
  /** Force the movie master selection to keep a specific providerFileId. */
  movieMasterKeepFileId?: string;
}

export class FakeResourceProvider implements ResourceProvider {
  private readonly keywordResults: Record<string, CandidateFixture[]>;
  private readonly keywordErrors: Record<string, string>;
  private nextSnapshotNumber = 1;

  constructor(input: { keywordResults: Record<string, CandidateFixture[]>; keywordErrors?: Record<string, string> }) {
    this.keywordResults = input.keywordResults;
    this.keywordErrors = input.keywordErrors ?? {};
  }

  async search(input: { keyword: string }): Promise<ResourceSnapshot> {
    const error = this.keywordErrors[input.keyword];
    if (error !== undefined) {
      throw new Error(error);
    }

    const snapshotId = `snapshot_${this.nextSnapshotNumber}`;
    this.nextSnapshotNumber += 1;
    const fixtures = this.keywordResults[input.keyword] ?? [];
    const candidates: ResourceCandidate[] = fixtures.map((fixture, index) => ({
      id: `${snapshotId}_candidate_${index + 1}`,
      snapshotId,
      index,
      title: fixture.title,
      type: "115",
      source: fixture.source ?? "fake",
      episodeHints: [...fixture.episodeHints],
      qualityHints: [...(fixture.qualityHints ?? [])],
      providerPayload: { ...(fixture.providerPayload ?? {}) },
    }));

    return {
      id: snapshotId,
      provider: "fake",
      keyword: input.keyword,
      candidates,
      createdAt: FIXED_CREATED_AT,
    };
  }
}

export class FakeStorageExecutor implements StorageExecutor {
  private readonly directories: Map<string, VerifiedFile[]>;
  private readonly transferOutcomes: Record<string, TransferOutcome>;
  private readonly nestedDirectories: Set<string>;
  private nextDirectoryNumber = 1;
  private nextTransferNumber = 1;

  private readonly packageTrees: Map<string, FakePackageTreeFile[]>;

  private readonly unparsedFiles: Map<string, UnparsedVideoFile[]>;

  constructor(input: {
    directories?: Record<string, VerifiedFile[]>;
    transferOutcomes?: Record<string, TransferOutcome>;
    nestedDirectories?: Set<string>;
    packageTrees?: Record<string, FakePackageTreeFile[]>;
    unparsedFiles?: Record<string, UnparsedVideoFile[]>;
  } = {}) {
    this.unparsedFiles = new Map(
      Object.entries(input.unparsedFiles ?? {}).map(([directoryId, files]) => [
        directoryId,
        files.map((file) => ({ ...file })),
      ]),
    );
    this.packageTrees = new Map(
      Object.entries(input.packageTrees ?? {}).map(([directoryId, files]) => [
        directoryId,
        files.map((file) => ({ ...file })),
      ]),
    );
    this.directories = new Map(
      Object.entries(input.directories ?? {}).map(([directoryId, files]) => [
        directoryId,
        files.map((file) => ({ ...file })),
      ]),
    );
    this.transferOutcomes = cloneTransferOutcomes(input.transferOutcomes ?? {});
    this.nestedDirectories = new Set(input.nestedDirectories ?? []);
  }

  private readonly directoryIdsByName = new Map<string, string>();

  async createDirectory(input: { name: string; parentId: string }): Promise<string> {
    const nameKey = `${input.parentId}::${input.name}`;
    const existing = this.directoryIdsByName.get(nameKey);
    if (existing !== undefined) {
      return existing;
    }
    const directoryId = `${input.parentId}_${input.name}_${this.nextDirectoryNumber}`;
    this.nextDirectoryNumber += 1;
    this.directories.set(directoryId, []);
    this.directoryIdsByName.set(nameKey, directoryId);
    return directoryId;
  }

  async listVideoFiles(directoryId: string): Promise<VerifiedFile[]> {
    return this.filesFor(directoryId).map((file) => ({ ...file }));
  }

  async listUnparsedVideoFiles(directoryId: string): Promise<UnparsedVideoFile[]> {
    return (this.unparsedFiles.get(directoryId) ?? []).map((file) => ({ ...file }));
  }

  async renameFile(input: { directoryId: string; fileId: string; newName: string }): Promise<void> {
    const unparsed = this.unparsedFiles.get(input.directoryId) ?? [];
    const unparsedIndex = unparsed.findIndex((file) => file.providerFileId === input.fileId);
    if (unparsedIndex >= 0) {
      const [file] = unparsed.splice(unparsedIndex, 1);
      const episodeCode = episodeCodeFromFileName(input.newName);
      if (episodeCode === null) {
        unparsed.push({ ...file!, name: input.newName });
      } else {
        this.filesFor(input.directoryId).push({
          id: file!.providerFileId,
          storageDirectoryId: input.directoryId,
          name: input.newName,
          sizeBytes: file!.sizeBytes,
          episodeCode,
          providerFileId: file!.providerFileId,
        });
      }
      this.unparsedFiles.set(input.directoryId, unparsed);
      return;
    }
    const files = this.filesFor(input.directoryId);
    const verified = files.find((file) => file.id === input.fileId);
    if (verified === undefined) {
      throw new Error(`fake renameFile: file ${input.fileId} not found in ${input.directoryId}`);
    }
    verified.name = input.newName;
    const episodeCode = episodeCodeFromFileName(input.newName);
    if (episodeCode !== null) {
      verified.episodeCode = episodeCode;
    }
  }

  async transfer(input: {
    workflowRunId: string;
    directoryId: string;
    candidate: ResourceCandidate;
  }): Promise<TransferAttempt> {
    const outcome = this.transferOutcomes[input.candidate.id] ?? {
      status: "failed",
      providerMessage: "no fake transfer outcome configured",
      files: [],
    };
    const materializedFileIds = outcome.files.map((file) => file.id);

    if (outcome.status === "succeeded") {
      const files = this.filesFor(input.directoryId);
      files.push(...outcome.files.map((file) => ({ ...file, storageDirectoryId: input.directoryId })));
    }

    const attempt: TransferAttempt = {
      id: `transfer_${this.nextTransferNumber}`,
      workflowRunId: input.workflowRunId,
      candidateId: input.candidate.id,
      status: outcome.status,
      providerMessage: outcome.providerMessage,
      materializedFileIds,
    };
    this.nextTransferNumber += 1;
    return attempt;
  }

  async flattenDirectory(directoryId: string): Promise<{ moved: string[]; removed: string[] }> {
    if (!this.nestedDirectories.has(directoryId)) {
      return { moved: [], removed: [] };
    }

    return {
      moved: this.filesFor(directoryId).map((file) => file.id),
      removed: [`${directoryId}_nested`],
    };
  }

  async deleteFiles(input: { directoryId: string; fileIds: string[] }): Promise<{ deleted: string[] }> {
    const fileIds = new Set(input.fileIds);
    const files = this.filesFor(input.directoryId);
    const deleted = files.filter((file) => fileIds.has(file.id)).map((file) => file.id);
    this.directories.set(
      input.directoryId,
      files.filter((file) => !fileIds.has(file.id)),
    );
    return { deleted };
  }

  async removeDirectory(directoryId: string): Promise<{ removed: boolean }> {
    const existed =
      this.directories.has(directoryId) ||
      this.unparsedFiles.has(directoryId) ||
      this.packageTrees.has(directoryId);
    this.directories.delete(directoryId);
    this.unparsedFiles.delete(directoryId);
    this.packageTrees.delete(directoryId);
    for (const [nameKey, id] of this.directoryIdsByName) {
      if (id === directoryId) {
        this.directoryIdsByName.delete(nameKey);
      }
    }
    return { removed: existed };
  }

  async listTree(input: { directoryId: string; maxDepth?: number }): Promise<PackageTreeFile[]> {
    const configured = (this.packageTrees.get(input.directoryId) ?? []).map(
      ({ episodeCode: _episodeCode, ...file }) => ({ ...file }),
    );
    const transferred = (this.directories.get(input.directoryId) ?? []).map((file) => ({
      path: file.name,
      providerFileId: file.id,
      sizeBytes: file.sizeBytes,
    }));
    return [...configured, ...transferred];
  }

  async moveFiles(input: { fileIds: string[]; targetDirectoryId: string }): Promise<{ moved: string[] }> {
    const wanted = new Set(input.fileIds);
    const moved: string[] = [];
    for (const [directoryId, files] of this.directories) {
      if (directoryId === input.targetDirectoryId) {
        continue;
      }
      const moving = files.filter((file) => wanted.has(file.id));
      if (moving.length === 0) {
        continue;
      }
      this.directories.set(
        directoryId,
        files.filter((file) => !wanted.has(file.id)),
      );
      const target = this.filesFor(input.targetDirectoryId);
      for (const file of moving) {
        target.push({ ...file, storageDirectoryId: input.targetDirectoryId });
        moved.push(file.id);
      }
    }
    for (const [directoryId, files] of this.unparsedFiles) {
      if (directoryId === input.targetDirectoryId) {
        continue;
      }
      const moving = files.filter((file) => wanted.has(file.providerFileId));
      if (moving.length === 0) {
        continue;
      }
      this.unparsedFiles.set(
        directoryId,
        files.filter((file) => !wanted.has(file.providerFileId)),
      );
      const target = this.unparsedFiles.get(input.targetDirectoryId) ?? [];
      target.push(...moving);
      this.unparsedFiles.set(input.targetDirectoryId, target);
      moved.push(...moving.map((file) => file.providerFileId));
    }
    for (const [stagingId, treeFiles] of this.packageTrees) {
      const keep: FakePackageTreeFile[] = [];
      for (const treeFile of treeFiles) {
        if (!wanted.has(treeFile.providerFileId)) {
          keep.push(treeFile);
          continue;
        }
        moved.push(treeFile.providerFileId);
        const baseName = treeFile.path.split("/").at(-1) ?? treeFile.path;
        if (treeFile.episodeCode !== undefined) {
          this.filesFor(input.targetDirectoryId).push({
            id: treeFile.providerFileId,
            storageDirectoryId: input.targetDirectoryId,
            name: baseName,
            sizeBytes: treeFile.sizeBytes,
            episodeCode: treeFile.episodeCode,
            providerFileId: treeFile.providerFileId,
          });
        } else {
          // No episode identity in the name: the real executor cannot see
          // this file as an episode — it lands as an unparsed video.
          const unparsed = this.unparsedFiles.get(input.targetDirectoryId) ?? [];
          unparsed.push({
            providerFileId: treeFile.providerFileId,
            name: baseName,
            sizeBytes: treeFile.sizeBytes,
          });
          this.unparsedFiles.set(input.targetDirectoryId, unparsed);
        }
      }
      this.packageTrees.set(stagingId, keep);
    }
    return { moved };
  }

  private filesFor(directoryId: string): VerifiedFile[] {
    const existing = this.directories.get(directoryId);
    if (existing !== undefined) {
      return existing;
    }

    const files: VerifiedFile[] = [];
    this.directories.set(directoryId, files);
    return files;
  }
}

export class FakeAgentNodes implements AgentNodes {
  private readonly packageRecognition: PackageRecognitionDecision | undefined;
  private readonly movieMasterKeepFileId: string | undefined;

  constructor(options: FakeAgentNodesOptions = {}) {
    this.packageRecognition = options.packageRecognition;
    this.movieMasterKeepFileId = options.movieMasterKeepFileId;
  }

  async selectMovieMasterFile(
    input: MovieMasterSelectionInput,
  ): Promise<MovieMasterSelectionDecision> {
    // Default heuristic for tests: keep the largest candidate, unless a specific
    // keeper is configured (to assert the workflow honors the agent's pick).
    const configured = this.movieMasterKeepFileId
      ? input.candidates.find((candidate) => candidate.providerFileId === this.movieMasterKeepFileId)
      : undefined;
    const keeper =
      configured ??
      [...input.candidates].sort((left, right) => right.sizeBytes - left.sizeBytes)[0];
    if (!keeper) {
      throw new Error("FakeAgentNodes.selectMovieMasterFile: no candidates");
    }
    return {
      node: "fake_movie_master_selection",
      keepFileId: keeper.providerFileId,
      reason: configured ? "configured keeper" : "largest candidate",
    };
  }

  async planAcquisition(input: AcquisitionPlanningInput): Promise<AcquisitionPlanningResult> {
    const failedTitles = new Set(input.failureEvidence.map((evidence) => evidence.candidateTitle));
    const keywords = uniqueKeywords([
      input.initialKeyword,
      input.title,
      ...input.aliases,
      `${input.title} 4K`,
    ]);
    const snapshots: ResourceSnapshot[] = [];
    const searchedKeywords: string[] = [];
    const trace: AcquisitionPlanningResult["trace"] = [
      {
        type: "node_start",
        nodeName: "AcquisitionPlanningAgent",
        schemaName: "acquisition_planning",
        maxSteps: 12,
      },
    ];

    for (const keyword of keywords) {
      searchedKeywords.push(keyword);
      trace.push({
        type: "tool_call",
        nodeName: "AcquisitionPlanningAgent",
        toolName: "searchResources",
        input: { keyword },
      });
      let snapshot: ResourceSnapshot;
      try {
        snapshot = await input.searchResources({ keyword });
      } catch (error) {
        trace.push({
          type: "tool_result",
          nodeName: "AcquisitionPlanningAgent",
          toolName: "searchResources",
          output: { keyword, error: errorMessage(error) },
        });
        continue;
      }
      snapshots.push(snapshot);
      trace.push({
        type: "tool_result",
        nodeName: "AcquisitionPlanningAgent",
        toolName: "searchResources",
        output: { snapshotId: snapshot.id, keyword: snapshot.keyword, candidateCount: snapshot.candidates.length },
      });
      if (snapshot.candidates.length === 0) {
        continue;
      }

      const dispositions = minimalCoveringDispositions({
        candidates: snapshot.candidates,
        missingEpisodes: input.missingEpisodes,
        failedTitles,
      });
      trace.push({
        type: "node_finish",
        nodeName: "AcquisitionPlanningAgent",
        schemaName: "acquisition_planning",
      });
      const hasSelection = dispositions.some((disposition) => disposition.disposition === "selected");
      return {
        plan: {
          node: "fake_acquisition_planning",
          selectedSnapshotId: hasSelection ? snapshot.id : null,
          searchedKeywords,
          candidateDispositions: hasSelection
            ? dispositions
            : dispositions.map((disposition) => ({ ...disposition, episodes: [] })),
          confidence: hasSelection ? "high" : "low",
          reason: hasSelection
            ? "Fake planning selected a minimal covering set by episode hints."
            : "Fake planning found no candidate covering the missing episodes.",
        },
        snapshots,
        trace,
      };
    }

    trace.push({
      type: "node_finish",
      nodeName: "AcquisitionPlanningAgent",
      schemaName: "acquisition_planning",
    });
    return {
      plan: {
        node: "fake_acquisition_planning",
        selectedSnapshotId: null,
        searchedKeywords,
        candidateDispositions: [],
        confidence: "low",
        reason: "Fake planning exhausted keywords without a non-empty snapshot.",
      },
      snapshots,
      trace,
    };
  }

  async planMovieAcquisition(input: MoviePlanningInput): Promise<AcquisitionPlanningResult> {
    const failedTitles = new Set(input.failureEvidence.map((evidence) => evidence.candidateTitle));
    const keywords = uniqueKeywords([
      input.initialKeyword,
      input.title,
      ...input.aliases,
      `${input.title} 4K`,
    ]);
    const snapshots: ResourceSnapshot[] = [];
    const searchedKeywords: string[] = [];
    const trace: AcquisitionPlanningResult["trace"] = [
      { type: "node_start", nodeName: "MoviePlanningAgent", schemaName: "movie_planning", maxSteps: 8 },
    ];

    for (const keyword of keywords) {
      searchedKeywords.push(keyword);
      trace.push({ type: "tool_call", nodeName: "MoviePlanningAgent", toolName: "searchResources", input: { keyword } });
      let snapshot: ResourceSnapshot;
      try {
        snapshot = await input.searchResources({ keyword });
      } catch (error) {
        trace.push({
          type: "tool_result",
          nodeName: "MoviePlanningAgent",
          toolName: "searchResources",
          output: { keyword, error: errorMessage(error) },
        });
        continue;
      }
      snapshots.push(snapshot);
      trace.push({
        type: "tool_result",
        nodeName: "MoviePlanningAgent",
        toolName: "searchResources",
        output: { snapshotId: snapshot.id, keyword: snapshot.keyword, candidateCount: snapshot.candidates.length },
      });
      const chosen = snapshot.candidates.find((candidate) => !failedTitles.has(candidate.title));
      if (chosen === undefined) {
        continue;
      }
      trace.push({ type: "node_finish", nodeName: "MoviePlanningAgent", schemaName: "movie_planning" });
      return {
        plan: {
          node: "fake_movie_planning",
          selectedSnapshotId: snapshot.id,
          searchedKeywords,
          candidateDispositions: snapshot.candidates.map((candidate) =>
            candidate.id === chosen.id
              ? { candidateId: candidate.id, disposition: "selected", episodes: ["S01E01"], reason: "Fake movie pick" }
              : { candidateId: candidate.id, disposition: "rejected", episodes: [], reason: "Not the chosen movie file" },
          ),
          confidence: "high",
          reason: "Fake movie planning selected a single candidate.",
        },
        snapshots,
        trace,
      };
    }

    trace.push({ type: "node_finish", nodeName: "MoviePlanningAgent", schemaName: "movie_planning" });
    return {
      plan: {
        node: "fake_movie_planning",
        selectedSnapshotId: null,
        searchedKeywords,
        candidateDispositions: [],
        confidence: "low",
        reason: "Fake movie planning found no candidate.",
      },
      snapshots,
      trace,
    };
  }

  async recognizePackage(input: PackageRecognitionInput): Promise<PackageRecognitionDecision> {
    return (
      this.packageRecognition ?? {
        node: "fake_package_recognition",
        fileMappings: [],
        rejectedProviderFileIds: input.files.map((file) => file.providerFileId),
        confidence: "low",
        reason: "No fake package recognition mapping configured.",
      }
    );
  }
}

function minimalCoveringDispositions(input: {
  candidates: ResourceCandidate[];
  missingEpisodes: string[];
  failedTitles: Set<string>;
}): CandidateDisposition[] {
  const missing = new Set(input.missingEpisodes);
  const chosen = new Set<string>();
  const coveredByChosen = new Set<string>();
  for (const episode of input.missingEpisodes) {
    if (coveredByChosen.has(episode)) {
      continue;
    }
    const candidate = input.candidates.find(
      (item) => item.episodeHints.includes(episode) && !input.failedTitles.has(item.title),
    );
    if (candidate === undefined) {
      continue;
    }
    chosen.add(candidate.id);
    for (const hint of candidate.episodeHints) {
      if (missing.has(hint)) {
        coveredByChosen.add(hint);
      }
    }
  }

  return input.candidates.map((candidate) => {
    if (chosen.has(candidate.id)) {
      return {
        candidateId: candidate.id,
        disposition: "selected" as const,
        episodes: [...candidate.episodeHints],
        reason: "Fake selection: episode hints cover missing episodes.",
      };
    }
    if (input.failedTitles.has(candidate.title)) {
      return {
        candidateId: candidate.id,
        disposition: "rejected" as const,
        episodes: [],
        reason: "Fake rejection: failure evidence names this resource.",
      };
    }
    return {
      candidateId: candidate.id,
      disposition: "rejected" as const,
      episodes: [],
      reason: "Fake rejection: not needed for minimal coverage.",
    };
  });
}

function uniqueKeywords(keywords: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const keyword of keywords) {
    const trimmed = keyword.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    unique.push(trimmed);
  }
  return unique;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cloneTransferOutcomes(transferOutcomes: Record<string, TransferOutcome>): Record<string, TransferOutcome> {
  return Object.fromEntries(
    Object.entries(transferOutcomes).map(([candidateId, outcome]) => [
      candidateId,
      {
        ...outcome,
        files: outcome.files.map((file) => ({ ...file })),
      },
    ]),
  );
}
