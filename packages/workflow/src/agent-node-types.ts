import type { z } from "zod";

export type AgentNodeName =
  | "AcquisitionPlanningAgent"
  | "MoviePlanningAgent"
  | "MovieMasterSelectionAgent"
  | "PackageRecognitionAgent";

export interface AgentNodeSpec {
  nodeName: AgentNodeName;
  schemaName:
    | "acquisition_planning"
    | "movie_planning"
    | "movie_master_selection"
    | "package_recognition";
  maxSteps: number;
  system: string;
  toolInputSchemas?: Record<string, z.ZodType>;
}
