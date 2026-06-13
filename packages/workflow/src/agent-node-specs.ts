import type { AgentNodeName, AgentNodeSpec } from "./agent-node-types.js";
import {
  ACQUISITION_PLANNING_AGENT_SPEC,
  MOVIE_PLANNING_AGENT_SPEC,
} from "./agent-nodes/acquisition-planning-agent.js";
import { MOVIE_MASTER_SELECTION_AGENT_SPEC } from "./agent-nodes/movie-master-selection-agent.js";
import { PACKAGE_RECOGNITION_AGENT_SPEC } from "./agent-nodes/package-recognition-agent.js";

export type { AgentNodeName, AgentNodeSpec } from "./agent-node-types.js";

export const AGENT_NODE_SPECS = {
  AcquisitionPlanningAgent: ACQUISITION_PLANNING_AGENT_SPEC,
  MoviePlanningAgent: MOVIE_PLANNING_AGENT_SPEC,
  MovieMasterSelectionAgent: MOVIE_MASTER_SELECTION_AGENT_SPEC,
  PackageRecognitionAgent: PACKAGE_RECOGNITION_AGENT_SPEC,
} as const satisfies Record<AgentNodeName, AgentNodeSpec>;
