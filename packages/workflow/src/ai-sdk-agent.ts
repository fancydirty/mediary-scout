import { createOpenAICompatible, type OpenAICompatibleProviderSettings } from "@ai-sdk/openai-compatible";
import { generateText, stepCountIs, type ToolSet } from "ai";
import { z } from "zod";
import { AGENT_NODE_SPECS } from "./agent-node-specs.js";
import {
  runAgentNode,
  type AgentNodeExecutionRequest,
  type AgentNodeToolSet,
} from "./agent-node-runtime.js";
import type { Confidence, ResourceSnapshot } from "./domain.js";
import type {
  PackageRecognitionDecision,
  PackageRecognitionInput,
} from "./package-normalizer.js";
import type {
  AcquisitionPlanningInput,
  AcquisitionPlanningResult,
  AgentNodes,
  MovieMasterSelectionDecision,
  MovieMasterSelectionInput,
  MoviePlanningInput,
} from "./ports.js";

// The shipped default model — any OpenAI-compatible endpoint works; override
// with AGENT_MODEL_BASE_URL / AGENT_MODEL_ID / AGENT_MODEL_API_KEY.
const DEFAULT_PROVIDER_NAME = "agent-model";
const DEFAULT_BASE_URL = "https://token-plan-sgp.xiaomimimo.com/v1";
const DEFAULT_MODEL_ID = "mimo-v2.5-pro";

/** Per-step latency telemetry. Off unless MEDIA_TRACK_PERF_LOG is set, so it
 *  never spams production but stays available for diagnosing slow runs. */
function perfLog(message: string): void {
  if (process.env.MEDIA_TRACK_PERF_LOG) {
    console.error(`[perf] ${message}`);
  }
}

const acquisitionPlanningSchema = z.object({
  selectedSnapshotId: z.string().nullable(),
  searchedKeywords: z.array(z.string()),
  candidateDispositions: z.array(
    z.object({
      candidateId: z.string(),
      disposition: z.enum(["selected", "rejected", "uncertain"]),
      episodes: z.array(z.string()),
      reason: z.string(),
    }),
  ),
  confidence: z.enum(["low", "medium", "high"]),
  reason: z.string(),
});

const packageRecognitionSchema = z.object({
  fileMappings: z.array(
    z.object({
      providerFileId: z.string(),
      seasonNumber: z.number().int().positive(),
      episodeNumber: z.number().int().positive(),
      confidence: z.enum(["low", "medium", "high"]),
      reason: z.string(),
    }),
  ),
  rejectedProviderFileIds: z.array(z.string()),
  foreignWorkProviderFileIds: z.array(z.string()).optional(),
  confidence: z.enum(["low", "medium", "high"]),
  reason: z.string(),
});

const movieMasterSelectionSchema = z.object({
  keepFileId: z.string(),
  reason: z.string(),
});

type AcquisitionPlanningOutput = z.infer<typeof acquisitionPlanningSchema>;
type PackageRecognitionOutput = z.infer<typeof packageRecognitionSchema>;
type MovieMasterSelectionOutput = z.infer<typeof movieMasterSelectionSchema>;
type StructuredOutput =
  | AcquisitionPlanningOutput
  | PackageRecognitionOutput
  | MovieMasterSelectionOutput;

export interface StructuredOutputRequest extends AgentNodeExecutionRequest {}

export type GenerateStructuredOutput = (request: StructuredOutputRequest) => Promise<StructuredOutput>;

export interface VercelAiAgentNodesOptions {
  apiKey?: string;
  baseURL?: string;
  modelId?: string;
  providerName?: string;
  generateStructuredOutput?: GenerateStructuredOutput;
  /**
   * The user's preferred subtitle language (e.g. "中文"). Injected into every
   * planning agent's input as standing context — a release named in a language
   * is far more likely to ship that language's subtitles. This lives on the
   * agent (a global user preference), not threaded through each workflow call.
   */
  preferredLanguage?: string;
}

export class VercelAiAgentNodes implements AgentNodes {
  private readonly generateStructuredOutput: GenerateStructuredOutput;
  private readonly preferredLanguage: string | undefined;

