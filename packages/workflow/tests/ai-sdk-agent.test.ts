import { describe, expect, it } from "vitest";
import {
  AGENT_NODE_SPECS,
  extractJsonText,
  createXiaomiMimoProviderConfig,
  runAgentNode,
  VercelAiAgentNodes,
  type ResourceSnapshot,
} from "../src/index.js";

describe("VercelAiAgentNodes", () => {
  it("uses the Singapore Token Plan model id and api-key header by default", () => {
    const config = createXiaomiMimoProviderConfig({ apiKey: "secret" });

    expect(config.modelId).toBe("mimo-v2.5-pro");
    expect(config.providerSettings).toMatchObject({
      baseURL: "https://token-plan-sgp.xiaomimimo.com/v1",
      headers: {
        "api-key": "secret",
      },
    });
    expect(config.providerSettings).not.toHaveProperty("apiKey");
  });

  it("defines the two remaining specialist node specs", () => {
    expect(Object.keys(AGENT_NODE_SPECS)).toEqual(["AcquisitionPlanningAgent", "PackageRecognitionAgent"]);
    expect(AGENT_NODE_SPECS.AcquisitionPlanningAgent.system).toContain("No just-in-case");
    expect(AGENT_NODE_SPECS.AcquisitionPlanningAgent.system).toContain("EVERY candidate");
    expect(AGENT_NODE_SPECS.AcquisitionPlanningAgent.system).toContain("failureEvidence");
    expect(AGENT_NODE_SPECS.PackageRecognitionAgent.system).toContain("multi-season");
  });

  it("teaches coverage-first selection: overlap for initialization, packs over gaps", () => {
    const system = AGENT_NODE_SPECS.AcquisitionPlanningAgent.system;
    expect(system).toContain("coverage completeness ALWAYS beats pack-size preference");
    expect(system).toContain("Overlap is safe");
    expect(system).toContain("Never sacrifice coverage to avoid a big pack");
  });

  it("runs a node with read-only tools, maxSteps, and audit trace", async () => {
    const result = await runAgentNode({
      spec: AGENT_NODE_SPECS.AcquisitionPlanningAgent,
      input: {
        title: "Show",
        initialKeyword: "Show 4K",
      },
      tools: {
        searchResources: {
          readOnly: true,
          description: "Search fake resource snapshots.",
          inputSchema: AGENT_NODE_SPECS.AcquisitionPlanningAgent.toolInputSchemas.searchResources,
          execute: async ({ keyword }: { keyword: string }) => ({
            snapshotId: "snapshot_1",
            keyword,
            candidateCount: 1,
          }),
        },
      },
      executor: async (request) => {
        expect(request.maxSteps).toBeGreaterThanOrEqual(4);
        const searchResult = await request.tools!.searchResources!.execute({ keyword: "Show S01" });
        expect(searchResult).toMatchObject({
          snapshotId: "snapshot_1",
        });
        return {
          selectedSnapshotId: "snapshot_1",
          searchedKeywords: ["Show S01"],
          candidateDispositions: [],
          confidence: "high",
          reason: "Alias search found the target.",
        };
      },
    });

    expect(result.output).toMatchObject({
      selectedSnapshotId: "snapshot_1",
      searchedKeywords: ["Show S01"],
    });
    expect(result.trace.map((event) => event.type)).toEqual([
      "node_start",
      "tool_call",
      "tool_result",
      "node_finish",
    ]);
  });

  it("plans acquisition through the read-only search tool and observed snapshots", async () => {
    const snapshot: ResourceSnapshot = {
      id: "snapshot_1",
      provider: "fake",
      keyword: "Show 4K",
      candidates: [
        {
          id: "snapshot_1_candidate_1",
          snapshotId: "snapshot_1",
          index: 0,
          title: "Show S01E01 4K",
          type: "115",
          source: "fake",
          episodeHints: ["S01E01"],
          qualityHints: ["4K"],
          providerPayload: {},
        },
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const agent = new VercelAiAgentNodes({
      generateStructuredOutput: async (request) => {
        expect(request.schemaName).toBe("acquisition_planning");
        expect(request.system).toBe(AGENT_NODE_SPECS.AcquisitionPlanningAgent.system);
        expect(request.prompt).toContain("failureEvidence");
        const observed = await request.tools!.searchResources!.execute({ keyword: "Show 4K" });
        expect(observed).toMatchObject({ snapshotId: "snapshot_1", candidateCount: 1 });
        return {
          selectedSnapshotId: "snapshot_1",
          searchedKeywords: ["Show 4K"],
          candidateDispositions: [
            {
              candidateId: "snapshot_1_candidate_1",
              disposition: "selected",
              episodes: ["S01E01"],
              reason: "Exact missing episode.",
            },
          ],
          confidence: "high",
          reason: "Initial keyword was enough.",
        };
      },
    });

    const result = await agent.planAcquisition({
      title: "Show",
      aliases: [],
      seasonNumber: 1,
      qualityPreference: "4K",
      missingEpisodes: ["S01E01"],
      latestAiredEpisode: 1,
      initialKeyword: "Show 4K",
      failureEvidence: [],
      searchResources: async () => snapshot,
    });

    expect(result.plan.node).toBe("vercel_ai_acquisition_planning");
    expect(result.plan.selectedSnapshotId).toBe("snapshot_1");
    expect(result.snapshots).toEqual([snapshot]);
  });

  it("surfaces provider errors to the model as tool results instead of throwing", async () => {
    const agent = new VercelAiAgentNodes({
      generateStructuredOutput: async (request) => {
        const observed = await request.tools!.searchResources!.execute({ keyword: "Show 4K" });
        expect(observed).toEqual({ keyword: "Show 4K", error: "provider 400" });
        return {
          selectedSnapshotId: null,
          searchedKeywords: ["Show 4K"],
          candidateDispositions: [],
          confidence: "low",
          reason: "Provider failed for every keyword tried.",
        };
      },
    });

    const result = await agent.planAcquisition({
      title: "Show",
      aliases: [],
      seasonNumber: 1,
      qualityPreference: "4K",
      missingEpisodes: ["S01E01"],
      latestAiredEpisode: 1,
      initialKeyword: "Show 4K",
      failureEvidence: [],
      searchResources: async () => {
        throw new Error("provider 400");
      },
    });

    expect(result.plan.selectedSnapshotId).toBeNull();
    expect(result.snapshots).toEqual([]);
  });

  it("turns structured package recognition output into a bounded file mapping decision", async () => {
    const agent = new VercelAiAgentNodes({
      generateStructuredOutput: async (request) => {
        expect(request.schemaName).toBe("package_recognition");
        expect(request.prompt).toContain("provider_1");
        return {
          fileMappings: [
            {
              providerFileId: "provider_1",
              seasonNumber: 1,
              episodeNumber: 1,
              confidence: "medium",
              reason: "The parent package and filename indicate the first episode.",
            },
          ],
          rejectedProviderFileIds: [],
          confidence: "medium",
          reason: "One ambiguous package file was mapped.",
        };
      },
    });

    await expect(
      agent.recognizePackage({
        title: "Show",
        year: 2024,
        files: [
          {
            path: "Show Pack/Disc A/Episode 01.mkv",
            providerFileId: "provider_1",
            sizeBytes: 100,
          },
        ],
        parserEvidence: [
          {
            path: "Show Pack/Disc A/Episode 01.mkv",
            providerFileId: "provider_1",
            parsedSeasonNumber: null,
            parsedEpisodeNumber: 1,
            confidence: "medium",
            evidence: ["filename_episode"],
          },
        ],
      }),
    ).resolves.toEqual({
      node: "vercel_ai_package_recognition",
      fileMappings: [
        {
          providerFileId: "provider_1",
          seasonNumber: 1,
          episodeNumber: 1,
          confidence: "medium",
          reason: "The parent package and filename indicate the first episode.",
        },
      ],
      rejectedProviderFileIds: [],
      confidence: "medium",
      reason: "One ambiguous package file was mapped.",
    });
  });
});

describe("extractJsonText", () => {
  it("returns a bare JSON object unchanged", () => {
    expect(extractJsonText('{"a":1}')).toBe('{"a":1}');
  });

  it("strips markdown fences", () => {
    expect(extractJsonText('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("extracts the object from surrounding commentary", () => {
    expect(extractJsonText('Here is my plan:\n{"a":{"b":2}}\nDone.')).toBe('{"a":{"b":2}}');
  });

  it("throws when no JSON object is present", () => {
    expect(() => extractJsonText("no json here")).toThrowError(/No JSON object/);
  });
});