  constructor(options: VercelAiAgentNodesOptions = {}) {
    this.generateStructuredOutput =
      options.generateStructuredOutput ?? createAiSdkStructuredGenerator(options);
    this.preferredLanguage = options.preferredLanguage;
  }

  private get languageContext(): { preferredLanguage: string } | Record<string, never> {
    return this.preferredLanguage === undefined ? {} : { preferredLanguage: this.preferredLanguage };
  }

  async planAcquisition(input: AcquisitionPlanningInput): Promise<AcquisitionPlanningResult> {
    const snapshots: ResourceSnapshot[] = [];
    const result = await runAgentNode({
      spec: AGENT_NODE_SPECS.AcquisitionPlanningAgent,
      input: {
        title: input.title,
        aliases: input.aliases,
        seasons: input.seasons,
        qualityPreference: input.qualityPreference,
        missingEpisodes: input.missingEpisodes,
        initialKeyword: input.initialKeyword,
        ...this.languageContext,
        failureEvidence: input.failureEvidence,
      },
      tools: {
        searchResources: {
          readOnly: true,
          description:
            "Search the resource provider with one keyword. Read-only. Returns the full persisted ResourceSnapshot; judge from this complete evidence. Returns {keyword, error} when the provider fails.",
          inputSchema: AGENT_NODE_SPECS.AcquisitionPlanningAgent.toolInputSchemas.searchResources,
          execute: async ({ keyword }) => {
            try {
              const snapshot = await input.searchResources({ keyword });
              snapshots.push(snapshot);
              return {
                snapshotId: snapshot.id,
                provider: snapshot.provider,
                keyword: snapshot.keyword,
                candidateCount: snapshot.candidates.length,
                candidates: snapshot.candidates.map((candidate) => ({
                  id: candidate.id,
                  title: candidate.title,
                  type: candidate.type,
                  source: candidate.source,
                  episodeHints: candidate.episodeHints,
                  qualityHints: candidate.qualityHints,
                })),
              };
            } catch (error) {
              return { keyword, error: error instanceof Error ? error.message : String(error) };
            }
          },
        },
      },
      executor: this.generateStructuredOutput,
    });
    const output = acquisitionPlanningSchema.parse(result.output);

    return {
      plan: {
        node: "vercel_ai_acquisition_planning",
        selectedSnapshotId: output.selectedSnapshotId,
        searchedKeywords: output.searchedKeywords,
        candidateDispositions: output.candidateDispositions,
        confidence: output.confidence as Confidence,
        reason: output.reason,
      },
      snapshots,
      trace: result.trace,
    };
  }

  async planMovieAcquisition(input: MoviePlanningInput): Promise<AcquisitionPlanningResult> {
    const snapshots: ResourceSnapshot[] = [];
    const result = await runAgentNode({
      spec: AGENT_NODE_SPECS.MoviePlanningAgent,
      input: {
        title: input.title,
        aliases: input.aliases,
        year: input.year,
        qualityPreference: input.qualityPreference,
        initialKeyword: input.initialKeyword,
        ...this.languageContext,
        failureEvidence: input.failureEvidence,
      },
      tools: {
        searchResources: {
          readOnly: true,
          description:
            "Search the resource provider with one keyword. Read-only. Returns the full persisted ResourceSnapshot; judge from this complete evidence. Returns {keyword, error} when the provider fails.",
          inputSchema: AGENT_NODE_SPECS.MoviePlanningAgent.toolInputSchemas.searchResources,
          execute: async ({ keyword }) => {
            const ts = Date.now();
            try {
              const snapshot = await input.searchResources({ keyword });
              perfLog(`pansou search "${keyword}" ${Date.now() - ts}ms → ${snapshot.candidates.length} candidates`);
              snapshots.push(snapshot);
              return {
                snapshotId: snapshot.id,
                provider: snapshot.provider,
                keyword: snapshot.keyword,
                candidateCount: snapshot.candidates.length,
                candidates: snapshot.candidates.map((candidate) => ({
                  id: candidate.id,
                  title: candidate.title,
                  type: candidate.type,
                  source: candidate.source,
                  episodeHints: candidate.episodeHints,
                  qualityHints: candidate.qualityHints,
                })),
              };
            } catch (error) {
              perfLog(`pansou search "${keyword}" ${Date.now() - ts}ms → ERROR`);
              return { keyword, error: error instanceof Error ? error.message : String(error) };
            }
          },
        },
      },
      executor: this.generateStructuredOutput,
    });
    const output = acquisitionPlanningSchema.parse(result.output);

    return {
      plan: {
        node: "vercel_ai_movie_planning",
        selectedSnapshotId: output.selectedSnapshotId,
        searchedKeywords: output.searchedKeywords,
        candidateDispositions: output.candidateDispositions,
        confidence: output.confidence as Confidence,
        reason: output.reason,
      },
      snapshots,
      trace: result.trace,
    };
  }

  async selectMovieMasterFile(
    input: MovieMasterSelectionInput,
  ): Promise<MovieMasterSelectionDecision> {
    const result = await runAgentNode({
      spec: AGENT_NODE_SPECS.MovieMasterSelectionAgent,
      input: {
        title: input.title,
        year: input.year,
        candidates: input.candidates.map((candidate) => ({
          providerFileId: candidate.providerFileId,
          name: candidate.name,
          sizeBytes: candidate.sizeBytes,
        })),
      },
      executor: this.generateStructuredOutput,
    });
    const output = movieMasterSelectionSchema.parse(result.output);
    return {
      node: "vercel_ai_movie_master_selection",
      keepFileId: output.keepFileId,
      reason: output.reason,
    };
  }

  async recognizePackage(input: PackageRecognitionInput): Promise<PackageRecognitionDecision> {
    const result = await runAgentNode({
      spec: AGENT_NODE_SPECS.PackageRecognitionAgent,
      input: {
        title: input.title,
        year: input.year,
        files: input.files.map((file) => ({
          path: file.path,
          providerFileId: file.providerFileId,
          sizeBytes: file.sizeBytes,
        })),
        parserEvidence: input.parserEvidence,
      },
      executor: this.generateStructuredOutput,
    });
    const output = packageRecognitionSchema.parse(result.output);

    return {
      node: "vercel_ai_package_recognition",
      fileMappings: output.fileMappings.map((mapping) => ({
        ...mapping,
        confidence: mapping.confidence as Confidence,
      })),
      rejectedProviderFileIds: output.rejectedProviderFileIds,
      ...(output.foreignWorkProviderFileIds === undefined
        ? {}
        : { foreignWorkProviderFileIds: output.foreignWorkProviderFileIds }),
      confidence: output.confidence as Confidence,
      reason: output.reason,
    };
  }
}

/**
 * Build the agent nodes from environment config. The model is just an
 * OpenAI-compatible endpoint — swapping providers is only the three params
 * api key / base url / model id, so the env keys are model-agnostic
 * (`AGENT_MODEL_API_KEY` / `_BASE_URL` / `_ID`). The legacy `XIAOMI_MIMO_*`
 * keys are still read as a fallback so existing configs keep working.
 */
export function createAgentNodesFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  preferredLanguage?: string,
): VercelAiAgentNodes {
  const options: VercelAiAgentNodesOptions = {};
  const apiKey = env.AGENT_MODEL_API_KEY ?? env.XIAOMI_MIMO_API_KEY;
  const baseURL = env.AGENT_MODEL_BASE_URL ?? env.XIAOMI_MIMO_BASE_URL;
  const modelId = env.AGENT_MODEL_ID ?? env.XIAOMI_MIMO_MODEL_ID;
  if (apiKey !== undefined) {
    options.apiKey = apiKey;
  }
  if (baseURL !== undefined) {
    options.baseURL = baseURL;
  }
  if (modelId !== undefined) {
    options.modelId = modelId;
  }
  if (preferredLanguage !== undefined) {
    options.preferredLanguage = preferredLanguage;
  }
  return new VercelAiAgentNodes(options);
}

export function createAgentProviderConfig(options: VercelAiAgentNodesOptions = {}): {
  providerSettings: OpenAICompatibleProviderSettings;
  modelId: string;
} {
  const providerSettings: OpenAICompatibleProviderSettings = {
    name: options.providerName ?? DEFAULT_PROVIDER_NAME,
    baseURL: options.baseURL ?? DEFAULT_BASE_URL,
    ...(options.apiKey === undefined ? {} : { headers: { "api-key": options.apiKey } }),
  };

  return {
    providerSettings,
    modelId: options.modelId ?? DEFAULT_MODEL_ID,
  };
}

/**
 * Structured output without `response_format` support. The Mimo
 * OpenAI-compatible endpoint rejects JSON-schema response formats, so
 * `Output.object()` cannot enforce the contract. Instead the JSON schema is
 * embedded in the system prompt, the tool loop runs normally, and the final
 * text is parsed manually with zod — with one repair round when the first
 * reply is not valid JSON. Validation still happens at this boundary either
 * way; a plan that fails the schema never reaches the workflow.
 */
function createAiSdkStructuredGenerator(options: VercelAiAgentNodesOptions): GenerateStructuredOutput {
  const { providerSettings, modelId } = createAgentProviderConfig(options);
  const provider = createOpenAICompatible(providerSettings);
  const model = provider(modelId);

  return async (request) => {
    const schema = schemaFor(request.schemaName);
    const tools = request.tools === undefined ? undefined : toAiSdkTools(request.tools);
    const system = `${request.system}

Final answer format (hard requirement):
Reply with ONLY one JSON object matching this JSON Schema — no markdown fences, no commentary before or after it:
${JSON.stringify(z.toJSONSchema(schema))}`;

    const t0 = Date.now();
    const first = await generateText({
      model,
      system,
      prompt: request.prompt,
      stopWhen: stepCountIs(request.maxSteps),
      ...(tools === undefined ? {} : { tools }),
    });
    const steps = first.steps?.length ?? 0;
    const toolCalls = (first.steps ?? []).reduce((n, s) => n + (s.toolCalls?.length ?? 0), 0);
    // Per-call latency breakdown — the model loop (reasoning + tool round-trips)
    // is the dominant cost; this exposes how many steps it burned and how long.
    perfLog(
      `${request.nodeName}: model loop ${Date.now() - t0}ms, steps=${steps}, toolCalls=${toolCalls}, finish=${first.finishReason}`,
    );
    const firstParsed = parseStructuredText(schema, first.text);
    if (firstParsed.success) {
      return firstParsed.data as StructuredOutput;
    }

    const repair = await generateText({
      model,
      system,
      messages: [
        { role: "user", content: request.prompt },
        ...first.response.messages,
        {
          role: "user",
          content: `Your previous reply was not a valid JSON object for the required schema (${firstParsed.error}). Reply now with ONLY the JSON object. Do not call tools. Do not add any text around it.`,
        },
      ],
    });
    const repaired = parseStructuredText(schema, repair.text);
    if (repaired.success) {
      return repaired.data as StructuredOutput;
    }
    throw new Error(
      `Model did not return a valid ${request.schemaName} object after one repair round: ${repaired.error}`,
    );
  };
}

export function extractJsonText(text: string): string {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const body = (fenced?.[1] ?? trimmed).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("No JSON object found in model reply");
  }
  return body.slice(start, end + 1);
}

function parseStructuredText(
  schema: ReturnType<typeof schemaFor>,
  text: string,
): { success: true; data: unknown } | { success: false; error: string } {
  let candidate: unknown;
  try {
    candidate = JSON.parse(extractJsonText(text));
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
  const result = schema.safeParse(candidate);
  if (!result.success) {
    return { success: false, error: result.error.message };
  }
  return { success: true, data: result.data };
}

function schemaFor(schemaName: StructuredOutputRequest["schemaName"]) {
  switch (schemaName) {
    case "acquisition_planning":
    case "movie_planning":
      // Same output shape; the movie agent maps its single pick to ["S01E01"].
      return acquisitionPlanningSchema;
    case "movie_master_selection":
      return movieMasterSelectionSchema;
    case "package_recognition":
      return packageRecognitionSchema;
    default:
      throw new Error(`No structured output schema registered for ${schemaName}`);
  }
}

function toAiSdkTools(tools: AgentNodeToolSet): ToolSet {
  return Object.fromEntries(
    Object.entries(tools).map(([name, definition]) => [
      name,
      {
        description: definition.description,
        inputSchema: definition.inputSchema,
        execute: definition.execute,
      },
    ]),
  ) as ToolSet;
}
